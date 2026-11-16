import { redisCommand } from './ledger.js';

const DAY_TTL = 40 * 24 * 3600;
const WHO_TTL = 366 * 24 * 3600;
const TOTAL_KEY = 'fpass:visit:total';

const RECORD = `
local dayKey = KEYS[1]
local uniqKey = KEYS[2]
local whoKey = KEYS[3]
local totalKey = KEYS[4]
local id = ARGV[1]
local day = ARGV[2]
local whoTtl = tonumber(ARGV[3])
local dayTtl = tonumber(ARGV[4])
redis.call('HINCRBY', dayKey, 'views', 1)
redis.call('HINCRBY', totalKey, 'views', 1)
redis.call('SADD', uniqKey, id)
local uniques = redis.call('SCARD', uniqKey)
redis.call('HSET', dayKey, 'uniques', uniques)
local created = redis.call('SET', whoKey, day, 'NX', 'EX', whoTtl)
if created then
  redis.call('HINCRBY', dayKey, 'new', 1)
  redis.call('HINCRBY', totalKey, 'users', 1)
end
redis.call('EXPIRE', dayKey, dayTtl)
redis.call('EXPIRE', uniqKey, dayTtl)
return 1
`;

const READ = `
local out = {}
local last = #KEYS
for i = 1, last - 1 do
  out[#out + 1] = redis.call('HGET', KEYS[i], 'views') or '0'
  out[#out + 1] = redis.call('HGET', KEYS[i], 'uniques') or '0'
  out[#out + 1] = redis.call('HGET', KEYS[i], 'new') or '0'
end
out[#out + 1] = redis.call('HGET', KEYS[last], 'views') or '0'
out[#out + 1] = redis.call('HGET', KEYS[last], 'users') or '0'
return out
`;

function vnParts(date) {
    const shifted = new Date(date.getTime() + 7 * 3600000);
    return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

function shiftParts(parts, delta) {
    const next = new Date(Date.UTC(parts.y, parts.m, parts.d) + delta * 86400000);
    return { y: next.getUTCFullYear(), m: next.getUTCMonth(), d: next.getUTCDate() };
}

function dayStamp(parts) {
    const month = String(parts.m + 1).padStart(2, '0');
    const day = String(parts.d).padStart(2, '0');
    return parts.y + '-' + month + '-' + day;
}

function dayList(count) {
    const days = [];
    let cursor = vnParts(new Date());
    for (let i = 0; i < count; i++) {
        days.push(dayStamp(cursor));
        cursor = shiftParts(cursor, -1);
    }
    return days;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function rateKey(ip) {
    let hash = 2166136261;
    const text = String(ip || 'unknown');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return 'fpass:visit:rate:' + (hash >>> 0).toString(16) + ':' + Math.floor(Date.now() / 60000);
}

export async function recordVisit(env, id, ip) {
    const bucket = rateKey(ip);
    const hits = num(await redisCommand(env, ['INCR', bucket]));
    if (hits === 1) await redisCommand(env, ['EXPIRE', bucket, 120]);
    if (hits > 40) return { ok: true };
    const day = dayList(1)[0].replace(/-/g, '');
    await redisCommand(env, [
        'EVAL', RECORD, '4',
        'fpass:visit:day:' + day,
        'fpass:visit:uniq:' + day,
        'fpass:visit:who:' + id,
        TOTAL_KEY,
        id,
        day,
        String(WHO_TTL),
        String(DAY_TTL)
    ]);
    return { ok: true };
}

export async function visitHistory(env) {
    const days = dayList(30);
    const keys = days.map((day) => 'fpass:visit:day:' + day.replace(/-/g, ''));
    keys.push(TOTAL_KEY);
    const raw = await redisCommand(env, ['EVAL', READ, String(keys.length)].concat(keys));
    const rows = days.map((day, index) => ({
        day,
        views: num(raw && raw[index * 3]),
        users: num(raw && raw[index * 3 + 1]),
        newUsers: num(raw && raw[index * 3 + 2])
    }));
    const base = days.length * 3;
    const week = rows.slice(0, 7);
    const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
    return {
        today: rows[0],
        week: { views: sum(week, 'views'), newUsers: sum(week, 'newUsers') },
        month: { views: sum(rows, 'views'), newUsers: sum(rows, 'newUsers') },
        all: { views: num(raw && raw[base]), users: num(raw && raw[base + 1]) },
        days: rows
    };
}
