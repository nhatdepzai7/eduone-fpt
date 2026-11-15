import { submitPending } from '../server/exams-store.js';
import { clientIp, fail, json, mount, sameOrigin } from '../server/http.js';
import { redisCommand } from '../server/ledger.js';

async function handle(req, env) {
    try {
        if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST.' });
        if (!sameOrigin(req)) return json(403, { error: 'Chỉ gửi đề từ chính trang này.' });
        const ip = clientIp(req);
        const key = 'fpass:contribute:' + ip;
        const n = Number(await redisCommand(env, ['INCR', key]));
        if (n === 1) await redisCommand(env, ['EXPIRE', key, 3600]);
        if (n > 8) return json(429, { error: 'Bạn đã gửi nhiều đề trong giờ này. Thử lại sau.' });
        const body = await req.json(400000);
        const saved = await submitPending(env, {
            name: body && body.name,
            code: body && body.code,
            subject: body && body.subject,
            quotaId: body && body.quotaId,
            note: body && body.note,
            text: body && body.text
        });
        return json(200, saved);
    } catch (e) {
        return fail(e, 'contribute');
    }
}

const { onRequest, handler } = mount(handle);
export { onRequest };
export default handler;
