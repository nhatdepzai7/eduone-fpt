/**
 * Tài khoản Google và giftcode Obsidian PRO.
 * Dữ liệu nằm trên Redis đang dùng (tiền tố fpass:), không thêm kho mới.
 * Lượt AI không lấy từ số máy khách gửi lên.
 */

import { cleanCode, envGet, fundState, redisCommand } from './ledger.js';

const SESSION_TTL = 60 * 60 * 24 * 30;
const LIB_CAP = 480000;
const ITEM_CAP = 4000;

function bad(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

function pairs(result) {
    const out = {};
    const rows = Array.isArray(result) ? result : [];
    for (let i = 0; i + 1 < rows.length; i += 2) out[rows[i]] = rows[i + 1];
    return out;
}

function clip(value, max) {
    return String(value == null ? '' : value).replace(/\u0000/g, '').slice(0, max);
}

function giftCodeOf(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

function randomToken(bytes) {
    const list = new Uint8Array(bytes);
    crypto.getRandomValues(list);
    let out = '';
    for (let i = 0; i < list.length; i++) out += list[i].toString(16).padStart(2, '0');
    return out;
}

function randomGift() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const list = new Uint8Array(8);
    crypto.getRandomValues(list);
    let out = 'FPASS';
    for (let i = 0; i < list.length; i++) out += alphabet[list[i] % alphabet.length];
    return out;
}

function clientId(env) {
    return envGet(env, 'GOOGLE_CLIENT_ID').trim();
}

export function authConfig(env) {
    const id = clientId(env);
    return { enabled: !!id, clientId: id };
}

async function verifyGoogle(env, idToken) {
    const aud = clientId(env);
    if (!aud) bad('no-google', 'Máy chủ chưa bật đăng nhập Google.');
    const token = clip(idToken, 4000);
    if (token.length < 20) bad('bad-token', 'Google không xác nhận được tài khoản.');
    const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.aud !== aud || !data.sub) bad('bad-token', 'Google không xác nhận được tài khoản.');
    if (String(data.email_verified) !== 'true') bad('bad-token', 'Email Google chưa được xác nhận.');
    return { sub: clip(data.sub, 80), email: clip(data.email, 120).toLowerCase() };
}

async function readUser(env, sub) {
    const row = pairs(await redisCommand(env, ['HGETALL', 'fpass:user:' + sub]));
    if (!row.sub) return null;
    return {
        sub: row.sub,
        email: row.email || '',
        fundCode: cleanCode(row.fundCode),
        tier: row.tier || '',
        proUntil: Number(row.proUntil) === -1 ? -1 : Math.max(0, Math.floor(Number(row.proUntil) || 0))
    };
}

function publicUser(user, fund) {
    const until = Number(user && user.proUntil) || 0;
    const live = user && user.tier === 'OBSIDIAN_PRO' && (until === -1 || until > Date.now());
    return {
        email: user ? user.email : '',
        tier: live ? 'OBSIDIAN_PRO' : '',
        proUntil: live ? until : 0,
        fundCode: fund && fund.code ? fund.code : (user && user.fundCode) || ''
    };
}

async function scoreFund(env, code) {
    if (!code) return -1;
    try {
        const state = await fundState(env, code);
        return state.balance + (state.aiCredits || 0) + (state.proUntil ? 100000 : 0);
    } catch (e) {
        return 0;
    }
}

/* Mỗi mã quỹ thuộc về một tài khoản Google. Lượt mua qua SePay cộng vào mã, nên mã gắn với ai thì lượt thuộc về người đó. */
async function fundOwner(env, code) {
    if (!code) return '';
    const sub = await redisCommand(env, ['GET', 'fpass:fundowner:' + code]);
    return typeof sub === 'string' ? sub : '';
}

async function claimFund(env, code, user) {
    if (!code) return;
    await redisCommand(env, ['SET', 'fpass:fundowner:' + code, user.sub, 'NX']);
    if (await fundOwner(env, code) !== user.sub) return;
    if (user.email) await redisCommand(env, ['SET', 'fpass:fundmail:' + code, user.email]);
}

function mintFund() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const list = new Uint8Array(8);
    crypto.getRandomValues(list);
    let out = '';
    for (let i = 0; i < list.length; i++) out += alphabet[list[i] % alphabet.length];
    return out;
}

