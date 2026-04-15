// ═══════════════════════════════════════════════════════════════
//  Grav v2.1.0 — Autopilot for Antigravity / Kiro
//
//  Modular architecture:
//    constants.js  — Frozen config & patterns
//    utils.js      — Sanitized utilities
//    injection.js  — Runtime injection/eject
//    learning.js   — Karpathy-inspired adaptive learning
//    wiki.js       — Second Brain knowledge base
//    bridge.js     — HTTP bridge (runtime ↔ host)
//    terminal.js   — Terminal activity listener
//    dashboard.js  — Webview dashboard
//    cdp.js        — Chrome DevTools Protocol (OOPIF reach)
//    extension.js  — Orchestrator (this file)
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');

const { ACCEPT_CMDS, DEFAULT_PATTERNS, SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST } = require('./constants');
const { cfg, extractCommands } = require('./utils');
const injection = require('./injection');
const learning  = require('./learning');
const wiki      = require('./wiki');
const bridge    = require('./bridge');
const terminal  = require('./terminal');
const dashboard = require('./dashboard');

let cdp = null;
try { cdp = require('./cdp'); } catch (_) { /* ws not installed — CDP disabled */ }

// ── Shared State ─────────────────────────────────────────────
let _ctx         = null;
let _enabled     = true;
let _scrollOn    = true;
let _stats       = {};
let _log         = [];
let _totalClicks = 0;
let _acceptTimer = null;
let _lastQuotaMs = 0;
let _termLog     = [];

// ── Auto-CDP: Patch argv.json to always launch with debug port ──
const CDP_PORT = 9333;

/**
 * Ensure Antigravity's argv.json includes --remote-debugging-port.
 * This makes CDP available automatically on every launch — no manual flags needed.
 * Returns true if patched (needs restart), false if already patched or not applicable.
 */
function ensureCdpInArgv() {
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');

    // Antigravity stores argv.json in ~/.antigravity/
    const argvPath = path.join(os.homedir(), '.antigravity', 'argv.json');
    if (!fs.existsSync(argvPath)) return false;

    try {
        const raw = fs.readFileSync(argvPath, 'utf8');
        // Already has remote-debugging-port?
        if (raw.includes('remote-debugging-port')) return false;

        // Parse JSONC (strip // comments)
        const jsonClean = raw.replace(/^\s*\/\/.*$/gm, '');
        const data = JSON.parse(jsonClean);

        // Add the flag
        data['remote-debugging-port'] = CDP_PORT;

        // Rebuild with comments preserved: insert before closing }
        const insertLine = `\n\t// Grav: Enable CDP for auto-clicking OOPIF buttons (Accept All, Run, etc.)\n\t"remote-debugging-port": ${CDP_PORT}`;
        const patched = raw.replace(/\n?\s*\}\s*$/, ',' + insertLine + '\n}');

        fs.writeFileSync(argvPath, patched, 'utf8');
        return true;
    } catch (e) {
        console.error('[Grav] Failed to patch argv.json:', e.message);
        return false;
    }
}

let _sessionState = {
    startMs: 0, msgCount: 0, toolCalls: [], responseTimes: [],
    lastActivityMs: 0, aiTyping: false, approveCount: 0,
    rejectCount: 0, toolBreakdown: {},
};

// Status bar items
let _sbMain, _sbClicks, _sbScroll;

// ── State accessors (for bridge/dashboard) ───────────────────
function getState() {
    return {
        enabled: _enabled, scrollOn: _scrollOn,
        stats: _stats, log: _log, totalClicks: _totalClicks,
        session: _sessionState, termLog: _termLog,
    };
}

function setState(patch) {
    if (patch.enabled !== undefined) _enabled = patch.enabled;
    if (patch.scrollOn !== undefined) _scrollOn = patch.scrollOn;
}

function getSessionSafe() {
    const now = Date.now();
    const sessionMs = _sessionState.startMs ? now - _sessionState.startMs : 0;
    const avgResponseMs = _sessionState.responseTimes.length > 0
        ? Math.round(_sessionState.responseTimes.reduce((a, b) => a + b, 0) / _sessionState.responseTimes.length)
        : 0;
    return {
        sessionMs, msgCount: _sessionState.msgCount,
        approveCount: _sessionState.approveCount,
        aiTyping: _sessionState.aiTyping, avgResponseMs,
        toolBreakdown: _sessionState.toolBreakdown,
        recentTools: _sessionState.toolCalls.slice(-20),
        learningHealth: wiki.learningHealth(),
    };
}

