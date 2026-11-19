/**
 * Kho đề trên Redis.
 * Chính thức: fpass:exams + fpass:exam:{id}
 * Chờ duyệt: fpass:pending + fpass:pending:{id}
 */

import { cleanCode, redisCommand } from './ledger.js';

const SUBJECTS = {
    eos: { label: 'EOS', type: 'mcq' },
    fe: { label: 'FE', type: 'mcq' },
    pt: { label: 'PT', type: 'mcq' },
    vocab: { label: 'Từ vựng', type: 'vocab' },
    other: { label: 'Khác', type: 'mcq' }
};

/* Đề admin đăng (kể cả từ file Word song ngữ) được lớn hơn đề sinh viên gửi chờ duyệt. */
const LIMITS = {
    official: { items: 400, json: 1000000 },
    pending: { items: 120, json: 350000 }
};
const MAX_OFFICIAL = 25;
const MAX_PENDING = 40;
export const OFFICIAL_BODY = 1200000;

export function subjectOf(value) {
    const key = String(value || '').toLowerCase();
    return SUBJECTS[key] ? key : 'other';
}

function clip(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function bad(message) {
    const err = new Error(message);
    err.code = 'bad-exam';
    return err;
}

function cleanOptions(raw) {
    if (Array.isArray(raw)) return raw.slice(0, 4).map((o) => clip(o, 500));
    if (raw && typeof raw === 'object') return ['A', 'B', 'C', 'D'].map((letter) => clip(raw[letter] || raw[letter.toLowerCase()], 500));
    return [];
}

/* Bỏ trường rỗng để bộ đề song ngữ nhỏ gọn khi lưu và tải về. */
function compact(item) {
    const out = {};
    Object.keys(item).forEach((key) => {
        const v = item[key];
        if (v === '' || v == null) return;
        if (Array.isArray(v) && (!v.length || (key === 'optionsVi' && !v.some(Boolean)))) {
            if (key === 'options' || key === 'keywords') out[key] = v;
            return;
        }
        out[key] = v;
    });
    return out;
}

function cleanItem(raw, group) {
    const d = raw && typeof raw === 'object' ? raw : {};
    let options = cleanOptions(d.options || d.o || d.choices);
    const filled = options.filter(Boolean).length;
    let type = d.type === 'vocab' || d.type === 'mcq' ? d.type : (filled >= 2 ? 'mcq' : 'vocab');
    if (type === 'mcq' && filled < 2) type = 'vocab';
    const question = clip(d.questionOrWord || d.question || d.word || d.q || d.tu, type === 'mcq' ? 1500 : 400);
    if (!question) return null;
    let answer = d.answerOrMeaning != null ? d.answerOrMeaning : (d.answer != null ? d.answer : (d.meaning != null ? d.meaning : (d.a != null ? d.a : d.nghia)));
    if (type === 'mcq') {
        const text = clip(answer, 500);
        const letter = text.toUpperCase().match(/^([A-D])/);
        if (letter) answer = letter[1];
        else {
            const idx = options.findIndex((o) => o && o.toLowerCase() === text.toLowerCase());
            answer = idx >= 0 ? 'ABCD'[idx] : '';
        }
        if (!answer) return null;
        while (options.length < 4) options.push('');
        options = options.slice(0, 4);
        if (!options['ABCD'.indexOf(answer)]) return null;
    } else {
        answer = clip(answer, 1500);
        if (!answer) return null;
        options = [];
    }
    let keywords = d.keywords || d.k || [];
    if (typeof keywords === 'string') keywords = keywords.split(/[,;|\n]/);
    if (!Array.isArray(keywords)) keywords = [];
    let optionsVi = type === 'mcq' ? cleanOptions(d.optionsVi) : [];
    if (optionsVi.some(Boolean)) { while (optionsVi.length < 4) optionsVi.push(''); } else optionsVi = [];
    return compact({
        type,
        ref: clip(d.ref, 40),
        group: clip(d.group || group, 80),
        questionOrWord: question,
        options,
        answerOrMeaning: answer,
        explanationOrExample: clip(d.explanationOrExample || d.explanation || d.example || d.e, 2500),
        keywords: keywords.map((k) => clip(k, 80)).filter((k) => k.length >= 2).slice(0, 24),
        questionVi: clip(d.questionVi, 1500),
        optionsVi,
        explanationVi: clip(d.explanationVi, 2500),
        wordType: clip(d.wordType, 24),
        ipa: clip(d.ipa, 80),
        exampleVi: clip(d.exampleVi, 1500)
    });
}

function itemsFromStages(stages, group) {
    const out = [];
    ['1', '2', '3'].forEach((n) => {
        const list = stages[n] || stages[Number(n)] || [];
        if (!Array.isArray(list)) return;
        list.forEach((row) => {
            const item = cleanItem(row, group);
            if (item) out.push(item);
        });
    });
    return out;
}

function itemsFromData(data, group) {
    if (Array.isArray(data)) return data.map((row) => cleanItem(row, group)).filter(Boolean);
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.items)) return data.items.map((row) => cleanItem(row, group)).filter(Boolean);
    if (data.stages && typeof data.stages === 'object') return itemsFromStages(data.stages, group);
    return [];
}

