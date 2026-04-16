// ═══════════════════════════════════════════════════════════════
//  Grav v3.0 — Autopilot for Antigravity
//
//  Architecture (CDP-first):
//    CDP engine   — primary mechanism for OOPIF agent panel
//    injection    — fallback for older Antigravity versions
//    bridge       — config sync + dashboard data
//    learning     — adaptive command confidence
//    wiki         — knowledge base
//    terminal     — terminal activity listener
//    dashboard    — webview dashboard
//
//  Zero-config: just install and use.
//    - argv.json auto-patched with --remote-debugging-port=9333
//    - CDP auto-connects and discovers agent panel targets
//    - Observer auto-injected with self-healing heartbeat
//    - No manual flags, no manual restart (unless first install)
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const { DEFAULT_PATTERNS, RISKY_PATTERNS, SAFE_TERMINAL_CMDS } = require('./constants');
const { cfg } = require('./utils');
const injection = require('./injection');
const learning  = require('./learning');
const wiki      = require('./wiki');
const bridge    = require('./bridge');
const terminal  = require('./terminal');
const dashboard = require('./dashboard');

let cdp = null;
try { cdp = require('./cdp'); } catch (_) { /* ws not installed */ }

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
let _acceptPaused = false;
let _dynamicAcceptCmds = []; // discovered at runtime

const CDP_PORT = 9333;

// Session tracking
let _sessionState = {
    startMs: 0, msgCount: 0, toolCalls: [], responseTimes: [],
    lastActivityMs: 0, aiTyping: false, approveCount: 0,
    rejectCount: 0, toolBreakdown: {},
};

// Status bar
let _sbMain, _sbClicks, _sbScroll, _sbCdp;

// ── Auto-CDP: Patch argv.json ────────────────────────────────
function ensureCdpInArgv() {
    try {
        const argvPath = path.join(os.homedir(), '.antigravity', 'argv.json');
        if (!fs.existsSync(argvPath)) return false;

        const raw = fs.readFileSync(argvPath, 'utf8');
        if (raw.includes('remote-debugging-port')) {
            // Fix: Antigravity only reads string values from argv.json, not numbers.
            // Replace numeric value with string value if present.
            if (raw.includes(`"remote-debugging-port": ${CDP_PORT}`) && !raw.includes(`"remote-debugging-port": "${CDP_PORT}"`)) {
                const fixed = raw.replace(
                    `"remote-debugging-port": ${CDP_PORT}`,
                    `"remote-debugging-port": "${CDP_PORT}"`
                );
                fs.writeFileSync(argvPath, fixed, 'utf8');
                return true; // need restart
            }
            return false;
        }

        // Value MUST be a string — Antigravity's argv parser ignores numbers
        const insertLine = `\n\t// Grav: CDP auto-click (port ${CDP_PORT})\n\t"remote-debugging-port": "${CDP_PORT}"`;
        const patched = raw.replace(/\n?\s*\}\s*$/, ',' + insertLine + '\n}');
        fs.writeFileSync(argvPath, patched, 'utf8');
        return true;
    } catch (e) {
        console.error('[Grav] argv.json patch failed:', e.message);
        return false;
    }
}

// ── Dynamic Command Discovery ────────────────────────────────
async function discoverAcceptCommands() {
    try {
        const allCmds = await vscode.commands.getCommands(true);
        // Blocklist: commands that open settings, configure, or manage permissions
        const SKIP_WORDS = ['setting', 'config', 'preference', 'browser', 'permission',
                            'manage', 'open', 'show', 'toggle', 'enable', 'disable',
                            'edit', 'view', 'list', 'reset', 'clear'];
        _dynamicAcceptCmds = allCmds.filter(c => {
            const lower = c.toLowerCase();
            // Must contain antigravity or agent
            if (!lower.includes('antigravity') && !lower.includes('agent')) return false;
            // Must contain an accept-like action
            if (!lower.includes('accept') && !lower.includes('approve') &&
                !lower.includes('allow') && !lower.includes('keep')) return false;
            // Must NOT contain settings/config/browser related words
            for (const skip of SKIP_WORDS) {
                if (lower.includes(skip)) return false;
            }
            return true;
        });
        if (_dynamicAcceptCmds.length > 0) {
            console.log('[Grav] Discovered accept commands:', _dynamicAcceptCmds.join(', '));
        }
    } catch (_) {}
}