/* Mã của máy khách chỉ được nhận khi chưa thuộc tài khoản khác. */
async function pickFund(env, current, guest, sub) {
    const a = cleanCode(current);
    let b = cleanCode(guest);
    if (b && sub) {
        const owner = await fundOwner(env, b);
        if (owner && owner !== sub) b = '';
    }
    if (!a) return b;
    if (!b || a === b) return a;
    const left = await scoreFund(env, a);
    const right = await scoreFund(env, b);
    return right > left ? b : a;
}

function keepText(prev, next, max) {
    const a = clip(prev, max);
    const b = clip(next, max);
    if (!a) return b;
    if (!b) return a;
    return b.length >= a.length ? b : a;
}

function mergeItem(prev, next) {
    const base = prev || next;
    const other = base === prev ? next : prev;
    return {
        id: clip(base.id, 80),
        type: base.type === 'mcq' || (other && other.type === 'mcq') ? (next && next.type === 'mcq' ? 'mcq' : base.type) : 'vocab',
        group: keepText(prev && prev.group, next && next.group, 80),
        questionOrWord: keepText(prev && prev.questionOrWord, next && next.questionOrWord, 1500),
        answerOrMeaning: keepText(prev && prev.answerOrMeaning, next && next.answerOrMeaning, 1500),
        explanationOrExample: keepText(prev && prev.explanationOrExample, next && next.explanationOrExample, 2500),
        exampleVi: keepText(prev && prev.exampleVi, next && next.exampleVi, 1500),
        ipa: keepText(prev && prev.ipa, next && next.ipa, 80),
        wordType: keepText(prev && prev.wordType, next && next.wordType, 24),
        example: undefined
    };
}

function slimItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = clip(raw.id, 80);
    if (!id) return null;
    const mcq = raw.type === 'mcq';
    const options = mcq && Array.isArray(raw.options) ? raw.options.slice(0, 4).map((opt) => clip(opt, 500)) : [];
    const item = {
        id,
        type: mcq ? 'mcq' : 'vocab',
        group: clip(raw.group, 80),
        questionOrWord: clip(raw.questionOrWord, mcq ? 1500 : 400),
        answerOrMeaning: clip(raw.answerOrMeaning, 1500),
        explanationOrExample: clip(raw.explanationOrExample, 2500),
        exampleVi: clip(raw.exampleVi, 1500),
        ipa: clip(raw.ipa, 80),
        wordType: clip(raw.wordType, 24),
        keywords: Array.isArray(raw.keywords) ? raw.keywords.slice(0, 20).map((k) => clip(k, 80)).filter(Boolean) : [],
        reviewCount: Math.max(0, Math.min(100000, Math.floor(Number(raw.reviewCount) || 0))),
        correctCount: Math.max(0, Math.min(100000, Math.floor(Number(raw.correctCount) || 0))),
        wrongCount: Math.max(0, Math.min(100000, Math.floor(Number(raw.wrongCount) || 0)))
    };
    if (mcq) {
        item.options = options;
        item.answerOrMeaning = clip(raw.answerOrMeaning, 8);
    }
    return item;
}

function mergeItems(cloud, guest) {
    const map = new Map();
    (Array.isArray(cloud) ? cloud : []).forEach((row) => {
        const item = slimItem(row);
        if (item) map.set(item.id, item);
    });
    (Array.isArray(guest) ? guest : []).forEach((row) => {
        const item = slimItem(row);
        if (!item) return;
        const prev = map.get(item.id);
        if (!prev) {
            map.set(item.id, item);
            return;
        }
        const merged = mergeItem(prev, item);
        merged.keywords = (item.keywords && item.keywords.length >= (prev.keywords || []).length) ? item.keywords : prev.keywords;
        merged.options = item.options || prev.options;
        merged.reviewCount = Math.max(prev.reviewCount || 0, item.reviewCount || 0);
        merged.correctCount = Math.max(prev.correctCount || 0, item.correctCount || 0);
        merged.wrongCount = Math.max(prev.wrongCount || 0, item.wrongCount || 0);
        merged.type = prev.type === 'mcq' || item.type === 'mcq' ? 'mcq' : 'vocab';
        map.set(item.id, merged);
    });
    return Array.from(map.values()).slice(0, ITEM_CAP);
}

