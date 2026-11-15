(function (EDU) {
    'use strict';

    /*
     * Quỹ lượt thi dùng chung trên trình duyệt này.
     * Không gắn máy. Lượt không hết hạn: mua thêm là cộng vào số dư.
     * Máy khác nhận cùng quỹ khi dán mã EDUF1 (sổ cái các lần mua và lần nộp).
     */
    const KEY = 'fund';
    const UNIT = 5000;
    const PACKS = [
        { id: 'basic', name: 'Gói Cơ Bản', who: 'Cá nhân', turns: 20, off: 0 },
        { id: 'group', name: 'Gói Nhóm', who: 'Phòng KTX', turns: 100, off: 0.3 },
        { id: 'class', name: 'Gói Đại Gia', who: 'Cả lớp / Ôn trọn kỳ', turns: 250, off: 0.5 }
    ];
    const TURNS = { basic: 20, group: 100, class: 250 };
    const listeners = new Set();

    const priceOf = (pack) => Math.round(pack.turns * UNIT * (1 - pack.off));

    const blank = () => ({ code: 'CHUNG', balance: 0, history: [] });

    const cleanCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

    const validEvent = (ev) => {
        if (!ev || typeof ev !== 'object') return false;
        if (!/^[a-z0-9]{8,24}$/.test(ev.id)) return false;
        const t = Number(ev.t);
        if (!t || t < 1700000000000 || t > Date.now() + 86400000) return false;
        if (ev.kind === 'buy') return TURNS[ev.pack] === ev.delta;
        if (ev.kind === 'eos') return ev.delta === -1;
        return false;
    };

    const load = () => {
        const raw = EDU.Store.prefs.get(KEY, null);
        const fund = blank();
        if (!raw || typeof raw !== 'object') return fund;
        const code = cleanCode(raw.code);
        if (code.length >= 4) fund.code = code;
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
        const sum = fund.history.reduce((n, ev) => n + ev.delta, 0);
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
        return { code: fund.code, balance: fund.balance, history: fund.history.slice() };
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
        fund.code = code;
        return save(fund);
    };

    const buy = (packId) => {
        const pack = PACKS.find((p) => p.id === packId);
        if (!pack) throw new Error('Gói không hợp lệ.');
        const fund = load();
        fund.history.unshift({
            id: newId('b'),
            t: Date.now(),
            delta: pack.turns,
            kind: 'buy',
            pack: pack.id,
            note: pack.name
        });
        fund.balance += pack.turns;
        return save(fund);
    };

    const spend = (note) => {
        const fund = load();
        if (fund.balance < 1) return null;
        fund.history.unshift({
            id: newId('e'),
            t: Date.now(),
            delta: -1,
            kind: 'eos',
            pack: '',
            note: EDU.Security.cleanText(note || 'Nộp bài EOS', 80)
        });
        fund.balance -= 1;
        return save(fund);
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
        read,
        subscribe,
        balance: () => load().balance,
        setCode,
        buy,
        spend,
        exportCode: () => encode(load()),
        importCode,
        openShop
    };
})(window.EDU = window.EDU || {});
