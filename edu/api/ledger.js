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
  return 1
end
return 0
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
    const url = envGet(env, 'UPSTASH_REDIS_REST_URL').trim().replace(/\/$/, '');
    const token = envGet(env, 'UPSTASH_REDIS_REST_TOKEN').trim();
    if (!url || !token) {
        const err = new Error('missing-redis');
        err.code = 'missing-redis';
        throw err;
    }
    return { url, token };
}

async function redisCall(env, args) {
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

export async function creditPurchase(env, purchase) {
    const claimed = await redisCall(env, [
        'EVAL', CLAIM, 2,
        'eduone:sepay:txn:' + purchase.id,
        'eduone:fund:' + purchase.code,
        JSON.stringify(purchase.event)
    ]);
    return Number(claimed) === 1;
}

export async function listPurchases(env, code) {
    const rows = await redisCall(env, ['LRANGE', 'eduone:fund:' + code, '0', '299']);
    const purchases = [];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
        try {
            const ev = JSON.parse(row);
            if (ev && ev.kind === 'buy') purchases.push(ev);
        } catch (e) {}
    });
    return purchases;
}
