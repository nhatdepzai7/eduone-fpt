import { fail, json, mount, sameOrigin } from '../server/http.js';

/* Tra từ dự phòng cho ô gợi ý ở Sổ từ, dùng khi từ điển có sẵn trên máy không có từ đó.
   IPA + từ loại lấy từ dictionaryapi.dev, nghĩa tiếng Việt lấy từ MyMemory. Cả hai miễn phí, không cần key
   và không tốn lượt AI. Chạy qua server để trang giữ nguyên CSP connect-src 'self'. */

const WORD = /^[a-z][a-z' -]{1,39}$/i;
const POS = { noun: 'n', verb: 'v', adjective: 'adj', adverb: 'adv', preposition: 'prep', conjunction: 'conj', pronoun: 'pron', interjection: 'interj', exclamation: 'interj', determiner: 'det' };

async function getJson(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function clean(s, max) {
    return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function english(word) {
    const data = await getJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word), 3500);
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) return {};
    const phon = (entry.phonetics || []).find(p => p && p.text) || {};
    const ipa = clean(entry.phonetic || phon.text, 60);
    const meaning = (entry.meanings || [])[0] || {};
    const def = ((meaning.definitions || [])[0] || {});
    return {
        ipa: ipa,
        wordType: POS[String(meaning.partOfSpeech || '').toLowerCase()] || '',
        example: clean(def.example, 300)
    };
}

async function vietnamese(word) {
    const data = await getJson('https://api.mymemory.translated.net/get?langpair=en|vi&q=' + encodeURIComponent(word), 3500);
    const text = clean(data && data.responseData && data.responseData.translatedText, 120);
    /* MyMemory trả lại nguyên từ khi không dịch được: coi như không có nghĩa. */
    if (!text || text.toLowerCase() === word.toLowerCase() || /MYMEMORY|QUERY LENGTH/i.test(text)) return '';
    return text.toLowerCase();
}

async function handle(req) {
    try {
        if (req.method !== 'GET') return json(405, { error: 'Chỉ nhận GET.' });
        if (!sameOrigin(req)) return json(403, { error: 'Chỉ tra từ từ chính trang này.' });
        let w = '';
        try { w = (new URL(req.url, 'http://x').searchParams.get('w') || '').trim().toLowerCase(); } catch (e) { w = ''; }
        if (!WORD.test(w)) return json(400, { error: 'Từ không hợp lệ.' });
        const [en, vi] = await Promise.all([english(w), vietnamese(w)]);
        if (!vi && !en.ipa) return json(200, { found: false }, { 'Cache-Control': 'public, max-age=3600' });
        return json(200, {
            found: true,
            word: w,
            wordType: en.wordType || '',
            ipa: en.ipa || '',
            meaning: vi,
            example: en.example || ''
        }, { 'Cache-Control': 'public, max-age=86400, s-maxage=604800' });
    } catch (e) {
        return fail(e, 'dict');
    }
}

const { onRequest, handler } = mount(handle);
export { onRequest };
export default handler;