// ── State Accessors ──────────────────────────────────────────
function getState() {
    return {
        enabled: _enabled, scrollOn: _scrollOn,
        stats: _stats, log: _log, totalClicks: _totalClicks,
        session: _sessionState, termLog: _termLog,
        cdpConnected: cdp ? cdp.isConnected() : false,
        cdpSessions: cdp ? cdp.getSessionCount() : 0,
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
        cdpConnected: cdp ? cdp.isConnected() : false,
        cdpSessions: cdp ? cdp.getSessionCount() : 0,
    };
}

// ── Status Bar ───────────────────────────────────────────────
function createBar() {
    _sbMain   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    _sbClicks = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    _sbScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10002);
    _sbCdp    = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10003);
    _sbMain.command = _sbClicks.command = _sbScroll.command = _sbCdp.command = 'grav.dashboard';
    _sbClicks.color = '#f9e2af';
    _ctx.subscriptions.push(_sbMain, _sbClicks, _sbScroll, _sbCdp);
    refreshBar();
    _sbMain.show(); _sbClicks.show(); _sbScroll.show(); _sbCdp.show();
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

    // Merge CDP clicks + bridge clicks
    const cdpClicks = cdp ? cdp.getTotalClicks() : 0;
    const total = _totalClicks + cdpClicks;
    if (_sbClicks) _sbClicks.text = '$(target) ' + total;

    if (_sbCdp) {
        const connected = cdp && cdp.isConnected();
        const sessions  = cdp ? cdp.getSessionCount() : 0;
        _sbCdp.text  = connected ? '$(plug) CDP:' + sessions : '$(debug-disconnect) CDP';
        _sbCdp.color = connected ? '#94e2d5' : '#f38ba8';
        _sbCdp.tooltip = connected
            ? `CDP connected | ${sessions} target(s) attached`
            : 'CDP disconnected — restart Antigravity for auto-click';
    }
}

// ── Accept Loop (VS Code API fallback) ───────────────────────
function startAcceptLoop() {
    if (_acceptTimer) clearInterval(_acceptTimer);
    const ms = cfg('approveIntervalMs', 2000);
    _acceptTimer = setInterval(() => {
        if (!_enabled || _acceptPaused) return;

        // Use dynamically discovered commands
        for (const cmd of _dynamicAcceptCmds) {
            vscode.commands.executeCommand(cmd).then(() => {
                _totalClicks++;
                refreshBar();
            }).catch(() => {});
        }
    }, ms);
}

function pauseAcceptLoop()  { _acceptPaused = true; }
function resumeAcceptLoop() { _acceptPaused = false; }

// ── Safe Terminal Auto-Approve ───────────────────────────────
// NOTE: Writing to chat.tools.* configs triggers Antigravity's
// Settings - Browser UI to open for user confirmation.
// We now SKIP this entirely — let the CDP observer and runtime
// handle auto-approve via button clicking instead.
// The learning engine still tracks commands internally.
function setupSafeApprove() {
    // Intentionally disabled — config writes to chat.tools.terminal.autoApprove
    // cause Antigravity to open Settings - Browser window repeatedly.
    // Terminal command safety is handled by the learning engine + Safety Guard.
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
        console.log('[Grav] Quota detected');
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
            console.log('[Grav] Discovered pattern:', p);
        }
    }
    if (changed && _ctx) {
        _ctx.globalState.update('discoveredPatterns', discovered.slice(-50));
        const msg = `[Grav] Discovered: ${patterns.slice(0, 3).join(', ')}`;
        vscode.window.showInformationMessage(msg, 'Add to auto-click', 'Ignore').then(pick => {
            if (pick === 'Add to auto-click') {
                const currentPatterns = cfg('approvePatterns', DEFAULT_PATTERNS);
                const dp = _ctx.globalState.get('disabledPatterns', []);
                for (const p of patterns) {
                    if (!currentPatterns.includes(p) && !dp.includes(p)) currentPatterns.push(p);
                }
                vscode.workspace.getConfiguration('grav').update('approvePatterns', currentPatterns, vscode.ConfigurationTarget.Global);
                if (cdp) cdp.hotUpdate();
            }
        });
    }
}

