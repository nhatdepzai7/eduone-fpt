/**
 * Khung chung cho API Node (Vercel) và onRequest (Cloudflare).
 */

export function json(status, obj, extra) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }, extra || {})
    });
}

function tooBig() {
    const err = new Error('too-big');
    err.code = 'too-big';
    return err;
}

/* cf-connecting-ip chỉ đáng tin khi chạy trên Cloudflare; trên Vercel ai cũng tự đặt được header này. */
export function clientIp(req) {
    if (req.edge) {
        const cf = String(req.header('cf-connecting-ip') || '').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64);
        if (cf) return cf;
    }
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
    if (e && e.code === 'no-admin') return json(503, { error: 'Máy chủ chưa đặt ADMIN_PASSWORD (tối thiểu 12 ký tự).' });
    if (e && e.code === 'rate') return json(429, { error: e.message || 'Thao tác quá nhiều lần. Thử lại sau.' });
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

export function fromWeb(request, edge) {
    return {
        edge: !!edge,
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

function webRequest(value) {
    return value && value.headers && typeof value.headers.get === 'function' ? value : null;
}

async function send(res, response) {
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.send(await response.text());
}

export function mount(handle) {
    async function handler(req, res) {
        try {
            const nodeRes = res && typeof res.status === 'function' ? res : null;
            const incoming = webRequest(req) || webRequest(req && req.request);
            const env = (req && req.env) || (typeof process !== 'undefined' ? process.env : {});
            const edge = !!(req && req.request && incoming === req.request);
            const response = await handle(incoming ? fromWeb(incoming, edge) : fromNode(req && req.request ? req.request : req), env);
            if (nodeRes) {
                await send(nodeRes, response);
                return;
            }
            return response;
        } catch (e) {
            const body = json(500, { error: 'Không thực hiện được.' });
            if (res && typeof res.status === 'function') {
                await send(res, body);
                return;
            }
            return body;
        }
    }
    return { onRequest: handler, handler };
}
