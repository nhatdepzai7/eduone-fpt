/* Ngưỡng cấp bậc theo tổng phiếu. Sửa mảng này là đủ, không cần đổi dữ liệu đã lưu.
   Cấp 1 bắt đầu từ 0 phiếu. Mốc tiếp theo là số phiếu cần để lên cấp kế. */
export const RANK_THRESHOLDS = [0, 10, 30, 100, 300];

/* eosMock có trong danh sách để bước sau ghi phiếu thi thử mà không phải đổi cấu trúc.
   Bước này chưa ghi loại đó. */
export const VOTE_TYPES = ['flashcard', 'quiz5', 'testAll', 'reviewWeak', 'eosMock'];

/* Một phiên chỉ thành phiếu khi đã chấm hoặc trả lời ít nhất bấy nhiêu mục. */
export const MIN_ANSWERS = 5;
