/**
 * GET /api/fund?code=MAQUY — số còn lại và sổ mua / nộp của mã.
 * POST /api/fund — trừ 1 lượt trên server, mọi trình duyệt cùng mã thấy cùng số.
 */

import { authConfig, currentAccount, loginGoogle, payAccount, redeemGift } from '../server/account.js';
import { fundState, redisCommand, spendTurn } from '../server/ledger.js';

const LOOKUPS_PER_WINDOW = 600;
const LOOKUP_WINDOW = 600;

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

function clientIp(req) {
    if (req.edge) {
        const cf = String(req.header('cf-connecting-ip') || '').trim();
        if (cf) return cf.slice(0, 64);
    }
    const fwd = String(req.header('x-forwarded-for') || '').split(',')[0].trim();
    return (fwd || String(req.header('x-real-ip') || '').trim() || 'unknown').slice(0, 64);
}

/* Đếm số lần tra mã quỹ theo IP để không dò hết các mã ngắn. Redis lỗi thì không chặn. */
async function lookupAllowed(env, req) {
    try {
        const key = 'fpass:fund:look:' + clientIp(req);
        const n = Number(await redisCommand(env, ['INCR', key]));
        if (n === 1) await redisCommand(env, ['EXPIRE', key, LOOKUP_WINDOW]);
        return n <= LOOKUPS_PER_WINDOW;
    } catch (e) {
        return true;
    }
}

function bodyLimit(url) {
    return /(?:\?|&)action=login(?:&|$)/.test(String(url || '')) ? 500000 : 4000;
}

function parseBody(raw, limit) {
    const cap = limit || 4000;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) return parseBody(raw.toString('utf8'), cap);
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw) return {};
    if (raw.length > cap) return null;
    try { return JSON.parse(raw); }
    catch (e) { return null; }
}

function accountError(e, extra) {
    const code = e && e.code;
    if (code === 'rate') return json(429, { error: e.message, code }, extra);
    if (code === 'no-google') return json(503, { error: e.message, code }, extra);
    if (code === 'bad-token' || code === 'auth') return json(401, { error: e.message, code }, extra);
    if (code === 'too-big') return json(413, { error: e.message, code }, extra);
    if (code === 'missing-gift' || code === 'bad-gift' || code === 'inactive-gift' || code === 'full-gift' || code === 'used-gift' || code === 'bad-code') {
        return json(400, { error: e.message, code }, extra);
    }
    if (code === 'missing-redis' || code === 'redis') return json(503, { error: 'Máy chủ chưa nối Redis.', code }, extra);
    console.error('[account]', code || 'error');
    return json(500, { error: 'Không thực hiện được.' }, extra);
}

async function handleRequest(req, env, body) {
    const extra = {};
    const origin = req.header('origin');
    if (origin && sameOrigin(req)) {
        extra['Access-Control-Allow-Origin'] = origin;
        extra.Vary = 'Origin';
        extra['Access-Control-Allow-Headers'] = 'Content-Type, Accept, Authorization';
        extra['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra });
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Chỉ nhận GET hoặc POST.' }, Object.assign({ Allow: 'GET, POST, OPTIONS' }, extra));
    const fromPage = sameOrigin(req) || req.header('sec-fetch-site') === 'same-origin';
    if (!fromPage) return json(403, { error: 'Chỉ dùng quỹ từ chính trang này.' }, extra);

    const queryText = (req.url || '').indexOf('?') >= 0 ? (req.url || '').slice((req.url || '').indexOf('?') + 1) : '';
    const action = new URLSearchParams(queryText).get('action') || '';
    if (action === 'config' || action === 'login' || action === 'me' || action === 'redeem' || action === 'pay') {
        try {
            if (action === 'config' && req.method === 'GET') return json(200, authConfig(env), extra);
            if (action === 'me' && req.method === 'GET') return json(200, await currentAccount(env, req), extra);
            if (action === 'pay' && req.method === 'POST') return json(200, await payAccount(env, req, body || {}), extra);
            if (action === 'login' && req.method === 'POST') {
                if (!body) return json(413, { error: 'Kho từ quá lớn để đồng bộ.' }, extra);
                return json(200, await loginGoogle(env, body), extra);
            }
            if (action === 'redeem' && req.method === 'POST') {
                if (!body) return json(400, { error: 'Thiếu nội dung yêu cầu.' }, extra);
                return json(200, await redeemGift(env, req, body, clientIp(req)), extra);
            }
            return json(405, { error: 'Sai phương thức.' }, extra);
        } catch (e) {
            return accountError(e, extra);
        }
    }

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
    if (!(await lookupAllowed(env, req))) return json(429, { error: 'Tra mã quá nhiều lần. Thử lại sau ít phút.' }, extra);

    try {
        const state = await fundState(env, code);
        const purchases = state.events.filter((ev) => ev.kind === 'buy');
        return json(200, {
            code,
            balance: state.balance,
            granted: state.granted,
            spent: state.spent,
            purchases,
            events: state.events,
            aiUnlocked: state.aiUnlocked,
            aiUsed: state.aiUsed,
            aiLimit: state.aiLimit,
            aiCredits: state.aiCredits,
            scans: state.scans,
            scanGrant: state.scanGrant,
            proUntil: state.proUntil || 0
        }, extra);
    } catch (e) {
        console.error('[fund] chưa đọc được sổ', e && e.code ? e.code : 'error');
        return json(503, { error: 'Máy chủ chưa nối sổ quỹ.' }, extra);
    }
}

function adapt(incoming, edge) {
    if (incoming && typeof incoming.header === 'function' && incoming.url) return incoming;
    if (incoming && typeof incoming.header === 'function') return incoming;
    return {
        edge: !!edge,
        method: incoming.method,
        url: incoming.url || '',
        header(name) { return (incoming.headers && incoming.headers.get(name)) || ''; }
    };
}

export async function onRequest(context) {
    const request = context.request;
    const raw = request.method === 'POST' ? await request.text() : '';
    const body = request.method === 'POST' ? parseBody(raw, bodyLimit(request.url)) : null;
    return handleRequest(adapt(request, true), context.env || {}, body);
}

async function readBody(req) {
    const cap = bodyLimit(req.url);
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return parseBody(req.body, cap);
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(parseBody(Buffer.concat(chunks).toString('utf8'), cap)));
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
