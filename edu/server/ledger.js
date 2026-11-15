/**
 * Sổ quỹ lượt thi. Webhook SePay ghi giao dịch, trình duyệt đọc lại theo mã quỹ.
 * Giá gói phải khớp edu/js/core/quota.js: 20 lượt = 100.000đ, 100 = 350.000đ, 250 = 625.000đ.
 */

export const ACCOUNT = '10006548943';
export const BANK = 'TPBank';

const PACK_BY_PRICE = {
    100000: { id: 'basic', turns: 20, name: 'Gói Cơ Bản' },
    350000: { id: 'group', turns: 100, name: 'Gói Nhóm' },
    625000: { id: 'class', turns: 250, name: 'Gói Đại Gia' }
};

const CLAIM = `
if redis.call('SET', KEYS[1], '1', 'NX') then
  redis.call('LPUSH', KEYS[2], ARGV[1])
  redis.call('LTRIM', KEYS[2], 0, 299)
  redis.call('SADD', KEYS[3], ARGV[2])
  if redis.call('HEXISTS', KEYS[4], 'created') == 0 then
    redis.call('HSET', KEYS[4], 'created', ARGV[5])
  end
  redis.call('HINCRBY', KEYS[4], 'balance', ARGV[3])
  redis.call('HINCRBY', KEYS[4], 'money', ARGV[4])
  redis.call('HSET', KEYS[4], 'updated', ARGV[5])
  redis.call('LPUSH', KEYS[5], ARGV[6])
  redis.call('LTRIM', KEYS[5], 0, 199)
  return 1
end
return 0
`;

const ADJUST = `
if redis.call('HEXISTS', KEYS[1], 'created') == 0 then
  redis.call('HSET', KEYS[1], 'created', ARGV[2], 'money', '0')
end
redis.call('HINCRBY', KEYS[1], 'balance', ARGV[1])
redis.call('HSET', KEYS[1], 'updated', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
if ARGV[4] ~= '' then
  redis.call('LPUSH', KEYS[3], ARGV[4])
  redis.call('LTRIM', KEYS[3], 0, 299)
end
return redis.call('HGET', KEYS[1], 'balance')
`;

const SPEND = `
local bal = tonumber(redis.call('HGET', KEYS[1], 'balance') or '0') or 0
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0') or 0
local left = bal - spent
if redis.call('EXISTS', KEYS[3]) == 1 then
  return left
end
if left < 1 then
  return -1
end
redis.call('SET', KEYS[3], '1', 'EX', 172800)
redis.call('HINCRBY', KEYS[1], 'spent', 1)
redis.call('HSET', KEYS[1], 'updated', ARGV[2])
redis.call('LPUSH', KEYS[2], ARGV[1])
redis.call('LTRIM', KEYS[2], 0, 299)
return left - 1
`;

export function envGet(env, name) {
    if (env && typeof env[name] === 'string' && env[name]) return env[name];
    if (typeof process !== 'undefined' && process.env && process.env[name]) return String(process.env[name]);
    return '';
}

export function fundCodeFrom(value) {
    const text = String(value || '').toUpperCase();
    const match = text.match(/(?:^|[^A-Z0-9])EDU\s+([A-Z0-9]{4,12})(?![A-Z0-9])/);
    return match ? match[1] : '';
}

export function cleanCode(value) {
    const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    return code.length >= 4 ? code : '';
}

export function packForAmount(amount) {
    const money = Math.round(Number(amount));
    return PACK_BY_PRICE[money] || null;
}

export function eventId(txnId) {
    const digits = String(txnId == null ? '' : txnId).replace(/\D/g, '').slice(0, 16);
    if (!digits) return '';
    return ('s' + digits.padStart(8, '0')).slice(0, 24);
}

