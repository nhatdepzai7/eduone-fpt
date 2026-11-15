import { requireAdmin } from '../../server/admin-auth.js';
import { fail, json, mount } from '../../server/http.js';
import { adjustQuota, listQuotas, listTransactions } from '../../server/ledger.js';

async function handle(req, env) {
    try {
        const token = await requireAdmin(req, env);
        if (!token) return json(401, { error: 'Cần đăng nhập quản trị.' });
        if (req.method === 'GET') {
            const quotas = await listQuotas(env);
            const transactions = await listTransactions(env);
            const revenue = quotas.reduce((sum, row) => sum + row.money, 0);
            return json(200, { quotas, transactions, revenue, count: quotas.length });
        }
        if (req.method === 'POST') {
            const body = await req.json(8000);
            const mode = body && body.op === 'create' ? 'create' : (body && body.op === 'set' ? 'set' : 'delta');
            const result = await adjustQuota(env, {
                mode,
                code: body && body.code,
                delta: body && body.delta,
                balance: mode === 'create' ? body && body.turns : body && body.balance,
                note: body && body.note
            });
            return json(200, result);
        }
        return json(405, { error: 'Chỉ nhận GET hoặc POST.' });
    } catch (e) {
        return fail(e, 'admin-quotas');
    }
}

const { onRequest, handler } = mount(handle);
export { onRequest };
export default handler;
