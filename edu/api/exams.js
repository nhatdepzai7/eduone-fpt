import { listOfficial } from './exams-store.js';
import { fail, json, mount, sameOrigin } from './http.js';

async function handle(req, env) {
    try {
        if (req.method !== 'GET') return json(405, { error: 'Chỉ nhận GET.' });
        if (!sameOrigin(req)) return json(403, { error: 'Chỉ xem đề từ chính trang này.' });
        const exams = await listOfficial(env);
        return json(200, { exams });
    } catch (e) {
        return fail(e, 'exams');
    }
}

const { onRequest, handler } = mount(handle);
export { onRequest };
export default handler;
