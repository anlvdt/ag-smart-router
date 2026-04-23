# Grav

Autopilot for Antigravity IDE. Zero-config CDP-first auto-approve with adaptive safety.

## What it does

Grav watches the Antigravity agent panel and automatically clicks approval buttons (Accept All, Run, Approve, Resume, etc.) so you can let the AI work uninterrupted. It uses Chrome DevTools Protocol to reach buttons inside sandboxed OOPIF webviews — the only reliable method since Antigravity v1.19.6+.

When the agent asks to run a terminal command, Grav's Safety Guard checks it against a blacklist of destructive patterns before clicking. A learning engine tracks your approve/reject behavior over time and adapts.

## Architecture

```
extension.js          entry point, lifecycle, commands
  |
  +-- cdp.js          CDP engine (primary) — WebSocket to Electron debug port
  |     |-- observer   injected JS that scans buttons + auto-scrolls
  |     |-- heartbeat  5s self-healing, auto-reconnect
  |     +-- native click  Input.dispatchMouseEvent fallback
  |
  +-- injection.js    workbench.html runtime (fallback for pre-OOPIF)
  +-- bridge.js       HTTP server on localhost for runtime <-> host sync
  +-- learning.js     SGD confidence engine (approve/reject = reward signal)
  +-- wiki.js         knowledge base — concepts, sequences, contradictions
  +-- terminal.js     shell execution listener (5 capture methods)
  +-- quota.js        Antigravity Language Server quota monitor
  +-- roi.js          time-saved tracker, productivity metrics
  +-- idle.js         typing detection — pauses auto-accept while editing
  +-- dashboard.js    webview panel controller
  +-- constants.js    patterns, blacklists, hyperparameters
  +-- utils.js        regex escape, path safety, command parsing
```

## How it works

1. On activation, Grav patches `argv.json` to enable `--remote-debugging-port=9333`
2. CDP connects to Electron, discovers webview targets, attaches to agent panel
3. A self-contained observer is injected into each target via `Runtime.evaluate`
4. The observer scans for buttons matching configured patterns every cycle
5. Before clicking "Run", the Safety Guard extracts the command text and checks it
6. If CDP click fails, it escalates to `Input.dispatchMouseEvent` (trusted browser events)
7. A fallback runtime in `workbench.html` handles older Antigravity versions

## Features

### Core
- CDP auto-click with OOPIF support
- Auto-scroll (stick-to-bottom) for agent chat
- Connection recovery — auto-clicks Resume, Try Again, Reconnect
- Idle detection — pauses when you type, resumes after 3s idle
- Dynamic command discovery via `vscode.commands.getCommands()`

### Safety
- Destructive command blacklist (rm -rf, drop database, fork bomb, etc.)
- Word-boundary matching prevents false positives
- Per-command confidence tracking with promotion/demotion suggestions
- Risky patterns disabled by default (Always Allow, Enable Overages, etc.)

### Learning Engine
- Mini-batch SGD with momentum — each command is a neuron with confidence weight
- Temporal decay for stale commands
- Context-aware: project, time-of-day, exit code signals
- Pattern generalization from co-occurrence clusters
- Automatic promotion to whitelist at 75% confidence after 5 observations

### Knowledge Base (Wiki)
- 3-layer architecture: raw events, compiled wiki, system rules
- Semantic command classification (16 categories)
- Sequence learning (command A followed by B)
- Contradiction detection (trusted command suddenly rejected)
- Periodic lint: orphan detection, stale pruning, auto-resolve

### Quota Monitor
- Polls Antigravity Language Server on localhost
- Per-model usage bars with status indicators
- Usage rate calculation (%/hour)
- Runway prediction — estimated time until quota exhaustion
- Reset countdown timers

### ROI Tracker
- Time saved per click (weighted by button type)
- Session and lifetime statistics
- Productivity gain percentage
- Projected daily savings

### Dashboard
- Collapsible sections: Control, Targets, Session, Quota, ROI, Brain, Memory, Stats, Log
- Real-time updates via webview messaging (1s stats, 5s brain/wiki)
- Click log, terminal log, wiki event log
- Concept map with confidence bars
- Pattern toggle grid

## Install

Install the `.vsix` file in Antigravity:

```
Extensions sidebar > ... > Install from VSIX > select grav-3.4.1.vsix
```

First launch requires a full quit and restart of Antigravity (Cmd+Q / Alt+F4) for CDP port activation. After that, everything is automatic.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Grav: Dashboard | Cmd+Shift+D | Open/close dashboard |
| Grav: Diagnostics | — | CDP status, targets, learning stats |
| Grav: Manage Terminal | — | Whitelist/blacklist/test commands |
| Grav: Refresh Observer | — | Force re-inject CDP observer |
| Grav: Pause Auto-Accept | — | Temporarily stop clicking |
| Grav: Resume Auto-Accept | — | Resume clicking |
| Grav: Stop All Terminals | Cmd+Shift+Q | Send Ctrl+C to all terminals |
| Grav: Force Accept All | — | Trigger all accept commands now |

## Configuration

All settings under `grav.*` in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| enabled | true | Master on/off |
| autoScroll | true | Stick chat to bottom |
| approvePatterns | [Accept all, Run, ...] | Button labels to click |
| approveIntervalMs | 1000 | Click scan interval |
| scrollIntervalMs | 500 | Scroll scan interval |
| scrollPauseMs | 15000 | Pause scroll when user scrolls up |
| cdpEnabled | true | Enable CDP engine |
| cdpPort | 9333 | CDP debug port |
| learnEnabled | true | Enable learning engine |
| terminalWhitelist | [] | Additional safe commands |
| terminalBlacklist | [] | Additional blocked commands |
| skipTerminalAccept | true | Skip blind terminal accept via API |

## Target detection

Grav only activates on Antigravity IDE (and its predecessors Windsurf/Codeium). Detection checks `vscode.env.appName`, `vscode.env.appRoot`, and `~/.antigravity/argv.json` existence. On VS Code, Cursor, or other editors, the extension loads but does nothing.

## Safety model

The blacklist uses two matching strategies:
- Multi-word patterns match at command start or after separators/sudo prefixes
- Single-word patterns use word-boundary matching to avoid false positives

Commands in `SAFE_TERMINAL_CMDS` (90+ common dev tools) are always allowed. The learning engine can promote frequently-approved commands to the whitelist and suggest blacklisting frequently-rejected ones.

## License

MIT
