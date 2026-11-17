import {
    MIN_ANSWERS,
    RANK_THRESHOLDS,
    VOTE_TYPES,
    dayKey,
    hasSession,
    meetsAnswerThreshold,
    planVote,
    rankOf,
    streakOf,
    summarize
} from '../../edu/js/core/identity.js';

const results = [];

function check(name, ok) {
    results.push({ name: name, ok: !!ok });
}

function vote(date, sessionId) {
    return { id: 'iv-' + sessionId, date: date, type: 'flashcard', sessionId: sessionId, createdAt: 1 };
}

check('Ngưỡng cấp bậc là 0, 10, 30, 100, 300', RANK_THRESHOLDS.join() === '0,10,30,100,300');
check('Có sẵn loại eosMock', VOTE_TYPES.indexOf('eosMock') >= 0);
check('Ngưỡng trả lời là 5', MIN_ANSWERS === 5 && meetsAnswerThreshold(5) && !meetsAnswerThreshold(4));

const none = summarize([], '2026-11-17');
check('Ngày đầu, chưa có phiếu: chưa xác nhận, chuỗi 0', none.confirmedToday === false && none.streak === 0 && none.total === 0 && none.todayCount === 0);
check('7 ngày gần nhất kết thúc bằng hôm nay', none.last7.length === 7 && none.last7[6].date === '2026-11-17' && none.last7.every((d) => d.on === false));

const first = summarize([vote('2026-11-17', 'a')], '2026-11-17');
check('Phiếu đầu tiên trong ngày: đã xác nhận, chuỗi 1, tổng 1', first.confirmedToday === true && first.streak === 1 && first.total === 1 && first.todayCount === 1);
check('Chấm hôm nay sáng trên 7 chấm', first.last7[6].on === true && first.last7[5].on === false);

const skipOne = summarize([vote('2026-11-15', 'a'), vote('2026-11-17', 'b')], '2026-11-17');
check('Bỏ 1 ngày rồi học lại: chuỗi không về 0', skipOne.streak === 2 && skipOne.confirmedToday === true);

const openGap = summarize([vote('2026-11-15', 'a')], '2026-11-17');
check('Mới bỏ 1 ngày, hôm nay còn mở: chuỗi còn, chưa xác nhận hôm nay', openGap.streak === 1 && openGap.confirmedToday === false && openGap.missedOnce === true);

const skipTwo = summarize([vote('2026-11-14', 'a')], '2026-11-17');
check('Bỏ 2 ngày liền: chuỗi gãy', skipTwo.streak === 0 && skipTwo.missedOnce === false && skipTwo.confirmedToday === false);

const restart = summarize([vote('2026-11-14', 'a'), vote('2026-11-17', 'b')], '2026-11-17');
check('Học lại sau 2 ngày trống: chỉ tính mạch mới', restart.streak === 1 && restart.total === 2);

const twoToday = summarize([vote('2026-11-17', 'a'), vote('2026-11-17', 'b')], '2026-11-17');
check('Hai phiên trong một ngày: tổng 2, chuỗi vẫn 1 ngày', twoToday.total === 2 && twoToday.todayCount === 2 && twoToday.streak === 1);

const late = new Date(2026, 10, 17, 23, 59, 59);
const early = new Date(2026, 10, 18, 0, 0, 0);
check('Qua nửa đêm thì khóa ngày đổi', dayKey(late) === '2026-11-17' && dayKey(early) === '2026-11-18');
const night = summarize([vote('2026-11-17', 'a')], dayKey(late));
const morning = summarize([vote('2026-11-17', 'a')], dayKey(early));
check('Trước nửa đêm: đã xác nhận hôm nay', night.confirmedToday === true && night.todayCount === 1 && night.streak === 1);
check('Sau nửa đêm: hôm nay chưa có phiếu, chuỗi hôm qua vẫn còn', morning.confirmedToday === false && morning.todayCount === 0 && morning.streak === 1 && morning.missedOnce === false);

const low = rankOf(0);
const mid = rankOf(25);
const top = rankOf(300);
check('0 phiếu đang ở mốc 0, còn 10 phiếu nữa', low.level === 1 && low.min === 0 && low.next === 10 && low.remaining === 10 && low.progress === 0);
check('25 phiếu nằm giữa mốc 10 và 30', mid.min === 10 && mid.next === 30 && mid.into === 15 && mid.remaining === 5 && mid.progress === 0.75);
check('Đủ 300 phiếu thì hết mốc kế', top.next == null && top.progress === 1 && top.remaining === 0);

const made = planVote({ sessionId: 42, type: 'quiz5', answered: 5 }, late);
check('Đủ 5 câu thì tạo được phiếu, id theo session', !!made && made.id === 'iv-42' && made.sessionId === '42' && made.date === '2026-11-17' && made.type === 'quiz5');
check('4 câu hoặc chỉ lật thẻ thì không tạo phiếu', planVote({ sessionId: 7, type: 'flashcard', answered: 4 }, late) == null);
check('Thi thử EOS chưa được ghi phiếu', planVote({ sessionId: 9, type: 'eosMock', answered: 40 }, late) == null);
check('Cùng sessionId thì nhận ra phiếu đã có', hasSession([made], 42) === true && hasSession([made], '42') === true && hasSession([made], 43) === false);
check('Chuỗi thuần không phụ thuộc đồng hồ máy', streakOf([vote('2026-11-01', 'a')], '2026-11-01') === 1);

const failed = results.filter((r) => !r.ok);
const sum = document.getElementById('sum');
const out = document.getElementById('out');
sum.textContent = failed.length ? (failed.length + ' ca chưa đúng') : (results.length + ' ca đều đúng');
results.forEach((r) => {
    const li = document.createElement('li');
    li.textContent = (r.ok ? 'Đúng. ' : 'Sai. ') + r.name;
    li.style.color = r.ok ? '#047857' : '#BE123C';
    out.appendChild(li);
});
