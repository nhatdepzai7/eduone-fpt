/**
 * GET /api/fund?code=MAQUY
 * Trả các lần SePay đã cộng cho mã quỹ. Trình duyệt tự ghép vào sổ local.
 */

import { cleanCode, listPurchases } from './ledger.js';

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

async function handleRequest(req, env) {
    const extra = {};
    const origin = req.header('origin');
    if (origin && sameOrigin(req)) {
        extra['Access-Control-Allow-Origin'] = origin;
        extra.Vary = 'Origin';
        extra['Access-Control-Allow-Headers'] = 'Content-Type, Accept';
        extra['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra });
    if (req.method !== 'GET') return json(405, { error: 'Chỉ nhận GET.' }, extra);
    const fromPage = sameOrigin(req) || req.header('sec-fetch-site') === 'same-origin';
    if (!fromPage) return json(403, { error: 'Chỉ xem quỹ từ chính trang này.' }, extra);

    const url = req.url || '';
    const query = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : '';
    const code = cleanCode(new URLSearchParams(query).get('code'));
    if (!code) return json(400, { error: 'Mã quỹ cần 4–12 chữ hoặc số.' }, extra);

    try {
        const purchases = await listPurchases(env, code);
        return json(200, { code, purchases }, extra);
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
    return handleRequest(adapt(context.request), context.env || {});
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
        const response = await handleRequest(nodeRequest(req), process.env);
        res.status(response.status);
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.send(await response.text());
        return;
    }
    return handleRequest(adapt(req), process.env);
}
