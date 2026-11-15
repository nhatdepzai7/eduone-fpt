/**
 * Khung chung cho API Node (Vercel) và onRequest (Cloudflare).
 */

export function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

function tooBig() {
    const err = new Error('too-big');
    err.code = 'too-big';
    return err;
}

export function clientIp(req) {
    const fwd = String(req.header('x-forwarded-for') || '').split(',')[0].trim();
    const raw = fwd || String(req.header('x-real-ip') || '');
    return raw.replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64) || 'unknown';
}

export function sameOrigin(req) {
    const origin = req.header('origin');
    if (!origin) return req.header('sec-fetch-site') === 'same-origin';
    try {
        return new URL(origin).host === String(req.header('host') || '').trim();
    } catch (e) {
        return false;
    }
}

export function fail(e, tag) {
    if (e && e.code === 'too-big') return json(413, { error: 'Nội dung quá lớn.' });
    if (e instanceof SyntaxError || (e && e.code === 'bad-json')) return json(400, { error: 'JSON không hợp lệ.' });
    if (e && e.code === 'bad-exam') return json(400, { error: e.message || 'Đề không hợp lệ.' });
    if (e && e.code === 'bad-code') return json(400, { error: 'Mã quỹ cần 4–12 chữ hoặc số.' });
    if (e && e.code === 'bad-turns') return json(400, { error: 'Số lượt không hợp lệ.' });
    if (e && e.code === 'locked') return json(429, { error: 'Đăng nhập sai quá nhiều lần. Thử lại sau 15 phút.' });
    if (e && e.code === 'full') return json(400, { error: e.message || 'Danh sách đã đầy.' });
    if (e && e.code === 'missing') return json(404, { error: 'Không tìm thấy đề.' });
    if (e && (e.code === 'missing-redis' || e.code === 'redis')) return json(503, { error: 'Máy chủ chưa nối Redis.' });
    console.error('[' + tag + ']', e && e.code ? e.code : 'error');
    return json(500, { error: 'Không thực hiện được.' });
}

function headerMap(headers) {
    const out = {};
    Object.keys(headers || {}).forEach((name) => {
        const value = headers[name];
        out[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value || '');
    });
    return out;
}

export function fromWeb(request) {
    return {
        method: request.method || 'GET',
        url: request.url || '',
        header(name) { return request.headers.get(name) || ''; },
        async json(limit) {
            const raw = await request.text();
            if (raw.length > limit) throw tooBig();
            if (!raw) return {};
            return JSON.parse(raw);
        }
    };
}

export function fromNode(req) {
    const headers = headerMap(req.headers);
    const host = headers.host || '';
    const proto = headers['x-forwarded-proto'] || 'https';
    const path = req.url || '/';
    return {
        method: req.method || 'GET',
        url: /^https?:/i.test(path) ? path : proto + '://' + host + path,
        header(name) { return headers[String(name).toLowerCase()] || ''; },
        async json(limit) {
            let raw = req.body;
            if (raw == null || raw === '') return {};
            if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(raw)) raw = raw.toString('utf8');
            if (typeof raw === 'string') {
                if (raw.length > limit) throw tooBig();
                return JSON.parse(raw);
            }
            const text = JSON.stringify(raw);
            if (text.length > limit) throw tooBig();
            return raw;
        }
    };
}

export function mount(handle) {
    const onRequest = (context) => handle(fromWeb(context.request), context.env || {});
    async function handler(req, res) {
        if (res && typeof res.status === 'function') {
            const response = await handle(fromNode(req), process.env);
            res.status(response.status);
            response.headers.forEach((value, name) => res.setHeader(name, value));
            res.send(await response.text());
            return;
        }
        const request = req && typeof req.headers !== 'undefined' && typeof req.headers.get === 'function' ? req : null;
        return handle(request ? fromWeb(request) : fromNode(req), process.env);
    }
    return { onRequest, handler };
}
