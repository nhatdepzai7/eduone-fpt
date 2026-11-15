/**
 * POST /api/machines — trình duyệt đã nhận sổ mua của một mã quỹ tự ghi tên máy.
 * GET /api/machines — chỉ admin (header Authorization: Bearer ADMIN_KEY) xem danh sách.
 */

import { cleanCode, envGet, listPurchases, redisCall } from '../server/ledger.js';

const MACHINE = /^[a-f0-9]{12}$/;
const TXN = /^[a-z0-9]{8,24}$/;

function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

function safeEqual(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (left.length !== right.length) return false;
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
}

function sameOrigin(req) {
    const origin = req.header('origin');
    if (!origin) return false;
    try {
        return new URL(origin).host === String(req.header('host') || '').trim();
    } catch (e) {
        return false;
    }
}

function cleanName(value) {
    return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
}

function pairs(result) {
    if (!result) return [];
    if (Array.isArray(result)) {
        const out = [];
        for (let i = 0; i < result.length; i += 2) out.push([String(result[i]), result[i + 1]]);
        return out;
    }
    if (typeof result === 'object') return Object.keys(result).map((key) => [key, result[key]]);
    return [];
}

async function readBody(req) {
    if (typeof req.json === 'function' && !req.raw) {
        try { return await req.json(); } catch (e) { return null; }
    }
    try { return JSON.parse(req.raw || '{}'); } catch (e) { return null; }
}

async function machinesOf(env, code) {
    const purchases = await listPurchases(env, code);
    const turns = {};
    purchases.forEach((ev) => { turns[ev.id] = ev.delta; });
    const rows = pairs(await redisCall(env, ['HGETALL', 'fpass:machines:' + code]));
    const machines = [];
    rows.forEach(([id, raw]) => {
        if (!MACHINE.test(id)) return;
        let rec = null;
        try { rec = JSON.parse(raw); } catch (e) { rec = null; }
        if (!rec || typeof rec !== 'object') return;
        const txns = (Array.isArray(rec.txns) ? rec.txns : []).filter((txn) => turns[txn]);
        machines.push({
            id,
            name: cleanName(rec.name),
            first: Number(rec.first) || 0,
            last: Number(rec.last) || 0,
            txns,
            turns: txns.reduce((sum, txn) => sum + (Number(turns[txn]) || 0), 0)
        });
    });
    machines.sort((a, b) => b.last - a.last);
    return { code, purchases: purchases.length, machines };
}

async function record(req, env) {
    if (!sameOrigin(req) && req.header('sec-fetch-site') !== 'same-origin') {
        return json(403, { error: 'Chỉ ghi máy từ chính trang này.' });
    }
    const body = await readBody(req);
    const code = cleanCode(body && body.code);
    const machine = String(body && body.machine || '');
    if (!code || !MACHINE.test(machine)) return json(400, { error: 'Thiếu mã quỹ hoặc mã máy.' });
    const wanted = (Array.isArray(body.purchases) ? body.purchases : [])
        .map((id) => String(id || ''))
        .filter((id) => TXN.test(id))
        .slice(0, 30);
    if (!wanted.length) return json(200, { recorded: false });

    const purchases = await listPurchases(env, code);
    const known = new Set(purchases.map((ev) => ev.id));
    const txns = wanted.filter((id) => known.has(id));
    if (!txns.length) return json(200, { recorded: false });

    const key = 'fpass:machines:' + code;
    const prevRaw = await redisCall(env, ['HGET', key, machine]);
    let prev = null;
    try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) { prev = null; }
    const count = Number(await redisCall(env, ['HLEN', key])) || 0;
    if (!prev && count >= 100) return json(200, { recorded: false });

    const seen = new Set(txns);
    (prev && Array.isArray(prev.txns) ? prev.txns : []).forEach((id) => { if (known.has(id)) seen.add(id); });
    const rec = {
        name: cleanName(body.name) || (prev && cleanName(prev.name)) || '',
        first: prev && Number(prev.first) ? Number(prev.first) : Date.now(),
        last: Date.now(),
        txns: Array.from(seen).slice(0, 30)
    };
    await redisCall(env, ['HSET', key, machine, JSON.stringify(rec)]);
    await redisCall(env, ['SADD', 'fpass:fund-index', code]);
    return json(200, { recorded: true });
}

async function adminList(req, env) {
    const secret = envGet(env, 'ADMIN_KEY').trim();
    if (!secret) return json(503, { error: 'Máy chủ chưa có khóa quản trị.' });
    const header = String(req.header('authorization') || '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (!match || !safeEqual(match[1], secret)) return json(401, { error: 'Khóa quản trị không đúng.' });

    const query = (req.url || '').indexOf('?') >= 0 ? (req.url || '').slice((req.url || '').indexOf('?') + 1) : '';
    const one = cleanCode(new URLSearchParams(query).get('code'));
    let codes = one ? [one] : [];
    if (!one) {
        const members = await redisCall(env, ['SMEMBERS', 'fpass:fund-index']);
        codes = (Array.isArray(members) ? members : []).map((code) => cleanCode(code)).filter(Boolean).slice(0, 40);
    }
    const books = [];
    for (let i = 0; i < codes.length; i++) books.push(await machinesOf(env, codes[i]));
    return json(200, { codes: books });
}

async function handleRequest(req, env) {
    try {
        if (req.method === 'POST') return await record(req, env);
        if (req.method === 'GET') return await adminList(req, env);
        return json(405, { error: 'Chỉ nhận GET hoặc POST.' });
    } catch (e) {
        console.error('[machines] lỗi sổ máy', e && e.code ? e.code : 'error');
        return json(503, { error: 'Chưa ghi được sổ máy.' });
    }
}

function adapt(incoming, raw) {
    if (incoming && typeof incoming.header === 'function') {
        incoming.raw = raw;
        return incoming;
    }
    return {
        method: incoming.method,
        url: incoming.url || '',
        raw,
        header(name) { return (incoming.headers && incoming.headers.get(name)) || ''; },
        json() { return Promise.resolve(JSON.parse(raw || '{}')); }
    };
}

export async function onRequest(context) {
    const request = context.request;
    const raw = request.method === 'POST' ? await request.text() : '';
    return handleRequest(adapt(request, raw), context.env || {});
}

function nodeRequest(req, raw) {
    const headerMap = {};
    Object.keys(req.headers || {}).forEach((name) => {
        const value = req.headers[name];
        headerMap[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value || '');
    });
    const host = headerMap.host || '';
    const proto = headerMap['x-forwarded-proto'] || 'https';
    const path = req.url || '/api/machines';
    return {
        method: req.method || 'GET',
        url: /^https?:/i.test(path) ? path : proto + '://' + host + path,
        raw,
        header(name) { return headerMap[String(name).toLowerCase()] || ''; }
    };
}

async function readRaw(req) {
    if (req.method !== 'POST' && req.method !== 'PUT') return '';
    if (typeof req.body === 'string') return req.body;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(req.body)) return req.body.toString('utf8');
    if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
    if (!req || typeof req.on !== 'function') return '';
    return await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

export default async function handler(req, res) {
    if (res && typeof res.status === 'function') {
        const response = await handleRequest(nodeRequest(req, await readRaw(req)), process.env);
        res.status(response.status);
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.send(await response.text());
        return;
    }
    const raw = typeof req.text === 'function' && req.method === 'POST' ? await req.text() : '';
    return handleRequest(adapt(req, raw), process.env);
}