// ── Status Bar ───────────────────────────────────────────────
function createBar() {
    _sbMain   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    _sbClicks = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    _sbScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10002);
    _sbMain.command = _sbClicks.command = _sbScroll.command = 'grav.dashboard';
    _sbClicks.color = '#f9e2af';
    _ctx.subscriptions.push(_sbMain, _sbClicks, _sbScroll);
    refreshBar();
    _sbMain.show(); _sbClicks.show(); _sbScroll.show();
}

function refreshBar() {
    if (!_sbMain) return;
    _sbMain.text  = _enabled ? '$(rocket) Grav' : '$(circle-slash) Grav';
    _sbMain.color = _enabled ? '#94e2d5' : '#f38ba8';
    _sbMain.backgroundColor = _enabled ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
    if (_sbScroll) {
        _sbScroll.text  = _scrollOn ? '$(fold-down) Scroll' : '$(circle-slash) Scroll';
        _sbScroll.color = _scrollOn ? '#94e2d5' : '#f38ba8';
    }
    if (_sbClicks) _sbClicks.text = '$(target) ' + _totalClicks;
}

// ── Accept Loop ──────────────────────────────────────────────
// FIX: Add pause/resume control + rate limiting to prevent
// the "brain keeps running terminal commands" spiral.
// The old loop blindly fired ACCEPT_CMDS every 2s, which auto-accepted
// every terminal command the AI proposed — creating an unstoppable chain.
let _acceptPaused = false;
let _acceptClickCount = 0;
const _ACCEPT_RATE_LIMIT = 10; // max accepts per 30s window
const _ACCEPT_RATE_WINDOW = 30000;
let _acceptRateStart = 0;

function startAcceptLoop() {
    if (_acceptTimer) clearInterval(_acceptTimer);
    const ms = cfg('approveIntervalMs', 2000);
    _acceptTimer = setInterval(() => {
        if (!_enabled || _acceptPaused) return;

        // Rate limiting: if we've accepted too many in a short window, pause
        const now = Date.now();
        if (now - _acceptRateStart > _ACCEPT_RATE_WINDOW) {
            _acceptRateStart = now;
            _acceptClickCount = 0;
        }
        if (_acceptClickCount >= _ACCEPT_RATE_LIMIT) {
            console.log('[Grav] Accept rate limit reached (' + _ACCEPT_RATE_LIMIT + '/' + (_ACCEPT_RATE_WINDOW/1000) + 's). Pausing accept loop.');
            _acceptPaused = true;
            // Auto-resume after the window resets
            setTimeout(() => {
                _acceptPaused = false;
                _acceptClickCount = 0;
                _acceptRateStart = Date.now();
                console.log('[Grav] Accept loop resumed after rate limit cooldown.');
            }, _ACCEPT_RATE_WINDOW);
            return;
        }

        // Only fire accept commands for NON-terminal steps by default.
        // Terminal commands should be accepted by the runtime's button clicker
        // (which has Safety Guard), not by blind VS Code command execution.
        const skipTerminal = cfg('skipTerminalAccept', true);
        for (const cmd of ACCEPT_CMDS) {
            if (skipTerminal && cmd === 'antigravity.terminalCommand.accept') continue;
            vscode.commands.executeCommand(cmd).then(() => {
                _acceptClickCount++;
            }).catch(() => {});
        }
    }, ms);
}

function pauseAcceptLoop() { _acceptPaused = true; }
function resumeAcceptLoop() { _acceptPaused = false; _acceptClickCount = 0; }