function mergeProgress(cloud, guest) {
    const map = new Map();
    const take = (row) => {
        if (!row || typeof row !== 'object') return;
        const id = clip(row.id, 120);
        if (!id) return;
        const prev = map.get(id) || { id };
        map.set(id, {
            id,
            packId: keepText(prev.packId, row.packId, 80),
            correctCount: Math.max(prev.correctCount || 0, Math.floor(Number(row.correctCount) || 0)),
            wrongCount: Math.max(prev.wrongCount || 0, Math.floor(Number(row.wrongCount) || 0)),
            srsStage: Math.max(prev.srsStage || 0, Math.floor(Number(row.srsStage) || 0)),
            due: Math.max(prev.due || 0, Math.floor(Number(row.due) || 0))
        });
    };
    (Array.isArray(cloud) ? cloud : []).forEach(take);
    (Array.isArray(guest) ? guest : []).forEach(take);
    return Array.from(map.values()).slice(0, 8000);
}

function mergeVotes(cloud, guest) {
    const map = new Map();
    const take = (row) => {
        if (!row || typeof row !== 'object') return;
        const id = clip(row.id, 80);
        const sessionId = clip(row.sessionId, 80);
        if (!id || !sessionId || map.has(sessionId)) return;
        map.set(sessionId, {
            id,
            sessionId,
            date: clip(row.date, 10),
            type: clip(row.type, 24),
            createdAt: Math.max(0, Math.floor(Number(row.createdAt) || 0))
        });
    };
    (Array.isArray(cloud) ? cloud : []).forEach(take);
    (Array.isArray(guest) ? guest : []).forEach(take);
    return Array.from(map.values()).slice(0, 5000);
}

async function readLib(env, sub) {
    const raw = await redisCommand(env, ['GET', 'fpass:lib:' + sub]);
    if (!raw || typeof raw !== 'string') return { items: [], progress: [], votes: [] };
    try {
        const data = JSON.parse(raw);
        return {
            items: Array.isArray(data.items) ? data.items : [],
            progress: Array.isArray(data.progress) ? data.progress : [],
            votes: Array.isArray(data.votes) ? data.votes : []
        };
    } catch (e) {
        return { items: [], progress: [], votes: [] };
    }
}

async function writeLib(env, sub, lib) {
    const text = JSON.stringify(lib);
    if (text.length > LIB_CAP) bad('too-big', 'Kho từ quá lớn để đồng bộ.');
    await redisCommand(env, ['SET', 'fpass:lib:' + sub, text]);
}

function bearer(req) {
    const header = String(req.header('authorization') || '');
    const match = header.match(/^Bearer\s+([a-f0-9]{32,128})$/i);
    return match ? match[1].toLowerCase() : '';
}

async function userFromSession(env, req) {
    const token = bearer(req);
    if (!token) return null;
    const sub = await redisCommand(env, ['GET', 'fpass:session:' + token]);
    if (!sub || typeof sub !== 'string') return null;
    return readUser(env, sub);
}

export async function loginGoogle(env, body) {
    const profile = await verifyGoogle(env, body && body.credential);
    const guest = body && body.guest && typeof body.guest === 'object' ? body.guest : {};
    const guestLib = guest.library && typeof guest.library === 'object' ? guest.library : {};
    let user = await readUser(env, profile.sub);
    /* Mã quỹ nhóm của người khác: tài khoản vẫn có mã riêng, nhưng máy này giữ mã nhóm để trừ lượt chung. */
    const guestCode = cleanCode(guest.fundCode);
    const guestOwner = guestCode ? await fundOwner(env, guestCode) : '';
    const sharedCode = guestOwner && guestOwner !== profile.sub ? guestCode : '';
    if (!user) {
        user = { sub: profile.sub, email: profile.email, fundCode: '', tier: '', proUntil: 0 };
    }
    user.email = profile.email || user.email;
    user.fundCode = await pickFund(env, user.fundCode, guest.fundCode, user.sub);
    if (!user.fundCode) user.fundCode = mintFund();
    await claimFund(env, user.fundCode, user);
    const proOn = user.tier === 'OBSIDIAN_PRO' && (user.proUntil === -1 || user.proUntil > Date.now());
    if (proOn && user.fundCode) {
        await redisCommand(env, ['HSET', 'fpass:quota:' + user.fundCode, 'pro', '1', 'proUntil', String(user.proUntil)]);
    }
    const cloud = await readLib(env, user.sub);
    const library = {
        items: mergeItems(cloud.items, guestLib.items),
        progress: mergeProgress(cloud.progress, guestLib.progress),
        votes: mergeVotes(cloud.votes, guestLib.votes)
    };
    await writeLib(env, user.sub, library);
    await redisCommand(env, [
        'HSET', 'fpass:user:' + user.sub,
        'sub', user.sub,
        'email', user.email,
        'fundCode', user.fundCode,
        'tier', user.tier || '',
        'proUntil', String(user.proUntil || 0)
    ]);
    if (user.email) await redisCommand(env, ['SET', 'fpass:usermail:' + user.email, user.sub]);
    const token = randomToken(32);
    await redisCommand(env, ['SET', 'fpass:session:' + token, user.sub, 'EX', String(SESSION_TTL)]);
    const fund = user.fundCode ? await fundState(env, user.fundCode).catch(() => null) : null;
    return { token, user: publicUser(user, fund ? { code: user.fundCode } : null), library, fundCode: user.fundCode, spendCode: sharedCode, proUntil: fund ? fund.proUntil : (user.proUntil || 0) };
}

