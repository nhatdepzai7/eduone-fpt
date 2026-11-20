/**
 * Kho đề trên Redis.
 * Chính thức: fpass:exams + fpass:exam:{id} (thông tin đề và thứ tự câu)
 *             + fpass:examq:{id} (hash: mỗi câu hỏi là một field, sửa từng câu không phải ghi lại cả đề)
 * Đề cũ còn mảng items trong fpass:exam:{id} vẫn đọc được; admin mở kho đề là tự chuyển sang dạng tách câu.
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
        id: questionId(d.id),
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

const QID = /^q[a-z0-9]{6,24}$/;

function questionId(value) {
    const id = String(value || '').toLowerCase();
    return QID.test(id) ? id : '';
}

let qSeq = 0;
/* Mã câu tăng dần theo thời gian tạo nên sắp theo mã là đúng thứ tự thêm vào. */
function newQuestionId() {
    qSeq = (qSeq + 1) % 1296;
    const bytes = new Uint8Array(2);
    crypto.getRandomValues(bytes);
    return 'q' + Date.now().toString(36) + qSeq.toString(36).padStart(2, '0') + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function withIds(items) {
    const seen = new Set();
    return items.map((item) => {
        let id = item.id;
        if (!id || seen.has(id)) id = newQuestionId();
        seen.add(id);
        return Object.assign({}, item, { id });
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

function examType(subject, items) {
    return subject === 'vocab' ? 'vocab' : (items.some((item) => item.type === 'mcq') ? 'mcq' : 'vocab');
}

function packRecord(input, items, id, kind) {
    const subject = subjectOf(input.subject);
    const type = examType(subject, items);
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

function pairs(result) {
    const out = {};
    const rows = Array.isArray(result) ? result : [];
    for (let i = 0; i + 1 < rows.length; i += 2) out[rows[i]] = rows[i + 1];
    return out;
}

async function readMeta(env, id) {
    const raw = await call(env, ['GET', 'fpass:exam:' + id]);
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        return data && data.id === id ? data : null;
    } catch (e) {
        return null;
    }
}

/* Thứ tự lưu trong meta có thể lệch khi hai admin thêm câu cùng lúc: câu thiếu trong thứ tự được nối vào cuối theo mã. */
async function readQuestions(env, id, meta) {
    const map = pairs(await call(env, ['HGETALL', 'fpass:examq:' + id]));
    const order = (Array.isArray(meta.order) ? meta.order : []).filter((qid) => map[qid]);
    const known = new Set(order);
    Object.keys(map).sort().forEach((qid) => { if (!known.has(qid)) order.push(qid); });
    const items = [];
    order.forEach((qid) => {
        try {
            const item = JSON.parse(map[qid]);
            if (item && typeof item === 'object') items.push(Object.assign(item, { id: qid }));
        } catch (e) {}
    });
    return items;
}

function publicExam(meta, items) {
    return {
        id: meta.id,
        name: meta.name,
        code: meta.code,
        subject: meta.subject,
        type: meta.type,
        desc: meta.desc,
        updated: meta.updated,
        count: items.length,
        items
    };
}

/* Đề dạng cũ chưa có mã câu: gán mã theo vị trí để tiến độ học không đổi giữa các lần tải. */
async function readOfficial(env, id) {
    const meta = await readMeta(env, id);
    if (!meta) return null;
    if (Array.isArray(meta.items)) {
        const items = meta.items.map((item, i) => Object.assign({}, item, { id: questionId(item.id) || (id + '-' + i) }));
        return Object.assign(publicExam(meta, items), { legacy: true });
    }
    return publicExam(meta, await readQuestions(env, id, meta));
}

async function writeQuestions(env, id, items, fresh) {
    if (fresh) await call(env, ['DEL', 'fpass:examq:' + id]);
    for (let i = 0; i < items.length; i += 80) {
        const args = ['HSET', 'fpass:examq:' + id];
        items.slice(i, i + 80).forEach((item) => {
            const body = Object.assign({}, item);
            delete body.id;
            args.push(item.id, JSON.stringify(body));
        });
        if (args.length > 2) await call(env, args);
    }
}

async function writeMeta(env, meta, items) {
    const record = {
        id: meta.id,
        name: meta.name,
        code: meta.code,
        subject: meta.subject,
        type: examType(meta.subject, items),
        desc: meta.desc,
        updated: Date.now(),
        count: items.length,
        order: items.map((item) => item.id)
    };
    await call(env, ['SET', 'fpass:exam:' + meta.id, JSON.stringify(record)]);
    return record;
}

async function storeExam(env, meta, items) {
    const list = withIds(items);
    if (JSON.stringify(list).length > LIMITS.official.json) throw bad('Bộ đề quá lớn.');
    await writeQuestions(env, meta.id, list, true);
    const record = await writeMeta(env, meta, list);
    await call(env, ['SADD', 'fpass:exams', meta.id]);
    return publicExam(record, list);
}

function legacyItems(meta) {
    return meta.items.map((item) => Object.assign({}, item, { id: questionId(item.id) }));
}

export async function listOfficial(env) {
    const rawIds = await call(env, ['SMEMBERS', 'fpass:exams']);
    const ids = (Array.isArray(rawIds) ? rawIds : []).filter((id) => safeId(id));
    const packs = [];
    for (let i = 0; i < ids.length && packs.length < MAX_OFFICIAL; i++) {
        const pack = await readOfficial(env, ids[i]);
        if (pack) {
            delete pack.legacy;
            packs.push(pack);
        }
    }
    packs.sort((a, b) => b.updated - a.updated);
    return packs;
}

/* Cho trang quản trị: chuyển đề dạng cũ sang dạng tách câu trước khi trả về, để mã câu admin thấy là mã thật. */
export async function listOfficialForAdmin(env) {
    const rawIds = await call(env, ['SMEMBERS', 'fpass:exams']);
    const ids = (Array.isArray(rawIds) ? rawIds : []).filter((id) => safeId(id));
    const packs = [];
    for (let i = 0; i < ids.length && packs.length < MAX_OFFICIAL; i++) {
        let pack = await readOfficial(env, ids[i]);
        if (!pack) continue;
        if (pack.legacy) {
            const meta = await readMeta(env, ids[i]);
            pack = await storeExam(env, meta, legacyItems(meta));
        }
        packs.push(pack);
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
        const exists = await readMeta(env, id);
        if (!exists) throw missing();
        /* Sửa tên, mã môn, mô tả mà không gửi lại nội dung: giữ nguyên từng câu đã sửa lẻ. */
        if (!String(input.text || '').trim()) {
            const current = await readOfficial(env, id);
            return storeExam(env, metaFrom(input, id), current.items.map((item) => Object.assign({}, item, { id: questionId(item.id) })));
        }
    }
    const items = parseExamInput(input.text, subjectOf(input.subject), courseCode(input.code, ''), 'official');
    return storeExam(env, metaFrom(input, id), items);
}

function missing(what) {
    const err = new Error(what || 'missing');
    err.code = 'missing';
    return err;
}

function metaFrom(input, id) {
    const subject = subjectOf(input.subject);
    return {
        id,
        name: clip(input.name, 80) || 'Đề hệ thống',
        code: courseCode(input.code, SUBJECTS[subject].label),
        subject,
        desc: clip(input.desc, 180) || ('Đề ' + SUBJECTS[subject].label + ' do admin đăng.')
    };
}

export async function deleteOfficial(env, id) {
    const safe = safeId(id);
    if (!safe) throw bad('Mã đề không hợp lệ.');
    await call(env, ['DEL', 'fpass:exam:' + safe]);
    await call(env, ['DEL', 'fpass:examq:' + safe]);
    await call(env, ['SREM', 'fpass:exams', safe]);
}

/* ---------- Ngân hàng câu hỏi: thêm, sửa, xóa từng câu ---------- */

async function editableExam(env, examId) {
    const id = safeId(examId);
    if (!id) throw bad('Mã đề không hợp lệ.');
    const meta = await readMeta(env, id);
    if (!meta) throw missing();
    if (Array.isArray(meta.items)) {
        const stored = await storeExam(env, meta, legacyItems(meta));
        return { meta: await readMeta(env, id), items: stored.items };
    }
    return { meta, items: await readQuestions(env, id, meta) };
}

export async function saveQuestion(env, examId, raw) {
    const { meta, items } = await editableExam(env, examId);
    const item = cleanItem(raw, meta.code);
    if (!item) throw bad('Câu hỏi cần nội dung, ít nhất 2 lựa chọn và một đáp án đúng trỏ vào lựa chọn có chữ.');
    const qid = questionId(raw && raw.id);
    const index = qid ? items.findIndex((row) => row.id === qid) : -1;
    if (qid && index < 0) throw missing('Câu này đã bị xóa.');
    if (index < 0 && items.length >= LIMITS.official.items) throw bad('Đề đã đủ ' + LIMITS.official.items + ' câu.');
    item.id = index >= 0 ? qid : newQuestionId();
    const next = items.slice();
    if (index >= 0) next[index] = item;
    else next.push(item);
    if (JSON.stringify(next).length > LIMITS.official.json) throw bad('Bộ đề quá lớn.');
    await writeQuestions(env, meta.id, [item], false);
    await writeMeta(env, meta, next);
    return { item, count: next.length };
}

export async function addQuestions(env, examId, list) {
    const { meta, items } = await editableExam(env, examId);
    const incoming = (Array.isArray(list) ? list : []).slice(0, LIMITS.official.items).map((row) => cleanItem(Object.assign({}, row, { id: '' }), meta.code)).filter(Boolean);
    if (!incoming.length) throw bad('Không có câu hợp lệ để thêm.');
    if (items.length + incoming.length > LIMITS.official.items) throw bad('Thêm vào sẽ vượt ' + LIMITS.official.items + ' câu mỗi đề.');
    const added = incoming.map((item) => Object.assign(item, { id: newQuestionId() }));
    const next = items.concat(added);
    if (JSON.stringify(next).length > LIMITS.official.json) throw bad('Bộ đề quá lớn.');
    await writeQuestions(env, meta.id, added, false);
    await writeMeta(env, meta, next);
    return { added: added.length, count: next.length };
}

export async function deleteQuestion(env, examId, qidValue) {
    const qid = questionId(qidValue);
    if (!qid) throw bad('Mã câu không hợp lệ.');
    const { meta, items } = await editableExam(env, examId);
    const next = items.filter((row) => row.id !== qid);
    if (next.length === items.length) throw missing('Câu này đã bị xóa.');
    await call(env, ['HDEL', 'fpass:examq:' + meta.id, qid]);
    await writeMeta(env, meta, next);
    return { count: next.length };
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
    const official = await storeExam(env, { id: pack.id, name: pack.name, code: pack.code, subject: subjectOf(pack.subject), desc: pack.desc }, pack.items);
    await rejectPending(env, pack.id);
    return official;
}