// ── Safe Terminal Auto-Approve ───────────────────────────────
// CHANGED: No longer force-enables IDE auto-approve settings.
// Only populates the whitelist rules — user controls the master switch.
function setupSafeApprove() {
    setTimeout(() => {
        try {
            const c = vscode.workspace.getConfiguration();
            const rules = c.get('chat.tools.terminal.autoApprove') || {};
            const allWhitelist = [...SAFE_TERMINAL_CMDS, ...learning.getWhitelist()];
            for (const cmd of learning.getPromotedCommands()) {
                if (!allWhitelist.includes(cmd)) allWhitelist.push(cmd);
            }
            for (const pat of learning.getPatternCache()) {
                if (!allWhitelist.includes(pat)) allWhitelist.push(pat);
            }
            for (const cmd of allWhitelist) {
                if (!learning.getBlacklist().includes(cmd)) rules[cmd] = true;
            }
            for (const cmd of learning.getBlacklist()) delete rules[cmd];

            // Only update the rules list — do NOT force-enable auto-approve master switches
            // User should enable those manually if they want
            c.update('chat.tools.terminal.autoApprove', rules, vscode.ConfigurationTarget.Global)
                .catch(() => {});
        } catch (_) {}
    }, 3000);
}

// ── Bridge Event Handlers ────────────────────────────────────
function onStatsUpdated() {
    _totalClicks = Object.values(_stats).reduce((a, b) => a + b, 0);
    refreshBar();
    if (_ctx) {
        _ctx.globalState.update('stats', _stats);
        _ctx.globalState.update('totalClicks', _totalClicks);
    }
}

function onClickLogged(d) {
    if (_ctx) _ctx.globalState.update('clickLog', _log);
    dashboard.postMessage({ command: 'logUpdated', log: _log });

    // Feed button clicks to learning engine
    if (cfg('learnEnabled', true) && d.button) {
        const btn = d.button.trim();
        const cmdMatch = btn.match(/[`']([^`']+)[`']/) || btn.match(/^(?:Run|Allow|Execute)\s+(.+)/i);
        if (cmdMatch) {
            learning.recordAction(cmdMatch[1].trim(), 'approve', {
                project: vscode.workspace.workspaceFolders?.[0]?.name,
            });
        }
    }
}

function onQuotaDetected() {
    if (Date.now() - _lastQuotaMs > 60000) {
        _lastQuotaMs = Date.now();
        console.log('[Grav] Quota exhaustion detected');
        dashboard.postMessage({ command: 'quotaDetected', ts: Date.now() });
    }
}

function onChatEvent(d) {
    const now = Date.now();
    _sessionState.lastActivityMs = now;

    if (d.type === 'message-start') {
        _sessionState.aiTyping = true;
    } else if (d.type === 'message-end') {
        _sessionState.aiTyping = false;
        _sessionState.msgCount++;
        if (d.responseMs > 0) {
            _sessionState.responseTimes.push(d.responseMs);
            if (_sessionState.responseTimes.length > 50) _sessionState.responseTimes.shift();
        }
    } else if (d.type === 'tool-call') {
        const tool = d.tool || 'tool-call';
        _sessionState.toolCalls.push({ tool, startMs: now, endMs: 0, durationMs: 0 });
        if (_sessionState.toolCalls.length > 100) _sessionState.toolCalls.shift();
        if (cfg('learnEnabled', true)) {
            learning.recordAction('__tool:' + tool, 'approve', {
                project: vscode.workspace.workspaceFolders?.[0]?.name,
            });
        }
    } else if (d.type === 'tool-result') {
        const tool = d.tool || 'tool-call';
        for (let i = _sessionState.toolCalls.length - 1; i >= 0; i--) {
            const tc = _sessionState.toolCalls[i];
            if (tc.tool === tool && tc.endMs === 0) {
                tc.endMs = now;
                tc.durationMs = d.durationMs || (now - tc.startMs);
                break;
            }
        }
        if (!_sessionState.toolBreakdown[tool]) _sessionState.toolBreakdown[tool] = { count: 0, totalMs: 0 };
        _sessionState.toolBreakdown[tool].count++;
        _sessionState.toolBreakdown[tool].totalMs += d.durationMs || 0;
    }

    dashboard.postMessage({ command: 'sessionUpdated', session: getSessionSafe() });
}

