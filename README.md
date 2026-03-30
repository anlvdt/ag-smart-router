# AG Autopilot

**Autopilot for Antigravity AI** — merged from 2 extensions into one, eliminating Layer 0 conflicts.
**Tự lái mọi thứ cho Antigravity AI** — merge từ 2 extension thành một, loại bỏ xung đột Layer 0.

- **ag-auto-click-scroll** v8.3 (by zixfel) — Auto Click, Auto Scroll, Click Stats
- **ag-auto-model-switch** v2.0 — Smart Model Router, Quota Fallback

## Why merge? | Tại sao merge?

Both extensions inject into `workbench.html` via Layer 0, causing DOM event conflicts and Antigravity crashes when running simultaneously. AG Autopilot uses a **single unified script**, completely eliminating conflicts.

Cả hai extension đều inject vào `workbench.html`, gây xung đột DOM events và crash Antigravity khi chạy đồng thời. AG Autopilot dùng **một script duy nhất**, loại bỏ hoàn toàn xung đột.

## Features | Tính năng

| Feature | Description | Mô tả |
|---|---|---|
| Auto Click | Auto-click Run, Allow, Accept, Always Allow, Keep Waiting... | Tự nhấn Run, Allow, Accept, Always Allow, Keep Waiting... |
| Auto Scroll | Scroll chat to bottom, pause when user scrolls up | Cuộn chat xuống cuối, tự dừng khi user kéo lên đọc |
| Smart Accept | Only click Accept in chat panel, never in diff editor | Accept chỉ click ở chat, không click ở diff editor |
| Click Stats | Realtime click statistics with progress bar | Thống kê click realtime với progress bar |
| Smart Router | Auto-select model based on prompt content (Cheap/Default/Extreme) | Tự chọn model theo nội dung prompt |
| Quota Fallback | Auto-switch model on quota exhaustion + send "Continue" | Tự đổi model khi hết quota + gửi "Continue" |
| HTTP Live Sync | Settings update in realtime via internal HTTP server | Settings cập nhật realtime qua HTTP server nội bộ |
| Multi-Instance | Support 2+ Antigravity windows simultaneously | Hỗ trợ 2+ cửa sổ Antigravity cùng lúc |
| Anti-Corrupt | Auto-update checksums, no "corrupt" warning | Tự cập nhật checksums, không hiện cảnh báo "corrupt" |

## Installation | Cài đặt

```bash
code --install-extension ag-autopilot-3.0.0.vsix
```

Or | Hoặc: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

## Usage | Sử dụng

- Click "Accept ON" / "Scroll ON" on Status Bar to open Settings | Click trên Status Bar để mở Settings
- `Ctrl+Shift+P` → `AG Autopilot: Open Settings`
- Toggle each feature ON/OFF in the Settings panel | Toggle từng tính năng ON/OFF trong Settings panel

## Uninstall old extensions | Gỡ extension cũ

```bash
code --uninstall-extension zixfel.ag-auto-click-scroll
code --uninstall-extension zixfel.ag-auto-model-switch
```

AG Autopilot will automatically clean up old inject tags from both extensions.
AG Autopilot sẽ tự dọn dẹp các tag inject cũ từ cả hai extension.

## License
MIT © ANLE
