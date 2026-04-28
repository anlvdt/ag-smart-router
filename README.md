# Grav — AI Autopilot for Windsurf / Antigravity IDE

**Stop babysitting your AI agent.** Grav auto-clicks approval buttons, keeps your chat pinned to the latest response, and blocks dangerous terminal commands — completely hands-free.

[![Version](https://img.shields.io/badge/version-4.0.0-blue)](https://github.com/anlvdt/grav) [![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## Why Grav?

Windsurf / Antigravity runs its agent panel inside an Out-of-Process IFrame (OOPIF) — standard VS Code extensions can't reach it. Grav connects directly via **Chrome DevTools Protocol (CDP)**, injecting an observer into the webview to reliably interact with every button regardless of Shadow DOM or iframe boundaries.

> **Works with:** Windsurf IDE, Antigravity IDE, VS Code Native Chat (Copilot Edits), and any VS Code fork that exposes a CDP debug port.

---

## Features

### 🤖 Auto-Click Agent Buttons
Automatically clicks `Accept`, `Accept All`, `Run`, `Approve`, `Retry`, `Proceed`, `Continue`, `Resume`, `Try Again`, and more. Four-layer click strategy for maximum reliability across React, web components, and native DOM.

### 🛡️ Safety Guard (Terminal Protection)
Reads every terminal command **before** clicking `Run`. Blocks 30+ destructive patterns:
- `rm -rf /`, `rm -rf *`, `rm -rf ~`
- `dd if=/dev/zero`, `kill -9 -1`, fork bombs
- `DROP DATABASE`, `TRUNCATE TABLE`
- `git push --force`, `git clean -fdx`
- `curl | bash`, `wget | sh`
- `sudo`, `su -`, `git reset --hard` (added in v3.6.3)
- Docker prune, Windows registry deletes, and more

### 📜 Auto-Scroll
Keeps the chat panel pinned to the bottom while AI responds. Automatically pauses when you scroll up and resumes when you scroll back down.

### 🧠 Adaptive Learning
Observes which terminal commands you approve or reject. Builds a confidence model and suggests promoting safe commands to the whitelist — fewer interruptions over time.

### 🛠️ Auto-Fixer *(Agent Runtime Optimizer)*
If the AI Agent (or you) makes a typo in the terminal and the command fails, Grav instantly evaluates the error and **automatically injects the corrected command**. No wasted turns thinking or asking for permission.
- `gti status` → auto-runs `git status`
- `npm instal` → auto-runs `npm install`
- `python script.py` (when python is missing on macOS) → auto-runs `python3 script.py`
- Parses Git suggestions: `"The most similar command is..."`

### 💬 VS Code Native Chat & Copilot Edits
Fully supports Microsoft's native **Copilot Edits** and Chat tools. Automatically detects native VS Code permission boundaries and auto-clicks `workbench.action.chat.applyAll`, `github.copilot.acceptWorkspaceEdit`, and inline chat accept buttons.

### 🗂️ Per-Project Patterns
Define custom button patterns and blacklists per workspace via `.vscode/grav.json`. Changes reload live without restarting the extension.

```json
{
  "patterns": ["Deploy", "Apply", "Confirm Deploy"],
  "blacklist": ["Drop DB"],
  "dryRun": false
}
```

### ⚡ Adaptive Accept Loop *(unique)*
Most auto-clickers poll at a fixed slow interval and miss approval dialogs. Grav detects when the AI agent fires a `run_command` tool call and **instantly drops its scan interval to 800ms for 10 seconds** — then returns to normal. This eliminates the race condition where an approval dialog appears and disappears before the next poll cycle.

> No other Windsurf/Antigravity extension implements event-driven adaptive polling.

### 🧩 Smart Terminal Kill Guard *(unique)*
When a notification containing input-related keywords appears, Grav now **inspects the actual DOM** before sending any kill signal. If the element contains a visible `<input>` or `<textarea>` (a real blocking shell prompt), it fires. If it's just Antigravity's approval toast — it's silently dismissed, leaving your terminal untouched.

> Prevents the #1 cause of "terminal killed for no reason" reports across all Windsurf extensions.

### 🔍 Diagnostics Conflict Report
`Grav: Diagnostics` now includes an automatic conflict scan: any command in `SAFE_TERMINAL_CMDS` that is also present in `grav.terminalBlacklist` is flagged with a warning. Previously these conflicts were silent and impossible to debug.

### 🔍 Dry Run Mode
Scan and match buttons without clicking. See exactly what Grav would click before enabling auto-approval on a new project.

### 📊 Real-Time Dashboard (`Cmd+Shift+D`)
- Click counter, session uptime, message count
- Toggle Auto-Click, Auto-Scroll, Dry Run
- Enable/disable individual button patterns
- Live activity log, learning engine stats, CDP status

---

## Installation

1. `Cmd+Shift+P` → **Extensions: Install from VSIX** → select `grav-3.6.7.vsix`
2. Fully quit Windsurf/Antigravity (`Cmd+Q` on macOS, `Alt+F4` on Windows)
3. Reopen the IDE — Grav auto-patches `argv.json` with the debug port
4. Status bar shows `🚀 Grav` — you're done

> **Status bar shows `CDP off`?** The IDE wasn't fully restarted. Quit completely and reopen.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `grav.enabled` | `true` | Master on/off switch |
| `grav.autoScroll` | `true` | Keep chat pinned to bottom |
| `grav.dryRun` | `false` | Scan without clicking |
| `grav.approvePatterns` | `[Accept, Run, ...]` | Button labels to auto-click |
| `grav.approveIntervalMs` | `1000` | Scan interval (ms) |
| `grav.scrollPauseMs` | `15000` | Pause duration after manual scroll-up (ms) |
| `grav.learnEnabled` | `true` | Adaptive learning engine |
| `grav.learnThreshold` | `3` | Approvals before whitelist suggestion |
| `grav.terminalWhitelist` | `[]` | Always-allow command patterns |
| `grav.terminalBlacklist` | `[]` | Always-block command patterns (supports `/regex/`) |
| `grav.cdpEnabled` | `true` | CDP engine (required for OOPIF access) |
| `grav.cdpPort` | `9333` | CDP debug port |

---

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `Grav: Dashboard` | `Cmd+Shift+D` | Open monitoring dashboard |
| `Grav: Diagnostics` | — | CDP sessions and button detection state |
| `Grav: Pause Auto-Accept` | `Cmd+Shift+P` | Temporarily pause clicking |
| `Grav: Resume Auto-Accept` | — | Resume clicking |
| `Grav: Toggle Dry Run` | — | Toggle dry run |
| `Grav: Toggle Auto-Scroll` | — | Toggle auto-scroll |
| `Grav: Refresh Observer` | — | Force re-inject observer into all sessions |
| `Grav: Force Reconnect CDP` | — | Manually reconnect CDP |
| `Grav: Init Project Config` | — | Create `.vscode/grav.json` template |
| `Grav: Purge Bad Learning Data` | — | Clean up incorrectly learned entries |
| `Grav: Manage Terminal Commands` | — | Interactively manage whitelist/blacklist |
| `Grav: Stop All Terminals` | `Cmd+Shift+Q` | Send Ctrl+C to Agent terminals (Auto-Kill) |

---

## Status Bar

| Display | Meaning |
|---|---|
| `🚀 Grav 42` | Active — 42 clicks this session |
| `⏸ Grav` | Paused |
| `👁 Grav DRY` | Dry Run mode |
| `🚫 Grav` | Disabled |
| `CDP 2` | CDP connected, 2 active sessions |
| `CDP off` | CDP not connected |

---

## Troubleshooting

**CDP off / disconnected:** Fully quit the IDE (`Cmd+Q`), not just close the window. Reopen. If still failing: `Grav: Force Reconnect CDP`.

**Buttons not being clicked:** Check Dry Run in Dashboard. Open Activity log. Run `Grav: Diagnostics`. Verify label case matches exactly.

**Learning store has garbage:** Run `Grav: Purge Bad Learning Data` (also runs automatically on startup).

**Terminal being killed unexpectedly:** Upgrade to v3.7.0. The Smart Terminal Kill Guard now verifies DOM input presence before firing — approval toasts will never trigger a kill.

---

## Requirements

- Windsurf IDE or Antigravity (VS Code fork with CDP debug port support)
- No additional setup — `ws` WebSocket module is bundled in the VSIX

---

## Changelog

### v4.0.0
- **Auto-Fixer Engine:** New heuristic module that evaluates failed terminal commands (exit code > 0) and automatically injects corrections for common typos (`gti`, `npm instal`), missing aliases (`python` -> `python3`), and Git's "most similar command" suggestions.
- **VS Code Native Chat Support:** Expanded dynamic command detection to fully support Microsoft Copilot Edits (`workbench.action.chat.applyAll`, `github.copilot.acceptWorkspaceEdit`) and Inline Chat.

### v3.7.0
- **Adaptive Accept Loop:** scan interval dynamically drops to 800ms for 10s when `run_command` tool-call fires — eliminates race condition where approval dialog expires before next poll cycle
- **Smart Terminal Kill Guard:** DOM-verified `KILL_TERMINAL` — only fires when an actual `<input>`/`<textarea>` is visible in the notification element; Antigravity approval toasts never trigger it
- **Diagnostics Conflict Report:** `Grav: Diagnostics` now surfaces conflicts between `SAFE_TERMINAL_CMDS` and user `terminalBlacklist` — no more silent misconfigurations
- **Fixed `SUPPRESS_KEYWORDS`:** removed `'requires input'` / `'waiting for user input'` — these are Antigravity's normal approval prompts, not errors
- **Fixed `DEFAULT_BLACKLIST`:** removed `'sudo '` — agent legitimately uses sudo; only `su -` / `su root` remain blocked

### v3.6.7
- Update UI layouts.

### v3.6.3
- **Dev Server Protection:** `grav.stopAllTerminals` (Auto-Kill) now safely filters out user dev servers (e.g., `npm run dev`, `serve`) to avoid collateral damage during deadlock resolution.
- **Enhanced Blacklist:** Added `sudo`, `su -`, and `git reset --hard` to strictly prevent unrecoverable states and password deadlocks.
- **Optimized Matching:** Refactored exact word-boundary matching in `matchesBlacklist` to prevent false positives for single-word destructive commands.

### v3.6.2
- **Updated Auto-Click Patterns:** Sync with Windsurf 1.24+ native UI (`Run Task`, `Allow in Workspace`).
- **Enhanced Security:** Removed sensitive one-time permissions (`Allow Once`, `Trust`) from auto-click defaults.
- **Deep Coverage:** Added missing variants to `RISKY_PATTERNS` and `REJECT_WORDS` for 100% native detection.

### v3.6.1
- Fixed adaptive learning ingesting invalid tokens (numbers, flags, version strings, filenames)
- Added `Grav: Purge Bad Learning Data` command + auto-purge on startup
- `extractCommands()` now rejects non-command tokens with explicit validation

### v3.6.0
- Per-project patterns via `.vscode/grav.json` with live file watcher
- Dry Run mode with Dashboard toggle and status bar indicator
- Notification suppression: replaced polling with debounced `MutationObserver`
- Added `Grav: Init Project Config` and `Grav: Toggle Dry Run` commands

### v3.5.1
- Multi-layer click: added CDP `Input.dispatchMouseEvent` as Layer 4
- RETRY mechanism: JS click verified, CDP native click as fallback
- Shadow DOM and iframe scanning in `collectAllButtons`

### v3.5.0
- CDP engine rewrite: exponential backoff reconnect, session pruning, heartbeat re-inject
- Safety Guard: reads `<code>` blocks adjacent to Run buttons
- Adaptive Learning Engine: mini-batch SGD, confidence scoring, promote/demote
- Knowledge Wiki: command sequence tracking and co-occurrence generalization

---

**Author:** An Le · [GitHub](https://github.com/anlvdt/grav) · [Issues](https://github.com/anlvdt/grav/issues) · anlvdt@gmail.com

☕️ **Support the Developer**
If Grav saves you time, consider supporting:
- 💳 **MB Bank**: `0360126996868` (LE VAN AN)
<p align="left">
  <img src="https://img.vietqr.io/image/970422-0360126996868-compact2.png" width="250" alt="MB Bank QR">
</p>