function onTerminalEvent(d) {
    const cmd = (d.cmd || '').trim();
    if (!cmd || cmd.length < 2) return;
    const now = Date.now();
    const recent = _termLog.find(t => t.cmd === cmd && (now - t._ts) < 10000);
    if (recent) return;

    _termLog.unshift({ time: new Date(now).toISOString().slice(11, 19), cmd, source: d.source || 'ui', _ts: now });
    if (_termLog.length > 100) _termLog.pop();

    if (cfg('learnEnabled', true)) {
        learning.recordAction(cmd, 'approve', { project: vscode.workspace.workspaceFolders?.[0]?.name });
    }
    dashboard.postMessage({ command: 'termLogUpdated', termLog: _termLog.slice(0, 30) });
}

function onPatternsDiscovered(patterns) {
    const discovered = _ctx ? _ctx.globalState.get('discoveredPatterns', []) : [];
    let changed = false;
    for (const p of patterns) {
        if (!discovered.includes(p) && !DEFAULT_PATTERNS.includes(p)) {
            discovered.push(p);
            changed = true;
            console.log('[Grav] GEPA: Discovered pattern:', p);
        }
    }
    if (changed && _ctx) {
        _ctx.globalState.update('discoveredPatterns', discovered.slice(-50));
        // Do NOT auto-add discovered patterns — require manual review
        // Show notification so user can decide
        const msg = `[Grav] Discovered new button${patterns.length > 1 ? 's' : ''}: ${patterns.slice(0, 3).join(', ')}`;
        vscode.window.showInformationMessage(msg, 'Add to auto-click', 'Ignore').then(pick => {
            if (pick === 'Add to auto-click') {
                const currentPatterns = cfg('approvePatterns', DEFAULT_PATTERNS);
                const dp = _ctx.globalState.get('disabledPatterns', []);
                for (const p of patterns) {
                    if (!currentPatterns.includes(p) && !dp.includes(p)) currentPatterns.push(p);
                }
                vscode.workspace.getConfiguration('grav').update('approvePatterns', currentPatterns, vscode.ConfigurationTarget.Global);
                injection.hotUpdateRuntime(_ctx);
            }
        });
    }
}

function onSave() {
    injection.writeRuntimeConfig(_ctx);
    refreshBar();
}

