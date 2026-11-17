/* Ngưỡng cấp bậc theo tổng phiếu. Sửa mảng này là đủ, không cần đổi dữ liệu đã lưu.
   Cấp 1 bắt đầu từ 0 phiếu. Mốc tiếp theo là số phiếu cần để lên cấp kế. */
export const RANK_THRESHOLDS = [0, 10, 30, 100, 300];

/* eosMock có trong danh sách để bước sau ghi phiếu thi thử mà không phải đổi cấu trúc.
   Bước này chưa ghi loại đó. */
export const VOTE_TYPES = ['flashcard', 'quiz5', 'testAll', 'reviewWeak', 'eosMock'];

/* Một phiên chỉ thành phiếu khi đã chấm hoặc trả lời ít nhất bấy nhiêu mục. */
export const MIN_ANSWERS = 5;

/* Bản sắc và câu khẳng định. Phiếu không nằm ở đây: phiếu gắn với người dùng. */
export const OBSIDIAN_IDENTITY = 'Học giả Obsidian Kỷ luật';
export const DEFAULT_IDENTITY_LINE = 'Tôi là người học mỗi ngày, kể cả hôm nay.';
export const IDENTITIES = [
    { name: 'Chinh phục IELTS', line: 'Tôi là người luyện IELTS mỗi ngày, kể cả hôm nay.', pro: false },
    { name: 'Chiến thần Học bổng / Qua môn', line: 'Tôi là người ôn bài đều đặn, kể cả hôm nay.', pro: false },
    { name: OBSIDIAN_IDENTITY, line: DEFAULT_IDENTITY_LINE, pro: true }
];
