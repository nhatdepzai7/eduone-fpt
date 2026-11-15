import { requireAdmin } from '../../server/admin-auth.js';
import { deleteOfficial, listOfficial, listPending, publishPending, rejectPending, saveOfficial, takePending } from '../../server/exams-store.js';
import { fail, json, mount } from '../../server/http.js';
import { adjustQuota } from '../../server/ledger.js';

async function handle(req, env) {
    try {
        const token = await requireAdmin(req, env);
        if (!token) return json(401, { error: 'Cần đăng nhập quản trị.' });
        if (req.method === 'GET') {
            const exams = await listOfficial(env);
            const pending = await listPending(env);
            return json(200, { exams, pending });
        }
        const body = await req.json(400000);
        const op = body && body.op;
        if (req.method === 'DELETE' || op === 'delete') {
            await deleteOfficial(env, (body && body.id) || '');
            return json(200, { ok: true });
        }
        if (op === 'reject') {
            await rejectPending(env, body.id);
            return json(200, { ok: true });
        }
        if (op === 'approve') {
            const pack = await takePending(env, body.id);
            const official = await publishPending(env, pack);
            let reward = Math.floor(Number(body.reward) || 0);
            if (reward < 0) reward = 0;
            if (reward > 500) reward = 500;
            let granted = null;
            let grantError = '';
            if (reward > 0) {
                try {
                    granted = await adjustQuota(env, {
                        mode: 'delta',
                        code: body.quotaId || pack.quotaId,
                        delta: reward,
                        note: 'Thưởng góp đề'
                    });
                } catch (err) {
                    grantError = err && err.code === 'bad-code'
                        ? 'Đề đã duyệt. Mã quỹ thưởng cần 4–12 chữ hoặc số nên chưa cộng lượt.'
                        : 'Đề đã duyệt nhưng chưa cộng được lượt thưởng.';
                }
            }
            return json(200, { exam: official, granted, grantError });
        }
        if (req.method === 'POST') {
            const exam = await saveOfficial(env, body || {});
            return json(200, { exam });
        }
        return json(405, { error: 'Không hỗ trợ phương thức này.' });
    } catch (e) {
        return fail(e, 'admin-exams');
    }
}

const { onRequest, handler } = mount(handle);
export { onRequest };
export default handler;