// ═════════════════════════════════════════════════════════════
//  Activate / Deactivate
// ═════════════════════════════════════════════════════════════
function activate(ctx) {
    _ctx = ctx;
    _stats       = ctx.globalState.get('stats', {});
    _totalClicks = ctx.globalState.get('totalClicks', 0);
    _log         = ctx.globalState.get('clickLog', []) || [];
    _enabled     = cfg('enabled', true);
    _scrollOn    = cfg('autoScroll', true);
    _sessionState.startMs = Date.now();

    // ── Pattern migration: merge new patterns, disable risky ones by default ──
    const { RISKY_PATTERNS } = require('./constants');
    const userPatterns = cfg('approvePatterns', null);
    const isFirstInstall = !userPatterns;

    if (isFirstInstall) {
        // First install: enable all SAFE patterns, disable RISKY ones
        const safePatterns = DEFAULT_PATTERNS.filter(p => !RISKY_PATTERNS.includes(p));
        vscode.workspace.getConfiguration('grav').update('approvePatterns', [...safePatterns], vscode.ConfigurationTarget.Global);
        ctx.globalState.update('disabledPatterns', [...RISKY_PATTERNS]);
        console.log(`[Grav] First install: ${safePatterns.length} safe ON, ${RISKY_PATTERNS.length} risky OFF`);
    } else if (Array.isArray(userPatterns)) {
        // Existing install: add new patterns (safe → enabled, risky → disabled)
        let merged = [...userPatterns];
        const dp = ctx.globalState.get('disabledPatterns', []);
        let addedSafe = 0, addedRisky = 0;
        for (const p of DEFAULT_PATTERNS) {
            if (!merged.includes(p) && !dp.includes(p)) {
                if (RISKY_PATTERNS.includes(p)) {
                    dp.push(p);
                    addedRisky++;
                } else {
                    merged.push(p);
                    addedSafe++;
                }
            }
        }
        if (addedSafe > 0 || addedRisky > 0) {
            vscode.workspace.getConfiguration('grav').update('approvePatterns', merged, vscode.ConfigurationTarget.Global);
            ctx.globalState.update('disabledPatterns', dp);
            console.log(`[Grav] Migration: ${addedSafe} safe added, ${addedRisky} risky disabled`);
        }
    }

    // Initialize modules
    wiki.init(ctx, () => learning.getData(), () => learning.getEpoch());
    learning.init(ctx, wiki);

    // Injection — always hot-update, full re-inject if needed
    injection.hotUpdateRuntime(ctx);
    const ver     = ctx.extension?.packageJSON?.version || '0';
    const lastVer = ctx.globalState.get('grav-version', '0');
    if (!injection.isInjected() || ver !== lastVer) {
        try {
            injection.inject(ctx);
            ctx.globalState.update('grav-version', ver);
            injection.clearCodeCache();
            injection.patchChecksums();
            setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 1000);
        } catch (e) { console.error('[Grav] inject:', e.message); }
    } else {
        injection.patchChecksums();
    }

    // Start services
    bridge.start(ctx, {
        learning, wiki, injection,
        getState, setState, getSessionSafe,
        onStatsUpdated, onClickLogged, onQuotaDetected,
        onChatEvent, onTerminalEvent, onPatternsDiscovered,
        onCommandBlocked: (cmd, reason) => {
            vscode.window.showWarningMessage(`[Grav Safety] ⛔ Blocked: ${reason}`);
            dashboard.postMessage({ command: 'commandBlocked', cmd: cmd.slice(0, 200), reason });
        },
    });
    startAcceptLoop();
    injection.writeRuntimeConfig(ctx);
    setupSafeApprove();
    terminal.setup(ctx, learning);

    // CDP mode — optional, for OOPIF reach in Antigravity agent panel
    // Auto-patch argv.json so Antigravity always launches with CDP
    const argvPatched = ensureCdpInArgv();
    if (argvPatched) {
        vscode.window.showInformationMessage(
            '[Grav] Đã cấu hình CDP tự động. Restart Antigravity 1 lần để Accept All hoạt động vĩnh viễn.',
            'Restart Now'
        ).then(pick => {
            if (pick === 'Restart Now') {
                // Relaunch Antigravity
                try {
                    require('child_process').execFile('open', ['-a', 'Antigravity']);
                } catch (_) {}
                setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 2000);
            }
        });
    }

    if (cdp) {
        cdp.init({
            onBlocked: (cmd, reason) => {
                vscode.window.showWarningMessage(
                    `[Grav Safety] ⛔ Blocked dangerous command: ${reason}`,
                    'View Details'
                ).then(pick => {
                    if (pick === 'View Details') {
                        vscode.window.showInformationMessage(`Command: ${cmd.slice(0, 200)}\nBlocked by: ${reason}`);
                    }
                });
                dashboard.postMessage({ command: 'commandBlocked', cmd: cmd.slice(0, 200), reason });
            },
        });
    }
    createBar();

    // Config change listener
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('grav')) {
            _enabled = cfg('enabled', true);
            _scrollOn = cfg('autoScroll', true);
            refreshBar();
        }
    }));

    // Win32 native "Keep Waiting" handler
    if (process.platform === 'win32') {
        const ps = 'Add-Type @"\nusing System;using System.Text;using System.Runtime.InteropServices;\npublic class GravWin32{\npublic delegate bool EnumWindowsProc(IntPtr hWnd,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr hwnd,EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern int GetClassName(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);\n[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hWnd,uint Msg,IntPtr w,IntPtr l);\n}\n"@\n$global:clicked=$false\n[GravWin32]::EnumWindows({param($hWnd,$lp)\nif(-not [GravWin32]::IsWindowVisible($hWnd)){return $true}\nif($global:clicked){return $false}\n[GravWin32]::EnumChildWindows($hWnd,{param($ch,$lp2)\n$cls=New-Object System.Text.StringBuilder 64\n[GravWin32]::GetClassName($ch,$cls,64)|Out-Null\nif($cls.ToString() -eq \'Button\'){$txt=New-Object System.Text.StringBuilder 256\n[GravWin32]::GetWindowText($ch,$txt,256)|Out-Null\nif($txt.ToString() -match \'Keep Waiting\'){[GravWin32]::PostMessage($ch,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);$global:clicked=$true}}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){return $false}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){Write-Output \'CLICKED\'}';
        const kwi = setInterval(() => {
            if (!_enabled) return;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 5000 }, (err, stdout) => {
                if (stdout && stdout.trim() === 'CLICKED') { _totalClicks++; refreshBar(); }
            });
        }, 3000);
        ctx.subscriptions.push({ dispose: () => clearInterval(kwi) });
    }

    // ── Commands ──
    ctx.subscriptions.push(
        vscode.commands.registerCommand('grav.inject', async () => {
            if (injection.inject(ctx)) {
                const c = await vscode.window.showInformationMessage('[Grav] Runtime injected. Reload?', 'Reload');
                if (c === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
        vscode.commands.registerCommand('grav.eject', async () => {
            if (injection.eject()) {
                const c = await vscode.window.showInformationMessage('[Grav] Runtime removed. Reload?', 'Reload');
                if (c === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
        vscode.commands.registerCommand('grav.dashboard', () => {
            dashboard.toggle(ctx, {
                learning, wiki, injection,
                getState, setState, getSessionSafe, onSave, refreshBar,
            });
        }),
        vscode.commands.registerCommand('grav.diagnostics', async () => {
            const stats = learning.getStats();
            const promoted = learning.getPromotedCommands();
            const lines = [
                `Grav v2.0.0`,
                `Platform: ${process.platform} (${require('os').arch()})`,
                `HTTP bridge: ${bridge.getPort() || 'not started'}`,
                `Enabled: ${_enabled}  Scroll: ${_scrollOn}`,
                `Total clicks: ${_totalClicks}`,
                `Injected: ${injection.isInjected()}`,
                ``,
                `── Learning Engine ──`,
                `Epoch: ${stats.epoch}`,
                `Tracking: ${stats.totalTracked} commands`,
                `Promoted: ${promoted.length} (${promoted.join(', ') || 'none'})`,
                `Patterns: ${learning.getPatternCache().length}`,
            ];
            const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('grav.manageTerminal', async () => {
            const actions = [
                { label: '$(add) Thêm vào Whitelist', action: 'addWhite' },
                { label: '$(shield) Thêm vào Blacklist', action: 'addBlack' },
                { label: '$(search) Kiểm tra lệnh', action: 'test' },
                { label: '$(book) Xem tất cả', action: 'viewAll' },
                { label: '$(graph) Learning Stats', action: 'learnStats' },
            ];
            const pick = await vscode.window.showQuickPick(actions, { placeHolder: 'Quản lý Terminal Commands' });
            if (!pick) return;
            // Simplified — delegate to learning module
            if (pick.action === 'test') {
                const cmd = await vscode.window.showInputBox({ prompt: 'Nhập lệnh để kiểm tra' });
                if (!cmd) return;
                const result = learning.evaluateCommand(cmd);
                const doc = await vscode.workspace.openTextDocument({
                    content: `${result.allowed ? '✓ ALLOWED' : '✗ BLOCKED'}\nReason: ${result.reason}\nCommands: ${result.commands.join(', ')}`,
                    language: 'text',
                });
                await vscode.window.showTextDocument(doc);
            }
        }),
        vscode.commands.registerCommand('grav.learnStats', async () => {
            const stats = learning.getStats();
            if (stats.commands.length === 0) {
                vscode.window.showInformationMessage('[Grav] Chưa có dữ liệu học');
                return;
            }
            const rows = stats.commands.map(s =>
                `${s.cmd.padEnd(22)} conf:${String(s.conf).padEnd(7)} obs:${String(s.obs).padEnd(5)} ${s.status}`
            );
            const doc = await vscode.workspace.openTextDocument({
                content: `Epoch: ${stats.epoch} | Tracking: ${stats.totalTracked}\n\n${rows.join('\n')}`,
                language: 'text',
            });
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('grav.launchCDP', async () => {
            const { execSync: es } = require('child_process');
            // Check if CDP already available
            try {
                const res = es('curl -s --connect-timeout 1 http://127.0.0.1:9333/json/version', { timeout: 3000 }).toString();
                if (res.includes('webSocketDebuggerUrl')) {
                    vscode.window.showInformationMessage('[Grav] CDP already running on port 9333. Enable grav.cdpEnabled in settings.');
                    return;
                }
            } catch (_) {}

            const pick = await vscode.window.showInformationMessage(
                '[Grav] Launch Antigravity with CDP mode?\nThis enables OOPIF button detection for terminal popups.',
                'Launch', 'Copy Command', 'Cancel'
            );
            if (pick === 'Launch') {
                try {
                    es('open -a Antigravity --args --remote-debugging-port=9333', { timeout: 5000 });
                    // Auto-enable CDP setting
                    await vscode.workspace.getConfiguration('grav').update('cdpEnabled', true, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('[Grav] Antigravity launching with CDP. Reload window in a few seconds.');
                } catch (e) {
                    vscode.window.showErrorMessage('[Grav] Failed to launch: ' + e.message);
                }
            } else if (pick === 'Copy Command') {
                await vscode.env.clipboard.writeText('open -a Antigravity --args --remote-debugging-port=9333');
                vscode.window.showInformationMessage('[Grav] Command copied. Paste in terminal, then enable grav.cdpEnabled.');
            }
        }),
        vscode.commands.registerCommand('grav.toggleCDP', async () => {
            if (!cdp) {
                vscode.window.showWarningMessage('[Grav] CDP module not available. Install ws: npm install ws');
                return;
            }
            const current = cfg('cdpEnabled', false);
            const newVal = !current;
            await vscode.workspace.getConfiguration('grav').update('cdpEnabled', newVal, vscode.ConfigurationTarget.Global);
            if (newVal) {
                cdp.setEnabled(true);
                vscode.window.showInformationMessage('[Grav] CDP mode ON — detecting OOPIF buttons');
            } else {
                cdp.setEnabled(false);
                vscode.window.showInformationMessage('[Grav] CDP mode OFF');
            }
        }),
        // FIX: Add pause/resume commands so user can stop the auto-accept spiral
        vscode.commands.registerCommand('grav.pauseAccept', () => {
            pauseAcceptLoop();
            vscode.window.showInformationMessage('[Grav] Auto-accept paused. Terminal commands will no longer be auto-approved.');
            refreshBar();
        }),
        vscode.commands.registerCommand('grav.resumeAccept', () => {
            resumeAcceptLoop();
            vscode.window.showInformationMessage('[Grav] Auto-accept resumed.');
            refreshBar();
        }),
        vscode.commands.registerCommand('grav.stopAllTerminals', () => {
            // Send SIGINT to all active terminals
            const terminals = vscode.window.terminals;
            let count = 0;
            for (const term of terminals) {
                try {
                    term.sendText('\x03', false); // Ctrl+C
                    count++;
                } catch (_) {}
            }
            vscode.window.showInformationMessage(`[Grav] Sent Ctrl+C to ${count} terminal(s).`);
        }),
        // Dedicated Accept All command — tries every possible approach
        vscode.commands.registerCommand('grav.acceptAll', async () => {
            let clicked = false;
            // Strategy 1: VS Code command API
            for (const cmd of ACCEPT_CMDS) {
                try {
                    await vscode.commands.executeCommand(cmd);
                    clicked = true;
                } catch (_) {}
            }
            // Strategy 2: If CDP is connected, force a scan
            if (cdp && cdp.isConnected()) {
                // CDP observer is already scanning continuously
                clicked = true;
            }
            if (clicked) {
                _totalClicks++;
                refreshBar();
            }
        }),
    );
}

function deactivate() {
    if (_sbMain)   _sbMain.dispose();
    if (_sbClicks) _sbClicks.dispose();
    if (_sbScroll) _sbScroll.dispose();
    if (_acceptTimer) clearInterval(_acceptTimer);
    bridge.stop();
    if (cdp) try { cdp.disconnect(); } catch (_) {}

    // Flush all data
    learning.flush();
    wiki.flush();
    if (_ctx) {
        try {
            _ctx.globalState.update('stats', _stats);
            _ctx.globalState.update('totalClicks', _totalClicks);
            _ctx.globalState.update('clickLog', _log);
        } catch (_) {}
    }
}

module.exports = { activate, deactivate };
