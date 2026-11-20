(function (EDU) {
    'use strict';
    const S = EDU.Security;

    const MAX = {
        id: 80, group: 80, word: 400, question: 1500, wordType: 24, ipa: 80, option: 500,
        answer: 1500, explanation: 2500, keyword: 80, keywords: 24, exampleVi: 1500, vietSub: 120, recall: 400
    };
    const SRS_STEPS = [1, 3, 7, 14];
    const LETTERS = ['A', 'B', 'C', 'D'];
    const DAY = 86400000;

    const WORD_TYPES = {
        n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', prep: 'preposition',
        conj: 'conjunction', pron: 'pronoun', interj: 'interjection', phr: 'phrase'
    };

    let seq = 0;
    /* createdAt tăng dần kể cả khi tạo nhiều mục trong cùng 1ms (dán nhanh, nhập Excel): giữ đúng mạch bài học khi sắp xếp. */
    let lastStamp = 0;
    const stamp = () => { let t = Date.now(); if (t <= lastStamp) t = lastStamp + 1; lastStamp = t; return new Date(t).toISOString(); };
    const newId = (prefix) => (prefix || 'it') + '-' + Date.now().toString(36) + '-' + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

    const pick = (o, keys) => {
        for (let i = 0; i < keys.length; i++) {
            if (o && o[keys[i]] != null && o[keys[i]] !== '') return o[keys[i]];
        }
        return undefined;
    };

    const toIso = (v) => {
        if (!v) return null;
        const t = new Date(v).getTime();
        return isFinite(t) ? new Date(t).toISOString() : null;
    };

    const toInt = (v, min, max) => {
        const n = Math.floor(Number(v) || 0);
        return Math.max(min, Math.min(max, n));
    };

    const cleanKeywords = (v) => {
        let arr = v;
        if (typeof v === 'string') arr = v.split(/[,;|\n]/);
        if (!Array.isArray(arr)) return [];
        const seen = new Set();
        const out = [];
        arr.forEach((k) => {
            const c = S.cleanText(k, MAX.keyword);
            const low = c.toLowerCase();
            if (c.length >= 2 && !seen.has(low) && out.length < MAX.keywords) {
                seen.add(low);
                out.push(c);
            }
        });
        return out;
    };

    const cleanOptions = (raw) => {
        let arr = raw;
        if (arr && !Array.isArray(arr) && typeof arr === 'object') arr = LETTERS.map((L) => arr[L] || arr[L.toLowerCase()]);
        if (!Array.isArray(arr)) arr = [];
        const out = arr.slice(0, 4).map((o) => S.cleanText(o, MAX.option).replace(/^\s*[A-Da-d][.)]\s+/, ''));
        while (out.length < 4) out.push('');
        return out;
    };

    /* Bản tiếng Việt của 4 lựa chọn (đề song ngữ). Không có thì để rỗng. */
    const cleanVi = (raw) => {
        if (!Array.isArray(raw) || !raw.some(Boolean)) return [];
        return cleanOptions(raw);
    };

    const answerLetter = (raw, options) => {
        if (raw == null || raw === '') return '';
        if (typeof raw === 'number' && raw >= 0 && raw < 4) return LETTERS[raw];
        const s = S.cleanText(raw, MAX.answer);
        const m = s.match(/^\(?([A-Da-d])\)?[.)]?$/);
        if (m) return m[1].toUpperCase();
        const idx = options.findIndex((o) => o && o.toLowerCase() === s.toLowerCase());
        return idx >= 0 ? LETTERS[idx] : '';
    };

    const normalizeItem = (raw, defaults) => {
        const d = raw && typeof raw === 'object' ? raw : {};
        const def = defaults || {};
        const optionsRaw = pick(d, ['options', 'choices', 'luaChon']);
        const options = cleanOptions(optionsRaw);
        const filled = options.filter(Boolean).length;
        let type = d.type === 'mcq' || d.type === 'vocab' ? d.type : (filled >= 2 ? 'mcq' : 'vocab');
        if (type === 'mcq' && filled < 2) type = 'vocab';

        const questionOrWord = S.cleanText(pick(d, ['questionOrWord', 'question', 'word', 'tu', 'q']), type === 'mcq' ? MAX.question : MAX.word);
        let answerOrMeaning = pick(d, ['answerOrMeaning', 'answer', 'meaning', 'nghia', 'a']);
        if (type === 'mcq') {
            answerOrMeaning = answerLetter(answerOrMeaning, options);
        } else {
            answerOrMeaning = S.cleanText(answerOrMeaning, MAX.answer);
        }

        const id = S.cleanText(d.id != null ? String(d.id) : '', MAX.id) || newId(def.idPrefix);

        return {
            id: id,
            type: type,
            group: S.cleanText(pick(d, ['group', 'nhom']) || def.group || '', MAX.group),
            checkpoint: [1, 2, 3].indexOf(Number(d.checkpoint)) >= 0 ? Number(d.checkpoint) : (def.checkpoint || 1),
            questionOrWord: questionOrWord,
            wordType: S.cleanText(pick(d, ['wordType', 'tuLoai']), MAX.wordType),
            ipa: S.cleanText(d.ipa, MAX.ipa),
            options: type === 'mcq' ? options : [],
            answerOrMeaning: answerOrMeaning,
            explanationOrExample: S.cleanText(pick(d, ['explanationOrExample', 'explanation', 'example', 'nguCanh', 'e']), MAX.explanation),
            keywords: cleanKeywords(pick(d, ['keywords', 'k'])),
            questionVi: type === 'mcq' ? S.cleanText(d.questionVi, MAX.question) : '',
            optionsVi: type === 'mcq' ? cleanVi(d.optionsVi) : [],
            explanationVi: S.cleanText(d.explanationVi, MAX.explanation),
            srsStage: toInt(pick(d, ['srsStage', 'bacOn']), 0, SRS_STEPS.length),
            wrongCount: toInt(pick(d, ['wrongCount', 'testSai']), 0, 1e6),
            nextReview: toIso(pick(d, ['nextReview', 'ngayOnTiep'])),
            exampleVi: S.cleanText(pick(d, ['exampleVi', 'nguCanhDich']), MAX.exampleVi),
            vietSub: S.cleanText(d.vietSub, MAX.vietSub),
            recallPrompt: S.cleanText(pick(d, ['recallPrompt', 'cauHoi']), MAX.recall),
            reviewCount: toInt(pick(d, ['reviewCount', 'soLanOn']), 0, 1e6),
            correctCount: toInt(pick(d, ['correctCount', 'testDung']), 0, 1e6),
            pronounceCount: toInt(pick(d, ['pronounceCount', 'phatAmDung']), 0, 1e6),
            lastReview: toIso(pick(d, ['lastReview', 'ngayOnCuoi'])),
            createdAt: toIso(pick(d, ['createdAt', 'ngayThem'])) || stamp(),
            source: def.source || (typeof d.source === 'string' ? S.cleanText(d.source, 60) : 'user')
        };
    };

    const CONTENT_FIELDS = ['type', 'group', 'checkpoint', 'questionOrWord', 'wordType', 'ipa', 'options', 'answerOrMeaning', 'explanationOrExample', 'keywords', 'questionVi', 'optionsVi', 'explanationVi', 'exampleVi', 'vietSub', 'recallPrompt'];

    const toShareable = (item) => {
        const out = {};
        CONTENT_FIELDS.forEach((k) => { out[k] = item[k]; });
        if (out.type !== 'mcq') delete out.options;
        ['questionVi', 'explanationVi'].forEach((k) => { if (!out[k]) delete out[k]; });
        if (!out.optionsVi || !out.optionsVi.length) delete out.optionsVi;
        return out;
    };

    const isFilled = (t) => !!(t && (t.questionOrWord || '').trim());

    const correctText = (t) => {
        if (!t) return '';
        if (t.type !== 'mcq') return t.answerOrMeaning || '';
        const i = LETTERS.indexOf(t.answerOrMeaning);
        return i >= 0 ? (t.options[i] || '') : '';
    };

    const weakScore = (t, now) => {
        const at = now || Date.now();
        let score = 0;
        if (!t.reviewCount) score += 80;
        score += (t.wrongCount || 0) * 25;
        score -= ((t.correctCount || 0) + (t.pronounceCount || 0)) * 4;
        if (t.nextReview) {
            if (new Date(t.nextReview).getTime() <= at) score += 40;
        } else if (t.lastReview) {
            const days = (at - new Date(t.lastReview).getTime()) / DAY;
            if (days >= 14) score += 35;
            else if (days >= 7) score += 20;
            else if (days >= 3) score += 8;
        }
        return score;
    };

    const isWeak = (t, now) => weakScore(t, now) >= 20;

    const isDue = (t, now) => !!(t.nextReview && new Date(t.nextReview).getTime() <= (now || Date.now()));

    const applyReview = (t, correct, kind) => {
        const nowIso = new Date().toISOString();
        if (kind === 'pronounce') {
            if (!correct) return { item: t, afterDays: null };
            return { item: Object.assign({}, t, { reviewCount: (t.reviewCount || 0) + 1, pronounceCount: (t.pronounceCount || 0) + 1 }), afterDays: null };
        }
        const stage = correct ? Math.min((t.srsStage || 0) + 1, SRS_STEPS.length) : 0;
        const afterDays = stage === 0 ? 0 : SRS_STEPS[stage - 1];
        return {
            afterDays: afterDays,
            item: Object.assign({}, t, {
                reviewCount: (t.reviewCount || 0) + 1,
                correctCount: (t.correctCount || 0) + (correct ? 1 : 0),
                wrongCount: (t.wrongCount || 0) + (correct ? 0 : 1),
                srsStage: stage,
                lastReview: nowIso,
                nextReview: new Date(Date.now() + afterDays * DAY).toISOString()
            })
        };
    };

    const reviewNote = (t) => {
        if (!t.nextReview) return t.reviewCount ? '' : 'chưa ôn';
        const diff = new Date(t.nextReview).getTime() - Date.now();
        if (diff <= 0) return 'đến hạn';
        return 'sau ' + Math.ceil(diff / DAY) + ' ngày';
    };

    /* Đề song ngữ: lang 'vi' đổi câu hỏi, lựa chọn, lời giải sang tiếng Việt; thứ tự lựa chọn và đáp án giữ nguyên. */
    const hasVi = (t) => !!(t && t.type === 'mcq' && (t.questionVi || (t.optionsVi && t.optionsVi.some(Boolean))));
    const inLang = (t, lang) => {
        if (lang !== 'vi' || !hasVi(t)) return t;
        const vi = t.optionsVi || [];
        return Object.assign({}, t, {
            questionOrWord: t.questionVi || t.questionOrWord,
            options: (t.options || []).map((o, i) => vi[i] || o),
            explanationOrExample: t.explanationVi || t.explanationOrExample
        });
    };

    const groupKey = (t) => ((t && t.group) || '').trim() || '__none';
    const groupLabel = (k) => (!k || k === 'all' ? 'Tất cả' : k === '__none' ? 'Chưa nhóm' : k);
    const inGroup = (t, g) => !g || g === 'all' || groupKey(t) === g;
    const byGroup = (ds, g) => ds.filter((t) => isFilled(t) && inGroup(t, g));

    const normGroupName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9à-ỹđ]+/gi, ' ').replace(/\s+/g, ' ').trim();

    const matchGroup = (name, keys) => {
        const ds = (keys || []).filter((k) => k && k !== '__none' && k !== 'all');
        if (!name || name === 'all') return name || 'all';
        if (ds.indexOf(name) >= 0) return name;
        const target = normGroupName(name);
        const exact = ds.find((k) => normGroupName(k) === target);
        if (exact) return exact;
        const unit = (target.match(/unit\s*(\d+)/) || [])[1];
        if (!unit) return name;
        const same = ds.filter((k) => (normGroupName(k).match(/unit\s*(\d+)/) || [])[1] === unit);
        if (same.length === 1) return same[0];
        const words = target.split(' ').filter((w) => w.length > 2 && w !== 'unit');
        let best = null;
        let score = 0;
        same.forEach((k) => {
            const b = normGroupName(k);
            const sc = words.reduce((n, w) => n + (b.indexOf(w) >= 0 ? 1 : 0), 0);
            if (sc > score) { score = sc; best = k; }
        });
        return score > 0 ? best : name;
    };

    const groupColor = (name) => {
        const palette = ['#4338CA', '#7C3AED', '#047857', '#B45309', '#BE185D', '#0E7490', '#1D4ED8'];
        let h = 0;
        const s = name || '';
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return palette[h % palette.length];
    };

    const shuffle = (arr) => {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = a[i];
            a[i] = a[j];
            a[j] = tmp;
        }
        return a;
    };

    const normAnswer = (s) => String(s || '').toLowerCase().normalize('NFC').trim().replace(/[.,!?;:"'’`]/g, '').replace(/\s+/g, ' ');

    const blankOut = (sentence, word) => {
        if (!sentence || !word) return '';
        return sentence.replace(new RegExp(S.escapeRegExp(word), 'gi'), '_____');
    };

    const recallPromptOf = (t) => {
        if (!t) return '';
        if (t.type === 'mcq') return t.questionOrWord;
        const q = (t.recallPrompt || '').trim();
        if (q && t.questionOrWord && q.toLowerCase().indexOf(t.questionOrWord.toLowerCase()) < 0) return q;
        if (t.answerOrMeaning) return '"' + t.answerOrMeaning + '" tiếng Anh là gì?';
        return t.questionOrWord;
    };

    /* ---------- IPA → cách đọc tiếng Việt (giữ nguyên thuật toán bản gốc) ---------- */
    const ipaToVi = (ipa) => {
        const s = String(ipa || '').toLowerCase().replace(/[/[\]().]/g, '').replace(/ɡ/g, 'g').replace(/\s+/g, '');
        if (!s) return '';
        const keys = ['aɪə', 'tʃ', 'dʒ', 'eɪ', 'aɪ', 'aʊ', 'ɔɪ', 'oʊ', 'əʊ', 'ɪə', 'eə', 'ʊə', 'iː', 'ɑː', 'ɔː', 'uː', 'ɜː', 'ɪ', 'i', 'e', 'æ', 'ɑ', 'ɒ', 'ɔ', 'ʊ', 'u', 'ʌ', 'ə', 'ɛ', 'ɝ', 'ɚ', 'θ', 'ð', 'ʃ', 'ʒ', 'ŋ', 'p', 'b', 't', 'd', 'k', 'g', 'f', 'v', 's', 'z', 'h', 'm', 'n', 'l', 'r', 'w', 'j'];
        const vowel = { 'aɪə': 1, 'eɪ': 1, 'aɪ': 1, 'aʊ': 1, 'ɔɪ': 1, 'oʊ': 1, 'əʊ': 1, 'ɪə': 1, 'eə': 1, 'ʊə': 1, 'iː': 1, 'ɑː': 1, 'ɔː': 1, 'uː': 1, 'ɜː': 1, 'ɪ': 1, 'i': 1, 'e': 1, 'æ': 1, 'ɑ': 1, 'ɒ': 1, 'ɔ': 1, 'ʊ': 1, 'u': 1, 'ʌ': 1, 'ə': 1, 'ɛ': 1, 'ɝ': 1, 'ɚ': 1 };
        const ph = [];
        let stress = false;
        for (let i = 0; i < s.length;) {
            const c = s.charAt(i);
            if (c === 'ˈ' || c === "'" || c === '´') { stress = true; i++; continue; }
            if (c === 'ˌ' || c === 'ː' || c === ':' || c === '-' || c === 'ˑ') { if (c === 'ˌ') stress = false; i++; continue; }
            let hit = '';
            for (let k = 0; k < keys.length; k++) {
                if (s.indexOf(keys[k], i) === i) { hit = keys[k]; break; }
            }
            if (!hit) { i++; continue; }
            ph.push({ p: hit, v: !!vowel[hit], strong: !!(stress && vowel[hit]) });
            if (vowel[hit]) stress = false;
            i += hit.length;
        }
        const vi = [];
        ph.forEach((a, i) => { if (a.v) vi.push(i); });
        if (!vi.length) return '';
        const onset = { str: 3, spr: 3, skr: 3, spl: 3, sk: 2, sp: 2, st: 2, sl: 2, sm: 2, sn: 2, sw: 2, tr: 2, dr: 2, kr: 2, gr: 2, fr: 2, pr: 2, br: 2, pl: 2, bl: 2, kl: 2, gl: 2, fl: 2, kw: 2, tw: 2 };
        const countOnset = (ds) => {
            if (!ds.length) return 0;
            const chain = ds.map((a) => a.p).join('');
            for (let n = ds.length; n >= 2; n--) {
                if (onset[chain.slice(chain.length - n)] === n) return n;
            }
            return ds[ds.length - 1].p === 'ŋ' ? 0 : 1;
        };
        const vMap = { 'ə': 'ơ', 'ʌ': 'ă', 'æ': 'a', 'ɑ': 'a', 'ɑː': 'a', 'ɒ': 'o', 'ɔ': 'ô', 'ɔː': 'o', 'ɪ': 'i', 'i': 'i', 'iː': 'i', 'e': 'ê', 'ɛ': 'e', 'ʊ': 'u', 'u': 'u', 'uː': 'u', 'ɜː': 'ơ', 'ɝ': 'ơ', 'ɚ': 'ơ', 'eɪ': 'ây', 'aɪ': 'ai', 'aʊ': 'ao', 'ɔɪ': 'oi', 'oʊ': 'âu', 'əʊ': 'âu', 'ɪə': 'iơ', 'eə': 'eơ', 'ʊə': 'uơ', 'aɪə': 'aiơ' };
        const cMap = { 'tʃ': 'ch', 'dʒ': 'j', 'θ': 'th', 'ð': 'đ', 'ʃ': 'sh', 'ʒ': 'gi', 'ŋ': 'ng', 'j': 'y' };
        const acute = { a: 'á', ă: 'ắ', â: 'ấ', e: 'é', ê: 'ế', i: 'í', o: 'ó', ô: 'ố', ơ: 'ớ', u: 'ú', ư: 'ứ', y: 'ý' };
        const ch = (p) => cMap[p] || p;
        const syl = vi.map((at, n) => {
            const end = n === vi.length - 1 ? ph.length : vi[n + 1];
            const tail = ph.slice(at + 1, end);
            const take = n === vi.length - 1 ? 0 : countOnset(tail);
            return { at: at, coda: tail.slice(0, tail.length - take), next: tail.slice(tail.length - take) };
        });
        return syl.map((sy, n) => {
            const head = n === 0 ? ph.slice(0, sy.at) : syl[n - 1].next;
            const h = head.map((a) => ch(a.p)).join('');
            const c = sy.coda.map((a) => ch(a.p)).join('');
            let v = vMap[ph[sy.at].p] || 'ơ';
            if (ph[sy.at].strong && ph[sy.at].p === 'ɪ' && !c) v = 'íp';
            else if (ph[sy.at].strong && acute[v.charAt(0)]) v = acute[v.charAt(0)] + v.slice(1);
            return h + v + c;
        }).filter(Boolean).join('-');
    };

    const readingOf = (t) => ipaToVi(t && t.ipa) || ((t && t.vietSub) || '');

    /* ---------- Quick Paste: tách văn bản dán vào thành vocab / mcq (không cần AI) ---------- */
    const OPT_LINE = /^\s*\(?([A-Da-d])[.):]\s*(.+)$/;
    const ANS_LINE = /^\s*(?:đáp án|dap an|answer|ans|đa|key)\s*[:\-=]?\s*\(?([A-Da-d])\)?/i;
    const Q_HEAD = /^\s*(?:câu|cau|question|q)?\s*\d{1,4}\s*[.):\-]\s*/i;

    const parseMcqBlock = (lines) => {
        const opts = [];
        let answer = '';
        let explanation = '';
        const q = [];
        lines.forEach((ln) => {
            const a = ln.match(ANS_LINE);
            if (a) { answer = a[1].toUpperCase(); return; }
            const ex = ln.match(/^\s*(?:giải thích|giai thich|explanation|gt)\s*[:\-]\s*(.+)$/i);
            if (ex) { explanation = ex[1]; return; }
            const o = ln.match(OPT_LINE);
            if (o && opts.length < 4 && q.length) {
                let text = o[2].trim();
                if (/^\*|\*$|\(\s*đúng\s*\)$/i.test(text)) {
                    answer = answer || LETTERS[opts.length];
                    text = text.replace(/^\*\s*|\s*\*$|\s*\(\s*đúng\s*\)$/gi, '');
                }
                opts.push(text);
                return;
            }
            if (!opts.length) q.push(ln.replace(Q_HEAD, ''));
        });
        if (opts.length < 2 || !q.length) return null;
        return { type: 'mcq', questionOrWord: q.join(' ').trim(), options: opts, answerOrMeaning: answer, explanationOrExample: explanation };
    };

    const parseVocabLine = (ln) => {
        const line = ln.replace(/^\s*(?:[-•*]|\d{1,4}[.)])\s*/, '').trim();
        if (!line) return null;
        const parts = line.split(/\t|\s+[-–—=:|]\s+|\s*[:=|]\s+/);
        let left = (parts[0] || '').trim();
        const right = parts.slice(1).join(' - ').trim();
        let wordType = '';
        let ipa = '';
        const ip = left.match(/\/[^/]+\//);
        if (ip) { ipa = ip[0]; left = left.replace(ip[0], '').trim(); }
        const wt = left.match(/\(\s*(n|v|adj|adv|prep|conj|pron|interj|phr)\.?\s*\)/i);
        if (wt) { wordType = wt[1].toLowerCase(); left = left.replace(wt[0], '').trim(); }
        if (!left) return null;
        return { type: 'vocab', questionOrWord: left, answerOrMeaning: right, wordType: wordType, ipa: ipa };
    };

    const parseQuickPaste = (text, group) => {
        const raw = S.cleanText(text, S.LIMITS.pasteChars);
        if (!raw) return [];
        const lines = raw.split('\n');
        const out = [];
        let block = [];
        const flush = () => {
            if (!block.length) return;
            const hasOpts = block.filter((l) => OPT_LINE.test(l)).length >= 2;
            if (hasOpts) {
                const m = parseMcqBlock(block);
                if (m) out.push(m);
            } else {
                block.forEach((l) => { const v = parseVocabLine(l); if (v) out.push(v); });
            }
            block = [];
        };
        lines.forEach((ln) => {
            if (!ln.trim()) { flush(); return; }
            if (Q_HEAD.test(ln) && block.some((l) => OPT_LINE.test(l))) flush();
            block.push(ln);
        });
        flush();
        return out.slice(0, S.LIMITS.recordsPerImport).map((d) => normalizeItem(Object.assign(d, { group: group || '' })));
    };

    /* ---------- Excel ---------- */
    const EXCEL_HEADERS = ['STT', 'Loại', 'Nhóm', 'Chặng', 'Từ / Câu hỏi', 'Từ loại', 'IPA', 'Lựa chọn A', 'Lựa chọn B', 'Lựa chọn C', 'Lựa chọn D', 'Nghĩa / Đáp án', 'Ví dụ / Giải thích', 'Dịch ví dụ', 'Từ khóa', 'Cách đọc', 'Đúng', 'Sai', 'Tổng ôn'];

    const toExcelRow = (t, i) => [
        i + 1, t.type === 'mcq' ? 'MCQ' : 'Từ vựng', t.group, t.checkpoint, t.questionOrWord, t.wordType, t.ipa,
        t.options[0] || '', t.options[1] || '', t.options[2] || '', t.options[3] || '',
        t.answerOrMeaning, t.explanationOrExample, t.exampleVi, (t.keywords || []).join(', '), readingOf(t),
        t.correctCount || 0, t.wrongCount || 0, t.reviewCount || 0
    ];

    const HEADER_MAP = {
        'loại': 'type', 'type': 'type', 'nhóm': 'group', 'group': 'group', 'chặng': 'checkpoint', 'checkpoint': 'checkpoint',
        'từ / câu hỏi': 'questionOrWord', 'từ vựng': 'questionOrWord', 'câu hỏi': 'questionOrWord', 'questionorword': 'questionOrWord', 'question': 'questionOrWord', 'word': 'questionOrWord',
        'từ loại': 'wordType', 'wordtype': 'wordType', 'ipa': 'ipa',
        'lựa chọn a': 'optA', 'lựa chọn b': 'optB', 'lựa chọn c': 'optC', 'lựa chọn d': 'optD', 'a': 'optA', 'b': 'optB', 'c': 'optC', 'd': 'optD',
        'nghĩa / đáp án': 'answerOrMeaning', 'nghĩa': 'answerOrMeaning', 'đáp án': 'answerOrMeaning', 'answerormeaning': 'answerOrMeaning', 'answer': 'answerOrMeaning', 'meaning': 'answerOrMeaning',
        'ví dụ / giải thích': 'explanationOrExample', 'ngữ cảnh (en)': 'explanationOrExample', 'giải thích': 'explanationOrExample', 'explanationorexample': 'explanationOrExample', 'explanation': 'explanationOrExample', 'example': 'explanationOrExample',
        'dịch ví dụ': 'exampleVi', 'ngữ cảnh (vi)': 'exampleVi', 'examplevi': 'exampleVi',
        'từ khóa': 'keywords', 'keywords': 'keywords'
    };

    const fromExcelRows = (rows, group) => {
        if (!Array.isArray(rows) || rows.length < 2) return [];
        const head = rows[0].map((h) => HEADER_MAP[String(h || '').trim().toLowerCase()] || null);
        if (head.indexOf('questionOrWord') < 0) throw new Error('Không thấy cột "Từ / Câu hỏi" trong sheet đầu tiên');
        S.guardCount(rows.length - 1, 0);
        return rows.slice(1).map((r) => {
            const o = {};
            head.forEach((k, i) => { if (k) o[k] = r[i]; });
            const opts = [o.optA, o.optB, o.optC, o.optD];
            if (opts.some((x) => x != null && String(x).trim())) o.options = opts;
            if (typeof o.type === 'string') o.type = /mcq|trắc/i.test(o.type) ? 'mcq' : 'vocab';
            return normalizeItem(o, { group: group || '' });
        }).filter(isFilled);
    };

    /* ---------- Import JSON (mảng hoặc { items: [] }) ---------- */
    const itemsFromJSON = (data, defaults) => {
        const arr = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
        if (!arr) throw new Error('JSON phải là mảng hoặc có trường "items"');
        S.guardCount(arr.length, 0);
        return arr.filter((d) => d && typeof d === 'object').map((d) => normalizeItem(d, defaults));
    };

    EDU.Schema = {
        MAX, SRS_STEPS, LETTERS, WORD_TYPES,
        newId, normalizeItem, toShareable, isFilled, correctText,
        weakScore, isWeak, isDue, applyReview, reviewNote,
        hasVi, inLang,
        groupKey, groupLabel, inGroup, byGroup, matchGroup, groupColor,
        shuffle, normAnswer, blankOut, recallPromptOf,
        ipaToVi, readingOf,
        parseQuickPaste, EXCEL_HEADERS, toExcelRow, fromExcelRows, itemsFromJSON,
        cleanKeywords, cleanOptions
    };
})(window.EDU = window.EDU || {});
