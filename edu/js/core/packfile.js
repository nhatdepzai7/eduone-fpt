(function (EDU) {
    'use strict';

    /*
     * File bộ đề trao tay. Admin tải file từ một môn đang có, gửi cho bạn.
     * Bạn nhập cùng file đó. Chặng đã mã hóa giữ nguyên; file mẫu góp đề chỉ có chặng viết tay.
     */

    const MAX_TEXT = 2000000;
    const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
    const BLOCKS = { it: 1, biz: 1, general: 1, lang: 1 };

    const clip = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

    const packId = (value) => clip(value, 32).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

    const downloadBlob = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const stageList = (stages) => {
        if (!Array.isArray(stages)) return [];
        return stages.map((stage) => ({
            n: Number(stage && stage.n),
            count: Math.max(0, Math.round(Number(stage && stage.count) || 0)),
            free: !!(stage && stage.free)
        })).filter((stage) => stage.n >= 1 && stage.n <= 3 && stage.count > 0).slice(0, 3);
    };

    const copyItem = (raw, fallbackId) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const type = raw.type === 'vocab' ? 'vocab' : 'mcq';
        const question = clip(raw.questionOrWord || raw.question || raw.q || raw.word, type === 'mcq' ? 1500 : 400);
        if (!question) return null;
        const options = (Array.isArray(raw.options) ? raw.options : (Array.isArray(raw.o) ? raw.o : []))
            .map((option) => clip(option, 500)).filter(Boolean).slice(0, 6);
        const item = {
            id: packId(raw.id) || fallbackId,
            checkpoint: [1, 2, 3].indexOf(Number(raw.checkpoint)) >= 0 ? Number(raw.checkpoint) : 1,
            group: clip(raw.group, 24),
            keywords: (Array.isArray(raw.keywords) ? raw.keywords : (Array.isArray(raw.k) ? raw.k : [])).map((word) => clip(word, 80)).filter(Boolean).slice(0, 8),
            type: options.length >= 2 ? 'mcq' : type,
            questionOrWord: question,
            wordType: clip(raw.wordType, 16),
            ipa: clip(raw.ipa, 80),
            options: options.length >= 2 ? options : [],
            answerOrMeaning: clip(raw.answerOrMeaning || raw.answer || raw.a, 400),
            explanationOrExample: clip(raw.explanationOrExample || raw.explanation || raw.e, 2500),
            exampleVi: clip(raw.exampleVi, 400)
        };
        if (item.type === 'mcq' && item.options.length < 2) return null;
        if (item.type === 'vocab' && !item.answerOrMeaning) return null;
        return item;
    };

    const lockedOf = (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        if (raw.v !== 1 || typeof raw.ct !== 'string' || raw.ct.length < 16 || raw.ct.length > 1500000) return null;
        if (typeof raw.iv !== 'string' || typeof raw.aad !== 'string' || !Array.isArray(raw.slots) || raw.slots.length < 1 || raw.slots.length > 6) return null;
        const slots = raw.slots.map((slot) => {
            if (!slot || typeof slot.salt !== 'string' || typeof slot.iv !== 'string' || typeof slot.wk !== 'string') return null;
            if (slot.salt.length > 80 || slot.iv.length > 80 || slot.wk.length > 200) return null;
            return { salt: slot.salt, iv: slot.iv, wk: slot.wk };
        });
        if (slots.some((slot) => !slot)) return null;
        return {
            v: 1,
            kdf: 'PBKDF2-SHA256',
            iter: Math.min(400000, Math.max(100000, Math.round(Number(raw.iter) || 210000))),
            aad: clip(raw.aad, 80),
            iv: raw.iv,
            ct: raw.ct,
            slots: slots
        };
    };

    const fromTemplate = (data) => {
        const stages = data.stages;
        if (!stages || Array.isArray(stages) || typeof stages !== 'object') return null;
        const id = packId(data.id);
        const free = [];
        [1, 2, 3].forEach((n) => {
            const list = stages[String(n)] || stages[n];
            if (!Array.isArray(list)) return;
            list.slice(0, 200).forEach((row, index) => {
                const item = copyItem(row, id + '-' + n + '-' + String(index + 1).padStart(3, '0'));
                if (!item) return;
                item.checkpoint = n;
                item.id = id + '-' + n + '-' + String(free.length + 1).padStart(3, '0');
                free.push(item);
            });
        });
        if (!free.length) return null;
        const counts = [1, 2, 3].map((n) => ({ n: n, count: free.filter((item) => item.checkpoint === n).length, free: true })).filter((stage) => stage.count);
        return finish({
            id: id,
            code: data.code,
            name: data.name,
            block: data.block,
            type: data.type,
            desc: data.desc,
            stages: counts,
            free: free
        });
    };

    const finish = (raw) => {
        const id = packId(raw.id);
        if (!ID.test(id)) throw new Error('Mã bộ đề không hợp lệ.');
        const free = (Array.isArray(raw.free) ? raw.free : []).slice(0, 400).map((item, index) => copyItem(item, id + '-1-' + String(index + 1).padStart(3, '0'))).filter(Boolean);
        const locked = lockedOf(raw.locked);
        if (!free.length && !locked) throw new Error('File chưa có câu hỏi.');
        const code = clip(raw.code, 16).toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
        if (code.length < 2) throw new Error('Thiếu mã môn.');
        const stages = stageList(raw.stages);
        const pack = {
            id: id,
            code: code,
            name: clip(raw.name, 80) || code,
            block: BLOCKS[raw.block] ? raw.block : 'general',
            type: raw.type === 'vocab' ? 'vocab' : 'mcq',
            desc: clip(raw.desc, 240),
            status: 'ready',
            source: 'file',
            stages: stages.length ? stages : [{ n: 1, count: free.length, free: true }],
            total: Math.max(free.length, stages.reduce((sum, stage) => sum + stage.count, 0)),
            free: free
        };
        if (locked) pack.locked = locked;
        return pack;
    };

    const parse = (text) => {
        const rawText = String(text || '');
        if (!rawText.trim()) throw new Error('File trống.');
        if (rawText.length > MAX_TEXT) throw new Error('File bộ đề quá lớn.');
        if (/sk-(?:proj-)?[A-Za-z0-9_-]{16,}/.test(rawText)) throw new Error('File đang chứa khóa bí mật. Hãy bỏ khóa ra rồi nhập lại.');
        let data;
        try { data = JSON.parse(rawText); } catch (e) { throw new Error('File không phải JSON.'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('File bộ đề không đúng định dạng.');
        if (data.kind === 'fpass-pack' || data.kind === 'eduone-pack') return finish(data.pack || {});
        if (data.stages && !Array.isArray(data.stages)) {
            const made = fromTemplate(data);
            if (made) return made;
        }
        return finish(data);
    };

    const download = (pack) => {
        if (!pack || pack.status !== 'ready') throw new Error('Môn này chưa có file để tải.');
        const body = {
            kind: 'fpass-pack',
            v: 1,
            pack: finish(pack)
        };
        const name = 'bo-de-' + body.pack.id + '.json';
        downloadBlob(new Blob([JSON.stringify(body)], { type: 'application/json' }), name);
        return name;
    };

    EDU.PackFile = { parse, download };
})(window.EDU = window.EDU || {});
