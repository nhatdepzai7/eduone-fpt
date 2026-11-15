import { bearer, loginAdmin, logoutAdmin, requireAdmin } from '../../server/admin-auth.js';
import { clientIp, fail, json, mount } from '../../server/http.js';

async function handle(req, env) {
    try {
        if (req.method === 'POST') {
            const body = await req.json(4000);
            const session = await loginAdmin(env, body && body.password, clientIp(req));
            return json(200, session);
        }
        if (req.method === 'DELETE') {
            const token = await requireAdmin(req, env);
            if (!token) return json(401, { error: 'Cần đăng nhập quản trị.' });
            await logoutAdmin(env, bearer(req));
            return json(200, { ok: true });
        }
        return json(405, { error: 'Chỉ nhận POST hoặc DELETE.' });
    } catch (e) {
        if (e && e.code === 'bad-password') return json(401, { error: 'Sai mật khẩu quản trị.' });
        return fail(e, 'admin-login');
    }
}

const { onRequest, handler } = mount(handle);
export { onRequest };
export default handler;
