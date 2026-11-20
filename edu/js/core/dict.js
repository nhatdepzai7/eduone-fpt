/* Gợi ý từ kiểu Google Translate cho ô nhập tiếng Anh ở Sổ từ. Không tốn lượt AI.
   1) Từ điển Anh-Việt có sẵn (js/data/dict-en-vi.json) + từ trong bộ đề Catalog, tải lần đầu rồi lưu IndexedDB.
   2) Từ hiếm không có trong đó: hỏi /api/dict (debounce do nơi gọi lo), nhớ kết quả trong phiên. */
(function (EDU) {
    const VERSION = 1;
    const DB = 'edu-dict';
    const STORE = 'kv';
    let list = null;
    let byWord = null;
    let loading = null;
    const remote = new Map();

    const idb = (mode, fn) => new Promise((resolve) => {
        if (!window.indexedDB) { resolve(null); return; }
        let req;
        try { req = indexedDB.open(DB, 1); } catch (e) { resolve(null); return; }
        req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch (e) { /* đã có */ } };
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
            try {
                const tx = req.result.transaction(STORE, mode);
                const out = fn(tx.objectStore(STORE));
                tx.oncomplete = () => { resolve(out && 'result' in out ? out.result : null); req.result.close(); };
                tx.onerror = () => { resolve(null); req.result.close(); };
            } catch (e) { resolve(null); }
        };
    });

    const parse = (rows) => rows.map((r) => {
        const p = String(r).split('|');
        return { w: p[0], t: p[1] || '', ipa: p[2] || '', vi: p[3] || '' };
    }).filter((e) => e.w);

    const fromCatalog = () => {
        const out = [];
        ((EDU.Catalog && EDU.Catalog.packs) || []).forEach((pk) => {
            if (pk.type !== 'vocab' || !Array.isArray(pk.free)) return;
            pk.free.forEach((d) => {
                const w = String(d.questionOrWord || '').trim();
                if (w && w.length <= 40) out.push({ w: w.toLowerCase(), t: d.wordType || '', ipa: d.ipa || '', vi: d.answerOrMeaning || '', ex: d.explanationOrExample || '' });
            });
        });
        return out;
    };

    const index = (entries) => {
        byWord = new Map();
        entries.concat(fromCatalog()).forEach((e) => { if (!byWord.has(e.w)) byWord.set(e.w, e); });
        list = Array.from(byWord.values()).sort((a, b) => (a.w < b.w ? -1 : a.w > b.w ? 1 : 0));
    };

    const load = () => {
        if (list) return Promise.resolve(list);
        if (loading) return loading;
        loading = (async () => {
            const cached = await idb('readonly', (s) => s.get('rows'));
            if (cached && cached.v === VERSION && Array.isArray(cached.rows)) {
                index(parse(cached.rows));
                return list;
            }
            try {
                const res = await fetch('/js/data/dict-en-vi.json?v=' + VERSION);
                const json = await res.json();
                const rows = Array.isArray(json.rows) ? json.rows : [];
                index(parse(rows));
                idb('readwrite', (s) => s.put({ v: VERSION, rows: rows }, 'rows'));
            } catch (e) {
                index([]);
            }
            return list;
        })();
        return loading;
    };

    /* Khớp đầu từ trước, rồi khớp trong cụm (vd "take" khớp "take off"). Tối đa 6 gợi ý. */
    const suggest = (q, max) => {
        const key = String(q || '').trim().toLowerCase();
        if (key.length < 2 || !list) return [];
        const n = max || 6;
        const head = [];
        const inner = [];
        for (let i = 0; i < list.length && head.length < n; i += 1) {
            const e = list[i];
            if (e.w.indexOf(key) === 0) head.push(e);
            else if (inner.length < n && e.w.indexOf(' ' + key) > 0) inner.push(e);
        }
        const out = head.concat(inner).slice(0, n);
        const r = remote.get(key);
        if (r && !out.length) out.push(r);
        return out.slice(0, n);
    };

    const exact = (q) => (byWord ? byWord.get(String(q || '').trim().toLowerCase()) || null : null);

    /* Tra từ hiếm qua server. Trả null khi không có hoặc lỗi mạng. */
    const lookup = async (q) => {
        const key = String(q || '').trim().toLowerCase();
        if (!/^[a-z][a-z' -]{1,39}$/.test(key)) return null;
        if (remote.has(key)) return remote.get(key);
        if (exact(key)) return exact(key);
        try {
            const res = await fetch('/api/dict?w=' + encodeURIComponent(key));
            if (!res.ok) return null;
            const d = await res.json();
            const e = d && d.found && d.meaning ? { w: key, t: d.wordType || '', ipa: d.ipa || '', vi: d.meaning, ex: d.example || '', online: true } : null;
            remote.set(key, e);
            return e;
        } catch (err) {
            return null;
        }
    };

    EDU.Dict = { load, suggest, lookup, exact, ready: () => !!list };
})(window.EDU = window.EDU || {});
