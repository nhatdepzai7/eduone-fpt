(function (EDU) {
    'use strict';
    const S = EDU.Security;
    const Sch = EDU.Schema;
    const Store = EDU.Store;

    /*
     * Mọi lệnh AI đi qua POST /api/ai cùng origin.
     * Trình duyệt không giữ key, không chọn model, không gửi system prompt.
     */
    const TIMEOUT_MS = 45000;
    const MIN_GAP_MS = 350;
    const MAX_ITEMS = 15;

    const ready = () => {
        try {
            return location.protocol === 'http:' || location.protocol === 'https:';
        } catch (e) {
            return false;
        }
    };

    const licenseKey = () => {
        const all = Store.prefs.get('licenses', {}) || {};
        const ids = Object.keys(all);
        for (let i = 0; i < ids.length; i++) {
            if (all[ids[i]]) return String(all[ids[i]]);
        }
        return '';
    };

    let lastCall = 0;
    let chain = Promise.resolve();
    const throttle = (fn) => {
        const run = chain.then(async () => {
            const wait = lastCall + MIN_GAP_MS - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            lastCall = Date.now();
            return fn();
        });
        chain = run.catch(() => {});
        return run;
    };

    const withTimeout = async (url, init) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            return await fetch(url, Object.assign({}, init, { signal: ctl.signal, credentials: 'same-origin' }));
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('AI phản hồi quá lâu, thử lại sau.');
            throw new Error('Không kết nối được dịch vụ AI.');
        } finally {
            clearTimeout(timer);
        }
    };

    const readError = async (res) => {
        let msg = 'AI lỗi ' + res.status;
        let body = null;
        try { body = await res.json(); } catch (e) {}
        if (body && typeof body.error === 'string') msg = S.cleanText(body.error, 200);
        if (res.status === 404) msg = 'Máy chủ này chưa có chức năng AI.';
        if (res.status === 429) msg = S.cleanText((body && body.error) || '', 200) || 'Đã hết lượt AI hôm nay.';
        if (res.status === 503) msg = 'Máy chủ chưa bật AI.';
        return new Error(msg);
    };

    const ask = (payload) => throttle(async () => {
        if (!ready()) throw new Error('AI chỉ chạy khi mở trang qua web, không mở file trực tiếp.');
        const res = await withTimeout('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ licenseKey: licenseKey() }, payload))
        });
        if (!res.ok) throw await readError(res);
        let data = null;
        try { data = await res.json(); } catch (e) { throw new Error('Máy chủ này chưa có chức năng AI.'); }
        return String((data && data.content) || '');
    });

    const asJSON = async (payload) => {
        const text = await ask(payload);
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('AI không trả về JSON hợp lệ.');
        return S.safeJSONParse(m[0], 2 * 1024 * 1024);
    };

    /* Chấm phát âm cần Whisper. Không gửi audio từ trình duyệt và không mở key. */
    const transcribe = async () => {
        throw new Error('Chấm phát âm tự động chưa mở trên máy chủ dùng chung. Hãy gõ từ.');
    };

    const enrichVocab = async (items) => {
        const input = items.slice(0, MAX_ITEMS).map((t) => ({
            id: t.id,
            word: t.questionOrWord,
            wordType: t.wordType,
            meaning: t.answerOrMeaning,
            example: t.explanationOrExample
        }));
        const json = await asJSON({ task: 'enrich', items: input });
        const out = {};
        (json.items || []).forEach((r) => {
            const id = S.cleanText(r.id, 80);
            if (!id) return;
            out[id] = {
                wordType: S.cleanText(r.wordType, Sch.MAX.wordType),
                answerOrMeaning: S.cleanText(r.meaning, Sch.MAX.answer),
                explanationOrExample: S.cleanText(r.example, Sch.MAX.explanation),
                exampleVi: S.cleanText(r.exampleVi, Sch.MAX.exampleVi),
                ipa: S.cleanText(r.ipa, Sch.MAX.ipa),
                keywords: Sch.cleanKeywords(r.keywords)
            };
        });
        return out;
    };

    const structurePaste = async (text, group) => {
        const raw = S.cleanText(text, S.LIMITS.aiPasteChars);
        const lineCount = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean).length;
        if (lineCount > 15) throw new Error('Mỗi lần AI chỉ nhận tối đa 15 dòng. Hãy dán từng phần.');
        const json = await asJSON({ task: 'structure', text: raw });
        const arr = Array.isArray(json.items) ? json.items.slice(0, 200) : [];
        return arr.map((r) => {
            const mcq = r.type === 'mcq';
            return Sch.normalizeItem({
                type: mcq ? 'mcq' : 'vocab',
                questionOrWord: mcq ? r.question : (r.word || r.question),
                options: mcq ? r.options : [],
                answerOrMeaning: mcq ? r.answer : r.meaning,
                explanationOrExample: mcq ? r.explanation : r.example,
                exampleVi: r.exampleVi,
                wordType: r.wordType,
                ipa: r.ipa,
                keywords: r.keywords,
                group: group || ''
            });
        }).filter(Sch.isFilled);
    };

    const recallPrompts = async (items) => {
        const input = items.slice(0, MAX_ITEMS).map((t) => ({
            id: t.id,
            word: t.questionOrWord,
            meaning: t.answerOrMeaning,
            example: t.explanationOrExample
        }));
        const json = await asJSON({ task: 'recall', items: input });
        const out = {};
        (json.items || json.muc || []).forEach((r) => {
            const src = items.find((t) => String(t.id) === String(r.id));
            const p = S.cleanText(r.prompt || r.cauHoi, Sch.MAX.recall);
            if (!src || !p) return;
            if (p.toLowerCase().indexOf(String(src.questionOrWord).toLowerCase()) >= 0) return;
            out[src.id] = p;
        });
        return out;
    };

    const gradeSentences = async (sentences, prompt) => {
        if (!ready()) return { ok: true, note: 'Đã nhận câu. AI chỉ chấm khi mở trang qua web.' };
        try {
            const list = (sentences || []).slice(0, MAX_ITEMS).map((c) => S.cleanText(c, 400));
            const j = await asJSON({ task: 'grade', sentences: list, instruction: S.cleanText(prompt, 300) });
            return { ok: !!j.ok, note: S.cleanText(j.note, 300) || (j.ok ? 'Câu ổn.' : 'Câu chưa đúng yêu cầu.') };
        } catch (e) {
            return { ok: false, note: e.message || 'Chưa gọi được AI. Thử lại.' };
        }
    };

    const explain = async (item) => {
        const j = await asJSON({
            task: 'explain',
            item: {
                question: item.questionOrWord,
                options: item.options,
                answer: item.answerOrMeaning
            }
        });
        return S.cleanText(j.explanation, Sch.MAX.explanation);
    };

    EDU.AI = { ready, transcribe, enrichVocab, structurePaste, recallPrompts, gradeSentences, explain };
})(window.EDU = window.EDU || {});
