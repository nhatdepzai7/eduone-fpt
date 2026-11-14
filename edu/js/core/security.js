(function (EDU) {
    'use strict';

    const LIMITS = {
        importBytes: 5 * 1024 * 1024,
        shareCodeChars: 3 * 1024 * 1024,
        packBytes: 8 * 1024 * 1024,
        recordsPerImport: 5000,
        recordsTotal: 20000,
        pasteChars: 60000,
        aiPasteChars: 3000,
        jsonDepth: 8
    };

    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escapeHTML = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

    // eslint-disable-next-line no-control-regex
    const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

    const cleanText = (v, max) => {
        if (v == null) return '';
        let s = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
        s = s.replace(CONTROL, '').replace(/\r\n?/g, '\n');
        try { s = s.normalize('NFC'); } catch (e) {}
        s = s.trim();
        return max && s.length > max ? s.slice(0, max) : s;
    };

    const sanitizeHTML = (v, max) => escapeHTML(cleanText(v, max));

    const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const keywordPattern = (keywords) => {
        const ds = (Array.isArray(keywords) ? keywords : [])
            .map((k) => cleanText(k, 80))
            .filter((k) => k.length >= 2)
            .sort((a, b) => b.length - a.length)
            .slice(0, 24);
        if (!ds.length) return null;
        try { return new RegExp('(' + ds.map(escapeRegExp).join('|') + ')', 'giu'); } catch (e) { return null; }
    };

    const highlightSegments = (text, keywords) => {
        const s = String(text == null ? '' : text);
        const re = keywordPattern(keywords);
        if (!re || !s) return [{ t: s, hit: false }];
        const out = [];
        let last = 0;
        let m;
        while ((m = re.exec(s)) !== null) {
            if (m.index > last) out.push({ t: s.slice(last, m.index), hit: false });
            out.push({ t: m[0], hit: true });
            last = m.index + m[0].length;
            if (m[0].length === 0) re.lastIndex++;
        }
        if (last < s.length) out.push({ t: s.slice(last), hit: false });
        return out;
    };

    const highlightHTML = (text, keywords) => highlightSegments(text, keywords)
        .map((seg) => (seg.hit ? '<mark>' + escapeHTML(seg.t) + '</mark>' : escapeHTML(seg.t)))
        .join('');

    const SECRET_KEY = /(api[_-]?key|openai|secret|token|password|authorization|bearer|license|licen[cs]e[_-]?key)/i;
    const SECRET_VALUE = /\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/g;

    const stripSecrets = (value, depth) => {
        const d = depth || 0;
        if (d > LIMITS.jsonDepth) return undefined;
        if (typeof value === 'string') return value.replace(SECRET_VALUE, '[đã ẩn]');
        if (Array.isArray(value)) return value.map((v) => stripSecrets(v, d + 1));
        if (value && typeof value === 'object') {
            const out = {};
            Object.keys(value).forEach((k) => {
                if (SECRET_KEY.test(k)) return;
                const v = stripSecrets(value[k], d + 1);
                if (v !== undefined) out[k] = v;
            });
            return out;
        }
        return value;
    };

    const FORBIDDEN_KEYS = { __proto__: 1, constructor: 1, prototype: 1 };

    const safeJSONParse = (text, maxBytes) => {
        const s = String(text == null ? '' : text);
        const limit = maxBytes || LIMITS.importBytes;
        if (s.length > limit) throw new Error('Dữ liệu vượt giới hạn ' + Math.round(limit / 1024 / 1024) + ' MB');
        return JSON.parse(s, function (k, v) {
            if (Object.prototype.hasOwnProperty.call(FORBIDDEN_KEYS, k)) return undefined;
            return v;
        });
    };

    const checkFile = (file, maxBytes) => {
        if (!file) throw new Error('Không có file');
        const limit = maxBytes || LIMITS.importBytes;
        if (file.size > limit) throw new Error('File "' + cleanText(file.name, 80) + '" lớn hơn ' + Math.round(limit / 1024 / 1024) + ' MB');
        return true;
    };

    const readText = (file, maxBytes) => new Promise((resolve, reject) => {
        try { checkFile(file, maxBytes); } catch (e) { reject(e); return; }
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error || new Error('Không đọc được file'));
        r.readAsText(file);
    });

    const readBuffer = (file, maxBytes) => new Promise((resolve, reject) => {
        try { checkFile(file, maxBytes); } catch (e) { reject(e); return; }
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error('Không đọc được file'));
        r.readAsArrayBuffer(file);
    });

    const guardCount = (incoming, existing) => {
        if (incoming > LIMITS.recordsPerImport) {
            throw new Error('Mỗi lần nhập tối đa ' + LIMITS.recordsPerImport + ' bản ghi (file có ' + incoming + ')');
        }
        if ((existing || 0) + incoming > LIMITS.recordsTotal) {
            throw new Error('Kho tối đa ' + LIMITS.recordsTotal + ' bản ghi. Hãy xóa bớt hoặc tách kho.');
        }
        return true;
    };

    const ensureStorage = async (bytesNeeded) => {
        try {
            if (!navigator.storage || !navigator.storage.estimate) return { ok: true };
            const est = await navigator.storage.estimate();
            const free = (est.quota || 0) - (est.usage || 0);
            if (est.quota && free < bytesNeeded * 2) {
                return { ok: false, free: free, need: bytesNeeded };
            }
            return { ok: true, free: free };
        } catch (e) {
            return { ok: true };
        }
    };

    const isSafeHttpUrl = (u) => {
        try {
            const url = new URL(String(u));
            return url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname));
        } catch (e) {
            return false;
        }
    };

    EDU.Security = {
        LIMITS,
        escapeHTML,
        cleanText,
        sanitizeHTML,
        escapeRegExp,
        highlightSegments,
        highlightHTML,
        stripSecrets,
        safeJSONParse,
        checkFile,
        readText,
        readBuffer,
        guardCount,
        ensureStorage,
        isSafeHttpUrl
    };
})(window.EDU = window.EDU || {});
