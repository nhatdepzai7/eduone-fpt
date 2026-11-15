/**
 * Phiên admin nằm trên Redis, hết hạn sau 12 giờ.
 * ADMIN_PASSWORD trên Vercel thay mật khẩu tạm dùng khi biến chưa được đặt.
 */

import { envGet, redisCommand } from './ledger.js';

const FALLBACK_PASSWORD = 'nhatadmin2026';
const SESSION_TTL = 60 * 60 * 12;

function safeEqual(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (left.length !== right.length) return false;
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
}

export function expectedPassword(env) {
    const set = envGet(env, 'ADMIN_PASSWORD').trim();
    return set || FALLBACK_PASSWORD;
}

export function bearer(req) {
    const header = String(req.header('authorization') || '');
    const match = header.match(/^Bearer\s+([A-Za-z0-9]{32,80})$/);
    return match ? match[1] : '';
}

export async function loginAdmin(env, password, ip) {
    const failKey = 'fpass:admin:fail:' + (ip || 'unknown');
    const prev = Number(await redisCommand(env, ['GET', failKey])) || 0;
    if (prev >= 8) {
        const err = new Error('locked');
        err.code = 'locked';
        throw err;
    }
    const given = String(password || '').slice(0, 200);
    if (!safeEqual(given, expectedPassword(env))) {
        const n = Number(await redisCommand(env, ['INCR', failKey]));
        if (n === 1) await redisCommand(env, ['EXPIRE', failKey, 900]);
        const err = new Error('bad-password');
        err.code = 'bad-password';
        throw err;
    }
    await redisCommand(env, ['DEL', failKey]);
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    await redisCommand(env, ['SET', 'fpass:admin:sess:' + token, '1', 'EX', String(SESSION_TTL)]);
    return { token, expiresIn: SESSION_TTL };
}

export async function requireAdmin(req, env) {
    const token = bearer(req);
    if (!token) return '';
    const hit = await redisCommand(env, ['GET', 'fpass:admin:sess:' + token]);
    return hit ? token : '';
}

export async function logoutAdmin(env, token) {
    if (!token) return;
    await redisCommand(env, ['DEL', 'fpass:admin:sess:' + token]);
}