const OPT_LINE = /^\s*\(?([A-Da-d])[.):]\s*(.+)$/;
const ANS_LINE = /^\s*(?:đáp án|dap an|answer|ans|đa|key)\s*[:\-=]?\s*\(?([A-Da-d])\)?/i;
const Q_HEAD = /^\s*(?:câu|cau|question|q)?\s*\d{1,4}\s*[.):\-]\s*/i;

function parseMcqBlock(lines) {
    const opts = [];
    let answer = '';
    let explanation = '';
    const question = [];
    lines.forEach((line) => {
        const ans = line.match(ANS_LINE);
        if (ans) { answer = ans[1].toUpperCase(); return; }
        const ex = line.match(/^\s*(?:giải thích|giai thich|explanation|gt)\s*[:\-]\s*(.+)$/i);
        if (ex) { explanation = ex[1]; return; }
        const opt = line.match(OPT_LINE);
        if (opt && opts.length < 4 && question.length) { opts.push(opt[2].trim()); return; }
        if (!opts.length) question.push(line.replace(Q_HEAD, ''));
    });
    if (opts.length < 2 || !question.join(' ').trim()) return null;
    return cleanItem({ type: 'mcq', question: question.join(' ').trim(), options: opts, answer, explanation }, '');
}

function parseVocabLine(line) {
    const text = line.replace(/^\s*(?:[-•*]|\d{1,4}[.)])\s*/, '').trim();
    if (!text) return null;
    const parts = text.split(/\t|\s+[-–—=:|]\s+|\s*[:=|]\s+/);
    const left = (parts[0] || '').trim();
    const right = parts.slice(1).join(' - ').trim();
    if (!left || !right) return null;
    return cleanItem({ type: 'vocab', word: left, meaning: right }, '');
}

function itemsFromText(text, subject) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let block = [];
    const flush = () => {
        if (!block.length) return;
        const hasOpts = block.filter((line) => OPT_LINE.test(line)).length >= 2;
        if (hasOpts) {
            const item = parseMcqBlock(block);
            if (item) out.push(item);
        } else if (subject === 'vocab') {
            block.forEach((line) => { const item = parseVocabLine(line); if (item) out.push(item); });
        }
        block = [];
    };
    lines.forEach((line) => {
        if (!line.trim()) { flush(); return; }
        if (Q_HEAD.test(line) && block.some((row) => OPT_LINE.test(row))) flush();
        block.push(line);
    });
    flush();
    return out;
}

export function parseExamInput(text, subject, group, kind) {
    const limit = LIMITS[kind] || LIMITS.pending;
    const raw = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!raw) throw bad('Chưa có nội dung đề.');
    if (raw.length > limit.json) throw bad('Nội dung đề quá lớn.');
    let items = [];
    if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
        let data;
        try { data = JSON.parse(raw); } catch (e) { throw bad('JSON không hợp lệ.'); }
        items = itemsFromData(data, group);
    } else {
        items = itemsFromText(raw, subject);
    }
    items = items.slice(0, limit.items);
    if (!items.length) throw bad('Không đọc được câu hỏi. Dùng JSON có items, file mẫu stages, hoặc mỗi câu có A. B. C. D. và Đáp án.');
    return items;
}

function examId() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return 'sys' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeId(value) {
    const id = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
    return /^sys[a-z0-9]{8,20}$/.test(id) ? id : '';
}

