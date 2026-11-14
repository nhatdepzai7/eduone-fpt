(function (EDU) {
    'use strict';

    /* ---------- Audio: Web Audio API synthesizer, không cần file mp3 ---------- */
    const Audio = (() => {
        let ctx = null;
        let master = null;
        let muted = !!(EDU.Store && EDU.Store.prefs.get('muted', false));

        const ensure = () => {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            if (!ctx) {
                try {
                    ctx = new Ctx();
                    master = ctx.createGain();
                    master.gain.value = 0.9;
                    master.connect(ctx.destination);
                } catch (e) {
                    ctx = null;
                    return null;
                }
            }
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            return ctx;
        };

        const tone = (opts) => {
            if (muted) return;
            const c = ensure();
            if (!c) return;
            const t0 = c.currentTime + (opts.delay || 0);
            const o = c.createOscillator();
            const g = c.createGain();
            o.type = opts.type || 'sine';
            o.frequency.setValueAtTime(opts.from, t0);
            if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.dur * 0.9);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(opts.peak || 0.08, t0 + (opts.attack || 0.012));
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
            o.connect(g);
            g.connect(master);
            o.start(t0);
            o.stop(t0 + opts.dur + 0.02);
        };

        return {
            unlock() { ensure(); },
            correct() {
                tone({ from: 1046.5, dur: 0.16, peak: 0.07 });
                tone({ from: 1318.5, dur: 0.24, peak: 0.06, delay: 0.07 });
            },
            wrong() {
                tone({ type: 'triangle', from: 196, to: 130, dur: 0.32, peak: 0.11, attack: 0.02 });
            },
            knock() {
                tone({ type: 'triangle', from: 440, to: 528, dur: 0.15, peak: 0.06 });
                tone({ type: 'triangle', from: 440, to: 528, dur: 0.15, peak: 0.05, delay: 0.22 });
            },
            tap() {
                tone({ type: 'sine', from: 660, dur: 0.05, peak: 0.03, attack: 0.004 });
            },
            milestone() {
                [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ from: f, dur: 0.22, peak: 0.06, delay: i * 0.09 }));
            },
            isMuted() { return muted; },
            setMuted(v) {
                muted = !!v;
                if (EDU.Store) EDU.Store.prefs.set('muted', muted);
            }
        };
    })();

    /* ---------- Keys: một listener keydown duy nhất, ngăn xếp scope (scope trên cùng xử lý trước) ---------- */
    const Keys = (() => {
        const stack = [];
        let installed = false;

        const isTyping = (el) => {
            if (!el) return false;
            const tag = el.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
        };

        const comboOf = (e) => {
            let k = e.key;
            if (k === ' ' || e.code === 'Space') k = 'Space';
            else if (k && k.length === 1) k = k.toLowerCase();
            const mods = [];
            if (e.ctrlKey || e.metaKey) mods.push('mod');
            if (e.altKey) mods.push('alt');
            if (e.shiftKey && k.length > 1) mods.push('shift');
            return mods.concat(k).join('+');
        };

        const onKey = (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.defaultPrevented) return;
            const combo = comboOf(e);
            const typing = isTyping(document.activeElement);
            const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
            for (let i = stack.length - 1; i >= 0; i--) {
                const scope = stack[i];
                const h = scope.map[combo];
                if (h) {
                    const fn = typeof h === 'function' ? h : h.run;
                    const allowInInput = typeof h === 'object' && h.allowInInput;
                    if (typing && !allowInInput) {
                        if (scope.modal) return;
                        continue;
                    }
                    if (onButton && (combo === 'Space' || combo === 'Enter') && !(typeof h === 'object' && h.overrideButton)) return;
                    const res = fn(e);
                    if (res !== false) e.preventDefault();
                    return;
                }
                if (scope.modal) return;
            }
        };

        const install = () => {
            if (installed) return;
            installed = true;
            window.addEventListener('keydown', onKey);
            window.addEventListener('pointerdown', () => Audio.unlock(), { once: true });
            window.addEventListener('keydown', () => Audio.unlock(), { once: true });
        };

        return {
            install,
            push(name, map, opts) {
                install();
                const scope = { name, map: map || {}, modal: !!(opts && opts.modal) };
                stack.push(scope);
                return {
                    update(m) { scope.map = m || {}; },
                    pop() {
                        const i = stack.indexOf(scope);
                        if (i >= 0) stack.splice(i, 1);
                    }
                };
            },
            isTyping
        };
    })();

    EDU.Audio = Audio;
    EDU.Keys = Keys;
})(window.EDU = window.EDU || {});
