# Grav — Autopilot + AI Learning Engine for Antigravity

Autopilot thông minh cho Antigravity IDE. Auto-approve, auto-scroll, quota radar, và một AI learning engine lấy cảm hứng từ Andrej Karpathy — tự học thói quen của bạn, tự quản lý whitelist/blacklist, tự compile knowledge vào persistent wiki.

---

## Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────┐
│              GRAV v1.0.0                        │
├────────────────────┬────────────────────────────┤
│   AUTOPILOT        │   AI LEARNING ENGINE       │
│                    │                            │
│  Auto-Approve      │  Karpathy Training Recipe  │
│  Stick-to-Bottom   │  ├ SGD + Momentum          │
│  Quota Radar       │  ├ RLVR (Verifiable Rewards)│
│  Corrupt Banner    │  ├ Weight Decay            │
│  Suppression       │  └ Pattern Generalization  │
│                    │                            │
│                    │  Second Brain (LLM Wiki)   │
│                    │  ├ Wiki Pages + Index       │
│                    │  ├ Concept Map             │
│                    │  ├ Contradiction Detection  │
│                    │  └ Periodic Lint           │
├────────────────────┴────────────────────────────┤
│  Terminal Command Management                    │
│  Whitelist (130+ built-in) + Blacklist + Learned│
│  Compound command parsing (&&, |, ;)            │
├─────────────────────────────────────────────────┤
│  Dashboard (3-tab webview)                      │
│  Autopilot | Second Brain | Stats               │
└─────────────────────────────────────────────────┘
```

Grav gồm 2 phần chính:

- **Autopilot** — tự động hóa các thao tác lặp lại: bấm nút, cuộn chat, phát hiện quota, đổi model.
- **AI Learning Engine** — hệ thống tự học dựa trên phương pháp của Andrej Karpathy, theo dõi thói quen approve/reject terminal commands, tự compile knowledge, tự suggest whitelist/blacklist.

---

## Tính năng

### Autopilot

| Tính năng | Mô tả |
|-----------|-------|
| Auto-Approve | Tự bấm Run, Allow, Accept, Always Allow, Keep Waiting, Continue, Retry |
| Stick-to-Bottom | Giữ chat cuộn xuống cuối, tự dừng khi bạn kéo lên đọc |
| Quota Radar | Phát hiện 25+ cụm từ hết quota, hiện cảnh báo |
| Corrupt Banner | Tự tắt thông báo "corrupt/reinstall" sau khi inject |
| Accept Loop | Gọi VS Code command API mỗi 2s để accept agent steps |
| Win32 Handler | Tự bấm "Keep Waiting" trên Windows native dialogs |

### Terminal Command Management

| Tính năng | Mô tả |
|-----------|-------|
| Built-in Whitelist | 130+ lệnh an toàn (npm, git, docker, python, cargo, kubectl...) |
| Built-in Blacklist | 18 patterns nguy hiểm (rm -rf /, fork bomb, dd if=...) |
| User Whitelist | Thêm lệnh tùy chỉnh qua settings hoặc Command Palette |
| User Blacklist | Chặn lệnh/pattern (hỗ trợ substring và `/regex/`) |
| Compound Parsing | Phân tích lệnh ghép: `npm build && docker push` → kiểm tra từng lệnh |
| Sudo Stripping | Tự strip sudo, nohup, env vars trước khi kiểm tra |

### AI Learning Engine (Karpathy-inspired)

Hệ thống tự học dựa trên 2 framework của Andrej Karpathy:

#### Framework 1: Neural Network Training Recipe

Mỗi terminal command được coi như một "neuron" với confidence weight:

| Thành phần | Giá trị mặc định | Mô tả |
|------------|-------------------|-------|
| Learning rate (α) | 0.15 | Tốc độ cập nhật confidence mỗi event |
| Momentum | 0.9 | Smooth out noise giữa các events |
| Weight decay (γ) | 0.97/ngày | Confidence giảm dần nếu không dùng |
| Promote threshold | 0.75 | Confidence đủ cao → suggest whitelist |
| Demote threshold | -0.50 | Confidence quá thấp → suggest blacklist |
| Min observations | 5 | Tối thiểu events trước khi suggest |
| Batch size | 10 | Mini-batch averaging giảm variance |

Công thức cập nhật (SGD with momentum):
```
reward = approve ? +1.0 : -1.0
reward += exit_code_bonus          ← RLVR: verifiable reward
batch_reward = avg(recent_rewards) ← mini-batch SGD
gradient = α × batch_reward
velocity = momentum × velocity + gradient
confidence += velocity × (1 - momentum)
confidence = clamp(-1, +1)
```

Khi confidence vượt threshold → Grav tự suggest thêm vào whitelist hoặc blacklist.

#### Framework 2: Second Brain (LLM Wiki)

Thay vì chỉ lưu raw data, Grav compile knowledge vào persistent wiki:

```
Layer 1 (Raw)   → Immutable observations (approve/reject events)
Layer 2 (Wiki)  → Compiled knowledge (pages, concepts, synthesis)
Layer 3 (Schema)→ Rules (hyperparameters, thresholds)
```

3 operations:
- **Ingest** — mỗi event ripple qua wiki: update command page, concept page, cross-references, detect contradictions
- **Query** — `evaluateCommand()` đọc wiki (compiled) thay vì scan raw data
- **Lint** — periodic health check: tìm orphans, stale entries, contradictions, unclassified commands

Wiki tự duy trì:
- **Index** — catalog tất cả commands đã biết, với summary, risk level, tags
- **Concepts** — nhóm commands theo category (package-manager, build-tool, database...)
- **Synthesis** — high-level patterns (peak activity time, trusted categories)
- **Contradictions** — phát hiện khi behavior thay đổi bất thường
- **Activity Log** — timeline mọi ingest/lint events

### Dashboard

Dashboard 3 tab, mở bằng `Cmd+Shift+D`:

| Tab | Nội dung |
|-----|----------|
| Autopilot | Module toggles, timing sliders, pattern chips |
| Second Brain | 6 hero metrics, Knowledge Wiki overview, Concept Map với confidence bars + risk badges, Wiki Activity Log |
| Stats | Click statistics, pattern distribution bars, click log |

---

## Commands

| Command | Phím tắt | Mô tả |
|---------|----------|-------|
| Grav: Inject Runtime | — | Inject runtime vào workbench.html |
| Grav: Eject Runtime | — | Gỡ runtime |
| Grav: Dashboard | `Cmd+Shift+D` | Mở dashboard 3 tab |
| Grav: Diagnostics | — | Xem thông tin debug + learning stats |
| Grav: Manage Terminal Commands | — | Menu quản lý whitelist/blacklist/wiki |
| Grav: View Learning Stats | — | Xem learning data |

Menu "Manage Terminal Commands" bao gồm:
- Thêm/xóa whitelist
- Thêm/xóa blacklist
- Kiểm tra lệnh (test nếu lệnh sẽ được allow)
- Xem tất cả (whitelist + blacklist + learned + patterns)
- Learning Stats (confidence, velocity, observations, status)
- Second Brain Wiki (full wiki view)
- Contradictions (xem mâu thuẫn)
- Lint Wiki (health check)
- Reset Learning (xóa toàn bộ data)

---

## Settings

| Setting | Type | Default | Mô tả |
|---------|------|---------|-------|
| `grav.enabled` | boolean | `true` | Bật/tắt Grav |
| `grav.autoScroll` | boolean | `true` | Stick-to-bottom scroll |
| `grav.approvePatterns` | string[] | `["Run","Allow","Always Allow","Keep Waiting","Continue","Retry"]` | Nút tự bấm |
| `grav.scrollPauseMs` | number | `7000` | Nghỉ cuộn khi user kéo lên (ms) |
| `grav.scrollIntervalMs` | number | `500` | Tốc độ quét cuộn (ms) |
| `grav.approveIntervalMs` | number | `1000` | Tốc độ quét nút (ms) |
| `grav.language` | enum | `"vi"` | Ngôn ngữ: vi, en, zh |
| `grav.terminalWhitelist` | string[] | `[]` | Lệnh thêm vào whitelist |
| `grav.terminalBlacklist` | string[] | `[]` | Lệnh/pattern bị chặn |
| `grav.learnEnabled` | boolean | `true` | Bật/tắt AI learning |
| `grav.learnThreshold` | number | `3` | Số lần approve để suggest |

---

## Cài đặt

### Từ VSIX file

```bash
# Antigravity CLI
antigravity --install-extension grav-1.0.0.vsix --force