export function eventTime(transactionDate) {
    const match = String(transactionDate || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    let t = Date.now();
    if (match) {
        t = Date.parse(match[1] + '-' + match[2] + '-' + match[3] + 'T' + match[4] + ':' + match[5] + ':' + match[6] + '+07:00');
    }
    if (!Number.isFinite(t) || t < 1700000000000) t = Date.now();
    if (t > Date.now() + 60000) t = Date.now();
    return t;
}

function redisConfig(env) {
    const url = (envGet(env, 'UPSTASH_REDIS_REST_URL') || envGet(env, 'KV_REST_API_URL')).trim().replace(/\/$/, '');
    const token = (envGet(env, 'UPSTASH_REDIS_REST_TOKEN') || envGet(env, 'KV_REST_API_TOKEN')).trim();
    if (!url || !token) {
        const err = new Error('missing-redis');
        err.code = 'missing-redis';
        throw err;
    }
    return { url, token };
}

export async function redisCall(env, args) {
    const { url, token } = redisConfig(env);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(args),
            signal: ctrl.signal
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || (data && data.error)) {
            const err = new Error('redis');
            err.code = 'redis';
            throw err;
        }
        return data.result;
    } finally {
        clearTimeout(timer);
    }
}

export async function redisCommand(env, args) {
    return redisCall(env, args);
}

export async function creditPurchase(env, purchase) {
    const turns = Math.round(Number(purchase.turns != null ? purchase.turns : purchase.event && purchase.event.delta));
    const money = Math.max(0, Math.round(Number(purchase.money) || 0));
    const when = String(purchase.event.t);
    const log = JSON.stringify({
        id: purchase.id,
        quotaId: purchase.code,
        amount: money,
        turns: turns,
        content: String(purchase.content || '').slice(0, 240),
        t: purchase.event.t
    });
    const claimed = await redisCommand(env, [
        'EVAL', CLAIM, 5,
        'fpass:sepay:txn:' + purchase.id,
        'fpass:fund:' + purchase.code,
        'fpass:quotas',
        'fpass:quota:' + purchase.code,
        'sepay_transactions',
        JSON.stringify(purchase.event),
        purchase.code,
        String(turns),
        String(money),
        when,
        log
    ]);
    return Number(claimed) === 1;
}

function readFundRows(rows) {
    const events = [];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
        try {
            const ev = JSON.parse(row);
            if (ev && (ev.kind === 'buy' || ev.kind === 'eos')) events.push(ev);
        } catch (e) {}
    });
    return events;
}

export async function listPurchases(env, code) {
    const rows = await redisCommand(env, ['LRANGE', 'fpass:fund:' + code, '0', '299']);
    return readFundRows(rows).filter((ev) => ev.kind === 'buy');
}

export async function fundState(env, code) {
    const hash = hashObject(await redisCommand(env, ['HGETALL', 'fpass:quota:' + code]));
    const granted = Math.max(0, Math.floor(Number(hash.balance) || 0));
    const spent = Math.max(0, Math.floor(Number(hash.spent) || 0));
    const rows = await redisCommand(env, ['LRANGE', 'fpass:fund:' + code, '0', '299']);
    return {
        granted,
        spent,
        balance: Math.max(0, granted - spent),
        events: readFundRows(rows)
    };
}

export async function spendTurn(env, input) {
    const code = cleanCode(input && input.code);
    if (!code) {
        const err = new Error('bad-code');
        err.code = 'bad-code';
        throw err;
    }
    const id = String(input && input.id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
    if (!/^[a-z0-9]{8,24}$/.test(id)) {
        const err = new Error('bad-id');
        err.code = 'bad-id';
        throw err;
    }
    const note = String(input && input.note || 'Nộp bài').replace(/[\u0000-\u001F]/g, '').slice(0, 80);
    const now = Date.now();
    const event = JSON.stringify({ id, t: now, delta: -1, kind: 'eos', pack: '', note });
    const left = Number(await redisCommand(env, [
        'EVAL', SPEND, 3,
        'fpass:quota:' + code,
        'fpass:fund:' + code,
        'fpass:spend:' + id,
        event,
        String(now)
    ]));
    return { ok: left >= 0, balance: left < 0 ? 0 : left, code };
}

function hashObject(result) {
    if (!result || typeof result !== 'object') return {};
    if (!Array.isArray(result)) return result;
    const out = {};
    for (let i = 0; i < result.length; i += 2) out[result[i]] = result[i + 1];
    return out;
}

async function redisPipeline(env, commands) {
    const { url, token } = redisConfig(env);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(url + '/pipeline', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(commands),
            signal: ctrl.signal
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(data)) {
            const err = new Error('redis');
            err.code = 'redis';
            throw err;
        }
        return data.map((row) => (row && Object.prototype.hasOwnProperty.call(row, 'result') ? row.result : null));
    } finally {
        clearTimeout(timer);
    }
}

