(function (EDU) {
    'use strict';

    /*
     * Định dạng khối khóa của một bộ đề (sinh bởi tools/build_packs.py ở gốc repo, ngoài edu/):
     * locked = {
     *   v: 1, kdf: 'PBKDF2-SHA256', iter, aad,
     *   iv, ct,                        // payload Chặng 2–3, mã hóa AES-256-GCM bằng khóa nội dung (CEK)
     *   slots: [{ salt, iv, wk }]      // CEK được bọc bằng KEK = PBKDF2(licenseKey, salt)
     * }
     */

    const b64ToBytes = (s) => {
        const bin = atob(String(s || ''));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    };

    const normalizeKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    const available = () => !!(window.crypto && window.crypto.subtle);

    const deriveKEK = async (licenseKey, salt, iter) => {
        const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeKey(licenseKey)), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iter },
            base,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
    };

    const unwrapCEK = async (locked, licenseKey) => {
        const aad = new TextEncoder().encode(locked.aad || '');
        for (let i = 0; i < locked.slots.length; i++) {
            const slot = locked.slots[i];
            try {
                const kek = await deriveKEK(licenseKey, b64ToBytes(slot.salt), locked.iter);
                const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(slot.iv), additionalData: aad }, kek, b64ToBytes(slot.wk));
                return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
            } catch (e) {
                /* GCM tag sai → key không khớp khe này, thử khe tiếp theo */
            }
        }
        return null;
    };

    const unlock = async (pack, licenseKey) => {
        if (!available()) throw new Error('Trình duyệt không hỗ trợ Web Crypto (cần HTTPS hoặc mở file trực tiếp).');
        const locked = pack && pack.locked;
        if (!locked || !Array.isArray(locked.slots) || !locked.slots.length) throw new Error('Bộ đề này không có phần khóa.');
        if (normalizeKey(licenseKey).length < 8) throw new Error('Mã kích hoạt quá ngắn.');
        const cek = await unwrapCEK(locked, licenseKey);
        if (!cek) throw new Error('Mã kích hoạt không đúng với bộ đề này.');
        const aad = new TextEncoder().encode(locked.aad || '');
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(locked.iv), additionalData: aad }, cek, b64ToBytes(locked.ct));
        const data = EDU.Security.safeJSONParse(new TextDecoder().decode(plain), EDU.Security.LIMITS.packBytes);
        const arr = Array.isArray(data) ? data : (data && data.items) || [];
        return arr.map((d) => EDU.Schema.normalizeItem(d, { source: 'pack:' + pack.id, group: pack.code }));
    };

    EDU.Vault = { unlock, normalizeKey, available };
})(window.EDU = window.EDU || {});
