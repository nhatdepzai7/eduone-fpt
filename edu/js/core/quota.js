(function (EDU) {
    'use strict';

    /*
     * Quỹ lượt thi. Mỗi trình duyệt mới có một mã riêng.
     * Mua và nộp bài trừ trên server: mọi máy dán cùng mã thì dùng chung một số còn lại.
     * Mã EDUF1 cũ vẫn nhận được, rồi số còn lại lấy từ server.
     */
    const KEY = 'fund';
    const UNIT = 5000;
    const PACKS = [
        { id: 'basic', name: 'Gói Cơ Bản', who: 'Cá nhân', turns: 20, off: 0 },
        { id: 'group', name: 'Gói Nhóm', who: 'Phòng KTX', turns: 100, off: 0.3 },
        { id: 'class', name: 'Gói Toàn Diện', who: 'Cả lớp / Ôn trọn kỳ', turns: 250, off: 0.5 }
    ];
    const VOCAB = {
        id: 'vocab',
        name: 'Gói Trợ Lý AI Từ Vựng & Đọc Hiểu Toàn Diện (Trọn Kỳ)',
        price: 29000,
        list: 59000,
        turns: 0
    };
    const AI_FREE = 100;
    const TURNS = { basic: 20, group: 100, class: 250 };
    const listeners = new Set();

    const priceOf = (pack) => Math.round(pack.turns * UNIT * (1 - pack.off));

    const cleanCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const mintCode = () => {
        const bytes = new Uint8Array(8);
        if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
        return out;
    };

    const validEvent = (ev) => {
        if (!ev || typeof ev !== 'object') return false;
        if (!/^[a-z0-9]{8,24}$/.test(ev.id)) return false;
        const t = Number(ev.t);
        if (!t || t < 1700000000000 || t > Date.now() + 86400000) return false;
        if (ev.kind === 'buy') {
            if (ev.pack === 'vocab' && ev.delta === 0) return true;
            if (TURNS[ev.pack] === ev.delta) return true;
            const grant = ev.delta;
            return ev.pack === 'admin' && grant === Math.floor(grant) && grant !== 0 && grant >= -5000 && grant <= 5000;
        }
        if (ev.kind === 'eos') return ev.delta === -1;
        return false;
    };

    const load = () => {
        const raw = EDU.Store.prefs.get(KEY, null);
        if (!raw || typeof raw !== 'object' || cleanCode(raw.code).length < 4) {
            const fresh = { code: mintCode(), balance: 0, history: [] };
            EDU.Store.prefs.set(KEY, fresh);
            return fresh;
        }
        const fund = {
            code: cleanCode(raw.code),
            balance: 0,
            history: [],
            aiUsed: Math.max(0, Math.floor(Number(raw.aiUsed)) || 0),
            aiUnlocked: raw.aiUnlocked === true,
            aiCredits: Math.max(0, Math.floor(Number(raw.aiCredits)) || 0),
            aiLimit: Math.max(AI_FREE, Math.floor(Number(raw.aiLimit)) || AI_FREE),
            scans: Math.max(0, Math.floor(Number(raw.scans)) || 0),
            scanGrant: Math.max(0, Math.floor(Number(raw.scanGrant)) || 0),
            proUntil: raw.proUntil === -1 ? -1 : Math.max(0, Math.floor(Number(raw.proUntil)) || 0)
        };
        const history = [];
        const seen = new Set();
        (Array.isArray(raw.history) ? raw.history : []).forEach((ev) => {
            if (!validEvent(ev) || seen.has(ev.id)) return;
            seen.add(ev.id);
            history.push({
                id: ev.id,
                t: ev.t,
                delta: ev.delta,
                kind: ev.kind,
                pack: ev.pack || '',
                note: EDU.Security.cleanText(ev.note || '', 80)
            });
        });
        history.sort((a, b) => b.t - a.t);
        fund.history = history.slice(0, 300);
        const sum = fund.history.reduce((n, ev) => n + (ev.delta || 0), 0);
        const stored = Math.floor(Number(raw.balance));
        fund.balance = Math.max(0, Number.isFinite(stored) ? stored : sum);
        return fund;
    };

    const save = (fund) => {
        fund.history = fund.history.slice(0, 300);
        fund.balance = Math.max(0, Math.floor(fund.balance));
        EDU.Store.prefs.set(KEY, fund);
        const snap = read();
        listeners.forEach((fn) => {
            try { fn(snap); } catch (e) {}
        });
        return snap;
    };

    const read = () => {
        const fund = load();
        return {
            code: fund.code,
            balance: fund.balance,
            history: fund.history.slice(),
            aiUsed: fund.aiUsed || 0,
            aiUnlocked: !!fund.aiUnlocked,
            aiCredits: fund.aiCredits || 0,
            aiLimit: fund.aiLimit || AI_FREE,
            scans: fund.scans || 0,
            scanGrant: fund.scanGrant || 0,
            proUntil: fund.proUntil === -1 ? -1 : Math.max(0, Math.floor(Number(fund.proUntil)) || 0)
        };
    };

    const subscribe = (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
    };

    const newId = (prefix) => (prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 24);

    const setCode = (value) => {
        const code = cleanCode(value);
        if (code.length < 4) throw new Error('Mã quỹ cần 4–12 chữ hoặc số.');
        const fund = load();
        if (fund.code !== code) {
            fund.code = code;
            fund.balance = 0;
            fund.history = [];
            fund.aiUsed = 0;
            fund.aiUnlocked = false;
            fund.aiCredits = 0;
            fund.aiLimit = AI_FREE;
            fund.scans = 0;
            fund.scanGrant = 0;
            fund.proUntil = 0;
        }
        return save(fund);
    };

    const BANK = {
        bin: 'TPB',
        name: 'TPBank',
        account: '10006548943',
        holder: 'NGUYEN VAN NHAT'
    };

    const memoOf = (code) => 'EDU ' + cleanCode(code);

    const qrUrl = (amount, code) => {
        const money = Math.round(Number(amount) || 0);
        return 'https://img.vietqr.io/image/TPB-10006548943-compact2.png?amount=' + money + '&addInfo=' + encodeURIComponent(memoOf(code));
    };

    const applyPurchases = (list) => {
        const fund = load();
        const seen = new Set(fund.history.map((ev) => ev.id));
        let added = 0;
        (Array.isArray(list) ? list : []).forEach((ev) => {
            if (!validEvent(ev) || ev.kind !== 'buy' || seen.has(ev.id)) return;
            seen.add(ev.id);
            fund.history.push({
                id: ev.id,
                t: ev.t,
                delta: ev.delta,
                kind: 'buy',
                pack: ev.pack || '',
                note: EDU.Security.cleanText(ev.note || '', 80)
            });
            fund.balance += ev.delta;
            added += ev.delta;
        });
        fund.history.sort((a, b) => b.t - a.t);
        const snap = save(fund);
        return { code: snap.code, balance: snap.balance, added };
    };

    let syncedOnce = false;

    const noteAi = (info) => {
        if (!info || typeof info !== 'object') return read();
        const fund = load();
        const before = !!fund.aiUnlocked;
        const beforeCredits = fund.aiCredits || 0;
        if (info.aiUnlocked === true || info.unlocked === true) fund.aiUnlocked = true;
        if (info.aiUnlocked === false || info.unlocked === false) fund.aiUnlocked = false;
        const used = Number(info.aiUsed != null ? info.aiUsed : info.used);
        if (Number.isFinite(used)) fund.aiUsed = Math.max(0, Math.floor(used));
        ['aiCredits', 'aiLimit', 'scans', 'scanGrant'].forEach((key) => {
            const n = Number(info[key]);
            if (Number.isFinite(n)) fund[key] = Math.max(0, Math.floor(n));
        });
        if (info.proUntil != null && info.proUntil !== '') {
            const until = Number(info.proUntil);
            fund.proUntil = until === -1 ? -1 : (Number.isFinite(until) ? Math.max(0, Math.floor(until)) : 0);
        }
        const snap = save(fund);
        return { code: snap.code, aiUsed: snap.aiUsed, aiUnlocked: snap.aiUnlocked, aiCredits: snap.aiCredits || 0, aiJustUnlocked: snap.aiUnlocked && !before, aiJustFunded: (snap.aiCredits || 0) > beforeCredits };
    };

    const applyServer = (state) => {
        const fund = load();
        const wasUnlocked = !!fund.aiUnlocked;
        const seen = new Set(fund.history.map((ev) => ev.id));
        let added = 0;
        let fresh = 0;
        let freshBuys = 0;
        (Array.isArray(state.events) ? state.events : []).forEach((ev) => {
            if (!validEvent(ev) || seen.has(ev.id)) return;
            seen.add(ev.id);
            fresh += 1;
            fund.history.push({
                id: ev.id,
                t: ev.t,
                delta: ev.delta,
                kind: ev.kind,
                pack: ev.pack || '',
                note: EDU.Security.cleanText(ev.note || '', 80)
            });
            if (ev.kind === 'buy' && ev.delta > 0) {
                added += ev.delta;
                freshBuys += 1;
            }
        });
        let remaining = Number(state.balance);
        if (syncedOnce && Number.isFinite(remaining) && remaining > fund.balance && !freshBuys) remaining = fund.balance;
        if (!fresh && Number.isFinite(remaining) && Math.floor(remaining) === fund.balance) {
            syncedOnce = true;
            const ai = noteAi(state);
            return { code: fund.code, balance: fund.balance, added: 0, aiUnlocked: ai.aiUnlocked, aiJustUnlocked: !!ai.aiJustUnlocked, aiJustFunded: !!ai.aiJustFunded };
        }
        if (Number.isFinite(remaining)) fund.balance = Math.max(0, Math.floor(remaining));
        fund.history.sort((a, b) => b.t - a.t);
        syncedOnce = true;
        const snap = save(fund);
        const ai = noteAi(state);
        return { code: snap.code, balance: snap.balance, added, aiUnlocked: ai.aiUnlocked, aiJustUnlocked: !!ai.aiJustUnlocked, aiJustFunded: !!ai.aiJustFunded };
    };

    const sync = async () => {
        const code = load().code;
        let res;
        try {
            res = await fetch('/api/fund?code=' + encodeURIComponent(code), { headers: { Accept: 'application/json' } });
        } catch (e) {
            throw new Error('Chưa kiểm tra được thanh toán.');
        }
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (!res.ok || !data) {
            throw new Error(res.status === 503 ? 'Máy chủ chưa nối sổ quỹ. Lượt sẽ cộng khi SePay ghi được giao dịch.' : 'Chưa kiểm tra được thanh toán.');
        }
        if (Number.isFinite(Number(data.balance)) || Array.isArray(data.events)) {
            return applyServer({
                balance: data.balance,
                events: Array.isArray(data.events) ? data.events : data.purchases,
                aiUsed: data.aiUsed,
                aiUnlocked: data.aiUnlocked,
                aiCredits: data.aiCredits,
                aiLimit: data.aiLimit,
                scans: data.scans,
                scanGrant: data.scanGrant,
                proUntil: data.proUntil
            });
        }
        if (Array.isArray(data.purchases)) return applyPurchases(data.purchases);
        throw new Error('Chưa kiểm tra được thanh toán.');
    };

    const spend = async (note) => {
        syncedOnce = true;
        const fund = load();
        const id = newId('e');
        const cleanNote = EDU.Security.cleanText(note || 'Nộp bài EOS', 80);
        let res;
        try {
            res = await fetch('/api/fund', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ code: fund.code, id, note: cleanNote })
            });
        } catch (e) {
            throw new Error('Chưa trừ được lượt. Kiểm tra mạng rồi nộp lại.');
        }
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (res.status === 409) {
            const empty = load();
            empty.balance = 0;
            save(empty);
            return null;
        }
        if (!res.ok || !data || data.ok !== true || !Number.isFinite(Number(data.balance))) {
            throw new Error(res.status === 503 ? 'Máy chủ chưa nối sổ quỹ, lượt chưa bị trừ.' : 'Chưa trừ được lượt.');
        }
        const next = load();
        if (!next.history.some((ev) => ev.id === id)) {
            next.history.unshift({ id, t: Date.now(), delta: -1, kind: 'eos', pack: '', note: cleanNote });
        }
        next.balance = Math.max(0, Math.floor(Number(data.balance)));
        return save(next);
    };

    const encode = (fund) => {
        const json = JSON.stringify({ v: 1, code: fund.code, balance: fund.balance, history: fund.history.slice(0, 120) });
        const bytes = new TextEncoder().encode(json);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return 'EDUF1.' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };

    const decode = (code) => {
        const raw = String(code || '').trim().replace(/^EDUF1\./i, '').replace(/\s+/g, '');
        if (!raw || raw.length > 20000) throw new Error('Mã quỹ không hợp lệ.');
        const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64 + '==='.slice((b64.length + 3) % 4);
        let bin;
        try { bin = atob(pad); } catch (e) { throw new Error('Mã quỹ không hợp lệ.'); }
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        let data;
        try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { throw new Error('Mã quỹ không hợp lệ.'); }
        if (!data || data.v !== 1) throw new Error('Mã quỹ không hợp lệ.');
        return data;
    };

    const importCode = (code) => {
        const data = decode(code);
        const fund = load();
        const incomingCode = cleanCode(data.code);
        if (incomingCode.length >= 4) fund.code = incomingCode;
        const seen = new Set(fund.history.map((ev) => ev.id));
        let added = 0;
        (Array.isArray(data.history) ? data.history : []).forEach((ev) => {
            if (!validEvent(ev) || seen.has(ev.id)) return;
            seen.add(ev.id);
            fund.history.push({
                id: ev.id,
                t: ev.t,
                delta: ev.delta,
                kind: ev.kind,
                pack: ev.pack || '',
                note: EDU.Security.cleanText(ev.note || '', 80)
            });
            fund.balance = Math.max(0, fund.balance + ev.delta);
            added += ev.delta;
        });
        fund.history.sort((a, b) => b.t - a.t);
        const snap = save(fund);
        return { code: snap.code, balance: snap.balance, added };
    };

    const openShop = () => {
        try { window.dispatchEvent(new CustomEvent('edu-fund-shop')); } catch (e) {}
    };

    EDU.Quota = {
        UNIT,
        packs: PACKS.map((p) => Object.assign({ price: priceOf(p), list: p.turns * UNIT }, p)),
        vocab: VOCAB,
        AI_FREE,
        read,
        subscribe,
        balance: () => load().balance,
        BANK,
        memoOf,
        qrUrl,
        setCode,
        sync,
        spend,
        noteAi,
        aiFillAllowed: () => {
            const fund = load();
            const until = Number(fund.proUntil);
            const pro = until === -1 || until > Date.now();
            return pro || !!fund.aiUnlocked || (fund.aiUsed || 0) < AI_FREE;
        },
        exportCode: () => encode(load()),
        importCode,
        openShop
    };
})(window.EDU = window.EDU || {});
