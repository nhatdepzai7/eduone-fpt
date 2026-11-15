/**
 * POST /api/ai
 * Vercel: file này là Serverless / Edge Function.
 * Cloudflare Pages: cùng file được gọi lại từ functions/api/ai.js.
 *
 * Key chỉ đọc từ OPENAI_API_KEY trên server. Không ghi key vào phản hồi, log, hay header.
 * Client không được chọn model, max_tokens, hay system prompt.
 */

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 1500;
const MAX_ITEMS = 15;
const MAX_CHARS = 3000;
const MAX_BODY = 12000;
const FREE_PER_DAY = 5;
const LICENSED_PER_DAY = 30;

const TASKS = {
    enrich: 0.3,
    structure: 0.2,
    recall: 0.4,
    grade: 0,
    explain: 0.3
};

const SYS = 'Bạn là trợ lý soạn học liệu cho sinh viên đại học Việt Nam. Luôn trả về JSON hợp lệ, không markdown. Chỉ làm đúng tác vụ được giao, không đóng vai chatbot tự do.';
const GRADE_SYS = 'Check English grammar for a Vietnamese learner. Reply JSON only: {"ok":true|false,"note":"one short Vietnamese sentence"}. ok is false only when the sentence is not understandable English or clearly misses the requested grammar.';

const buckets = new Map();

function envGet(env, name) {
    if (env && typeof env[name] === 'string' && env[name]) return env[name];
    if (typeof process !== 'undefined' && process.env && process.env[name]) return String(process.env[name]);
    return '';
}

function clip(value, max) {
    return String(value == null ? '' : value).slice(0, max);
}

function json(status, obj, extra) {
    const headers = Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    }, extra || {});
    return new Response(JSON.stringify(obj), { status: status, headers: headers });
}

function sameOrigin(req) {
    const origin = req.header('origin');
    if (!origin) return true;
    const hosts = (req.header('host') + ',' + req.header('x-forwarded-host'))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    try {
        return hosts.indexOf(new URL(origin).host) >= 0;
    } catch (e) {
        return false;
    }
}

function cors(req) {
    const origin = req.header('origin');
    const headers = {};
    if (origin && sameOrigin(req)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Edu-Device';
        headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    }
    return headers;
}

