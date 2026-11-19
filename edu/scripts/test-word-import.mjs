/**
 * Kiểm thử đọc đề Word: node scripts/test-word-import.mjs
 * Dựng document.xml nhỏ cho từng kiểu trình bày, chạy cả file mẫu admin/mau-de-word.docx,
 * rồi cho kết quả đi qua bộ lọc của server (exams-store) để chắc đăng được.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(root, 'admin/word-import.js')));
const W = globalThis.FPassWord;
const { parseExamInput } = await import(pathToFileURL(join(root, 'server/exams-store.js')));

let fails = 0;
function check(name, ok, extra) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra)));
    if (!ok) fails++;
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* r('chữ') thường, r('chữ', 'red') tô đỏ, r('chữ', 'bold'), r('chữ', 'hl') highlight, r('chữ', 'u') gạch chân */
const r = (t, kind) => {
    const props = { red: '<w:color w:val="C00000"/>', bold: '<w:b/>', hl: '<w:highlight w:val="yellow"/>', u: '<w:u w:val="single"/>', boldred: '<w:b/><w:color w:val="FF0000"/>' }[kind] || '';
    return { xml: '<w:r>' + (props ? '<w:rPr>' + props + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + esc(t) + '</w:t></w:r>' };
};
const p = (...runs) => '<w:p>' + runs.map((x) => (typeof x === 'string' ? r(x) : x).xml).join('') + '</w:p>';
const h = (t) => '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + r(t).xml + '</w:p>';
const doc = (...parts) => '<?xml version="1.0"?><w:document><w:body>' + parts.join('') + '<w:sectPr/></w:body></w:document>';
const cell = (...paras) => '<w:tc>' + (paras.length ? paras.join('') : '<w:p/>') + '</w:tc>';
const row = (...cells) => '<w:tr>' + cells.join('') + '</w:tr>';
const table = (...rows) => '<w:tbl>' + rows.join('') + '</w:tbl>';

/* 1. Kiểu có nhãn, song ngữ, keyword tô đỏ (giống file FIN202) */
let res = W.parseXml(doc(
    p('Ngân hàng câu hỏi'),
    p('Mã câu: X-001'),
    p(r('Chủ đề: ', 'bold'), 'Rủi ro / Risk'),
    p(r('Câu hỏi EN: ', 'bold'), 'What does ', r('beta', 'boldred'), ' measure?'),
    p(r('Câu hỏi VI: ', 'bold'), 'Hệ số ', r('beta', 'boldred'), ' đo lường gì?'),
    p(r('A. ', 'bold'), r('EN: ', 'bold'), 'Total risk  |  ', r('VI: ', 'bold'), 'Tổng rủi ro'),
    p(r('B. ', 'bold'), r('EN: ', 'bold'), 'Systematic risk  |  ', r('VI: ', 'bold'), 'Rủi ro hệ thống'),
    p(r('C. ', 'bold'), r('EN: ', 'bold'), 'Liquidity  |  ', r('VI: ', 'bold'), 'Thanh khoản'),
    p(r('D. ', 'bold'), r('EN: ', 'bold'), 'Inflation  |  ', r('VI: ', 'bold'), 'Lạm phát'),
    p(r('Đáp án đúng: ', 'bold'), 'B'),
    p(r('Giải thích EN: ', 'bold'), 'Beta captures ', r('market-wide', 'red'), ' risk.'),
    p(r('Giải thích VI: ', 'bold'), 'Beta phản ánh rủi ro ', r('toàn thị trường', 'red'), '.'),
    p(r('Hình minh họa: ', 'bold'), 'Không có')
));
let t = res.items[0] || {};
check('labeled: one question, no problems', res.items.length === 1 && res.problems.length === 0, res);
check('labeled: EN base + VI copy', t.question === 'What does beta measure?' && t.questionVi === 'Hệ số beta đo lường gì?', t);
check('labeled: options both languages', t.options[1] === 'Systematic risk' && t.optionsVi[1] === 'Rủi ro hệ thống', t);
check('labeled: answer, topic, explanations', t.answer === 'B' && t.group === 'Rủi ro' && t.explanationVi === 'Beta phản ánh rủi ro toàn thị trường.', t);
check('labeled: keywords from coloured text', ['beta', 'market-wide', 'toàn thị trường'].every((k) => t.keywords.includes(k)) && !t.keywords.some((k) => /EN|VI|Câu hỏi/.test(k)), t.keywords);

/* 2. Kiểu ngắn "Câu 1:" một ngôn ngữ, chủ đề từ Heading, đáp án là chữ của lựa chọn */
res = W.parseXml(doc(
    h('Chương 2: Giá trị thời gian'),
    p('Câu 1: Lãi kép tính trên ', r('gốc và lãi', 'hl'), '?'),
    p('A. Chỉ gốc'), p('B) Gốc và lãi đã nhập'), p('C. Chỉ lãi'), p('D. Không có'),
    p('Đáp án: Gốc và lãi đã nhập'),
    p('Lời giải: Lãi được nhập vào gốc mỗi kỳ.'),
    p('Câu 2: Hiện giá giảm khi lãi suất'),
    p('tăng hay giảm?'),
    p('A. Tăng  B. Giảm  C. Không đổi  D. Tùy kỳ hạn'),
    p('Answer: (A)')
));
check('short: two questions', res.items.length === 2, res);
check('short: topic from heading', res.items.every((x) => x.group === 'Chương 2: Giá trị thời gian'), res.items.map((x) => x.group));
check('short: answer given as option text', res.items[0] && res.items[0].answer === 'B' && res.items[0].explanation === 'Lãi được nhập vào gốc mỗi kỳ.', res.items[0]);
check('short: highlighted keyword', res.items[0] && res.items[0].keywords.includes('gốc và lãi'), res.items[0] && res.items[0].keywords);
check('short: question across two lines, options on one line', res.items[1] && res.items[1].question === 'Hiện giá giảm khi lãi suất tăng hay giảm?' && res.items[1].options[3] === 'Tùy kỳ hạn' && res.items[1].answer === 'A', res.items[1]);
check('short: Vietnamese-only has no VI copy', res.items[0] && !res.items[0].questionVi && !res.items[0].optionsVi, res.items[0]);

/* 3. Đáp án đánh dấu bằng in đậm cả lựa chọn và bằng dấu * */
res = W.parseXml(doc(
    p('1. Which is a current asset?'),
    p('A. Land'), p(r('B. Inventory', 'bold')), p('C. Goodwill'), p('D. Patents'),
    p('2. Which is a liability?'),
    p('A. Cash'), p('B. Equipment'), p('*C. Accounts payable'), p('D. Revenue')
));
check('marked: bold option is the answer', res.items[0] && res.items[0].answer === 'B' && !res.items[0].keywords.length, res.items[0]);
check('marked: star option is the answer', res.items[1] && res.items[1].answer === 'C' && res.items[1].options[2] === 'Accounts payable', res.items[1]);

/* 4. Dạng bảng */
res = W.parseXml(doc(
    table(
        row(cell(p('STT')), cell(p('Chủ đề')), cell(p('Câu hỏi')), cell(p('A')), cell(p('B')), cell(p('C')), cell(p('D')), cell(p('Đáp án')), cell(p('Giải thích')), cell(p('Từ khóa'))),
        row(cell(p('1')), cell(p('WACC')), cell(p('WACC dùng để ', r('chiết khấu', 'u'), ' gì?')), cell(p('Dòng tiền dự án')), cell(p('Cổ tức')), cell(p('Thuế')), cell(p('Lương')), cell(p('A')), cell(p('Chi phí vốn bình quân.')), cell(p('WACC, chi phí vốn'))),
        row(cell(p('2')), cell(p('WACC')), cell(p('Nợ rẻ hơn vốn chủ vì?')), cell(p('Lá chắn thuế')), cell(p('Rủi ro cao')), cell(p('Không trả lãi')), cell(p('Luật')), cell(p('A')), cell(), cell())
    )
));
check('table: two rows read', res.items.length === 2, res);
check('table: fields mapped by header', res.items[0] && res.items[0].group === 'WACC' && res.items[0].options[0] === 'Dòng tiền dự án' && res.items[0].answer === 'A' && res.items[0].explanation === 'Chi phí vốn bình quân.', res.items[0]);
check('table: keyword column + underlined text', res.items[0] && ['WACC', 'chi phí vốn', 'chiết khấu'].every((k) => res.items[0].keywords.includes(k)), res.items[0] && res.items[0].keywords);

/* 5. Câu thiếu đáp án bị báo, không bị đăng */
res = W.parseXml(doc(p('Câu 1: Câu không có đáp án?'), p('A. a'), p('B. b'), p('C. c'), p('D. d'), p('Câu 2: Có đáp án?'), p('A. a'), p('B. b'), p('C. c'), p('D. d'), p('Đáp án: D')));
check('missing answer: reported and skipped', res.items.length === 1 && res.problems.some((x) => /Câu 1: chưa có đáp án/.test(x)), res);

/* 6. Lời giới thiệu, mục lục đánh số không thành câu hỏi */
res = W.parseXml(doc(p('Tài liệu gồm 3 chủ đề.'), p('01. Chủ đề một — 5 câu'), p('02. Chủ đề hai — 5 câu'), p('Câu 1: Thật?'), p('A. x'), p('B. y'), p('C. z'), p('D. w'), p('Đáp án: A')));
check('intro and table of contents ignored', res.items.length === 1 && res.problems.length === 0, res);

/* 7. File Word mẫu tải về từ trang admin */
const buf = readFileSync(join(root, 'admin/mau-de-word.docx'));
res = await W.parseDocx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
check('template docx: 5 questions, 2 topics, no problems', res.items.length === 5 && Object.keys(res.stats.topics).length === 2 && !res.problems.length, res.stats);
check('template docx: course and exam name picked up', res.course === 'FIN202' && res.examName === 'Final Test', { course: res.course, examName: res.examName });

/* 8. Kết quả đi qua bộ lọc server, giữ phần song ngữ và keyword */
const stored = parseExamInput(JSON.stringify({ items: res.items }), 'other', 'FIN202', 'official');
const s0 = stored[0];
check('server keeps bilingual fields', stored.length === 5 && s0.questionVi && s0.optionsVi.length === 4 && s0.explanationVi && s0.keywords.length >= 2, s0);
check('server drops empty fields', !('ipa' in s0) && !('wordType' in s0) && !('questionVi' in stored[3]), stored[3]);
const big = Array.from({ length: 280 }, (_, i) => Object.assign({}, res.items[i % 3], { ref: 'Q' + i }));
check('official exam accepts 280 bilingual questions', parseExamInput(JSON.stringify({ items: big }), 'other', '', 'official').length === 280);
check('student submission still capped at 120', parseExamInput(JSON.stringify({ items: big }), 'other', '', 'pending').length === 120);

/* 9. File mẫu FIN202 đầy đủ (nếu có trên máy chạy kiểm thử) */
const sample = process.env.FIN202_DOCX;
if (sample) {
    const b = readFileSync(sample);
    const full = await W.parseDocx(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    check('FIN202: 280 questions, 11 topics, all bilingual with keywords', full.items.length === 280 && Object.keys(full.stats.topics).length === 11 && full.stats.bilingual === 280 && full.stats.withKeywords === 280 && !full.problems.length, full.stats);
    check('FIN202: fits in one stored exam', JSON.stringify(parseExamInput(JSON.stringify({ items: full.items }), 'other', 'FIN202', 'official')).length < 1000000);
}

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