/* Trước khi hiện mã QR: phải có phiên Google còn hạn. Trả về mã quỹ của tài khoản để nội dung chuyển khoản luôn là mã của người đó. */
export async function payAccount(env, req, body) {
    const user = await userFromSession(env, req);
    if (!user) bad('auth', 'Cần đăng nhập Google trước khi thanh toán.');
    let code = cleanCode(user.fundCode);
    if (!code || (await fundOwner(env, code) || user.sub) !== user.sub) {
        code = await pickFund(env, '', body && body.fundCode, user.sub);
        if (!code) code = mintFund();
        await redisCommand(env, ['HSET', 'fpass:user:' + user.sub, 'fundCode', code]);
    }
    await claimFund(env, code, user);
    /* Máy đang dùng mã nhóm của người khác: lượt mua vẫn cộng vào mã riêng, báo để người mua biết. */
    const asked = cleanCode(body && body.fundCode);
    const askedOwner = asked && asked !== code ? await fundOwner(env, asked) : '';
    const sharedCode = askedOwner && askedOwner !== user.sub ? asked : '';
    return { fundCode: code, email: user.email, sharedCode };
}

export async function currentAccount(env, req) {
    const user = await userFromSession(env, req);
    if (!user) bad('auth', 'Cần đăng nhập Google.');
    const fund = user.fundCode ? await fundState(env, user.fundCode).catch(() => null) : null;
    const library = await readLib(env, user.sub);
    return { user: publicUser(user, fund ? { code: user.fundCode } : null), library, fundCode: user.fundCode, proUntil: fund ? fund.proUntil : 0 };
}

const REDEEM = `
local gift = KEYS[1]
local redeemed = KEYS[2]
local userKey = KEYS[3]
local quotaKey = KEYS[4]
local uid = ARGV[1]
local email = ARGV[2]
local now = tonumber(ARGV[3])
if redis.call('HEXISTS', gift, 'code') == 0 then return 'missing' end
if redis.call('HGET', gift, 'active') ~= '1' then return 'off' end
local maxUses = tonumber(redis.call('HGET', gift, 'max') or '0') or 0
local used = tonumber(redis.call('HGET', gift, 'used') or '0') or 0
if maxUses > 0 and used >= maxUses then return 'full' end
if redis.call('SISMEMBER', redeemed, uid) == 1 then return 'again' end
redis.call('SADD', redeemed, uid)
redis.call('HINCRBY', gift, 'used', 1)
local days = tonumber(redis.call('HGET', gift, 'days') or '-1') or -1
local untilAt = -1
if days > 0 then untilAt = now + days * 86400000 end
redis.call('HSET', userKey, 'tier', 'OBSIDIAN_PRO', 'proUntil', tostring(untilAt), 'email', email)
if quotaKey ~= '' then redis.call('HSET', quotaKey, 'pro', '1', 'proUntil', tostring(untilAt)) end
return 'ok:' .. tostring(untilAt)
`;

async function redeemAllowed(env, key, limit) {
    const n = Number(await redisCommand(env, ['INCR', key]));
    if (n === 1) await redisCommand(env, ['EXPIRE', key, 900]);
    return n <= limit;
}