# Hoặc trong IDE
# Cmd+Shift+P → "Extensions: Install from VSIX..." → chọn file
```

### Build từ source

```bash
git clone https://github.com/anlvdt/grav
cd grav
npm install
npx vsce package --no-dependencies
# → grav-1.0.0.vsix
```

---

## Cách hoạt động

### Runtime Injection

Grav inject một file JavaScript (`grav-runtime.js`) vào `workbench.html` của Antigravity. Runtime chạy trong renderer process và thực hiện:

1. Quét DOM tìm buttons matching patterns → click
2. Theo dõi scroll position → auto-scroll to bottom
3. Scan text tìm quota phrases → báo host
4. Dismiss corrupt/reinstall banners

### HTTP Bridge

Runtime và host (extension process) giao tiếp qua HTTP bridge trên port 48787-48850:

- Runtime gửi: click stats, quota detection
- Host gửi: config updates, enable/disable
- API endpoints: `/api/click-log`, `/api/quota-detected`, `/api/eval-command`, `/api/learn-command`, `/api/wiki-query`, `/api/wiki-status`

### Checksum Patching

Sau khi inject, Grav tự patch `product.json` checksums để Antigravity không hiện warning "corrupt installation". Code Cache cũng được clear để force reload.

---

## AI Learning — Chi tiết kỹ thuật

### Data Flow

```
User approve/reject terminal command
        │
        ▼
  extractCommands()     ← parse compound commands
        │
        ▼
  recordCommandAction() ← gradient step (SGD + momentum)
        │
        ├──▶ Update _learnData (raw observations)
        ├──▶ wikiIngest() (compile vào wiki)
        │      ├── Update command page (summary, risk, tags)
        │      ├── Update concept page (category avg confidence)
        │      ├── Build cross-references (backlinks)
        │      ├── Detect contradictions
        │      ├── Update synthesis (high-level patterns)
        │      └── Append activity log
        ├──▶ suggestPromotion() (nếu conf ≥ 0.75)
        └──▶ suggestDemotion() (nếu conf ≤ -0.50)
