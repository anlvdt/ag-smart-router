# Grav — AI Autopilot for Windsurf / Antigravity IDE

**Stop babysitting your AI agent.** Grav auto-clicks approval buttons, keeps your chat pinned to the latest response, and blocks dangerous terminal commands — completely hands-free.

[![Version](https://img.shields.io/badge/version-4.0.18-blue)](https://marketplace.visualstudio.com/items?itemName=ANLE.grav) [![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE) [![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/ANLE.grav?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=ANLE.grav)

---

## Why Grav?

Windsurf / Antigravity runs its agent panel inside an Out-of-Process IFrame (OOPIF) — standard VS Code extensions can't reach it. Grav connects directly via **Chrome DevTools Protocol (CDP)**, injecting an observer into the webview to reliably interact with every button regardless of Shadow DOM or iframe boundaries.

> **Works with:** Windsurf IDE, Antigravity IDE, VS Code Native Chat (Copilot Edits), and any VS Code fork that exposes a CDP debug port.

---

## Features

### 🤖 Auto-Click Agent Buttons
Automatically clicks `Accept`, `Accept All`, `Run`, `Run Task`, `Execute`, `Approve`, `Retry`, `Proceed`, `Allow`, `Allow Once`, `Always Allow`, `Allow in Workspace`, and more. Four-layer click strategy for maximum reliability across React, web components, and native DOM.

### 🛡️ Safety Guard (Terminal Protection)
Reads every terminal command **before** clicking `Run` or `Execute`. Blocks 30+ destructive patterns:
- `rm -rf /`, `rm -rf *`, `rm -rf ~`
- `dd if=/dev/zero`, `kill -9 -1`, fork bombs (`:(){:|:&};:`)
- `DROP DATABASE`, `TRUNCATE TABLE`
- `git push --force`, `git push -f`, `git clean -fdx`, `git reset --hard`
- `curl <url> | bash`, `wget <url> | sh`, `curl <url> | zsh` — pipe-to-shell detection
- `docker system prune -a --volumes`
- Windows: `reg delete hk`, `vssadmin delete shadows`, PowerShell execution bypass
- `su -`, `su root` (interactive shell deadlock)

Custom patterns via `grav.terminalBlacklist` support plain substrings and `/regex/` syntax.

### 🌐 Skip Browser SubAgent
When the AI agent attempts to use a browser automation tool (`browser_subagent`, `computer_use`, `use_browser`), Grav detects it and clicks **Skip** instead of **Run** — preventing unintended browser sessions. Toggle via status bar or `Grav: Toggle Skip Browser SubAgent`.

### 📜 Auto-Scroll
Keeps the chat panel pinned to the bottom while AI responds. Automatically pauses when you scroll up and resumes when you scroll back down.

### 🧠 Adaptive Learning
Observes which terminal commands you approve or reject. Builds a confidence model and suggests promoting safe commands to the whitelist — fewer interruptions over time.

### 🛠️ Auto-Fixer
If the AI Agent makes a typo in the terminal and the command fails, Grav evaluates the error and **automatically injects the corrected command**. No wasted turns asking for permission.
- `gti status` → auto-runs `git status`
- `npm instal` → auto-runs `npm install`
- `python script.py` (missing alias on macOS) → auto-runs `python3 script.py`
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

### ⚡ Adaptive Accept Loop
Detects when the AI agent fires a `run_command` tool call and **instantly drops its scan interval to 800ms for 10 seconds** — then returns to normal. Eliminates the race condition where an approval dialog appears and disappears before the next poll cycle.

### 🧩 Smart Terminal Kill Guard
When a notification containing blocking keywords appears, Grav **inspects the actual DOM** before sending any kill signal. Only fires if the element contains a visible `<input>` or `<textarea>`. Antigravity's approval toasts are silently dismissed, leaving your terminal untouched.

### 🔍 Dry Run Mode
Scan and match buttons without clicking. See exactly what Grav would click before enabling auto-approval on a new project.

### 📊 Real-Time Dashboard (`Cmd+Shift+D`)
- Toggle Auto-Click, Auto-Scroll, Dry Run, Skip Browser SubAgent
- Enable/disable individual button patterns
- Live activity log, learning engine stats, CDP connection status
- ROI tracker, idle detection

---

## Installation

### From VS Marketplace (Recommended)
1. Open Windsurf / Antigravity IDE
2. `Cmd+Shift+X` → Search **"Grav"** → Install
3. Fully quit the IDE (`Cmd+Q` on macOS, `Alt+F4` on Windows)
4. Reopen — Grav auto-patches `argv.json` with the debug port
5. Status bar shows `🚀 Grav` — you're done

### From VSIX (Manual)
1. `Cmd+Shift+P` → **Extensions: Install from VSIX** → select `grav-4.0.18.vsix`
2. Fully quit and reopen the IDE

> **Status bar shows `CDP off`?** The IDE wasn't fully restarted. Quit completely and reopen.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `grav.enabled` | `true` | Master on/off switch |
| `grav.autoScroll` | `true` | Keep chat pinned to bottom |
| `grav.dryRun` | `false` | Scan without clicking |
| `grav.skipBrowserAgent` | `false` | Click Skip instead of Run on browser_subagent steps |
| `grav.approvePatterns` | `[Accept, Run, ...]` | Button labels to auto-click |
| `grav.presetMode` | `1.19.6` | Button preset: `1.19.6`, `1.23.2`, `1.24+`, `custom` |
| `grav.approveIntervalMs` | `3000` | Scan interval (ms, minimum enforced: 3000) |
| `grav.scrollPauseMs` | `15000` | Pause after manual scroll-up (ms) |
| `grav.learnEnabled` | `true` | Adaptive learning engine |
| `grav.terminalWhitelist` | `[]` | Always-allow command patterns |
| `grav.terminalBlacklist` | `[]` | Always-block command patterns (supports `/regex/`) |
| `grav.cdpEnabled` | `true` | CDP engine (required for OOPIF access) |
| `grav.cdpPort` | `9333` | CDP debug port |

---

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `Grav: Dashboard` | `Cmd+Shift+D` | Open monitoring dashboard |
| `Grav: Diagnostics` | — | CDP sessions, button detection state, conflict report |
| `Grav: Pause Auto-Accept` | — | Temporarily pause clicking |
| `Grav: Resume Auto-Accept` | — | Resume clicking |
| `Grav: Accept All` | — | Force-click all accept commands once |
| `Grav: Toggle Dry Run` | — | Toggle dry run mode |
| `Grav: Toggle Auto-Scroll` | — | Toggle auto-scroll |
| `Grav: Toggle Skip Browser SubAgent` | — | Toggle browser agent bypass |
| `Grav: Refresh Observer` | — | Force re-inject observer into all sessions |
| `Grav: Force Reconnect CDP` | — | Manually reconnect CDP |
| `Grav: Init Project Config` | — | Create `.vscode/grav.json` template |
| `Grav: Purge Bad Learning Data` | — | Clean up incorrectly learned entries |
| `Grav: Learning Stats` | — | View command confidence scores |
| `Grav: Manage Terminal Commands` | — | Interactively manage whitelist/blacklist |
| `Grav: Stop All Terminals` | `Cmd+Shift+Q` | Send Ctrl+C to agent terminals |

---

## Status Bar

| Display | Meaning |
|---|---|
| `🚀 Grav` | Active — auto-clicking |
| `⏸ Grav` | Paused |
| `🚫 Grav` | Disabled |
| `$(plug) N $(fold-down)` | CDP connected, N sessions, auto-scroll ON |
| `$(debug-disconnect)` | CDP disconnected |
| `$(exclude) SKIP` | Skip Browser SubAgent ON |
| `$(eye) DRY` | Dry Run mode ON |

---

## Troubleshooting

**CDP off / disconnected:** Fully quit the IDE (`Cmd+Q`), not just close the window. Reopen. If still failing: `Grav: Force Reconnect CDP`.

**Buttons not being clicked:** Check Dry Run in Dashboard. Open Activity log. Run `Grav: Diagnostics`. Verify label case matches exactly.

**Learning store has garbage:** Run `Grav: Purge Bad Learning Data` (also runs automatically on startup).

**Terminal being killed unexpectedly:** The Smart Terminal Kill Guard verifies DOM input presence before firing — approval toasts will never trigger a kill. If still happening, check `grav.terminalBlacklist` for conflicting entries via `Grav: Diagnostics`.

---

## Requirements

- Windsurf IDE or Antigravity (VS Code fork with CDP debug port support)
- No additional setup — `ws` WebSocket module is bundled in the VSIX

---

## Changelog

### v4.0.18
- **Fix Skip Browser SubAgent not clicking:** When `skipBrowserAgent` was ON, the Skip button failed to click because it lacked a reject-sibling (Skip itself is in `REJECT_WORDS`). Rewrote validation flow — Skip in browser context bypasses sibling check entirely.
- **Execute button safety guard:** `Execute` now goes through the same Run/Run Task safety guard path, ensuring terminal commands are checked before auto-clicking.
- **Skip only fires in browser context:** Added guard `if (matched === 'Skip' && !browserContext) continue` — prevents false Skip clicks on non-browser tool steps.
- **Dashboard overflow fix:** Dashboard panel no longer overflows on narrow viewports.
- **Softer status bar icon:** Reduced visual weight of status bar indicators.
- **Operation presets & observability:** Added operation mode system (`safe`/`balanced`/`fast`/`custom`) with `getState()` and `getSessionSafe()` exposing current mode. New observability state module for metrics tracking.

### v4.0.16 – v4.0.17
- CDP observer version bump and internal refactoring.
- Restored JS click fallback alongside CDP native click for iframe compatibility.

### v4.0.15
- Hardened target selection for CDP injection to avoid broad webview matching.
- Native `Accept All` / accept-loop commands now respect `skipTerminalAccept` and `skipBrowserAgent`, so blind command-level accepts no longer bypass the safer CDP path by default.
- Dashboard dynamic rows now render via DOM/text nodes instead of raw `innerHTML`.
- VSIX packaging excludes local scratch/index artifacts, and activation smoke test now runs against the local repo.

### v4.0.14
- **Fix CDP disconnection under load:** Heartbeat ticks (`setInterval` + async) were running concurrently — each spawning CDP commands that cascaded into timeouts, marking sessions dead, and triggering more discovery loops. Fixed with `_heartbeatRunning` guard that skips a tick if the previous is still in flight.
- **Fix concurrent `discoverTargets()`:** Added `_discoverRunning` guard to prevent the heartbeat, `Target.targetCreated` events, and `hotUpdate()` from running overlapping discovery loops.
- **Fast heartbeat ping:** Observer alive-check (`window.__grav3`) now uses 2s timeout (was 5s) so a dead session fails fast without blocking the full heartbeat tick for 5s.
- **Longer session pruning window:** `DEAD_AFTER_MS` raised from 15s → 30s, giving sessions more time to recover when Antigravity is busy processing a long AI turn.
- **Reconnecting status indicator:** Status bar now shows `$(sync~spin)` (spinning icon) while CDP is reconnecting, with attempt count. Previously showed `$(debug-disconnect)` immediately, causing confusion between "genuinely disconnected" and "momentarily reconnecting."
- **Cleanup guard:** `cleanup()` resets `_heartbeatRunning` and `_discoverRunning` so no stale "lock" blocks the next connection attempt after a WS close.

### v4.0.13
- **Security fix — pipe-to-shell detection:** `curl url | bash`, `wget url | sh`, `curl url | zsh` were silently passing the blacklist due to a regex anchor bug. All 8 pipe-to-shell patterns (`| bash`, `| sh`, `| zsh`, `| pwsh`, `wget|sh`, `curl|sh`, `curl|bash`, `wget|bash`) now correctly block in both the CDP observer and the learning safety guard.
- **False positive fix:** `git push --force` no longer incorrectly blocks `git push --force-with-lease` (trailing word-boundary lookahead added).
- **`Execute` button support:** Added to `DEFAULT_PATTERNS` and `PRESET_PATTERNS['1.24+']` — Antigravity variants that use `Execute` instead of `Run` are now auto-clicked.
- **`Allow This Workspace` added to 1.24+ preset** — covers Antigravity versions that use this label variant.
- **`HIGH_CONF` cleanup:** Removed dead entries `'Go'` (too generic, no matching pattern) and `'Approved'`. Added `'Allow This Workspace'` to match new preset entry.

### v4.0.12
- **Fix SKIP_BROWSER_AGENT false blocking:** When Skip Browser SubAgent was ON and an AI response contained multiple tool calls (e.g., `browser_subagent` followed by `run_terminal`), the terminal `Run` button was incorrectly blocked. Root cause: `b.closest('[class*=message], [class*=container]')` found a broad parent wrapping all steps; its `innerText` contained `browser_subagent` from the earlier step. Fix: narrowed selector to `[class*=tool], [class*=step]` only — per-step scope, no cross-step bleed.
- **Observer version bumped to v4.0.12** for force-reload on update.

### v4.0.11
- Restore JS click fallback alongside CDP native click for maximum compatibility.
- Fix iframe discovery for nested OOPIF targets in Antigravity 1.24+.

### v4.0.10 — v4.0.7
- CDP click: trigger native `Input.dispatchMouseEvent` directly to bypass Antigravity's permission guard.
- Human-like click sequence to avoid anti-automation detection on Antigravity update.
- Split status bar into 4 independent items (main, CDP, Skip, Dry Run).
- Skip Browser SubAgent feature: detect `browser_subagent`/`computer_use` tool calls and click Skip instead of Run.
- Fix activation crash introduced by Antigravity internal update.

### v4.0.0
- **Auto-Fixer Engine:** Evaluates failed terminal commands (exit code > 0) and automatically injects corrections for common typos, missing aliases, and Git suggestions.
- **VS Code Native Chat Support:** Full support for Copilot Edits (`workbench.action.chat.applyAll`, `github.copilot.acceptWorkspaceEdit`) and Inline Chat.

### v3.7.0
- Adaptive Accept Loop: scan interval drops to 800ms for 10s on `run_command` tool-call event.
- Smart Terminal Kill Guard: DOM-verified kill — only fires when `<input>`/`<textarea>` is visible.
- Diagnostics Conflict Report: surfaces conflicts between `SAFE_TERMINAL_CMDS` and user `terminalBlacklist`.

### v3.6.3
- Dev Server Protection: `grav.stopAllTerminals` filters out user dev servers.
- Enhanced Blacklist: Added `su -` and `git reset --hard`.
- Optimized word-boundary matching in `matchesBlacklist`.

### v3.6.0
- Per-project patterns via `.vscode/grav.json` with live file watcher.
- Dry Run mode with Dashboard toggle and status bar indicator.
- Notification suppression: debounced `MutationObserver` replaces polling.

### v3.5.0
- CDP engine rewrite: exponential backoff reconnect, session pruning, heartbeat re-inject.
- Safety Guard: reads `<code>` blocks adjacent to Run buttons.
- Adaptive Learning Engine: mini-batch SGD, confidence scoring, promote/demote.

---

**Author:** An Le · [GitHub](https://github.com/anlvdt/grav) · [Issues](https://github.com/anlvdt/grav/issues) · anlvdt@gmail.com

☕️ **Support the Developer**
If Grav saves you time, consider supporting:
- 💳 **MB Bank**: `0360126996868` (LE VAN AN)
<p align="left">
  <img src="https://img.vietqr.io/image/970422-0360126996868-compact2.png" width="250" alt="MB Bank QR">
</p>
