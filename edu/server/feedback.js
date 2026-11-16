import { requireAdmin } from './admin-auth.js';
import { clientIp, fail, json, sameOrigin } from './http.js';
import { envGet, redisCommand } from './ledger.js';

const KINDS = { bug: 'Báo lỗi', idea: 'Đề xuất', other: 'Góp ý khác' };
const LIST_KEY = 'fpass:feedback';

function clean(value, max) {
    return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function codeOf(value) {
    const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    return code.length >= 4 ? code : '';
}

function pathOf(value) {
    const path = clean(value, 180);
    if (!path.startsWith('/') || path.startsWith('//')) return '';
    return path;
}

function hashOf(text) {
    let hash = 2166136261;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

async function hits(env, key) {
    const n = Number(await redisCommand(env, ['INCR', key]));
    if (n === 1) await redisCommand(env, ['EXPIRE', key, 300]);
    return n;
}

async function notify(env, item) {
    const url = envGet(env, 'FEEDBACK_WEBHOOK_URL').trim();
    if (!/^https:\/\//i.test(url)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: '[FPass] ' + (KINDS[item.kind] || 'Góp ý') + (item.quotaId ? ' · ' + item.quotaId : '') + '\n' + item.message,
                feedback: item
            }),
            signal: ctrl.signal
        });
    } catch (e) {
        console.error('[feedback] webhook');
    } finally {
        clearTimeout(timer);
    }
}

export async function handleFeedback(req, env) {
    try {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: { Allow: 'GET, POST, OPTIONS' } });
        }
        if (req.method === 'GET') {
            const token = await requireAdmin(req, env);
            if (!token) return json(401, { error: 'Cần đăng nhập quản trị.' });
            const raw = await redisCommand(env, ['LRANGE', LIST_KEY, '0', '99']);
            const items = (Array.isArray(raw) ? raw : []).map((line) => {
                try { return JSON.parse(line); } catch (e) { return null; }
            }).filter((row) => row && row.id);
            return json(200, { items });
        }
        if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận GET hoặc POST.' });
        if (!sameOrigin(req)) return json(403, { error: 'Chỉ gửi góp ý từ chính trang này.' });

        const body = await req.json(8000);
        const kind = body && KINDS[body.kind] ? body.kind : '';
        const message = clean(body && body.message, 2000);
        if (!kind) return json(400, { error: 'Hãy chọn loại góp ý.' });
        if (!message) return json(400, { error: 'Hãy viết nội dung góp ý.' });

        const quotaId = codeOf(body && body.quotaId);
        const ipHits = await hits(env, 'fpass:feedback:rate:ip:' + hashOf(clientIp(req)));
        const codeHits = quotaId ? await hits(env, 'fpass:feedback:rate:code:' + quotaId) : 0;
        if (ipHits > 3 || codeHits > 3) {
            return json(429, { error: 'Bạn vừa gửi vài góp ý. Chờ khoảng 5 phút rồi gửi tiếp.' });
        }

        const item = {
            id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            t: Date.now(),
            kind,
            message,
            contact: clean(body && body.contact, 120),
            quotaId,
            screen: clean(body && body.screen, 160),
            path: pathOf(body && body.path),
            ua: clean(body && body.ua, 240)
        };
        await redisCommand(env, ['LPUSH', LIST_KEY, JSON.stringify(item)]);
        await redisCommand(env, ['LTRIM', LIST_KEY, '0', '199']);
        await notify(env, item);
        return json(200, { ok: true });
    } catch (e) {
        return fail(e, 'feedback');
    }
}
