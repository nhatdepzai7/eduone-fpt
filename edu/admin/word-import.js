/**
 * Đọc đề từ file Word (.docx) ngay trên trình duyệt admin, không gửi file đi đâu.
 *
 * Nhận nhiều kiểu trình bày:
 *  - Có nhãn: "Mã câu:", "Chủ đề:", "Câu hỏi EN:", "Câu hỏi VI:", "A. EN: … | VI: …", "Đáp án đúng:", "Giải thích EN/VI:", "Từ khóa:".
 *  - Không nhãn: "Câu 1: …" rồi các dòng A. B. C. D., "Đáp án: B".
 *  - Bảng: dòng đầu là tiêu đề cột (Câu hỏi, A, B, C, D, Đáp án, Giải thích, Chủ đề, Từ khóa…).
 *  - Đáp án đánh dấu bằng chữ in đậm/tô màu/gạch chân cả lựa chọn, hoặc dấu * trước chữ cái.
 * Từ khóa: chữ tô màu, highlight hoặc gạch chân bên trong câu hỏi, lựa chọn, giải thích.
 * Chủ đề: nhãn "Chủ đề:" hoặc tiêu đề (Heading) đứng trước nhóm câu.
 *
 * Chạy được cả trên trình duyệt (window.FPassWord) lẫn Node (module.exports) để kiểm thử.
 */
