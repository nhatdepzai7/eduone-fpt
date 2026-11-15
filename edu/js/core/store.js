(function (EDU) {
    'use strict';

    const DB_NAME = 'fpass';
    const DB_VERSION = 1;
    const STORES = {
        items: { keyPath: 'id', indexes: [['group', 'group'], ['type', 'type']] },
        progress: { keyPath: 'id', indexes: [['packId', 'packId']] },
        packs: { keyPath: 'id', indexes: [] }
    };
    const PREFIX = 'edu.';

    /* ---------- localStorage: cấu hình nhẹ ---------- */
    const prefs = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(PREFIX + key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch (e) {
                return fallback;
            }
        },
        set(key, value) {
            try {
                if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
                else localStorage.setItem(PREFIX + key, JSON.stringify(value));
                return true;
            } catch (e) {
                return false;
            }
        },
        remove(key) {
            try { localStorage.removeItem(PREFIX + key); } catch (e) {}
        }
    };

    /* Key OpenAI không bao giờ được nằm trên trình duyệt. Xóa key cũ nếu bản trước đã lưu. */
    const SECRET_RE = /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g;
    const scrubSecrets = () => {
        try {
            localStorage.removeItem('openaiKey');
            localStorage.removeItem(PREFIX + 'ai');
            localStorage.removeItem(PREFIX + 'device');
            const doomed = [];
            const redact = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                const v = k ? localStorage.getItem(k) : '';
                SECRET_RE.lastIndex = 0;
                if (!v || !SECRET_RE.test(v)) continue;
                if (v.length < 240) doomed.push(k);
                else redact.push(k);
            }
            doomed.forEach((k) => localStorage.removeItem(k));
            redact.forEach((k) => {
                SECRET_RE.lastIndex = 0;
                localStorage.setItem(k, localStorage.getItem(k).replace(SECRET_RE, ''));
            });
        } catch (e) {}
    };
    scrubSecrets();

    /* ---------- IndexedDB ---------- */
    let dbPromise = null;
    let fallback = null;

    const reqP = (req) => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    const copyRows = (fromDb, toDb, name) => new Promise((resolve, reject) => {
        if (!fromDb.objectStoreNames.contains(name) || !toDb.objectStoreNames.contains(name)) { resolve(0); return; }
        const read = fromDb.transaction(name, 'readonly').objectStore(name).getAll();
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
            const rows = read.result || [];
            if (!rows.length) { resolve(0); return; }
            const write = toDb.transaction(name, 'readwrite');
            rows.forEach((row) => write.objectStore(name).put(row));
            write.oncomplete = () => resolve(rows.length);
            write.onerror = () => reject(write.error);
        };
    });

    const adoptLegacy = (db) => new Promise((resolve) => {
        const count = db.transaction('items', 'readonly').objectStore('items').count();
        count.onerror = () => resolve();
        count.onsuccess = () => {
            if (count.result) { resolve(); return; }
            const oldReq = indexedDB.open('eduone');
            oldReq.onupgradeneeded = () => { try { oldReq.transaction.abort(); } catch (e) {} };
            oldReq.onerror = () => resolve();
            oldReq.onsuccess = () => {
                const old = oldReq.result;
                Promise.all(Object.keys(STORES).map((name) => copyRows(old, db, name))).then(() => {
                    old.close();
                    resolve();
                }, () => { old.close(); resolve(); });
            };
        };
    });

    const open = () => {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('no-idb')); return; }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                Object.keys(STORES).forEach((name) => {
                    if (db.objectStoreNames.contains(name)) return;
                    const os = db.createObjectStore(name, { keyPath: STORES[name].keyPath });
                    STORES[name].indexes.forEach(([n, k]) => os.createIndex(n, k, { unique: false }));
                });
            };
            req.onsuccess = () => {
                const db = req.result;
                adoptLegacy(db).then(() => resolve(db), () => resolve(db));
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IndexedDB bị chặn bởi tab khác'));
        }).catch((err) => {
            fallback = fallback || makeFallback();
            console.warn('IndexedDB không dùng được, chuyển sang bộ nhớ dự phòng:', err && err.message);
            return null;
        });
        return dbPromise;
    };

    const makeFallback = () => {
        const mem = {};
        Object.keys(STORES).forEach((n) => {
            mem[n] = new Map();
            (prefs.get('fallback.' + n, []) || []).forEach((r) => mem[n].set(r[STORES[n].keyPath], r));
        });
        const save = (n) => prefs.set('fallback.' + n, Array.from(mem[n].values()));
        return { mem, save };
    };

    const table = (name) => ({
        async all() {
            const db = await open();
            if (!db) return Array.from(fallback.mem[name].values());
            const tx = db.transaction(name, 'readonly');
            return reqP(tx.objectStore(name).getAll());
        },
        async byIndex(index, value) {
            const db = await open();
            if (!db) return Array.from(fallback.mem[name].values()).filter((r) => r[index] === value);
            const tx = db.transaction(name, 'readonly');
            return reqP(tx.objectStore(name).index(index).getAll(value));
        },
        async putMany(rows) {
            if (!rows || !rows.length) return;
            const db = await open();
            if (!db) {
                rows.forEach((r) => fallback.mem[name].set(r[STORES[name].keyPath], r));
                fallback.save(name);
                return;
            }
            await new Promise((resolve, reject) => {
                const tx = db.transaction(name, 'readwrite');
                const os = tx.objectStore(name);
                rows.forEach((r) => os.put(r));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('Ghi dữ liệu bị hủy (có thể đầy bộ nhớ)'));
            });
        },
        async deleteMany(keys) {
            if (!keys || !keys.length) return;
            const db = await open();
            if (!db) {
                keys.forEach((k) => fallback.mem[name].delete(k));
                fallback.save(name);
                return;
            }
            await new Promise((resolve, reject) => {
                const tx = db.transaction(name, 'readwrite');
                const os = tx.objectStore(name);
                keys.forEach((k) => os.delete(k));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        },
        async clear() {
            const db = await open();
            if (!db) {
                fallback.mem[name].clear();
                fallback.save(name);
                return;
            }
            await new Promise((resolve, reject) => {
                const tx = db.transaction(name, 'readwrite');
                tx.objectStore(name).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
    });

    /* Ghi chênh lệch giữa 2 phiên bản danh sách bất biến: chỉ put bản ghi đổi tham chiếu, xóa bản ghi biến mất. */
    const syncDiff = async (t, prev, next, keyOf) => {
        const key = keyOf || ((r) => r.id);
        const before = new Map((prev || []).map((r) => [key(r), r]));
        const changed = [];
        const seen = new Set();
        (next || []).forEach((r) => {
            const k = key(r);
            seen.add(k);
            if (before.get(k) !== r) changed.push(r);
        });
        const removed = [];
        before.forEach((_, k) => { if (!seen.has(k)) removed.push(k); });
        await t.putMany(changed);
        await t.deleteMany(removed);
        return { changed: changed.length, removed: removed.length };
    };

    const items = table('items');
    const progress = table('progress');
    const packs = table('packs');

    /* ---------- Migration từ bản cũ (localStorage 'tuVung', ids số) ---------- */
    const migrateLegacy = async () => {
        ['weeklyPlan', 'nextWeeklyPlan', 'hybridToday'].forEach((k) => {
            try {
                const v = localStorage.getItem(k);
                if (v == null) return;
                if (localStorage.getItem(PREFIX + k) == null) localStorage.setItem(PREFIX + k, v);
                localStorage.removeItem(k);
            } catch (e) {}
        });
        let legacy = null;
        try { legacy = localStorage.getItem('tuVung'); } catch (e) {}
        if (!legacy) return 0;
        const existing = await items.all();
        if (existing.length) return 0;
        let parsed;
        try { parsed = EDU.Security.safeJSONParse(legacy, 50 * 1024 * 1024); } catch (e) { return 0; }
        if (!Array.isArray(parsed)) return 0;
        const rows = parsed.map((d) => EDU.Schema.normalizeItem(d)).filter(EDU.Schema.isFilled);
        await items.putMany(rows);
        try {
            localStorage.setItem('tuVung.backup', legacy);
            localStorage.removeItem('tuVung');
        } catch (e) {}
        return rows.length;
    };

    const estimate = async () => {
        try {
            if (!navigator.storage || !navigator.storage.estimate) return null;
            return await navigator.storage.estimate();
        } catch (e) {
            return null;
        }
    };

    const requestPersist = async () => {
        try {
            if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
        } catch (e) {}
        return false;
    };

    EDU.Store = { prefs, scrubSecrets, items, progress, packs, syncDiff, migrateLegacy, estimate, requestPersist, open };
})(window.EDU = window.EDU || {});