export async function redeemGift(env, req, body, ip) {
    const user = await userFromSession(env, req);
    if (!user) bad('auth', 'Cần đăng nhập Google trước khi nhập mã.');
    /* Chặn dò mã quà: tối đa 10 lần thử mỗi tài khoản và 30 lần mỗi IP trong 15 phút. */
    const userOk = await redeemAllowed(env, 'fpass:redeem:user:' + user.sub, 10);
    const ipOk = await redeemAllowed(env, 'fpass:redeem:ip:' + String(ip || 'unknown').slice(0, 64), 30);
    if (!userOk || !ipOk) bad('rate', 'Nhập mã quá nhiều lần. Chờ 15 phút rồi thử lại.');
    const code = giftCodeOf(body && body.code);
    if (code.length < 4) bad('bad-gift', 'Mã không hợp lệ.');
    user.fundCode = await pickFund(env, user.fundCode, body && body.fundCode, user.sub);
    if (!user.fundCode) bad('bad-code', 'Máy này chưa có mã quỹ để gắn gói PRO.');
    await redisCommand(env, ['HSET', 'fpass:user:' + user.sub, 'fundCode', user.fundCode]);
    const row = await redisCommand(env, [
        'EVAL', REDEEM, 4,
        'fpass:gift:' + code,
        'fpass:giftred:' + code,
        'fpass:user:' + user.sub,
        'fpass:quota:' + user.fundCode,
        user.sub,
        user.email,
        String(Date.now())
    ]);
    const flag = String(row || '');
    if (flag === 'missing') bad('missing-gift', 'Không có mã này.');
    if (flag === 'off') bad('inactive-gift', 'Mã này đang tắt.');
    if (flag === 'full') bad('full-gift', 'Mã này đã đủ số người.');
    if (flag === 'again') bad('used-gift', 'Tài khoản này đã dùng mã này rồi.');
    if (flag.indexOf('ok:') !== 0) bad('redis', 'Chưa kích hoạt được mã.');
    const until = Number(flag.slice(3));
    return { ok: true, tier: 'OBSIDIAN_PRO', proUntil: Number.isFinite(until) ? until : -1, fundCode: user.fundCode };
}

export async function listGifts(env) {
    const codes = await redisCommand(env, ['SMEMBERS', 'fpass:gifts']);
    const list = Array.isArray(codes) ? codes : [];
    const gifts = [];
    for (let i = 0; i < list.length && i < 100; i++) {
        const code = giftCodeOf(list[i]);
        if (!code) continue;
        const row = pairs(await redisCommand(env, ['HGETALL', 'fpass:gift:' + code]));
        if (!row.code) continue;
        const members = await redisCommand(env, ['SMEMBERS', 'fpass:giftred:' + code]);
        const ids = Array.isArray(members) ? members.slice(0, 40) : [];
        const emails = [];
        for (let n = 0; n < ids.length; n++) {
            const email = await redisCommand(env, ['HGET', 'fpass:user:' + ids[n], 'email']);
            if (typeof email === 'string' && email) emails.push(email);
        }
        gifts.push({
            code,
            tier: 'OBSIDIAN_PRO',
            durationDays: Math.floor(Number(row.days) || -1),
            maxUses: Math.max(0, Math.floor(Number(row.max) || 0)),
            usedCount: Math.max(0, Math.floor(Number(row.used) || 0)),
            active: row.active === '1',
            emails
        });
    }
    gifts.sort((a, b) => a.code.localeCompare(b.code));
    return gifts;
}

export async function createGift(env, body) {
    let code = giftCodeOf(body && body.code);
    if (!code) code = randomGift();
    if (code.length < 4) bad('bad-gift', 'Mã cần từ 4 ký tự.');
    const exists = await redisCommand(env, ['HEXISTS', 'fpass:gift:' + code, 'code']);
    if (Number(exists) === 1) bad('exists', 'Mã này đã có.');
    const lifetime = !body || body.lifetime === true || body.durationDays == null || body.durationDays === '' || Number(body.durationDays) < 0;
    const days = lifetime ? -1 : Math.max(1, Math.min(3650, Math.floor(Number(body.durationDays) || 0)));
    const maxUses = Math.max(1, Math.min(100000, Math.floor(Number(body && body.maxUses) || 20)));
    await redisCommand(env, [
        'HSET', 'fpass:gift:' + code,
        'code', code,
        'tier', 'OBSIDIAN_PRO',
        'days', String(days),
        'max', String(maxUses),
        'used', '0',
        'active', '1'
    ]);
    await redisCommand(env, ['SADD', 'fpass:gifts', code]);
    return { code, durationDays: days, maxUses, usedCount: 0, active: true, tier: 'OBSIDIAN_PRO', emails: [] };
}

export async function toggleGift(env, body) {
    const code = giftCodeOf(body && body.code);
    if (code.length < 4) bad('bad-gift', 'Mã không hợp lệ.');
    const exists = await redisCommand(env, ['HEXISTS', 'fpass:gift:' + code, 'code']);
    if (Number(exists) !== 1) bad('missing-gift', 'Không có mã này.');
    const active = body && body.active === false ? '0' : '1';
    await redisCommand(env, ['HSET', 'fpass:gift:' + code, 'active', active]);
    return { code, active: active === '1' };
}