function courseCode(value, fallback) {
    const code = String(value || '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    return code.length >= 2 ? code : fallback;
}

function packRecord(input, items, id, kind) {
    const subject = subjectOf(input.subject);
    const type = subject === 'vocab' ? 'vocab' : (items.some((item) => item.type === 'mcq') ? 'mcq' : 'vocab');
    const record = {
        id,
        name: clip(input.name, 80) || 'Đề hệ thống',
        code: courseCode(input.code, SUBJECTS[subject].label),
        subject,
        type,
        desc: clip(input.desc, 180) || ('Đề ' + SUBJECTS[subject].label + ' do admin đăng.'),
        updated: Date.now(),
        count: items.length,
        items
    };
    const json = JSON.stringify(record);
    if (json.length > (LIMITS[kind] || LIMITS.pending).json) throw bad('Bộ đề quá lớn.');
    return { record, json };
}

function call(env, args) {
    return redisCommand(env, args);
}

export async function listOfficial(env) {
    const rawIds = await call(env, ['SMEMBERS', 'fpass:exams']);
    const ids = (Array.isArray(rawIds) ? rawIds : []).filter((id) => safeId(id));
    const packs = [];
    for (let i = 0; i < ids.length && packs.length < MAX_OFFICIAL; i++) {
        const pack = await readStored(env, 'fpass:exam:', ids[i]);
        if (pack) packs.push(pack);
    }
    packs.sort((a, b) => b.updated - a.updated);
    return packs;
}

export async function listPending(env) {
    const rawIds = await call(env, ['SMEMBERS', 'fpass:pending']);
    const ids = (Array.isArray(rawIds) ? rawIds : []).filter((id) => safeId(id));
    const packs = [];
    for (let i = 0; i < ids.length && packs.length < MAX_PENDING; i++) {
        const pack = await readStored(env, 'fpass:pending:', ids[i]);
        if (pack) packs.push(pack);
    }
    packs.sort((a, b) => b.updated - a.updated);
    return packs;
}

async function readStored(env, prefix, id) {
    const raw = await call(env, ['GET', prefix + id]);
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        if (!data || data.id !== id || !Array.isArray(data.items)) return null;
        return data;
    } catch (e) {
        return null;
    }
}

export async function saveOfficial(env, input) {
    const id = safeId(input.id) || examId();
    const creating = !safeId(input.id);
    if (creating) {
        const count = Number(await call(env, ['SCARD', 'fpass:exams'])) || 0;
        if (count >= MAX_OFFICIAL) throw bad('Kho đề đã đủ 25 bộ. Xóa bớt trước khi đăng thêm.');
    } else {
        const exists = await readStored(env, 'fpass:exam:', id);
        if (!exists) {
            const err = new Error('missing');
            err.code = 'missing';
            throw err;
        }
    }
    const items = parseExamInput(input.text, subjectOf(input.subject), courseCode(input.code, ''), 'official');
    const built = packRecord(input, items, id, 'official');
    await call(env, ['SET', 'fpass:exam:' + id, built.json]);
    await call(env, ['SADD', 'fpass:exams', id]);
    return built.record;
}

export async function deleteOfficial(env, id) {
    const safe = safeId(id);
    if (!safe) throw bad('Mã đề không hợp lệ.');
    await call(env, ['DEL', 'fpass:exam:' + safe]);
    await call(env, ['SREM', 'fpass:exams', safe]);
}

export async function submitPending(env, input) {
    const count = Number(await call(env, ['SCARD', 'fpass:pending'])) || 0;
    if (count >= MAX_PENDING) {
        const err = new Error('Hàng chờ đã đầy. Admin cần duyệt bớt đề.');
        err.code = 'full';
        throw err;
    }
    const id = examId();
    const items = parseExamInput(input.text, subjectOf(input.subject), courseCode(input.code, ''), 'pending');
    const built = packRecord(input, items, id, 'pending');
    built.record.quotaId = cleanCode(input.quotaId);
    built.record.note = clip(input.note, 160);
    const json = JSON.stringify(built.record);
    if (json.length > LIMITS.pending.json) throw bad('Bộ đề quá lớn.');
    await call(env, ['SET', 'fpass:pending:' + id, json]);
    await call(env, ['SADD', 'fpass:pending', id]);
    return { id, count: items.length };
}

export async function rejectPending(env, id) {
    const safe = safeId(id);
    if (!safe) throw bad('Mã đề không hợp lệ.');
    await call(env, ['DEL', 'fpass:pending:' + safe]);
    await call(env, ['SREM', 'fpass:pending', safe]);
}

export async function takePending(env, id) {
    const safe = safeId(id);
    if (!safe) throw bad('Mã đề không hợp lệ.');
    const pack = await readStored(env, 'fpass:pending:', safe);
    if (!pack) {
        const err = new Error('missing');
        err.code = 'missing';
        throw err;
    }
    return pack;
}

export async function publishPending(env, pack) {
    const count = Number(await call(env, ['SCARD', 'fpass:exams'])) || 0;
    if (count >= MAX_OFFICIAL) throw bad('Kho đề đã đủ 25 bộ. Xóa bớt trước khi duyệt.');
    const official = {
        id: pack.id,
        name: pack.name,
        code: pack.code,
        subject: pack.subject,
        type: pack.type,
        desc: pack.desc,
        updated: Date.now(),
        count: pack.items.length,
        items: pack.items
    };
    await call(env, ['SET', 'fpass:exam:' + pack.id, JSON.stringify(official)]);
    await call(env, ['SADD', 'fpass:exams', pack.id]);
    await rejectPending(env, pack.id);
    return official;
}
