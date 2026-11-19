/**
 * Phiên admin nằm trên Redis, hết hạn sau 12 giờ.
 * Trình duyệt chỉ giữ mã phiên trong cookie HttpOnly, JavaScript trên trang không đọc được.
 * Không có mật khẩu dự phòng: thiếu ADMIN_PASSWORD (hoặc quá ngắn) thì trang quản trị đóng.
 */

import { envGet, redisCommand } from './ledger.js';
import { sameOrigin } from './http.js';

const SESSION_TTL = 60 * 60 * 12;
const MIN_PASSWORD = 12;
export const ADMIN_COOKIE = 'fpass_admin';
export const ADMIN_HEADER = 'x-fpass-admin';

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
    return set.length >= MIN_PASSWORD ? set : '';
}

function cookieValue(req, name) {
    const raw = String(req.header('cookie') || '');
    const parts = raw.split(';');
    for (let i = 0; i < parts.length; i++) {
        const eq = parts[i].indexOf('=');
        if (eq < 0) continue;
        if (parts[i].slice(0, eq).trim() === name) return parts[i].slice(eq + 1).trim();
    }
    return '';
}

export function sessionToken(req) {
    const token = cookieValue(req, ADMIN_COOKIE);
    return /^[a-f0-9]{48}$/.test(token) ? token : '';
}

function secureFlag(req) {
    const url = String(req.url || '');
    return /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(url) ? '' : '; Secure';
}

export function sessionCookie(req, token) {
    return ADMIN_COOKIE + '=' + token + '; HttpOnly' + secureFlag(req) + '; SameSite=Strict; Path=/api; Max-Age=' + SESSION_TTL;
}

export function clearCookie(req) {
    return ADMIN_COOKIE + '=; HttpOnly' + secureFlag(req) + '; SameSite=Strict; Path=/api; Max-Age=0';
}

/* Request đổi dữ liệu phải đến từ chính trang và mang header riêng (trình duyệt lạ không tự gắn được). */
export function trustedWrite(req) {
    return sameOrigin(req) && req.header(ADMIN_HEADER) === '1';
}

export async function loginAdmin(env, password, ip) {
    const expected = expectedPassword(env);
    if (!expected) {
        const err = new Error('no-admin');
        err.code = 'no-admin';
        throw err;
    }
    const failKey = 'fpass:admin:fail:' + (ip || 'unknown');
    const prev = Number(await redisCommand(env, ['GET', failKey])) || 0;
    if (prev >= 8) {
        const err = new Error('locked');
        err.code = 'locked';
        throw err;
    }
    const given = String(password || '').slice(0, 200);
    if (!safeEqual(given, expected)) {
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
    const token = sessionToken(req);
    if (!token) return '';
    const hit = await redisCommand(env, ['GET', 'fpass:admin:sess:' + token]);
    return hit ? token : '';
}

export async function logoutAdmin(env, token) {
    if (!token) return;
    await redisCommand(env, ['DEL', 'fpass:admin:sess:' + token]);
}
