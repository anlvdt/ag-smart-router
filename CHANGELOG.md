# Changelog

## [1.1.0] - 2026-04-25

### Security
- **HTTP bridge auth token**: Bridge now generates a random token on startup and validates it on every API request. Runtime receives the token via config injection. Prevents unauthorized local processes from injecting learning data or probing the whitelist.
- **CORS restriction**: Changed `Access-Control-Allow-Origin` from `*` to `vscode-webview://*`.
- **Shell path sanitization**: `elevatedWrite()` now escapes single quotes in file paths before passing to shell commands.
- **Regex length limit**: User-defined blacklist regex patterns are limited to 200 characters to prevent ReDoS.

### Architecture
- **Modular codebase**: Split monolithic `extension.js` (2,360 lines) into 7 focused modules:
  - `constants.js` — All constants and hyperparameters
  - `state.js` — Shared mutable state
  - `utils.js` — Utility functions
  - `inject.js` — Runtime injection logic
  - `learning.js` — AI Learning Engine + Second Brain wiki
  - `terminal.js` — Command analysis, evaluation, terminal listener
  - `bridge.js` — HTTP bridge server
  - `dashboard.js` — Webview dashboard

### Fixed
- **Duplicate event recording**: Terminal commands were recorded twice (at start and end of execution). Now records only at end event, where exit code is available for RLVR reward computation.

### Added
- **Unit tests**: 62 tests covering core functions (extractCommands, evaluateCommand, matchesBlacklist, recordCommandAction, classifyCommand, wikiQuery, wikiLint, shellEscape, etc.)
- **CI pipeline**: GitHub Actions workflow running tests on Node.js 18 and 20.
- **CHANGELOG.md**: This file.

### Changed
- Moved legacy test files from repo root to `scripts/legacy-tests/`.
- Moved `KARPATHY-AI-LEARNING-GUIDE.md` to `docs/`.

## [1.0.0] - 2025-01-01

### Added
- Initial release: Autopilot + AI Learning Engine for Antigravity IDE.
- Auto-approve buttons (Run, Allow, Always Allow, Keep Waiting, Continue).
- Stick-to-bottom scroll for chat panel.
- Quota radar: detect 25+ exhaustion phrases.
- Corrupt-banner suppression.
- Terminal command whitelist (130+ commands) and blacklist (18 patterns).
- Karpathy-inspired adaptive learning with SGD, momentum, temporal decay.
- Second Brain wiki with 3-layer architecture.
- Dashboard with 3 tabs (Autopilot, Second Brain, Stats).
- Multi-language support (Vietnamese, English, Chinese).