function quotaView(code, hash) {
    const h = hashObject(hash);
    return {
        code,
        balance: Math.max(0, Math.floor(Number(h.balance) || 0)),
        spent: Math.max(0, Math.floor(Number(h.spent) || 0)),
        remaining: Math.max(0, Math.floor(Number(h.balance) || 0) - Math.max(0, Math.floor(Number(h.spent) || 0))),
        money: Math.max(0, Math.floor(Number(h.money) || 0)),
        updated: Math.floor(Number(h.updated) || 0),
        created: Math.floor(Number(h.created) || 0)
    };
}

export async function listQuotas(env) {
    const codes = await redisCommand(env, ['SMEMBERS', 'fpass:quotas']);
    const list = (Array.isArray(codes) ? codes : []).map((code) => cleanCode(code)).filter(Boolean).slice(0, 200);
    if (!list.length) return [];
    const rows = await redisPipeline(env, list.map((code) => ['HGETALL', 'fpass:quota:' + code]));
    return list.map((code, i) => quotaView(code, rows[i])).sort((a, b) => b.updated - a.updated);
}

export async function listTransactions(env) {
    const rows = await redisCommand(env, ['LRANGE', 'sepay_transactions', '0', '49']);
    const out = [];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
        try {
            const ev = JSON.parse(row);
            const code = cleanCode(ev && ev.quotaId);
            if (!ev || !ev.id || !code) return;
            out.push({
                id: String(ev.id).replace(/[^a-z0-9]/g, '').slice(0, 24),
                quotaId: code,
                amount: Math.max(0, Math.floor(Number(ev.amount) || 0)),
                turns: Math.floor(Number(ev.turns) || 0),
                content: String(ev.content || '').slice(0, 240),
                t: Math.floor(Number(ev.t) || 0)
            });
        } catch (e) {}
    });
    return out;
}

function adminEventId() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return ('a' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')).slice(0, 24);
}

export async function adjustQuota(env, input) {
    const code = cleanCode(input && input.code);
    if (!code) {
        const err = new Error('bad-code');
        err.code = 'bad-code';
        throw err;
    }
    const current = Math.max(0, Math.floor(Number(await redisCommand(env, ['HGET', 'fpass:quota:' + code, 'balance'])) || 0));
    const exists = Number(await redisCommand(env, ['EXISTS', 'fpass:quota:' + code])) === 1;
    if (input.mode === 'create' && exists) return { code, balance: current, delta: 0, existed: true };

    let delta = 0;
    if (input.mode === 'set' || input.mode === 'create') {
        const target = Math.floor(Number(input.balance));
        if (!Number.isFinite(target) || target < 0 || target > 20000) {
            const err = new Error('bad-turns');
            err.code = 'bad-turns';
            throw err;
        }
        delta = target - current;
    } else {
        delta = Math.floor(Number(input.delta));
        if (!Number.isFinite(delta) || delta === 0 || delta < -5000 || delta > 5000) {
            const err = new Error('bad-turns');
            err.code = 'bad-turns';
            throw err;
        }
        if (current + delta < 0) delta = -current;
    }
    if (delta === 0 && exists) return { code, balance: current, delta: 0 };

    const now = Date.now();
    const event = delta === 0 ? null : {
        id: adminEventId(),
        t: now,
        delta,
        kind: 'buy',
        pack: 'admin',
        note: String(input.note || 'Admin cấp lượt').replace(/[\u0000-\u001F]/g, '').slice(0, 80)
    };
    const balance = await redisCommand(env, [
        'EVAL', ADJUST, 3,
        'fpass:quota:' + code,
        'fpass:quotas',
        'fpass:fund:' + code,
        String(delta),
        String(now),
        code,
        event ? JSON.stringify(event) : ''
    ]);
    return { code, balance: Math.max(0, Math.floor(Number(balance) || 0)), delta };
}
