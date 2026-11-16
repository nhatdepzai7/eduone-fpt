/**
 * POST /api/sepay
 * SePay gọi khi có giao dịch TPBank. Chỉ cộng lượt khi:
 * - xác thực API Key và/hoặc HMAC đúng,
 * - accountNumber là 10006548943, gateway TPBank, tiền vào,
 * - số tiền khớp một gói, nội dung có "EDU <mã quỹ>".
 * Trả {"success":true} trong mọi giao dịch hợp lệ để SePay không gửi lại.
 * Thiếu khóa xác thực hoặc Redis thì 503, SePay sẽ gửi lại.
 */

import { ACCOUNT, BANK, creditPurchase, envGet, eventId, eventTime, fundCodeFrom, packForAmount } from '../server/ledger.js';

const MAX_BODY = 16000;

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

async function hmacHex(secret, message) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authorize(req, raw, env) {
    const key = envGet(env, 'SEPAY_WEBHOOK_KEY').trim();
    const secret = envGet(env, 'SEPAY_WEBHOOK_SECRET').trim();
    if (!key && !secret) return { ok: false, status: 503, message: 'Máy chủ chưa bật xác thực SePay.' };
    if (key && !safeEqual(req.header('authorization'), 'Apikey ' + key)) {
        return { ok: false, status: 401, message: 'Unauthorized' };
    }
    if (secret) {
        const stamp = String(req.header('x-sepay-timestamp') || '').trim();
        const signature = String(req.header('x-sepay-signature') || '').trim().toLowerCase();
        const now = Math.floor(Date.now() / 1000);
        const sent = Number(stamp);
        if (!sent || Math.abs(now - sent) > 300) return { ok: false, status: 401, message: 'Request expired' };
        const expected = 'sha256=' + await hmacHex(secret, stamp + '.' + raw);
        if (!safeEqual(signature, expected)) return { ok: false, status: 401, message: 'Invalid signature' };
    }
    return { ok: true };
}

function parsePayload(raw, contentType) {
    if (String(contentType || '').includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(raw);
        const body = {};
        params.forEach((value, name) => { body[name] = value; });
        return body;
    }
    return JSON.parse(raw || '{}');
}

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

function isTpbank(gateway) {
    const name = String(gateway || '').toLowerCase().replace(/\s+/g, '');
    return name === 'tpbank' || name === 'tpb';
}

async function handleRequest(req, env) {
    if (req.method !== 'POST') return json(405, { success: false, message: 'Chỉ nhận POST.' });
    const auth = await authorize(req, req.raw || '', env);
    if (!auth.ok) return json(auth.status, { success: false, message: auth.message });

    const declared = parseInt(req.header('content-length') || '0', 10);
    if (declared > MAX_BODY || String(req.raw || '').length > MAX_BODY) {
        return json(413, { success: false, message: 'Nội dung quá lớn.' });
    }

    let body;
    try { body = parsePayload(req.raw || '', req.header('content-type')); }
    catch (e) { return json(400, { success: false, message: 'Payload không hợp lệ.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(400, { success: false, message: 'Payload không hợp lệ.' });
    }

    const txn = eventId(body.id);
    if (!txn) return json(400, { success: false, message: 'Thiếu mã giao dịch.' });

    const accountOk = digits(body.accountNumber) === ACCOUNT && isTpbank(body.gateway);
    const incoming = String(body.transferType || '') === 'in';
    if (!accountOk || !incoming) {
        console.error('[sepay] bỏ qua', txn, 'account/gateway/chiều tiền không khớp', BANK, ACCOUNT);
        return json(200, { success: true, credited: false });
    }

    const code = fundCodeFrom(body.content) || fundCodeFrom(body.description) || fundCodeFrom(String(body.code || ''));
    const pack = packForAmount(body.transferAmount);
    if (!code || !pack) {
        console.error('[sepay] không cộng', txn, 'amount', Number(body.transferAmount) || 0, 'memo', code ? 'có mã' : 'thiếu EDU');
        return json(200, { success: true, credited: false });
    }

    const event = {
        id: txn,
        t: eventTime(body.transactionDate),
        delta: pack.turns,
        kind: 'buy',
        pack: pack.id,
        note: pack.name
    };

    try {
        const added = await creditPurchase(env, {
            id: txn,
            code,
            event,
            turns: pack.turns,
            money: body.transferAmount,
            content: body.content || body.description || '',
            packId: pack.id
        });
        console.error('[sepay]', added ? 'đã cộng' : 'giao dịch đã xử lý', txn, code, pack.turns);
        return json(200, { success: true, credited: added, turns: added ? pack.turns : 0 });
    } catch (e) {
        console.error('[sepay] chưa ghi được sổ quỹ', txn, e && e.code ? e.code : 'error');
        return json(503, { success: false, message: 'Chưa ghi được sổ quỹ.' });
    }
}

function adapt(incoming, raw) {
    if (incoming && typeof incoming.header === 'function') {
        incoming.raw = raw;
        return incoming;
    }
    return {
        method: incoming.method,
        raw,
        header(name) { return (incoming.headers && incoming.headers.get(name)) || ''; }
    };
}

export async function onRequest(context) {
    const request = context.request;
    const raw = await request.text();
    return handleRequest(adapt(request, raw), context.env || {});
}

async function readRaw(req) {
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

function nodeRequest(req, raw) {
    const headerMap = {};
    Object.keys(req.headers || {}).forEach((name) => {
        const value = req.headers[name];
        headerMap[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value || '');
    });
    return {
        method: req.method || 'GET',
        raw,
        header(name) { return headerMap[String(name).toLowerCase()] || ''; }
    };
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    if (res && typeof res.status === 'function') {
        const response = await handleRequest(nodeRequest(req, await readRaw(req)), process.env);
        res.status(response.status);
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.send(await response.text());
        return;
    }
    const raw = typeof req.text === 'function' ? await req.text() : '';
    return handleRequest(adapt(req, raw), process.env);
}
