/**
 * GET /api/fund?code=MAQUY — số còn lại và sổ mua / nộp của mã.
 * POST /api/fund — trừ 1 lượt trên server, mọi trình duyệt cùng mã thấy cùng số.
 */

import { fundState, spendTurn } from '../server/ledger.js';

function json(status, obj, extra) {
    const headers = Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    }, extra || {});
    return new Response(JSON.stringify(obj), { status, headers });
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

function parseBody(raw) {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) return parseBody(raw.toString('utf8'));
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw) return {};
    if (raw.length > 4000) return null;
    try { return JSON.parse(raw); }
    catch (e) { return null; }
}

async function handleRequest(req, env, body) {
    const extra = {};
    const origin = req.header('origin');
    if (origin && sameOrigin(req)) {
        extra['Access-Control-Allow-Origin'] = origin;
        extra.Vary = 'Origin';
        extra['Access-Control-Allow-Headers'] = 'Content-Type, Accept';
        extra['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra });
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Chỉ nhận GET hoặc POST.' }, Object.assign({ Allow: 'GET, POST, OPTIONS' }, extra));
    const fromPage = sameOrigin(req) || req.header('sec-fetch-site') === 'same-origin';
    if (!fromPage) return json(403, { error: 'Chỉ dùng quỹ từ chính trang này.' }, extra);

    if (req.method === 'POST') {
        if (!body || typeof body !== 'object') return json(400, { error: 'Thiếu nội dung yêu cầu.' }, extra);
        try {
            const result = await spendTurn(env, body);
            if (!result.ok) return json(409, { error: 'Mã này đã hết lượt.', code: result.code, balance: 0 }, extra);
            return json(200, result, extra);
        } catch (e) {
            if (e && (e.code === 'bad-code' || e.code === 'bad-id')) return json(400, { error: 'Mã quỹ hoặc mã lượt không hợp lệ.' }, extra);
            console.error('[fund] chưa trừ được lượt', e && e.code ? e.code : 'error');
            return json(503, { error: 'Chưa trừ được lượt.' }, extra);
        }
    }

    const url = req.url || '';
    const query = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : '';
    const code = String(new URLSearchParams(query).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (code.length < 4) return json(400, { error: 'Mã quỹ cần 4–12 chữ hoặc số.' }, extra);

    try {
        const state = await fundState(env, code);
        const purchases = state.events.filter((ev) => ev.kind === 'buy');
        return json(200, { code, balance: state.balance, granted: state.granted, spent: state.spent, purchases, events: state.events }, extra);
    } catch (e) {
        console.error('[fund] chưa đọc được sổ', e && e.code ? e.code : 'error');
        return json(503, { error: 'Máy chủ chưa nối sổ quỹ.' }, extra);
    }
}

function adapt(incoming) {
    if (incoming && typeof incoming.header === 'function' && incoming.url) return incoming;
    if (incoming && typeof incoming.header === 'function') return incoming;
    return {
        method: incoming.method,
        url: incoming.url || '',
        header(name) { return (incoming.headers && incoming.headers.get(name)) || ''; }
    };
}

export async function onRequest(context) {
    const request = context.request;
    const body = request.method === 'POST' ? parseBody(await request.text()) : null;
    return handleRequest(adapt(request), context.env || {}, body);
}

async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') return parseBody(req.body);
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(parseBody(Buffer.concat(chunks).toString('utf8'))));
        req.on('error', () => resolve(null));
    });
}

function nodeRequest(req) {
    const headerMap = {};
    Object.keys(req.headers || {}).forEach((name) => {
        const value = req.headers[name];
        headerMap[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value || '');
    });
    const host = headerMap.host || '';
    const proto = headerMap['x-forwarded-proto'] || 'https';
    const path = req.url || '/api/fund';
    return {
        method: req.method || 'GET',
        url: /^https?:/i.test(path) ? path : proto + '://' + host + path,
        header(name) { return headerMap[String(name).toLowerCase()] || ''; }
    };
}

export default async function handler(req, res) {
    if (res && typeof res.status === 'function') {
        const body = req.method === 'POST' ? await readBody(req) : null;
        const response = await handleRequest(nodeRequest(req), process.env, body);
        res.status(response.status);
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.send(await response.text());
        return;
    }
    const body = req.method === 'POST' ? await readBody(req) : null;
    return handleRequest(adapt(req), process.env, body);
}
