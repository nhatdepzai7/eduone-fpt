import { DEFAULT_IDENTITY_LINE, IDENTITIES, MIN_ANSWERS, OBSIDIAN_IDENTITY, RANK_THRESHOLDS, VOTE_TYPES } from './identity-config.js?v=ielts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WALK = 3660;

export function dayKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return d.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
}

function parseDay(key) {
    const parts = String(key || '').split('-');
    if (parts.length !== 3) return null;
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function shiftDay(key, delta) {
    const d = parseDay(key);
    if (!d) return '';
    d.setDate(d.getDate() + delta);
    return dayKey(d);
}

export function isVoteType(type) {
    return VOTE_TYPES.indexOf(type) >= 0;
}

export function identityLine(name) {
    const found = IDENTITIES.find((item) => item && item.name === name);
    return found ? found.line : DEFAULT_IDENTITY_LINE;
}

export function meetsAnswerThreshold(count) {
    return typeof count === 'number' && isFinite(count) && count >= MIN_ANSWERS;
}

/* eosMock: bài thi thử EOS nộp hợp lệ (app chỉ gửi khi đã trả lời ít nhất nửa đề) tính như 1 ca, gửi kèm slot: true.
   Phiên của một ca học (slot: true) thành phiếu chỉ cần ít nhất 1 thẻ: "Chạm đáy 30s" giữ thói quen bằng 2 thẻ,
   theo quy tắc 2 phút của Atomic Habits. Phiên tự do vẫn cần MIN_ANSWERS. */
export function planVote(input, now) {
    if (!input || !isVoteType(input.type)) return null;
    const lean = Number(input.lean) || 0;
    const enough = input.slot
        ? (typeof input.answered === 'number' && input.answered >= 1)
        : lean > 0 ? (typeof input.answered === 'number' && input.answered >= Math.min(lean, MIN_ANSWERS)) : meetsAnswerThreshold(input.answered);
    if (!enough) return null;
    if (input.sessionId == null || input.sessionId === '') return null;
    const at = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    if (isNaN(at.getTime())) return null;
    const sessionId = String(input.sessionId);
    return {
        id: 'iv-' + sessionId,
        date: dayKey(at),
        type: input.type,
        sessionId: sessionId,
        createdAt: at.getTime()
    };
}

export function hasSession(votes, sessionId) {
    const id = String(sessionId);
    return (votes || []).some((v) => v && String(v.sessionId) === id);
}

function datesOf(votes) {
    const set = new Set();
    (votes || []).forEach((v) => {
        const key = typeof v === 'string' ? v : (v && v.date);
        if (DAY.test(key)) set.add(key);
    });
    return set;
}

export function tally(votes, today) {
    const counts = {};
    let total = 0;
    (votes || []).forEach((v) => {
        if (!v || !DAY.test(v.date)) return;
        total += 1;
        counts[v.date] = (counts[v.date] || 0) + 1;
    });
    return { total: total, todayCount: counts[today] || 0, counts: counts };
}

export function lastDays(votes, today, n) {
    const span = n || 7;
    const { counts } = tally(votes, today);
    const out = [];
    for (let i = span - 1; i >= 0; i -= 1) {
        const date = shiftDay(today, -i);
        const count = counts[date] || 0;
        out.push({ date: date, count: count, on: count > 0 });
    }
    return out;
}

export function rankOf(total, thresholds) {
    const steps = (thresholds || RANK_THRESHOLDS).slice().sort((a, b) => a - b);
    const n = Math.max(0, total || 0);
    let index = 0;
    steps.forEach((step, i) => { if (n >= step) index = i; });
    const min = steps[index];
    const next = index + 1 < steps.length ? steps[index + 1] : null;
    const span = next == null ? 0 : next - min;
    const into = next == null ? n - min : n - min;
    const progress = next == null ? 1 : (span === 0 ? 1 : into / span);
    return {
        index: index,
        level: index + 1,
        min: min,
        next: next,
        into: into,
        span: span,
        remaining: next == null ? 0 : next - n,
        progress: progress
    };
}

/* Chuỗi đếm số ngày có phiếu trong mạch hiện tại.
   Hôm nay còn mở: chưa có phiếu hôm nay không tính là một ngày đã bỏ lỡ.
   Một ngày trống nằm giữa hai ngày có phiếu không làm gãy chuỗi.
   Hai ngày trống liền nhau thì mạch cũ dừng, không cộng các phiếu phía trước khoảng trống đó. */
export function streakOf(votes, today) {
    if (!DAY.test(today)) return 0;
    const set = datesOf(votes);
    let cursor = shiftDay(today, -1);
    let emptyRun = 0;
    let voted = 0;
    for (let i = 0; i < MAX_WALK; i += 1) {
        if (set.has(cursor)) {
            voted += 1;
            emptyRun = 0;
        } else {
            emptyRun += 1;
            if (emptyRun >= 2) break;
        }
        cursor = shiftDay(cursor, -1);
    }
    if (set.has(today)) voted += 1;
    return voted;
}

export function summarize(votes, today) {
    const bag = tally(votes, today);
    const yesterday = shiftDay(today, -1);
    const votedYesterday = (bag.counts[yesterday] || 0) > 0;
    const streak = streakOf(votes, today);
    const confirmedToday = bag.todayCount >= 1;
    return {
        total: bag.total,
        todayCount: bag.todayCount,
        confirmedToday: confirmedToday,
        votedYesterday: votedYesterday,
        missedOnce: !confirmedToday && !votedYesterday && streak > 0,
        last7: lastDays(votes, today, 7),
        rank: rankOf(bag.total),
        streak: streak
    };
}

const api = {
    RANK_THRESHOLDS: RANK_THRESHOLDS,
    VOTE_TYPES: VOTE_TYPES,
    MIN_ANSWERS: MIN_ANSWERS,
    IDENTITIES: IDENTITIES,
    OBSIDIAN_IDENTITY: OBSIDIAN_IDENTITY,
    identityLine: identityLine,
    dayKey: dayKey,
    shiftDay: shiftDay,
    isVoteType: isVoteType,
    meetsAnswerThreshold: meetsAnswerThreshold,
    planVote: planVote,
    hasSession: hasSession,
    tally: tally,
    lastDays: lastDays,
    rankOf: rankOf,
    streakOf: streakOf,
    summarize: summarize
};

export { DEFAULT_IDENTITY_LINE, IDENTITIES, MIN_ANSWERS, OBSIDIAN_IDENTITY, RANK_THRESHOLDS, VOTE_TYPES };

if (typeof window !== 'undefined') {
    const root = window.EDU = window.EDU || {};
    root.Identity = api;
}