```

### Evaluation Flow

```
evaluateCommand("npm run build && docker push myapp")
        │
        ▼
  Check blacklist (hard block)     ← highest priority
        │
        ▼
  extractCommands() → ["npm", "docker"]
        │
        ▼
  For each command:
    1. In whitelist? → ALLOW
    2. wikiQuery() → page.riskLevel == "safe"? → ALLOW
    3. In _learnData with conf > 0? → ALLOW (low confidence)
    4. Unknown → BLOCK
        │
        ▼
  Return { allowed, reason, commands, confidence, wiki }
```

### Concept Categories

Hệ thống tự phân loại commands vào 14 categories:

| Category | Commands |
|----------|----------|
| package-manager | npm, yarn, pip, cargo, brew, apt... |
| version-control | git |
| container-ops | docker, podman, kubectl, helm |
| build-tool | make, gcc, tsc, webpack, vite... |
| test-runner | jest, vitest, mocha, playwright |
| linter-formatter | eslint, prettier, ruff, black |
| file-ops | ls, cp, mv, find, tar, zip... |
| network | curl, wget, ping, dig... |
| system-info | ps, top, df, uname, whoami... |
| text-processing | grep, sed, awk, jq... |
| database | sqlite3, psql, mysql, mongosh... |
| language-runtime | node, python, java, rustc... |
| infra | terraform, ansible |
| crypto-encoding | base64, openssl, sha256sum... |

---

## Ngôn ngữ

Dashboard hỗ trợ 3 ngôn ngữ: Tiếng Việt (mặc định), English, 中文.

Thay đổi: Settings → `grav.language` hoặc trong Dashboard footer.

---

## Yêu cầu

- Antigravity IDE (VS Code fork) v1.60.0+
- macOS, Linux, hoặc Windows
- Không cần CDP, không cần thêm dependencies

---

## Troubleshooting

| Vấn đề | Giải pháp |
|--------|-----------|
| Runtime không inject | Chạy `Grav: Inject Runtime`, reload IDE |
| Nút không tự bấm | Kiểm tra `grav.enabled` = true, pattern có trong danh sách |
| Lệnh terminal bị block | Chạy `Grav: Manage Terminal Commands` → "Kiểm tra lệnh" |
| Corrupt warning | Grav tự patch checksums, nếu vẫn hiện → `Grav: Inject Runtime` lại |
| Learning không hoạt động | Kiểm tra `grav.learnEnabled` = true |
| Dashboard trống | Reload IDE sau khi inject |

---

## Credits

- AI Learning Engine lấy cảm hứng từ [Andrej Karpathy](https://karpathy.ai):
  - "A Recipe for Training Neural Networks" (2019)
  - "LLM Wiki" / Second Brain pattern (2026)
  - RLVR — Reinforcement Learning from Verifiable Rewards (2025)

---

## License

MIT © ANLE
