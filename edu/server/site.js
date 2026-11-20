/**
 * Cài đặt hiển thị chung của trang: danh sách video hướng dẫn.
 * Lưu ở fpass:site:guide. Admin sửa trong trang quản trị, trang chủ và /app đọc qua GET /api/exams?only=guide.
 */

import { redisCommand } from './ledger.js';

const KEY = 'fpass:site:guide';
const MAX_VIDEOS = 8;

function clip(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

function bad(message) {
    const err = new Error(message);
    err.code = 'bad-exam';
    return err;
}

/* Chỉ nhận link https của nơi trang nhúng được (khớp CSP frame-src và media-src). */
const ALLOWED = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be|(?:www\.|vt\.|vm\.)?tiktok\.com|drive\.google\.com)\/|^https:\/\/[^\s"'<>]+\.(?:mp4|webm)(?:\?[^\s"'<>]*)?$/i;

export function cleanGuide(input) {
    const list = Array.isArray(input && input.videos) ? input.videos : [];
    const videos = [];
    list.slice(0, MAX_VIDEOS).forEach((row, i) => {
        const url = clip(row && row.url, 400);
        if (!url) return;
        if (!ALLOWED.test(url)) throw bad('Video ' + (i + 1) + ': chỉ nhận link YouTube, TikTok, Google Drive hoặc file .mp4/.webm (https).');
        videos.push({ title: clip(row && row.title, 60) || ('Video ' + (videos.length + 1)), url });
    });
    return { videos };
}

export async function readGuide(env) {
    const raw = await redisCommand(env, ['GET', KEY]);
    if (!raw || typeof raw !== 'string') return { videos: [] };
    try {
        return cleanGuide(JSON.parse(raw));
    } catch (e) {
        return { videos: [] };
    }
}

export async function saveGuide(env, input) {
    const guide = cleanGuide(input);
    await redisCommand(env, ['SET', KEY, JSON.stringify(Object.assign({ updated: Date.now() }, guide))]);
    return guide;
}