function onSave() {
    injection.writeRuntimeConfig(_ctx);
    if (cdp) cdp.hotUpdate();
    refreshBar();
}

// ═════════════════════════════════════════════════════════════
//  Activate
// ═════════════════════════════════════════════════════════════
async function activate(ctx) {
    _ctx = ctx;
    _stats       = ctx.globalState.get('stats', {});
    _totalClicks = ctx.globalState.get('totalClicks', 0);
    _log         = ctx.globalState.get('clickLog', []) || [];
    _enabled     = cfg('enabled', true);
    _scrollOn    = cfg('autoScroll', true);
    _sessionState.startMs = Date.now();

    // ── Pattern migration ──
    const userPatterns = cfg('approvePatterns', null);
    const isFirstInstall = !userPatterns;

    if (isFirstInstall) {
        const safePatterns = DEFAULT_PATTERNS.filter(p => !RISKY_PATTERNS.includes(p));
        await vscode.workspace.getConfiguration('grav').update('approvePatterns', [...safePatterns], vscode.ConfigurationTarget.Global);
        await ctx.globalState.update('disabledPatterns', [...RISKY_PATTERNS]);
    } else if (Array.isArray(userPatterns)) {
        let merged = [...userPatterns];
        const dp = ctx.globalState.get('disabledPatterns', []);
        let addedSafe = 0, addedRisky = 0;
        for (const p of DEFAULT_PATTERNS) {
            if (!merged.includes(p) && !dp.includes(p)) {
                if (RISKY_PATTERNS.includes(p)) { dp.push(p); addedRisky++; }
                else { merged.push(p); addedSafe++; }
            }
        }
        if (addedSafe > 0 || addedRisky > 0) {
            await vscode.workspace.getConfiguration('grav').update('approvePatterns', merged, vscode.ConfigurationTarget.Global);
            await ctx.globalState.update('disabledPatterns', dp);
        }
    }

    // Initialize modules
    wiki.init(ctx, () => learning.getData(), () => learning.getEpoch());
    learning.init(ctx, wiki);

    // ── Auto-patch argv.json for CDP (zero-config) ──
    const argvPatched = ensureCdpInArgv();
    if (argvPatched) {
        vscode.window.showInformationMessage(
            '[Grav] Đã cấu hình CDP. Cần QUIT hoàn toàn Antigravity (Cmd+Q / Alt+F4) rồi mở lại để CDP hoạt động. Reload Window không đủ.',
            'OK'
        );
    }

    // ── CDP Engine (PRIMARY) ──
    if (cdp) {
        cdp.init({
            onBlocked: (cmd, reason) => {
                vscode.window.showWarningMessage(`[Grav Safety] Blocked: ${reason}`);
                dashboard.postMessage({ command: 'commandBlocked', cmd: cmd.slice(0, 200), reason });
            },
            onClicked: (data) => {
                _sessionState.approveCount++;
                refreshBar();
                dashboard.postMessage({ command: 'logUpdated', log: cdp.getClickLog() });
            },
            onChatEvent: onChatEvent,
        });
    }

    // ── Injection (FALLBACK for older versions) ──
    injection.hotUpdateRuntime(ctx);
    const ver     = ctx.extension?.packageJSON?.version || '0';
    const lastVer = ctx.globalState.get('grav-version', '0');
    if (!injection.isInjected() || ver !== lastVer) {
        try {
            injection.inject(ctx);
            ctx.globalState.update('grav-version', ver);
            injection.clearCodeCache();
            injection.patchChecksums();
            // Only reload if CDP is NOT connected (avoid double-reload)
            if (!cdp || !cdp.isConnected()) {
                setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 1000);
            }
        } catch (e) { console.error('[Grav] inject:', e.message); }
    } else {
        injection.patchChecksums();
    }

    // ── Bridge (for dashboard + config sync) ──
    bridge.start(ctx, {
        learning, wiki, injection,
        getState, setState, getSessionSafe,
        onStatsUpdated, onClickLogged, onQuotaDetected,
        onChatEvent, onTerminalEvent, onPatternsDiscovered,
        onCommandBlocked: (cmd, reason) => {
            vscode.window.showWarningMessage(`[Grav Safety] Blocked: ${reason}`);
            dashboard.postMessage({ command: 'commandBlocked', cmd: cmd.slice(0, 200), reason });
        },
    });

    // ── Accept Loop (VS Code API fallback) ──
    await discoverAcceptCommands();
    startAcceptLoop();
    injection.writeRuntimeConfig(ctx);
    setupSafeApprove();
    terminal.setup(ctx, learning);

    // ── Status Bar ──
    createBar();

    // Refresh CDP status periodically
    const cdpRefresh = setInterval(refreshBar, 5000);
    ctx.subscriptions.push({ dispose: () => clearInterval(cdpRefresh) });

    // Config change listener
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('grav')) {
            _enabled = cfg('enabled', true);
            _scrollOn = cfg('autoScroll', true);
            refreshBar();
            if (cdp) cdp.hotUpdate();
        }
    }));

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
                `Grav v3.0.0`,
                `Platform: ${process.platform} (${require('os').arch()})`,
                ``,
                `── CDP Engine ──`,
                `Connected: ${cdp ? cdp.isConnected() : 'N/A'}`,
                `Sessions: ${cdp ? cdp.getSessionCount() : 0}`,
                `CDP Clicks: ${cdp ? cdp.getTotalClicks() : 0}`,
                ``,
                `── Extension Host ──`,
                `HTTP bridge: ${bridge.getPort() || 'not started'}`,
                `Enabled: ${_enabled}  Scroll: ${_scrollOn}`,
                `Total clicks: ${_totalClicks}`,
                `Injected: ${injection.isInjected()}`,
                `Accept commands: ${_dynamicAcceptCmds.join(', ') || 'none discovered'}`,
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
        vscode.commands.registerCommand('grav.toggleCDP', async () => {
            if (!cdp) {
                vscode.window.showWarningMessage('[Grav] CDP not available. Install ws: npm install ws');
                return;
            }
            const current = cfg('cdpEnabled', true);
            const newVal = !current;
            await vscode.workspace.getConfiguration('grav').update('cdpEnabled', newVal, vscode.ConfigurationTarget.Global);
            cdp.setEnabled(newVal);
            vscode.window.showInformationMessage(`[Grav] CDP ${newVal ? 'ON' : 'OFF'}`);
        }),
        vscode.commands.registerCommand('grav.pauseAccept', () => {
            pauseAcceptLoop();
            vscode.window.showInformationMessage('[Grav] Auto-accept paused.');
            refreshBar();
        }),
        vscode.commands.registerCommand('grav.resumeAccept', () => {
            resumeAcceptLoop();
            vscode.window.showInformationMessage('[Grav] Auto-accept resumed.');
            refreshBar();
        }),
        vscode.commands.registerCommand('grav.stopAllTerminals', () => {
            let count = 0;
            for (const term of vscode.window.terminals) {
                try { term.sendText('\x03', false); count++; } catch (_) {}
            }
            vscode.window.showInformationMessage(`[Grav] Sent Ctrl+C to ${count} terminal(s).`);
        }),
        vscode.commands.registerCommand('grav.acceptAll', async () => {
            // Strategy 1: Dynamic commands
            for (const cmd of _dynamicAcceptCmds) {
                try { await vscode.commands.executeCommand(cmd); } catch (_) {}
            }
            // Strategy 2: CDP force scan (via hot-update which triggers re-inject)
            if (cdp && cdp.isConnected()) {
                cdp.hotUpdate();
            }
            _totalClicks++;
            refreshBar();
        }),
    );
}

function deactivate() {
    if (_sbMain)   _sbMain.dispose();
    if (_sbClicks) _sbClicks.dispose();
    if (_sbScroll) _sbScroll.dispose();
    if (_sbCdp)    _sbCdp.dispose();
    if (_acceptTimer) clearInterval(_acceptTimer);
    bridge.stop();
    if (cdp) try { cdp.disconnect(); } catch (_) {}

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
