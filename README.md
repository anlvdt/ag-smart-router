# AG Autopilot

**Autopilot for Antigravity AI** — merged from 2 extensions into one, eliminating Layer 0 conflicts.
**Tự lái mọi thứ cho Antigravity AI** — merge từ 2 extension thành một, loại bỏ xung đột Layer 0.

## Credits & Nguồn gốc mã nguồn

| Thành phần | Tác giả gốc | Nguồn | Ghi chú |
|---|---|---|---|
| Auto Click & Auto Scroll (Layer 0) | **zixfel** | Extension `zixfel.ag-auto-click-scroll` v8.3 | Logic auto-click approval buttons, stick-to-bottom scroll, click stats, editor skip, approval detection |
| Smart Model Router & Quota Fallback | **ANLE (anlvdt)** | Extension `zixfel.ag-auto-model-switch` v2.0 → refactored | CDP-based model switching, tier routing, quota detection |
| AG Autopilot (merged + v5–v6) | **ANLE (anlvdt)** | [github.com/anlvdt/ag-smart-router](https://github.com/anlvdt/ag-smart-router) | Merge 2 extensions, CDP architecture, tier-aware fallback, adaptive cooldown, routing history |

Mã nguồn Auto Click & Auto Scroll ban đầu được viết bởi **zixfel**, phát hành dưới dạng VS Code extension `ag-auto-click-scroll`. AG Autopilot kế thừa và mở rộng logic này, đồng thời tái cấu trúc toàn bộ kiến trúc sang CDP-based approach.

## v6.0.0 — Smart Router & Quota Fallback Overhaul

### What changed | Thay đổi gì?

| Feature | Before (v5.x) | After (v6.0) |
|---|---|---|
| Smart Router | Regex-only, no quota awareness | Quota-aware + tier-aware + cost estimation |
| Quota Fallback | Round-robin, fixed cooldown | Tier-aware scoring, adaptive cooldown, dual-limit detection |
| Exhaustion tracking | Simple timestamp, 30min TTL | Sprint (30min) vs Weekly (7 day) dual-limit awareness |
| Cooldown | Fixed 5s/60s | Adaptive 6-level escalation (3s → 120s) |
| Fallback selection | Sequential round-robin | Scored: same-tier preference, cross-family bonus, reliability history |
| Model info | No status bar indicator | Live model indicator in status bar |
| Routing history | None | Tracks success/failure, persists across sessions |
| Quota detection | 13 phrases | 17 phrases + weekly/credit detection + proactive quota bar monitoring |
| Regex patterns | Basic EN/VI | Expanded: frameworks, cloud, Chinese keywords |
| CDP sessions | No cleanup | Stale session detection + auto-cleanup |
| escapeRegex | Broken replacement string | Fixed `\\$&` |
| HTTP server | No cleanup on deactivate | Proper server close |
| Debug output | Basic | Includes routing stats, cooldown level, exhaustion types |

### Key improvements | Cải tiến chính

- **Quota-aware Smart Router**: checks if target model is exhausted before routing, finds best alternative in same tier
- **Token cost estimation**: won't switch to expensive model (Opus) for short/simple prompts
- **Tier-aware fallback**: prefers same-tier models (e.g., Claude Opus → Gemini 3.5 Pro) before downgrading
- **Cross-family preference**: when Claude is exhausted, prefers Gemini (separate quota pool)
- **Adaptive cooldown**: escalates from 3s to 120s on consecutive failures, resets on success
- **Dual-limit awareness**: distinguishes sprint (5h) vs weekly (7-day) quota exhaustion
- **Routing history**: learns from past switch success/failure, persists across sessions
- **Proactive quota monitoring**: checks quota bar levels every 30s, warns before hitting wall
- **Live model indicator**: status bar shows current model name, updates every 10s
- **Enhanced Quick Pick**: shows model cost, reliability %, family, tier, exhaustion type

### Bug fixes | Sửa lỗi
- **escapeRegex**: replacement string was corrupted (`\\7da170df...` → `\\$&`)
- **CDP stale sessions**: dead sessions now auto-cleaned via `Target.detachedFromTarget` events
- **Session verification**: `cdpAttach` verifies existing sessions before reuse
- **HTTP server leak**: server now properly closed on `deactivate()`
- **Race condition**: `_cdpQuotaSwitchInProgress` flag checked more consistently

## Features | Tính năng

| Feature | Description | Mô tả |
|---|---|---|
| Auto Click | Auto-click Run, Allow, Accept, Always Allow, Keep Waiting... | Tự nhấn Run, Allow, Accept, Always Allow, Keep Waiting... |
| Auto Scroll | Scroll chat to bottom, pause when user scrolls up | Cuộn chat xuống cuối, tự dừng khi user kéo lên đọc |
| Smart Accept | Only click Accept in chat panel, never in diff editor | Accept chỉ click ở chat, không click ở diff editor |
| Click Stats | Realtime click statistics with progress bar | Thống kê click realtime với progress bar |
| Smart Router | Quota-aware model selection by prompt content + cost | Tự chọn model theo nội dung prompt + chi phí quota |
| Quota Fallback | Tier-aware auto-switch with adaptive cooldown + "Continue" | Tự đổi model theo tier khi hết quota + gửi "Continue" |
| HTTP Live Sync | Settings update in realtime via internal HTTP server | Settings cập nhật realtime qua HTTP server nội bộ |
| Multi-Instance | Support 2+ Antigravity windows simultaneously | Hỗ trợ 2+ cửa sổ Antigravity cùng lúc |
| Anti-Corrupt | Auto-update checksums, no "corrupt" warning | Tự cập nhật checksums, không hiện cảnh báo "corrupt" |
| Model Indicator | Live status bar showing current model | Status bar hiển thị model hiện tại |
| Route Stats | API endpoint for routing analytics | API endpoint cho phân tích routing |

## Architecture | Kiến trúc

```
┌──────────────────────────┐     ┌─────────────────────────────────┐
│   Layer 0 (injected)     │     │   Extension Host (Node.js)      │
│                          │     │                                 │
│  • Auto Click            │     │  • Smart Router (CDP)           │
│  • Auto Scroll           │HTTP │    - Quota-aware tier routing   │
│  • Thin Enter stub  ────────────▶    - Token cost estimation     │
│  • HTTP config sync      │     │    - Routing history/learning   │
│  • Corrupt banner dismiss│     │  • Quota Fallback (CDP)         │
│                          │     │    - Dual-limit detection       │
│  ~310 lines              │     │    - Tier-aware scoring         │
│                          │     │    - Adaptive cooldown          │
│                          │     │    - Proactive monitoring       │
│                          │     │  • CDP WebSocket connection     │
│                          │     │  • Settings & Status Bar        │
│                          │     │  • HTTP server + /api/route-stats│
│                          │     │  • Win32 Keep Waiting           │
└──────────────────────────┘     └─────────────────────────────────┘
```

## Model Tiers | Phân tier model

| Tier | Models | Cost | Use case |
|------|--------|------|----------|
| Extreme | Claude Opus 4.7/4.6 (Thinking) | 9-10 | Architecture, system design, ML, complex refactor |
| High | Claude Sonnet 4.6/4.5, Gemini 3.5 Pro | 4-5 | Database, security, testing, DevOps, cloud |
| Default | Gemini 3.1 Pro (High), GPT-OSS 120B/100B | 2-3 | Implement, create, build, write code |
| Cheap | Gemini 3 Flash (New), Gemini 3 Flash | 1 | Explain, format, translate, simple questions |

## Installation | Cài đặt

```bash
code --install-extension ag-autopilot-6.0.0.vsix
```

Or | Hoặc: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

## Requires | Yêu cầu
- Antigravity must run with `--remote-debugging-port=9333` for Smart Router & Quota Fallback
- Auto Click & Auto Scroll work without CDP

## License
MIT © ANLE
