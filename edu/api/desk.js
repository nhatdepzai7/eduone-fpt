import { handleExams, handleGiftcodes, handleLogin, handleQuotas, handleVisits } from '../server/admin-routes.js';
import { json, mount } from '../server/http.js';

function actionOf(req) {
    try {
        return new URL(req.url).searchParams.get('action') || '';
    } catch (e) {
        return '';
    }
}

async function handle(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET, POST, DELETE, OPTIONS' } });
    const action = actionOf(req);
    if (action === 'login') return handleLogin(req, env);
    if (action === 'quotas') return handleQuotas(req, env);
    if (action === 'exams') return handleExams(req, env);
    if (action === 'visits') return handleVisits(req, env);
    if (action === 'giftcodes') return handleGiftcodes(req, env);
    return json(404, { error: 'Không có route này.' });
}

const { onRequest, handler } = mount(handle);
export { onRequest };
export default handler;
