import { createGift, listGifts, toggleGift } from './account.js';
import { bearer, loginAdmin, logoutAdmin, requireAdmin } from './admin-auth.js';
import { deleteOfficial, listOfficial, listPending, publishPending, rejectPending, saveOfficial, takePending } from './exams-store.js';
import { clientIp, fail, json, mount, sameOrigin } from './http.js';
import { adjustAiGrant, adjustQuota, listQuotas, listTransactions } from './ledger.js';
import { recordVisit, visitHistory } from './visits.js';

export async function handleLogin(req, env) {
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

export async function handleQuotas(req, env) {
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
            if (body && body.op === 'ai') {
                const result = await adjustAiGrant(env, body);
                return json(200, result);
            }
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

export async function handleExams(req, env) {
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

export async function handleVisits(req, env) {
    try {
        if (req.method === 'POST') {
            const fromPage = sameOrigin(req) || req.header('sec-fetch-site') === 'same-origin';
            if (!fromPage) return json(403, { error: 'Chỉ ghi nhận từ chính trang này.' });
            const body = await req.json(200);
            const id = String(body && body.id || '').toLowerCase();
            if (!/^[a-f0-9]{16}$/.test(id)) return json(400, { error: 'Thiếu mã máy.' });
            await recordVisit(env, id, clientIp(req));
            return json(200, { ok: true });
        }
        if (req.method === 'GET') {
            const token = await requireAdmin(req, env);
            if (!token) return json(401, { error: 'Cần đăng nhập quản trị.' });
            return json(200, await visitHistory(env));
        }
        return json(405, { error: 'Chỉ nhận GET hoặc POST.' });
    } catch (e) {
        return fail(e, 'visits');
    }
}

export async function handleGiftcodes(req, env) {
    try {
        const token = await requireAdmin(req, env);
        if (!token) return json(401, { error: 'Cần đăng nhập quản trị.' });
        if (req.method === 'GET') return json(200, { gifts: await listGifts(env) });
        if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận GET hoặc POST.' });
        const body = await req.json(8000);
        const op = body && body.op;
        if (op === 'toggle') return json(200, await toggleGift(env, body));
        if (op === 'create') return json(200, await createGift(env, body));
        return json(400, { error: 'Thiếu thao tác.' });
    } catch (e) {
        if (e && (e.code === 'exists' || e.code === 'bad-gift' || e.code === 'missing-gift')) return json(400, { error: e.message });
        return fail(e, 'admin-gifts');
    }
}

export const loginOnRequest = mount(handleLogin).onRequest;
export const quotasOnRequest = mount(handleQuotas).onRequest;
export const examsOnRequest = mount(handleExams).onRequest;
