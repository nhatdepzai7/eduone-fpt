(function (EDU) {
    'use strict';
    const Sch = EDU.Schema;

    /* =====================================================================
     * Nav — máy trạng thái điều hướng toàn app (không reload trang)
     * mode: 'self' (Tự nhập & học hằng ngày) | 'bank' (Kho data sẵn)
     * ===================================================================== */
    const Nav = {
        initial(savedMode) {
            return { mode: savedMode === 'bank' ? 'bank' : 'self', tab: 'today', view: 'shelf', packId: null, block: 'it', busy: false };
        },
        reduce(s, ev) {
            if (s.busy && !ev.force && ['SWITCH_MODE', 'TAB', 'SHELF', 'OPEN_PACK'].indexOf(ev.type) >= 0) return s;
            switch (ev.type) {
                case 'SWITCH_MODE': return Object.assign({}, s, { mode: ev.mode, busy: false });
                case 'TAB': return Object.assign({}, s, { mode: 'self', tab: ev.tab, busy: false });
                case 'ZERO_CLICK': return s.busy ? s : Object.assign({}, s, { mode: 'self', tab: 'today' });
                case 'BLOCK': return Object.assign({}, s, { block: ev.block });
                case 'OPEN_PACK': return Object.assign({}, s, { mode: 'bank', view: 'pack', packId: ev.id, busy: false });
                case 'PACK_VIEW': return Object.assign({}, s, { view: ev.view, busy: ev.view === 'eos' || ev.view === 'burst' });
                case 'SHELF': return Object.assign({}, s, { mode: 'bank', view: 'shelf', packId: null, busy: false });
                case 'RELEASE': return Object.assign({}, s, { busy: false });
                default: return s;
            }
        }
    };

    /* =====================================================================
     * Time helpers
     * ===================================================================== */
    const z = (n) => String(n).padStart(2, '0');
    const dayKeyOf = (d) => d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
    const minutesOf = (hhmm) => {
        const p = String(hhmm || '00:00').split(':');
        return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
    };
    const hhmmOf = (min) => {
        const p = Math.max(0, Math.min(min, 23 * 60 + 59));
        return z(Math.floor(p / 60)) + ':' + z(p % 60);
    };
    const fmtCountdown = (ms) => {
        const s = Math.max(0, Math.ceil(ms / 1000));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return (h ? h + ':' : '') + z(m) + ':' + z(s % 60);
    };
    const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const WEEK_LABEL = { monday: 'Thứ 2', tuesday: 'Thứ 3', wednesday: 'Thứ 4', thursday: 'Thứ 5', friday: 'Thứ 6', saturday: 'Thứ 7', sunday: 'Chủ nhật' };
    const weekdayOf = (d) => ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()];

    /* Bộ đếm nhịp chạy trong Web Worker: không bị trình duyệt bóp như setInterval ở tab nền. */
    const createTicker = (onTick) => {
        let worker = null;
        let timer = null;
        try {
            const blob = new Blob(['setInterval(function(){postMessage(Date.now())},1000)'], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            worker = new Worker(url);
            URL.revokeObjectURL(url);
            worker.onmessage = () => onTick(Date.now());
        } catch (e) {
            timer = setInterval(() => onTick(Date.now()), 1000);
        }
        const onVis = () => onTick(Date.now());
        document.addEventListener('visibilitychange', onVis);
        window.addEventListener('focus', onVis);
        return () => {
            if (worker) worker.terminate();
            if (timer) clearInterval(timer);
            document.removeEventListener('visibilitychange', onVis);
            window.removeEventListener('focus', onVis);
        };
    };

    /* =====================================================================
     * Plan — "Một ngày có điểm dừng": 3 ca/ngày, khóa plan trong ngày (Ulysses)
     * ===================================================================== */
    const SLOT_MODES = ['flashcard', 'test', 'weak', 'burst'];
    const MODE_LABEL = { flashcard: 'Flashcard', test: 'Điền từ', weak: 'Ôn từ yếu', burst: 'Băng đạn 5 câu' };

    const makeSlot = (id, time, anchor, group, mode, cardCount, ext) => ({
        id: id,
        time: time,
        anchorLabel: anchor,
        phase1_inApp: { group: group, mode: mode, cardCount: cardCount },
        phase2_externalTask: {
            hasExternal: !!(ext && ext.book),
            bookTitle: (ext && ext.book) || '',
            taskDetail: (ext && ext.task) || '',
            classSyncNote: (ext && ext.note) || '',
            durationMinutes: ext && ext.book ? (ext.phut || 25) : 0
        },
        phase3_verificationGate: {
            gateType: (ext && ext.gate) || 'sentence_creation',
            prompt: (ext && ext.prompt) || '',
            sentenceCount: (ext && ext.cau) || 1,
            minWords: (ext && ext.min) || 2
        },
        dienTam: !!(ext && ext.dienTam)
    });
    const blankDay = () => [
        makeSlot(1, '08:00', 'Sáng', 'all', 'flashcard', 8, {}),
        makeSlot(2, '13:00', 'Chiều', 'all', 'flashcard', 8, {}),
        makeSlot(3, '20:00', 'Tối', 'all', 'flashcard', 8, {})
    ];

    const defaultWeek = () => {
        const days = {};
        WEEK.forEach((key) => { days[key] = blankDay(); });
        return { version: 2, title: 'Tuần của bạn', days: days };
    };

    const normGroup = (g) => (g === 'tat-ca' || !g ? 'all' : g === '__trong' ? '__none' : g);

    const normSlot = (s, i) => {
        const p1 = (s && s.phase1_inApp) || {};
        const p2 = (s && s.phase2_externalTask) || {};
        const p3 = (s && s.phase3_verificationGate) || {};
        const group = normGroup(p1.group || (s && s.group));
        const mode = SLOT_MODES.indexOf(p1.mode || (s && s.mode)) >= 0 ? (p1.mode || s.mode) : 'flashcard';
        const cardCount = Math.max(1, Math.min(40, Number(p1.cardCount || (s && s.baseCardCount)) || 8));
        const hasBook = !!(p2.hasExternal && (p2.bookTitle || p2.taskDetail));
        return {
            id: [1, 2, 3].indexOf(s && s.id) >= 0 ? s.id : (i + 1),
            time: /^\d{2}:\d{2}$/.test(s && s.time) ? s.time : ['08:00', '13:00', '20:00'][i] || '08:00',
            anchorLabel: String((s && s.anchorLabel) || '').trim().slice(0, 60) || (['Sáng', 'Chiều', 'Tối'][i] || ('Ca ' + (i + 1))),
            group: group,
            mode: mode,
            baseCardCount: cardCount,
            phase1_inApp: { group: group, mode: mode, cardCount: cardCount },
            phase2_externalTask: {
                hasExternal: hasBook,
                bookTitle: String(p2.bookTitle || '').slice(0, 120),
                taskDetail: String(p2.taskDetail || '').slice(0, 300),
                classSyncNote: String(p2.classSyncNote || '').slice(0, 200),
                durationMinutes: Math.max(0, Math.min(180, Number(p2.durationMinutes) || 0))
            },
            phase3_verificationGate: {
                gateType: p3.gateType === 'harvest_words' ? 'harvest_words' : 'sentence_creation',
                prompt: String(p3.prompt || '').slice(0, 300),
                sentenceCount: Math.max(1, Math.min(3, Number(p3.sentenceCount) || 1)),
                minWords: Math.max(2, Math.min(5, Number(p3.minWords) || 2))
            },
            dienTam: !!(s && s.dienTam),
            nghi: !!(s && s.nghi),
            status: s && (s.status === 'done' || s.status === 'phase2') ? s.status : 'pending',
            snoozedOnce: !!(s && s.snoozedOnce),
            snoozeMin: s && s.snoozeMin != null ? s.snoozeMin : (s && s.snoozePhut != null ? s.snoozePhut : null),
            finishedAt: (s && s.finishedAt) || null,
            phase2StartedAt: (s && s.phase2StartedAt) || null,
            cardsDone: (s && s.cardsDone) || 0,
            remembered: (s && s.remembered) || 0,
            deckIds: (s && Array.isArray(s.deckIds)) ? s.deckIds.map(String) : null
        };
    };

    const isValidWeek = (w) => !!(w && w.days && WEEK.every((k) => Array.isArray(w.days[k]) && w.days[k].length === 3));

    const FRESH = { status: 'pending', deckIds: null, snoozedOnce: false, snoozeMin: null, snoozePhut: null, finishedAt: null, phase2StartedAt: null, cardsDone: 0, remembered: 0 };

    const normWeek = (w) => {
        const src = isValidWeek(w) ? w : defaultWeek();
        const days = {};
        WEEK.forEach((k) => {
            days[k] = src.days[k].map((s, i) => normSlot(Object.assign({}, s, FRESH), i));
        });
        return { version: 2, title: String((src && src.title) || 'Tuần').slice(0, 60), days: days };
    };

    const buildDay = (raw, date, dayKey, keepState) => {
        const slots = ((raw && raw.slots) || []).map((s, i) => normSlot(keepState ? s : Object.assign({}, s, FRESH), i));
        return { date: date, dayKey: dayKey, slots: slots.sort((a, b) => a.id - b.id) };
    };

    const triggerMin = (slot) => (slot.snoozedOnce && slot.snoozeMin != null ? slot.snoozeMin : minutesOf(slot.time));

    const slotStatus = (slot, now) => {
        if (slot.nghi || slot.status === 'done') return 'DONE';
        const start = triggerMin(slot);
        const cur = now.getHours() * 60 + now.getMinutes();
        if (cur < start - 30) return 'STANDBY';
        if (cur < start) return 'EARLY';
        if (cur < start + 30) return 'ON_TIME';
        return 'LATE';
    };

    const cardLimit = (slot, kind, minimal) => {
        const base = (slot && slot.baseCardCount) || 8;
        if (kind === 'LATE_RECOVERY') return minimal ? Math.min(2, base) : Math.min(5, base);
        return base;
    };

    const currentSlot = (slots, now) => {
        const gate = slots.find((s) => !s.nghi && s.status === 'phase2');
        if (gate) return { kind: 'GATE', slot: gate, early: false };
        const pending = slots.filter((s) => !s.nghi && s.status !== 'done');
        if (!pending.length) return { kind: 'ALL_DONE', slot: null, early: false };
        const ds = pending.map((s) => ({ slot: s, st: slotStatus(s, now) }));
        const opened = ds.filter((x) => x.st === 'EARLY' || x.st === 'ON_TIME' || x.st === 'LATE').sort((a, b) => triggerMin(a.slot) - triggerMin(b.slot));
        const live = opened.length ? opened[opened.length - 1] : null;
        if (live && live.st === 'ON_TIME') return { kind: 'ON_TIME_ACTIVE', slot: live.slot, early: false };
        if (live && live.st === 'LATE') return { kind: 'LATE_RECOVERY', slot: live.slot, early: false };
        if (live && live.st === 'EARLY') return { kind: 'STANDBY', slot: live.slot, early: true };
        const next = ds.slice().sort((a, b) => triggerMin(a.slot) - triggerMin(b.slot))[0];
        return { kind: 'STANDBY', slot: next.slot, early: false };
    };

    const buildDeck = (slot, items, limit) => {
        const pool = Sch.byGroup(items, Sch.matchGroup(slot.group || 'all', items.map(Sch.groupKey)));
        const map = new Map(pool.map((t) => [t.id, t]));
        const weakSort = (arr) => arr.slice().sort((a, b) => Sch.weakScore(b) - Sch.weakScore(a));
        let order;
        if (slot.deckIds && slot.deckIds.length) {
            const kept = slot.deckIds.map((id) => map.get(id)).filter(Boolean);
            const rest = pool.filter((t) => slot.deckIds.indexOf(t.id) < 0);
            order = kept.concat(slot.mode === 'weak' ? weakSort(rest) : Sch.shuffle(rest));
        } else if (slot.mode === 'weak') {
            const weak = weakSort(pool.filter((t) => Sch.isWeak(t)));
            order = weak.length ? weak : weakSort(pool);
        } else {
            order = Sch.shuffle(pool);
        }
        return order.slice(0, limit);
    };

    const Plan = {
        WEEK, WEEK_LABEL, MODE_LABEL, SLOT_MODES,
        defaultWeek, normSlot, normWeek, isValidWeek, buildDay, triggerMin, slotStatus, cardLimit, currentSlot, buildDeck,
        dayKeyOf, weekdayOf, minutesOf, hhmmOf, fmtCountdown
    };

    /* =====================================================================
     * Burst — "Băng đạn 5 câu": preview 15s → phản xạ → sai thì nhồi lại cuối băng
     * ===================================================================== */
    const BURST_SIZE = 5;
    const PREVIEW_MS = 15000;
    const RETRY_MS = 15000;

    const chunk = (arr, n) => {
        const out = [];
        for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
        return out;
    };

    const Burst = {
        SIZE: BURST_SIZE, PREVIEW_MS, RETRY_MS,
        init(ids, opts) {
            const o = opts || {};
            const batches = chunk(ids.slice(), o.size || BURST_SIZE);
            return {
                batches: batches,
                b: 0,
                phase: batches.length ? (o.skipPreview ? 'drill' : 'preview') : 'done',
                queue: batches.length ? batches[0].slice() : [],
                retryAt: {},
                firstTry: {},
                misses: {},
                cleared: [],
                startedAt: Date.now()
            };
        },
        head(s, now) {
            if (s.phase !== 'drill' || !s.queue.length) return { id: null, waitMs: 0 };
            const t = now || Date.now();
            const ready = s.queue.find((id) => !(s.retryAt[id] > t));
            if (ready != null) return { id: ready, waitMs: 0 };
            const id = s.queue[0];
            return { id: id, waitMs: Math.max(0, s.retryAt[id] - t) };
        },
        reduce(s, a) {
            switch (a.type) {
                case 'START_DRILL':
                    return s.phase === 'preview' ? Object.assign({}, s, { phase: 'drill' }) : s;
                case 'ANSWER': {
                    if (s.phase !== 'drill') return s;
                    const id = a.id;
                    if (s.queue.indexOf(id) < 0) return s;
                    const firstTry = Object.assign({}, s.firstTry);
                    if (firstTry[id] === undefined) firstTry[id] = !!a.correct;
                    const rest = s.queue.filter((x) => x !== id);
                    if (a.correct) {
                        const cleared = s.cleared.concat(id);
                        const phase = rest.length ? 'drill' : (s.b < s.batches.length - 1 ? 'batchDone' : 'done');
                        return Object.assign({}, s, { queue: rest, cleared: cleared, firstTry: firstTry, phase: phase });
                    }
                    const retryAt = Object.assign({}, s.retryAt, { [id]: (a.now || Date.now()) + RETRY_MS });
                    const misses = Object.assign({}, s.misses, { [id]: (s.misses[id] || 0) + 1 });
                    return Object.assign({}, s, { queue: rest.concat(id), retryAt: retryAt, misses: misses, firstTry: firstTry });
                }
                case 'NEXT_BATCH': {
                    if (s.phase !== 'batchDone') return s;
                    const b = s.b + 1;
                    return Object.assign({}, s, { b: b, queue: s.batches[b].slice(), phase: a.skipPreview ? 'drill' : 'preview' });
                }
                default:
                    return s;
            }
        },
        stats(s) {
            const ids = Object.keys(s.firstTry);
            const ok = ids.filter((id) => s.firstTry[id]).length;
            return {
                total: s.batches.reduce((n, b) => n + b.length, 0),
                answered: ids.length,
                firstTryCorrect: ok,
                missed: ids.filter((id) => !s.firstTry[id]),
                elapsedMs: Date.now() - s.startedAt
            };
        }
    };

    /* =====================================================================
     * Panic-to-Action Divider — chia nỗi sợ mùa thi thành ca 10 phút
     * ===================================================================== */
    const Panic = {
        SESSION_MIN: 10,
        plan(opts) {
            const remaining = Math.max(0, opts.remaining | 0);
            const hoursLeft = Math.max(1, Number(opts.hoursLeft) || 1);
            const awake = 14;
            let perSession = opts.perSession || 15;
            const days = Math.max(1, Math.ceil(hoursLeft / 24));
            const studyMinutesAvail = hoursLeft >= 24 ? days * awake * 60 : Math.max(60, (hoursLeft - Math.min(7, hoursLeft / 3)) * 60);
            let sessions = Math.ceil(remaining / perSession);
            if (sessions * Panic.SESSION_MIN > studyMinutesAvail * 0.45 && perSession < 25) {
                perSession = 25;
                sessions = Math.ceil(remaining / perSession);
            }
            const perDay = Math.max(1, Math.ceil(sessions / days));
            const gapMin = Math.max(Panic.SESSION_MIN, Math.floor((Math.min(studyMinutesAvail, awake * 60)) / Math.max(1, perDay)));
            return {
                remaining: remaining,
                perSession: perSession,
                sessions: sessions,
                days: days,
                perDay: perDay,
                minutesPerDay: perDay * Panic.SESSION_MIN,
                gapMin: gapMin,
                overload: sessions * Panic.SESSION_MIN > studyMinutesAvail * 0.6
            };
        },
        status(exam, now) {
            if (!exam) return null;
            const t = now || Date.now();
            const total = Math.max(1, exam.sessions);
            const span = Math.max(1, exam.examAt - exam.createdAt);
            const elapsed = Math.min(1, Math.max(0, (t - exam.createdAt) / span));
            const expected = Math.min(total, Math.floor(elapsed * total));
            const done = exam.sessionsDone || 0;
            return {
                expected: expected,
                done: done,
                total: total,
                onTrack: done >= expected,
                behind: Math.max(0, expected - done),
                msLeft: Math.max(0, exam.examAt - t)
            };
        }
    };

    /* =====================================================================
     * EOS — dựng đề thi thử, chấm điểm
     * ===================================================================== */
    const EOS = {
        build(items, count) {
            const mcq = items.filter((t) => t.type === 'mcq' && t.options.filter(Boolean).length >= 2 && t.answerOrMeaning);
            const n = Math.max(1, Math.min(count || 40, mcq.length));
            return Sch.shuffle(mcq).slice(0, n).map((t) => {
                const order = Sch.shuffle([0, 1, 2, 3].filter((i) => t.options[i]));
                return { id: t.id, order: order };
            });
        },
        grade(paper, answers, itemsById) {
            let correct = 0;
            const wrong = [];
            paper.forEach((q, i) => {
                const t = itemsById.get(q.id);
                if (!t) return;
                const chosen = answers[i];
                const right = Sch.LETTERS.indexOf(t.answerOrMeaning);
                if (chosen != null && q.order[chosen] === right) correct++;
                else wrong.push({ index: i, id: q.id, chosenOriginal: chosen != null ? q.order[chosen] : null });
            });
            return { correct: correct, total: paper.length, score10: paper.length ? Math.round((correct / paper.length) * 100) / 10 : 0, wrong: wrong };
        }
    };

    EDU.Engine = { Nav, Plan, Burst, Panic, EOS, createTicker };
})(window.EDU = window.EDU || {});
