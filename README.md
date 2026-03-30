# AG Smart Router (for Antigravity AI)

**AG Smart Router** là một extension (VSIX) chích mã trực tiếp (Layer 0 Injection) vào VS Code nhằm mang lại trải nghiệm đa tác nhân (multi-agent orchestration) cho hệ thống AI của bạn. Lấy cảm hứng từ sự mượt mà của `oh-my-claudecode`, extension này tự động điều phối các LLM (Large Language Models) tốt nhất cho từng câu lệnh của bạn, giúp tiết kiệm lên tới 50% chi phí/quota mà vẫn bảo đảm chất lượng tư duy cao nhất.

## 🚀 Tính năng nổi bật (Features)

1. **Định tuyến Prompt Thông minh (Smart Routing - Pre-send)**
   Trước khi gửi một đoạn chat lên máy chủ AI, hệ thống sẽ chớp nhoáng phân tích độ dài và ngữ nghĩa của prompt, từ đó tự động đổi sang Model phù hợp:
   - ⚡ **Chế độ nhẹ (Gemini 3 Flash):** Tự động kích hoạt cho các tác vụ vụn vặt như `giải thích, comment, format, typo, spell, rename, lint, clean` hoặc các câu lệnh rất ngắn.
   - 🧠 **Chế độ suy luận sâu (Claude Opus 4.6 / GPT-OSS 120B):** Chuyên trị các prompt chứa kiến trúc, xây dựng hệ thống, debug phức tạp, chẩn đoán file dài (`architecture, setup, debug, refactor, complex, plan, structure, design, error, build`). Tốn kém nhưng chất lượng.
   - ⚖️ **Chế độ cân bằng (Gemini 3.1 Pro High):** Xử lý giao tiếp và các task lập trình chung hằng ngày.

2. **Cơ chế Vượt Lỗi Quota Bền Bỉ (Quota Fallback Recovery)**
   Khi một model cụ thể đạt ngưỡng giới hạn "Baseline model quota reached" (Hết Quota), hệ thống sẽ không bỏ cuộc. Nó lập tức click **Dismiss** hộp thoại báo lỗi, duyệt theo danh sách khẩn cấp (Fallback Priorities), tự động đổi sang một Model AI chưa hết hạn và gõ `"Continue"` để gửi đi, tiếp tục chuỗi Auto-run đang dang dở. Toàn bộ diễn ra ngầm sau vài giây.

3. **Hoạt động Siêu Mượt ở Layer 0**
   Nhờ sự can thiệp thẳng vào `workbench.html` bằng Javascript thuần tuý, việc tự động click đổi model của hệ thống diễn ra chưa tới 300ms và không hề xung đột với các React States hay extension có sẵn khác.

## 💡 Ưu điểm (Benefits)

- **Zero-Cognitive Load:** Bạn không cần phải đắn đo "Với câu lệnh này thì mình nên mở menu chọn model Flash hay Opus nhỉ?". Cứ tự nhiên gõ và bóp cò (Enter), AI sẽ làm phần còn lại.
- **Tiết Kiệm Token:** Hạn chế lãng phí Opus cho việc format file code hoặc hỏi đáp cú pháp vô bổ.
- **Đóng gói VSIX:** Cài đặt nhanh chóng trên UI, có phím tắt bật/tắt (Enable/Disable) theo yêu cầu.

## 🛠 Cách Cài Đặt (Installation)

1. Mở Terminal trong VS Code.
2. Cài đặt file `.vsix` đã được package:
   ```bash
   code --install-extension ag-auto-model-switch-2.0.0.vsix
   ```
   *(Zsh/Bash aliases cho VS Code Insider: thay `code` thành `code-insiders`)*.
3. Trong VS Code, mở màn hình lệnh `Command Palette (Cmd+Shift+P)` và gõ:
   - `AG Model Switch: Enable Auto-Switch`
4. Có thể máy tính của bạn (macOS) sẽ yêu cầu cấp quyền Administrator/TouchID lần đầu tiên do việc ghi đè file HTML hệ thống. Vui lòng **Cho phép (Allow)**.
5. Một thông báo nhỏ góc phải sẽ yêu cầu **Reload Window**, bấm vào đó để VS Code khởi động lại kèm Layer 0 đã kích hoạt thành công.

## 🔍 Cách Hoạt Động Cốt Lõi (Architecture)
Extension sử dụng MutationObserver và EventListener nhúng trực tiếp trên giao diện:
- Lắng nghe `keydown (Enter)` với `useCapture = true` để làm ngưng quá trình gửi của React web UI (Antigravity).
- Chạy Regex Heuristics đánh giá tin nhắn.
- Quét DOM lấy Node của Model Menu Dropdown, đóng/mở tự động trong nền.
- Sử dụng `KeyboardEvent` tái tạo cú nhấn Enter chính hiệu.

---
*Disclaimer: Extension hoạt động bằng cơ chế inject Layer 0 của DOM. Bất cứ bản cập nhật UI nào từ hệ thống gốc có thể làm thay đổi cấu trúc thẻ HTML (class `.action-item`, `.monaco-button`). Khi đó bạn sẽ cần cập nhật Regex Selectors trong `autoModelScript.js`.*
