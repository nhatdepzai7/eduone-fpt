# EduOne — Design System (MASTER)

Sinh theo quy trình Design System Generator của `ui-ux-pro-max` (Product → Style → Color → Typography → Effects → Anti-patterns → Checklist).

## 1. Bối cảnh sản phẩm
- **Loại:** EdTech, công cụ học tập cá nhân (productivity + exam prep).
- **Người dùng:** sinh viên đại học (FPT), học từ vựng hằng ngày và cày đề trắc nghiệm tốc độ cao mùa thi FE/EOS/PT.
- **Mục tiêu UX:** tập trung cao, đọc lướt câu hỏi dài không mỏi mắt, phản hồi xúc giác tức thì, thao tác 1 chạm / 0 chuột.

## 2. Style Priority
1. **Calm Focus Minimalism** — nền dịu, ít viền, một hành động chính mỗi màn.
2. **Tactile Flat** — nút có chiều sâu nhẹ (shadow 1px + nhấn lún 1px), không skeuomorphism.
3. **Exam Realism** (chỉ ở EOS Simulator) — bố cục dày đặc, xám trung tính, header xanh đậm như phần mềm thi.

## 3. Color Palette (đã kiểm tương phản WCAG trên nền trắng)
| Token | Hex | Dùng cho | Tương phản |
|---|---|---|---|
| `--bg` | `#F5F6F8` | nền trang (giảm chói so với trắng tinh) | — |
| `--surface` | `#FFFFFF` | thẻ, bảng | — |
| `--surface-2` | `#EEF0F4` | vùng phụ, ô nhập nền | — |
| `--border` | `#DCE0E8` | viền mảnh | — |
| `--ink` | `#111827` | chữ chính | 17.7:1 |
| `--ink-2` | `#374151` | chữ phụ | 10.3:1 |
| `--muted` | `#5B6474` | chú thích | 5.9:1 (AA) |
| `--primary` | `#4338CA` | hành động chính, focus ring | 7.9:1 (AAA) |
| `--primary-soft` | `#EEF0FF` | nền chip chọn | — |
| `--success` | `#047857` | đúng | 5.5:1 |
| `--danger` | `#BE123C` | sai | 6.0:1 |
| `--warn` | `#B45309` | trễ giờ, cảnh báo | 5.0:1 |
| `--mark` | `#FDE68A` | Highlight keyword (phím H) | chữ `--ink` 15:1 |
| `--eos-head` | `#1E3A8A` | header EOS Simulator | chữ trắng 10.4:1 |

Màu nhóm (group color bar) chỉ dùng làm vạch 4px, không mang chữ.

## 4. Typography Pairing
- **Be Vietnam Pro** (400/500/600/700) — UI + đọc câu hỏi. Thiết kế cho tiếng Việt, dấu không chồng dòng.
- **JetBrains Mono** (500/600) — đồng hồ đếm ngược, phím tắt (`kbd`), số thứ tự câu; dùng `tabular-nums`.
- Thang chữ: 13 / 14 / 16 (base) / 18 (câu hỏi mobile) / 20 (câu hỏi desktop) / 28 / 40 / 64 (đồng hồ).
- `line-height` 1.6 cho câu hỏi, độ dài dòng tối đa `68ch`.

## 5. Key Effects (150–250 ms, tôn trọng `prefers-reduced-motion`)
- **Press:** `translateY(1px)` + giảm shadow, 90 ms.
- **Correct:** viền xanh + vòng sáng 200 ms, âm "ting" (sine C6→E6), auto-advance 200 ms.
- **Wrong:** rung ngang 320 ms (±6px), âm trầm (triangle 196→130 Hz), giữ đáp án 1.5 s.
- **Card enter:** trượt 8px + fade 180 ms.
- **Highlight (H):** chữ phụ `opacity .45`, keyword nền `--mark`, chuyển 150 ms.
- Reduced motion: thay rung/trượt bằng đổi màu, giữ nguyên âm thanh.

## 6. Anti-patterns (cấm)
- Emoji làm icon UI → dùng 100% SVG Lucide (stroke 2, 24×24). Ngoại lệ có chủ đích: `document.title` khi nhắc giờ ở tab nền.
- `innerHTML` với dữ liệu người dùng / file import / mã chia sẻ.
- Cắt chữ (`truncate`, `line-clamp`, chiều cao cố định) trên câu hỏi, đáp án, chip nhóm.
- Bỏ outline focus; chỉ đổi màu để báo trạng thái (luôn kèm icon/chữ).
- Nút chạm < 44px; nút đáp án MCQ trên mobile < 56px.
- Phím tắt bắt `keydown` khi đang gõ IME (Unikey/EVKey) → phải kiểm `isComposing`.

## 7. Pre-delivery Checklist
- [x] Focus ring 3px `--primary` + offset 2px trên mọi phần tử tương tác (`:focus-visible`).
- [x] Toàn bộ luồng học chạy được bằng bàn phím (1–4, A–D, H, M, Space, ←/→, Enter, Esc).
- [x] Text co giãn: `overflow-wrap:anywhere`, chip `flex-wrap`, ô bảng `textarea` tự cao.
- [x] Tương phản chữ ≥ 4.5:1, chữ lớn ≥ 3:1.
- [x] `aria-live` cho toast và phản hồi đúng/sai.
- [x] Không phụ thuộc file âm thanh ngoài (Web Audio synth).
- [x] Hoạt động trên 360px → 1440px.