function clientIp(req) {
    const cf = req.header('cf-connecting-ip');
    if (cf) return cf.trim().slice(0, 64);
    const real = req.header('x-real-ip');
    if (real) return real.trim().slice(0, 64);
    const fwd = req.header('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
    return '0';
}

function normalizeKey(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hasLicense(raw, env) {
    const key = normalizeKey(raw);
    if (!/^EDU[A-Z0-9]{12}$/.test(key)) return false;
    const list = envGet(env, 'EDU_LICENSE_KEYS');
    if (!list.trim()) return false;
    return list.split(/[\s,;]+/).some((part) => normalizeKey(part) === key);
}

function dayStamp() {
    return new Date().toISOString().slice(0, 10);
}

async function takeSlot(bucket, limit) {
    let used = buckets.get(bucket) || 0;
    const cacheUrl = 'https://quota.eduone.local/' + encodeURIComponent(bucket);
    try {
        if (typeof caches !== 'undefined' && caches.default) {
            const hit = await caches.default.match(cacheUrl);
            if (hit) used = Math.max(used, parseInt(await hit.text(), 10) || 0);
        }
    } catch (e) {}
    if (used >= limit) return false;
    used += 1;
    buckets.set(bucket, used);
    if (buckets.size > 4000) {
        const today = dayStamp();
        buckets.forEach((_, k) => { if (k.slice(0, 10) !== today) buckets.delete(k); });
    }
    try {
        if (typeof caches !== 'undefined' && caches.default) {
            await caches.default.put(cacheUrl, new Response(String(used), {
                headers: { 'Cache-Control': 'max-age=86400' }
            }));
        }
    } catch (e) {}
    return true;
}

function countItems(task, body) {
    if (task === 'enrich' || task === 'recall') return Array.isArray(body.items) ? body.items.length : 0;
    if (task === 'grade') return Array.isArray(body.sentences) ? body.sentences.length : 0;
    if (task === 'explain') return body.item ? 1 : 0;
    const lines = String(body.text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    return lines.length;
}

function userText(task, body) {
    if (task === 'structure') return String(body.text || '');
    if (task === 'grade') return JSON.stringify(body.sentences || []) + String(body.instruction || '');
    if (task === 'explain') return JSON.stringify(body.item || {});
    return JSON.stringify(body.items || []);
}

function messagesFor(task, body) {
    if (task === 'enrich') {
        const input = body.items.slice(0, MAX_ITEMS).map((t) => ({
            id: clip(t && t.id, 80),
            word: clip(t && (t.word || t.questionOrWord), 120),
            wordType: clip(t && t.wordType, 16),
            meaning: clip(t && (t.meaning || t.answerOrMeaning), 200),
            example: clip(t && (t.example || t.explanationOrExample), 240)
        }));
        return [
            { role: 'system', content: SYS },
            { role: 'user', content: 'Bổ sung thông tin còn thiếu cho từng từ tiếng Anh. Giữ nguyên giá trị đã có.\nTrả về {"items":[{"id":"...","wordType":"n|v|adj|adv|prep|conj|pron|phr","meaning":"nghĩa tiếng Việt ngắn","example":"1 câu ví dụ tiếng Anh","exampleVi":"dịch câu ví dụ","ipa":"/.../","keywords":["cụm 1","cụm 2"]}]}\n' + JSON.stringify(input) }
        ];
    }
    if (task === 'structure') {
        return [
            { role: 'system', content: SYS },
            { role: 'user', content: 'Tách văn bản sau thành tối đa 15 mục học liệu. Có 2 loại:\n- "vocab": từ tiếng Anh, điền wordType, ipa, meaning (tiếng Việt), example, exampleVi.\n- "mcq": câu trắc nghiệm, options đúng 4 phần tử (không kèm chữ A./B.), answer là "A"|"B"|"C"|"D", explanation tiếng Việt ngắn.\nMỗi mục có "keywords": 2-4 cụm xuất hiện nguyên văn trong câu hỏi hoặc đáp án đúng.\nTrả về {"items":[{"type":"vocab|mcq","word":"","question":"","options":[],"answer":"","wordType":"","ipa":"","meaning":"","example":"","exampleVi":"","explanation":"","keywords":[]}]}\n---\n' + clip(body.text, MAX_CHARS) }
        ];
    }
    if (task === 'recall') {
        const input = body.items.slice(0, MAX_ITEMS).map((t) => ({
            id: clip(t && t.id, 80),
            word: clip(t && t.word, 120),
            meaning: clip(t && t.meaning, 200),
            example: clip(t && t.example, 240)
        }));
        return [
            { role: 'system', content: SYS },
            { role: 'user', content: 'Tạo câu hỏi gợi nhớ từ vựng tiếng Anh cho người học Việt. Mỗi câu là tiếng Việt, dưới 18 từ, không chứa từ tiếng Anh cần nhớ, không phiên âm.\nTrả về {"items":[{"id":"...","prompt":"..."}]}\n' + JSON.stringify(input) }
        ];
    }
    if (task === 'grade') {
        const lines = body.sentences.slice(0, MAX_ITEMS).map((c, i) => (i + 1) + '. ' + clip(c, 400));
        return [
            { role: 'system', content: GRADE_SYS },
            { role: 'user', content: 'Yêu cầu: ' + clip(body.instruction, 300) + '\n' + lines.join('\n') }
        ];
    }
    const item = body.item || {};
    return [
        { role: 'system', content: SYS },
        { role: 'user', content: 'Giải thích ngắn (tối đa 4 câu, tiếng Việt) vì sao đáp án đúng, và mẹo loại trừ đáp án sai. Trả về {"explanation":"..."}\n' + JSON.stringify({
            question: clip(item.question, 800),
            options: Array.isArray(item.options) ? item.options.slice(0, 4).map((o) => clip(o, 240)) : [],
            answer: clip(item.answer, 80)
        }) }
    ];
}

function safeUpstream(status, text) {
    if (status === 401 || status === 403) return 'Máy chủ chưa kết nối được AI.';
    if (status === 429) return 'AI đang bận. Thử lại sau ít phút.';
    let msg = 'AI không trả lời được.';
    try {
        const parsed = JSON.parse(text);
        const inner = parsed && parsed.error && (parsed.error.message || parsed.error);
        if (typeof inner === 'string' && inner) msg = inner.slice(0, 180);
    } catch (e) {}
    return msg
        .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{8,}/g, '')
        .replace(/Bearer\s+\S+/gi, '')
        .trim() || 'AI không trả lời được.';
}

function adapt(incoming) {
    if (incoming && typeof incoming.header === 'function') return incoming;
    return {
        method: incoming.method,
        header(name) { return (incoming.headers && incoming.headers.get(name)) || ''; },
        text() { return incoming.text(); }
    };
}

async function handleRequest(incoming, env) {
    const req = adapt(incoming);
    const extra = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra });
    if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST.' }, extra);
    if (!sameOrigin(req)) return json(403, { error: 'Chỉ gọi AI từ chính trang này.' }, extra);

    const key = envGet(env, 'OPENAI_API_KEY').trim();
    if (!key || key === 'your_secret_key_here') return json(503, { error: 'Máy chủ chưa bật AI.' }, extra);

    const declared = parseInt(req.header('content-length') || '0', 10);
    if (declared > MAX_BODY) return json(413, { error: 'Nội dung quá lớn.' }, extra);

    let raw = '';
    try { raw = await req.text(); } catch (e) { raw = ''; }
    if (raw.length > MAX_BODY) return json(413, { error: 'Nội dung quá lớn.' }, extra);

    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { return json(400, { error: 'JSON không hợp lệ.' }, extra); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Payload không hợp lệ.' }, extra);

    const forbidden = ['model', 'messages', 'system', 'max_tokens', 'temperature', 'prompt', 'tools', 'functions'];
    for (let i = 0; i < forbidden.length; i++) {
        if (Object.prototype.hasOwnProperty.call(body, forbidden[i])) {
            return json(400, { error: 'Máy chủ tự chọn model và prompt.' }, extra);
        }
    }

    const task = body.task;
    if (!Object.prototype.hasOwnProperty.call(TASKS, task)) return json(400, { error: 'Tác vụ không được hỗ trợ.' }, extra);

    const n = countItems(task, body);
    if (!n) return json(400, { error: 'Chưa có nội dung để xử lý.' }, extra);
    if (n > MAX_ITEMS) return json(400, { error: 'Mỗi lần chỉ gửi tối đa 15 từ hoặc câu hỏi.' }, extra);
    if (userText(task, body).length > MAX_CHARS) return json(400, { error: 'Nội dung vượt 3000 ký tự.' }, extra);

    const limit = hasLicense(body.licenseKey, env) ? LICENSED_PER_DAY : FREE_PER_DAY;
    const bucket = dayStamp() + ':' + clientIp(req);
    if (!(await takeSlot(bucket, limit))) {
        return json(429, { error: 'Đã hết ' + limit + ' lượt AI hôm nay. Mai dùng tiếp.' }, extra);
    }

    let upstream;
    try {
        upstream = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + key
            },
            body: JSON.stringify({
                model: MODEL,
                temperature: TASKS[task],
                max_tokens: MAX_TOKENS,
                response_format: { type: 'json_object' },
                messages: messagesFor(task, body)
            })
        });
    } catch (e) {
        return json(502, { error: 'Không gọi được AI.' }, extra);
    }

    const text = await upstream.text();
    if (!upstream.ok) return json(502, { error: safeUpstream(upstream.status, text) }, extra);

    let content = '';
    try {
        const data = JSON.parse(text);
        content = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '');
    } catch (e) {
        return json(502, { error: 'AI không trả về JSON hợp lệ.' }, extra);
    }
    if (content.length > 20000) content = content.slice(0, 20000);
    return json(200, { content: content }, extra);
}

async function nodeRequest(req) {
    const headerMap = {};
    Object.keys(req.headers || {}).forEach((name) => {
        const value = req.headers[name];
        headerMap[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value || '');
    });
    let raw = '';
    if (typeof req.body === 'string') raw = req.body;
    else if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
    else if (req.body && typeof req.body === 'object') raw = JSON.stringify(req.body);
    else raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
    return {
        method: req.method || 'GET',
        header(name) { return headerMap[String(name).toLowerCase()] || ''; },
        text() { return Promise.resolve(raw); }
    };
}

export async function onRequest(context) {
    return handleRequest(context.request, context.env || {});
}

export default async function handler(req, res) {
    if (res && typeof res.status === 'function') {
        const response = await handleRequest(await nodeRequest(req), process.env);
        res.status(response.status);
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.send(await response.text());
        return;
    }
    return handleRequest(req, process.env);
}
