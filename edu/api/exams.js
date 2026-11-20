import { listOfficial } from '../server/exams-store.js';
import { fail, json, mount, sameOrigin } from '../server/http.js';
import { readGuide } from '../server/site.js';

function only(req) {
    try {
        return new URL(req.url).searchParams.get('only') || '';
    } catch (e) {
        return '';
    }
}

async function handle(req, env) {
    try {
        if (req.method !== 'GET') return json(405, { error: 'Chỉ nhận GET.' });
        if (!sameOrigin(req)) return json(403, { error: 'Chỉ xem đề từ chính trang này.' });
        /* Trang chủ chỉ cần link video, không tải cả kho đề. */
        if (only(req) === 'guide') return json(200, { guide: await readGuide(env) }, { 'Cache-Control': 'public, max-age=60' });
        const exams = await listOfficial(env);
        return json(200, { exams });
    } catch (e) {
        return fail(e, 'exams');
    }
}

const { onRequest, handler } = mount(handle);
export { onRequest };
export default handler;