(function (root) {
    'use strict';

    const MAX_QUESTIONS = 400;
    const VI_CHARS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

    /* ------------------------------------------------------------------ zip */

    function u16(b, i) { return b[i] | (b[i + 1] << 8); }
    function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

    async function inflateRaw(bytes) {
        if (typeof DecompressionStream === 'undefined') throw new Error('Trình duyệt quá cũ, không giải nén được file Word. Dùng Chrome/Edge/Safari bản mới.');
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function unzipEntry(buffer, name) {
        const b = new Uint8Array(buffer);
        let eocd = -1;
        for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
            if (u32(b, i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('File không phải .docx hợp lệ.');
        const count = u16(b, eocd + 10);
        let p = u32(b, eocd + 16);
        for (let n = 0; n < count && p + 46 <= b.length; n++) {
            if (u32(b, p) !== 0x02014b50) break;
            const method = u16(b, p + 10);
            const size = u32(b, p + 20);
            const nameLen = u16(b, p + 28);
            const extraLen = u16(b, p + 30);
            const commentLen = u16(b, p + 32);
            const local = u32(b, p + 42);
            const entry = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
            if (entry === name) {
                const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
                const data = b.subarray(start, start + size);
                if (method === 0) return data;
                if (method === 8) return inflateRaw(data);
                throw new Error('File Word nén theo kiểu lạ, hãy lưu lại bằng Word rồi thử lại.');
            }
            p += 46 + nameLen + extraLen + commentLen;
        }
        return null;
    }

    /* ------------------------------------------------------------ xml → đoạn */

    function decode(s) {
        return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
            if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
            return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
        });
    }

    function attr(tag, name) {
        const m = tag.match(new RegExp('\\b' + name + '="([^"]*)"'));
        return m ? m[1] : null;
    }

    function isOn(tag) {
        const v = attr(tag, 'w:val');
        return v == null || !/^(0|false|off|none)$/i.test(v);
    }

    /**
     * Trả về danh sách đoạn: { runs:[{t, b, mark}], style, cell:{t,r,c}|null }.
     * mark = chữ được nhấn (màu khác đen, highlight, tô nền, gạch chân).
     */
    function parseDocumentXml(xml) {
        const paras = [];
        const tables = [];
        let para = null;
        let run = null;
        let inRPr = false;
        let inText = false;
        const tblStack = [];
        const re = /<(\/?)([a-zA-Z0-9:]+)([^>]*?)(\/?)>|([^<]+)/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
            if (m[5] != null) {
                if (inText && run) run.t += decode(m[5]);
                continue;
            }
            const close = m[1] === '/';
            const tag = m[2];
            const rest = m[3] || '';
            const self = m[4] === '/';
            switch (tag) {
                case 'w:tbl':
                    if (!close) { tblStack.push({ id: tables.length, r: -1, c: -1 }); tables.push(true); } else tblStack.pop();
                    break;
                case 'w:tr':
                    if (!close && tblStack.length) { const t = tblStack[tblStack.length - 1]; t.r++; t.c = -1; }
                    break;
                case 'w:tc':
                    if (!close && tblStack.length) tblStack[tblStack.length - 1].c++;
                    break;
                case 'w:p':
                    if (!close) {
                        const t = tblStack[tblStack.length - 1];
                        para = { runs: [], style: '', cell: t ? { t: t.id, r: t.r, c: t.c } : null };
                        if (self) { paras.push(para); para = null; }
                    } else if (para) { paras.push(para); para = null; }
                    break;
                case 'w:pStyle':
                    if (para) para.style = attr(rest, 'w:val') || '';
                    break;
                case 'w:r':
                    if (!close && !self && para) run = { t: '', b: false, mark: false };
                    else if (close && run && para) { if (run.t) para.runs.push(run); run = null; }
                    break;
                case 'w:rPr':
                    inRPr = !close && !self;
                    break;
                case 'w:b':
                    if (inRPr && run) run.b = isOn(rest);
                    break;
                case 'w:color': {
                    const v = (attr(rest, 'w:val') || '').toUpperCase();
                    if (inRPr && run && v && !/^(AUTO|000000|0D0D0D|1A1A1A|262626|222222|111111|333333|404040|595959|7F7F7F|808080|FFFFFF)$/.test(v)) run.mark = true;
                    break;
                }
                case 'w:highlight':
                    if (inRPr && run && isOn(rest)) run.mark = true;
                    break;
                case 'w:shd': {
                    const fill = (attr(rest, 'w:fill') || '').toUpperCase();
                    if (inRPr && run && fill && !/^(AUTO|FFFFFF)$/.test(fill)) run.mark = true;
                    break;
                }
                case 'w:u':
                    if (inRPr && run && isOn(rest)) run.mark = true;
                    break;
                case 'w:t':
                    inText = !close && !self;
                    break;
                case 'w:tab':
                    if (run && !inRPr) run.t += '\t';
                    break;
                case 'w:br':
                case 'w:cr':
                    if (run && !inRPr) run.t += '\n';
                    break;
                case 'w:noBreakHyphen':
                    if (run) run.t += '-';
                    break;
                default:
                    break;
            }
        }
        return paras;
    }

    /* --------------------------------------------------------- đoạn → dòng */

    /** Một dòng chữ kèm các khoảng được nhấn: { text, marks:[[from,to]], bold:[[from,to]], style, cell }. */
    function linesOf(paras) {
        const out = [];
        paras.forEach((p) => {
            let text = '';
            const marks = [];
            const bold = [];
            p.runs.forEach((r) => {
                const from = text.length;
                text += r.t;
                if (r.mark) marks.push([from, text.length]);
                if (r.b) bold.push([from, text.length]);
            });
            let offset = 0;
            text.split('\n').forEach((part) => {
                const from = offset;
                const to = offset + part.length;
                offset = to + 1;
                const clip = (list) => list.map(([a, b]) => [Math.max(a, from) - from, Math.min(b, to) - from]).filter(([a, b]) => b > a);
                out.push({ text: part.replace(/ /g, ' '), marks: clip(marks), bold: clip(bold), style: p.style, cell: p.cell });
            });
        });
        return out;
    }

    /** Cắt một đoạn [from, to) của dòng, giữ thông tin nhấn. */
    function slice(line, from, to) {
        const end = to == null ? line.text.length : to;
        const move = (list) => list.map(([a, b]) => [Math.max(a, from) - from, Math.min(b, end) - from]).filter(([a, b]) => b > a);
        return { text: line.text.slice(from, end), marks: move(line.marks), bold: move(line.bold) };
    }

    /** Bỏ khoảng trắng đầu/cuối, dời các khoảng nhấn theo. */
    function trim(seg) {
        const lead = seg.text.length - seg.text.replace(/^\s+/, '').length;
        const text = seg.text.trim();
        const move = (list) => list.map(([a, b]) => [Math.max(0, a - lead), Math.min(text.length, b - lead)]).filter(([a, b]) => b > a);
        return { text, marks: move(seg.marks), bold: move(seg.bold) };
    }

    function share(seg, list) {
        const chars = seg.text.replace(/\s/g, '').length;
        if (!chars) return 0;
        let n = 0;
        list.forEach(([a, b]) => { n += seg.text.slice(a, b).replace(/\s/g, '').length; });
        return Math.min(1, n / chars);
    }

    /** Từ khóa trong một đoạn: các khoảng nhấn, trừ khi cả đoạn đều nhấn (đó là dấu đáp án, không phải từ khóa). */
    function keywordsOf(seg) {
        if (!seg || !seg.marks.length || share(seg, seg.marks) > 0.85) return [];
        const merged = [];
        seg.marks.slice().sort((x, y) => x[0] - y[0]).forEach(([a, b]) => {
            const last = merged[merged.length - 1];
            if (last && a <= last[1] + 1 && !/[.,;:!?]/.test(seg.text.slice(last[1], a))) last[1] = Math.max(last[1], b);
            else merged.push([a, b]);
        });
        return merged.map(([a, b]) => seg.text.slice(a, b).replace(/^[\s"'“”(\[]+|[\s"'“”)\].,;:!?]+$/g, '')).filter((k) => k.length >= 2 && k.length <= 80);
    }

    function emphasized(seg) {
        return share(seg, seg.marks) > 0.85 || share(seg, seg.bold) > 0.85;
    }

    /* ---------------------------------------------------------------- nhãn */

    const LANG_EN = '(?:en|eng|english|tiếng anh|ta)';
    const LANG_VI = '(?:vi|vn|việt|tiếng việt|tv)';
    const SEP = '\\s*[:：]\\s*';
    const lang = (word, code) => new RegExp('^(?:' + word + ')\\s*[(\\[]?\\s*' + code + '\\s*[)\\]]?' + SEP, 'i');

    const LABELS = [
        ['id', /^(?:mã câu hỏi|mã câu|mã số câu|question id|question code|item id)\s*[:：]\s*/i],
        ['course', /^(?:mã môn học|mã môn|course code|subject code)\s*[:：]\s*/i],
        ['examName', /^(?:tên kỳ thi|tên kì thi|kỳ thi|kì thi|exam name|exam)\s*[:：]\s*/i],
        ['topic', /^(?:chủ đề|phân loại|chuyên đề|chương|nhóm|dạng bài|topic|category|chapter|section|unit)\s*[:：]\s*/i],
        ['qEn', lang('câu hỏi|nội dung câu hỏi|question|câu', LANG_EN)],
        ['qVi', lang('câu hỏi|nội dung câu hỏi|question|câu', LANG_VI)],
        ['q', /^(?:câu hỏi|nội dung câu hỏi|nội dung|đề bài|question|stem)\s*[:：]\s*/i],
        ['ans', /^(?:đáp án đúng|đáp án|đ\/a|đa|answer key|correct answer|correct|answer|ans|key|kết quả)\s*[:：=]\s*/i],
        ['exEn', lang('giải thích|lời giải|giải|explanation|explain|solution|rationale', LANG_EN)],
        ['exVi', lang('giải thích|lời giải|giải|explanation|explain|solution|rationale', LANG_VI)],
        ['ex', /^(?:giải thích|lời giải|hướng dẫn giải|giải|explanation|explain|solution|rationale)\s*[:：]\s*/i],
        ['kw', /^(?:từ khóa|từ khoá|keywords?|key words?)\s*[:：]\s*/i],
        ['skip', /^(?:hình minh họa|hình minh hoạ|hình ảnh|hình|image|figure|picture|ghi chú|note|độ khó|difficulty|điểm|mark|points?)\s*[:：]\s*/i]
    ];
    const NUMBERED = /^\s*(?:câu|cau|question|q|bài)\s*(\d{1,4})\s*[.):\-–]?\s*/i;
    const BARE_NUMBER = /^\s*(\d{1,4})\s*[.)]\s+(?=\S)/;
    const OPTION = /^\s*(\*)?\s*\(?([A-Fa-f])\s*[.)]\s*(\*)?\s*/;
    const INLINE_OPTIONS = /\s+(?=\(?[B-F][.)]\s)/;
    const PART = /^\s*(EN|ENG|English|VI|VN|Tiếng Việt|Tiếng Anh)\s*[:：]\s*/i;

    function labelOf(text) {
        for (let i = 0; i < LABELS.length; i++) {
            const m = text.match(LABELS[i][1]);
            if (m) return { kind: LABELS[i][0], at: m[0].length };
        }
        return null;
    }

    function isVi(text) {
        const letters = text.replace(/[^\p{L}]/gu, '');
        if (!letters) return false;
        const hits = (text.match(new RegExp(VI_CHARS.source, 'gi')) || []).length;
        return hits >= 1 && hits / letters.length > 0.02;
    }

    function partLang(code) {
        return /^(vi|vn|tiếng việt)$/i.test(code) ? 'vi' : 'en';
    }

    /** "EN: x | VI: y" hoặc "x / y" → { en, vi } (mỗi phần là seg). Không tách được thì đoán ngôn ngữ. */
    function splitBilingual(seg) {
        const out = {};
        const pieces = [];
        let start = 0;
        const bar = /\s*\|\s*/g;
        let m;
        while ((m = bar.exec(seg.text)) !== null) {
            pieces.push(slice(seg, start, m.index));
            start = m.index + m[0].length;
        }
        pieces.push(slice(seg, start));
        let tagged = false;
        pieces.forEach((piece) => {
            const t = trim(piece);
            const pm = t.text.match(PART);
            if (pm) {
                tagged = true;
                out[partLang(pm[1])] = trim(slice(t, pm[0].length));
            }
        });
        if (tagged) return out;
        const whole = trim(seg);
        out[isVi(whole.text) ? 'vi' : 'en'] = whole;
        return out;
    }

    /* -------------------------------------------------------------- câu hỏi */

    function blank() {
        return { ref: '', topic: '', q: { en: [], vi: [] }, opts: [], ans: '', ansText: '', ex: { en: [], vi: [] }, kw: [], line: 0 };
    }

    function hasBody(it) { return it.q.en.length || it.q.vi.length; }

    function addSeg(list, seg) { if (seg && seg.text) list.push(seg); }

    function joinSegs(list) {
        if (!list.length) return null;
        let text = '';
        const marks = [];
        const bold = [];
        list.forEach((s) => {
            if (text) text += ' ';
            const off = text.length;
            text += s.text;
            s.marks.forEach(([a, b]) => marks.push([a + off, b + off]));
            s.bold.forEach(([a, b]) => bold.push([a + off, b + off]));
        });
        return { text, marks, bold };
    }

    function putQuestion(it, seg, langHint) {
        const parts = langHint ? { [langHint]: trim(seg) } : splitBilingual(seg);
        if (parts.en) addSeg(it.q.en, parts.en);
        if (parts.vi) addSeg(it.q.vi, parts.vi);
    }

    function putExplain(it, seg, langHint) {
        const parts = langHint ? { [langHint]: trim(seg) } : splitBilingual(seg);
        if (parts.en) addSeg(it.ex.en, parts.en);
        if (parts.vi) addSeg(it.ex.vi, parts.vi);
    }

    function putOption(it, letter, seg, starred) {
        const idx = 'ABCDEF'.indexOf(letter.toUpperCase());
        const parts = splitBilingual(seg);
        const opt = it.opts[idx] || { en: null, vi: null, mark: false };
        if (parts.en) opt.en = parts.en;
        if (parts.vi) opt.vi = parts.vi;
        if (starred || emphasized(trim(seg))) opt.mark = true;
        it.opts[idx] = opt;
    }

    function readAnswer(it, seg) {
        const text = trim(seg).text;
        const m = text.match(/^\(?([A-Fa-f])\)?(?:[.):\s]|$)/);
        if (m) it.ans = m[1].toUpperCase();
        else it.ansText = text;
    }

    /** Dòng dạng "A. x  B. y  C. z  D. w" → tách thành nhiều lựa chọn. */
    function optionPieces(line) {
        const pieces = [];
        let start = 0;
        const re = new RegExp(INLINE_OPTIONS.source, 'g');
        let m;
        while ((m = re.exec(line.text)) !== null) {
            pieces.push(slice(line, start, m.index));
            start = m.index + m[0].length;
        }
        pieces.push(slice(line, start));
        return pieces;
    }

    /* ------------------------------------------------------------ bảng đề */

    const COLUMNS = [
        ['ref', /^(mã câu|mã|id|stt|no\.?|#)$/i],
        ['topic', /^(chủ đề|phân loại|chuyên đề|chương|nhóm|topic|category|chapter|section|unit)$/i],
        ['qEn', /^(câu hỏi|question)\s*[(\[]?\s*(en|eng|english|tiếng anh)\s*[)\]]?$/i],
        ['qVi', /^(câu hỏi|question)\s*[(\[]?\s*(vi|vn|tiếng việt)\s*[)\]]?$/i],
        ['q', /^(câu hỏi|nội dung|đề bài|question|stem)$/i],
        ['optA', /^(a|đáp án a|lựa chọn a|option a|phương án a)$/i],
        ['optB', /^(b|đáp án b|lựa chọn b|option b|phương án b)$/i],
        ['optC', /^(c|đáp án c|lựa chọn c|option c|phương án c)$/i],
        ['optD', /^(d|đáp án d|lựa chọn d|option d|phương án d)$/i],
        ['ans', /^(đáp án đúng|đáp án|answer|correct|key|kết quả)$/i],
        ['exEn', /^(giải thích|lời giải|explanation|solution)\s*[(\[]?\s*(en|eng|english)\s*[)\]]?$/i],
        ['exVi', /^(giải thích|lời giải|explanation|solution)\s*[(\[]?\s*(vi|vn|tiếng việt)\s*[)\]]?$/i],
        ['ex', /^(giải thích|lời giải|explanation|solution)$/i],
        ['kw', /^(từ khóa|từ khoá|keywords?)$/i]
    ];

    function tableItems(lines) {
        const byTable = new Map();
        lines.forEach((ln) => {
            if (!ln.cell) return;
            if (!byTable.has(ln.cell.t)) byTable.set(ln.cell.t, new Map());
            const rows = byTable.get(ln.cell.t);
            if (!rows.has(ln.cell.r)) rows.set(ln.cell.r, new Map());
            const cells = rows.get(ln.cell.r);
            if (!cells.has(ln.cell.c)) cells.set(ln.cell.c, []);
            if (ln.text.trim()) cells.get(ln.cell.c).push(ln);
        });
        const items = [];
        const used = new Set();
        byTable.forEach((rows, tableId) => {
            const order = Array.from(rows.keys()).sort((a, b) => a - b);
            if (order.length < 2) return;
            const head = rows.get(order[0]);
            const map = {};
            head.forEach((cellLines, c) => {
                const name = cellLines.map((l) => l.text).join(' ').trim().replace(/\s*[:：]$/, '');
                const col = COLUMNS.find(([, re]) => re.test(name));
                if (col && map[col[0]] == null) map[col[0]] = c;
            });
            const hasQ = map.q != null || map.qEn != null || map.qVi != null;
            if (!hasQ || map.optA == null || map.optB == null) return;
            used.add(tableId);
            order.slice(1).forEach((r) => {
                const cells = rows.get(r);
                const seg = (key) => {
                    if (map[key] == null || !cells.has(map[key])) return null;
                    return joinSegs(cells.get(map[key]).map((l) => trim(l)));
                };
                const it = blank();
                const ref = seg('ref');
                if (ref) it.ref = ref.text;
                const topic = seg('topic');
                if (topic) it.topic = topic.text;
                if (seg('qEn')) putQuestion(it, seg('qEn'), 'en');
                if (seg('qVi')) putQuestion(it, seg('qVi'), 'vi');
                if (seg('q')) putQuestion(it, seg('q'));
                ['A', 'B', 'C', 'D'].forEach((L) => {
                    const s = seg('opt' + L);
                    if (s) {
                        const om = s.text.match(OPTION);
                        putOption(it, L, om && om[2].toUpperCase() === L ? slice(s, om[0].length) : s, !!(om && (om[1] || om[3])));
                    }
                });
                const ans = seg('ans');
                if (ans) readAnswer(it, ans);
                if (seg('exEn')) putExplain(it, seg('exEn'), 'en');
                if (seg('exVi')) putExplain(it, seg('exVi'), 'vi');
                if (seg('ex')) putExplain(it, seg('ex'));
                const kw = seg('kw');
                if (kw) it.kw = kw.text.split(/[,;|\n]/).map((k) => k.trim()).filter(Boolean);
                if (hasBody(it)) items.push(it);
            });
        });
        return { items, used };
    }

    /* ---------------------------------------------------------- dòng → câu */

    function looseItems(lines) {
        const items = [];
        const notes = {};
        let it = blank();
        let topic = '';
        let field = '';
        let stage = 'none';

        const flush = () => {
            const stray = !it.opts.length && !it.ans && !it.ansText;
            if ((hasBody(it) || it.opts.length) && !stray) {
                if (!it.topic) it.topic = topic;
                items.push(it);
            }
            it = blank();
            field = '';
            stage = 'none';
        };
        const complete = () => it.opts.filter(Boolean).length >= 2 && (it.ans || it.ansText || it.opts.some((o) => o && o.mark));

        lines.forEach((ln, index) => {
            const raw = ln.text;
            if (!raw.trim()) return;
            const line = { text: raw, marks: ln.marks, bold: ln.bold };
            const text = raw.trim();
            const isHeading = /heading|title|tiêu đề|tieude|chuong/i.test(ln.style || '');

            const label = labelOf(text);
            const lead = raw.length - raw.replace(/^\s+/, '').length;
            const after = label ? trim(slice(line, lead + label.at)) : null;

            if (label) {
                switch (label.kind) {
                    case 'id':
                        flush();
                        it.ref = after.text;
                        it.line = index;
                        stage = 'head';
                        return;
                    case 'course':
                    case 'examName':
                        if (label.kind === 'course' && after.text) notes.course = notes.course || after.text;
                        if (label.kind === 'examName' && after.text) notes.examName = notes.examName || after.text;
                        return;
                    case 'topic':
                        if (complete() || (hasBody(it) && it.opts.length)) flush();
                        if (hasBody(it) || it.ref || stage === 'head') it.topic = after.text;
                        else topic = after.text;
                        return;
                    case 'qEn':
                    case 'qVi':
                    case 'q': {
                        const langCode = label.kind === 'qEn' ? 'en' : label.kind === 'qVi' ? 'vi' : '';
                        const already = langCode ? it.q[langCode].length : hasBody(it);
                        if (complete() || (already && it.opts.length) || (already && !langCode)) flush();
                        if (!it.line) it.line = index;
                        putQuestion(it, after, langCode);
                        field = label.kind;
                        stage = 'question';
                        return;
                    }
                    case 'ans':
                        readAnswer(it, after);
                        field = 'ans';
                        stage = 'answer';
                        return;
                    case 'exEn':
                    case 'exVi':
                    case 'ex':
                        putExplain(it, after, label.kind === 'exEn' ? 'en' : label.kind === 'exVi' ? 'vi' : '');
                        field = label.kind;
                        stage = 'explain';
                        return;
                    case 'kw':
                        it.kw = it.kw.concat(after.text.split(/[,;|]/).map((k) => k.trim()).filter(Boolean));
                        field = 'kw';
                        return;
                    case 'skip':
                        field = 'skip';
                        return;
                    default:
                        return;
                }
            }

            const opt = text.match(OPTION);
            if (opt && (hasBody(it) || it.opts.length) && stage !== 'explain') {
                const pieces = optionPieces(trim(line));
                pieces.forEach((piece) => {
                    const p = trim(piece);
                    const om = p.text.match(OPTION);
                    if (!om) return;
                    putOption(it, om[2], slice(p, om[0].length), !!(om[1] || om[3]));
                });
                field = 'opt';
                stage = 'options';
                return;
            }

            const numbered = text.match(NUMBERED) || ((stage === 'none' || complete()) && text.match(BARE_NUMBER));
            if (numbered && !isHeading) {
                if (hasBody(it) || it.opts.length) flush();
                it.line = index;
                if (!it.ref) it.ref = numbered[1];
                const body = trim(slice(line, lead + numbered[0].length));
                if (body.text) putQuestion(it, body);
                field = 'q';
                stage = 'question';
                return;
            }

            const part = text.match(PART);
            if (part && stage === 'question') { putQuestion(it, trim(slice(line, lead + part[0].length)), partLang(part[1])); return; }
            if (part && stage === 'explain') { putExplain(it, trim(slice(line, lead + part[0].length)), partLang(part[1])); return; }

            if (isHeading || (!hasBody(it) && !it.ref && stage === 'none' && /^\d{1,2}\s+\S/.test(text) && text.length < 90)) {
                if (complete()) flush();
                if (!hasBody(it) && !it.ref) topic = text.replace(/^\d{1,2}[.)]?\s+/, '');
                return;
            }

            if (complete() && (stage === 'answer' || stage === 'options') && field !== 'ex' && field !== 'exEn' && field !== 'exVi') {
                flush();
                it.line = index;
                putQuestion(it, trim(line));
                field = 'q';
                stage = 'question';
                return;
            }

            if (field === 'qEn') { putQuestion(it, trim(line), 'en'); return; }
            if (field === 'qVi') { putQuestion(it, trim(line), 'vi'); return; }
            if (field === 'q' || (stage === 'head' || stage === 'none')) {
                if (!it.line) it.line = index;
                putQuestion(it, trim(line));
                field = 'q';
                stage = 'question';
                return;
            }
            if (field === 'exEn') { putExplain(it, trim(line), 'en'); return; }
            if (field === 'exVi') { putExplain(it, trim(line), 'vi'); return; }
            if (field === 'ex') { putExplain(it, trim(line)); return; }
            if (field === 'opt') {
                const last = it.opts.length - 1;
                if (last >= 0 && it.opts[last]) {
                    const o = it.opts[last];
                    const extra = splitBilingual(trim(line));
                    if (extra.vi && o.vi) o.vi = joinSegs([o.vi, extra.vi]);
                    else if (extra.vi) o.vi = extra.vi;
                    if (extra.en && o.en) o.en = joinSegs([o.en, extra.en]);
                    else if (extra.en) o.en = extra.en;
                }
            }
        });
        flush();
        return { items, notes };
    }

    /* ------------------------------------------------------------ chốt câu */

    function textOf(list) { const s = joinSegs(list); return s ? s.text : ''; }

    function kwFrom(list) { return list.reduce((acc, s) => acc.concat(keywordsOf(s)), []); }

    function finish(it, n) {
        const letters = ['A', 'B', 'C', 'D'];
        const extra = it.opts.length > 4 && it.opts.slice(4).some(Boolean);
        const opts = letters.map((_, i) => it.opts[i] || null);
        const optEn = opts.map((o) => (o && (o.en || o.vi) ? (o.en || o.vi).text : ''));
        const optVi = opts.map((o) => (o && o.vi && o.en ? o.vi.text : ''));
        const filled = optEn.filter(Boolean).length;
        const qEn = textOf(it.q.en);
        const qVi = textOf(it.q.vi);
        const exEn = textOf(it.ex.en);
        const exVi = textOf(it.ex.vi);
        const label = it.ref ? 'Câu ' + it.ref : 'Câu thứ ' + n;
        const problems = [];

        let answer = it.ans;
        if (!answer && it.ansText) {
            const want = it.ansText.toLowerCase().replace(/\s+/g, ' ');
            const idx = opts.findIndex((o) => o && [o.en, o.vi].some((s) => s && s.text.toLowerCase().replace(/\s+/g, ' ') === want));
            if (idx >= 0) answer = letters[idx];
        }
        if (!answer) {
            const marked = opts.map((o, i) => (o && o.mark ? letters[i] : '')).filter(Boolean);
            if (marked.length === 1) answer = marked[0];
        }

        const type = filled >= 2 ? 'mcq' : 'vocab';
        if (type === 'mcq') {
            if (!answer) problems.push(label + ': chưa có đáp án.');
            else if (!optEn[letters.indexOf(answer)]) problems.push(label + ': đáp án ' + answer + ' không có nội dung.');
            if (filled < 4) problems.push(label + ': chỉ có ' + filled + ' lựa chọn.');
            if (extra) problems.push(label + ': có hơn 4 lựa chọn, chỉ giữ A–D.');
        } else if (!it.ansText && !answer) {
            problems.push(label + ': không thấy lựa chọn A–D hay đáp án.');
        }

        const kw = [];
        const seen = new Set();
        it.kw.concat(kwFrom(it.q.en), kwFrom(it.q.vi), kwFrom(it.ex.en), kwFrom(it.ex.vi),
            opts.reduce((acc, o) => acc.concat(o ? keywordsOf(o.en || { text: '', marks: [], bold: [] }).concat(keywordsOf(o.vi || { text: '', marks: [], bold: [] })) : []), []))
            .forEach((k) => {
                const low = k.toLowerCase();
                if (!seen.has(low) && kw.length < 24) { seen.add(low); kw.push(k); }
            });

        const topic = String(it.topic || '').split(/\s+\/\s+/)[0].trim();
        const item = {
            type,
            ref: it.ref,
            group: topic,
            question: qEn || qVi,
            options: type === 'mcq' ? optEn : [],
            answer: type === 'mcq' ? answer : (it.ansText || answer),
            explanation: exEn || exVi,
            keywords: kw
        };
        if (qEn && qVi) item.questionVi = qVi;
        if (type === 'mcq' && optVi.some(Boolean)) item.optionsVi = optVi;
        if (exEn && exVi) item.explanationVi = exVi;
        if (!item.question) problems.push(label + ': thiếu nội dung câu hỏi.');
        return { item, problems };
    }

    function parseLines(lines) {
        const table = tableItems(lines);
        const rest = lines.filter((ln) => !ln.cell || !table.used.has(ln.cell.t));
        const loose = looseItems(rest);
        const raw = table.items.concat(loose.items);
        const items = [];
        const problems = [];
        raw.forEach((it, i) => {
            const done = finish(it, i + 1);
            problems.push.apply(problems, done.problems);
            if (done.item.question && (done.item.type !== 'mcq' || done.item.answer)) items.push(done.item);
        });
        if (items.length > MAX_QUESTIONS) problems.push('Đề có ' + items.length + ' câu, chỉ giữ ' + MAX_QUESTIONS + ' câu đầu.');
        const kept = items.slice(0, MAX_QUESTIONS);
        const topics = {};
        kept.forEach((t) => { const g = t.group || 'Chưa phân loại'; topics[g] = (topics[g] || 0) + 1; });
        return {
            items: kept,
            problems,
            stats: {
                found: raw.length,
                kept: kept.length,
                bilingual: kept.filter((t) => t.questionVi).length,
                withKeywords: kept.filter((t) => t.keywords.length).length,
                withExplanation: kept.filter((t) => t.explanation).length,
                topics
            },
            course: loose.notes.course || '',
            examName: loose.notes.examName || ''
        };
    }

    function parseXml(xml) {
        return parseLines(linesOf(parseDocumentXml(xml)));
    }

    async function parseDocx(buffer) {
        const data = await unzipEntry(buffer, 'word/document.xml');
        if (!data) throw new Error('Không thấy nội dung trong file. Chỉ nhận .docx (Word 2007 trở lên), không nhận .doc cũ.');
        return parseXml(new TextDecoder('utf-8').decode(data));
    }

    const api = { parseDocx, parseXml, parseDocumentXml, MAX_QUESTIONS };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FPassWord = api;
})(typeof self !== 'undefined' ? self : globalThis);
