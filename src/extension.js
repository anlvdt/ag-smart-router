'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { DEFAULT_PATTERNS, RISKY_PATTERNS } = require('./constants');
const { cfg } = require('./utils');
const injection = require('./injection');
const learning = require('./learning');
const wiki = require('./wiki');
const bridge = require('./bridge');
const terminal = require('./terminal');
const dashboard = require('./dashboard');

const roi = require('./roi');
const idle = require('./idle');

let cdp = null;
try { cdp = require('./cdp'); } catch (_) { /* optional CDP module */ }

const CDP_PORT = 9333;
let _ctx, _enabled = true, _scrollOn = true, _stats = {}, _log = [], _totalClicks = 0;
let _acceptTimer, _lastQuotaMs = 0, _termLog = [], _acceptPaused = false, _dynamicAcceptCmds = [], _failedCmds = new Set();
let _dryRun = false;  // Dry run: scan buttons but don't click
let _sessionState = { startMs: 0, msgCount: 0, toolCalls: [], responseTimes: [], lastActivityMs: 0, aiTyping: false, approveCount: 0, rejectCount: 0, toolBreakdown: {} };
let _sbMain, _isAntigravity = false;

// ── Detection & Config ───────────────────────────────────────
const isAntigravity = (() => {
    const checkPaths = ['.antigravity', '.windsurf'];
    return () => {
        const n = (vscode.env.appName || '') + ' ' + (vscode.env.appRoot || '');
        const l = n.toLowerCase();
        if (l.includes('antigravity') || l.includes('windsurf') || (l.includes('codeium') && !l.includes('codeium.codeium'))) return true;
        return checkPaths.some(p => fs.existsSync(path.join(os.homedir(), p, 'argv.json')));
    };
})();

const ensureCdpInArgv = (() => {
    const candidates = () => ['.antigravity', '.windsurf'].map(p => path.join(os.homedir(), p, 'argv.json')).filter(fs.existsSync);
    return () => {
        const argvPath = candidates()[0];
        if (!argvPath) return false;
        try {
            const raw = fs.readFileSync(argvPath, 'utf8');
            const portRegex = /"remote-debugging-port"\s*:\s*"?(\d+)"?/;
            const match = raw.match(portRegex);
            if (!match) {
                const patched = raw.replace(/\n?\s*\}\s*$/, `,\n\t"remote-debugging-port": "${CDP_PORT}"\n}`);
                fs.writeFileSync(argvPath, patched, 'utf8');
                return true;
            }
            const [_, port] = match;
            if (port === String(CDP_PORT) && raw.includes(`"${CDP_PORT}"`)) return false;
            const fixed = raw.replace(portRegex, `"remote-debugging-port": "${CDP_PORT}"`);
            fs.writeFileSync(argvPath, fixed, 'utf8');
            return true;
        } catch (e) { console.error('[Grav] argv patch:', e.message); return false; }
    };
})();

// ── State & Handlers ─────────────────────────────────────────
const getState = () => ({ enabled: _enabled, scrollOn: _scrollOn, stats: _stats, log: _log, totalClicks: _totalClicks, session: _sessionState, termLog: _termLog, cdpConnected: cdp ? cdp.isConnected() : false, cdpSessions: cdp ? cdp.getSessionCount() : 0, dryRun: _dryRun, projectPatterns: _projectPatterns });
const setState = (p) => { if (p.enabled !== undefined) _enabled = p.enabled; if (p.scrollOn !== undefined) _scrollOn = p.scrollOn; };
const getSessionSafe = () => {
    const now = Date.now();
    const sessionMs = _sessionState.startMs ? now - _sessionState.startMs : 0;
    const avgResponseMs = _sessionState.responseTimes.length > 0 ? Math.round(_sessionState.responseTimes.reduce((a, b) => a + b, 0) / _sessionState.responseTimes.length) : 0;
    return { sessionMs, msgCount: _sessionState.msgCount, approveCount: _sessionState.approveCount, aiTyping: _sessionState.aiTyping, avgResponseMs, toolBreakdown: _sessionState.toolBreakdown, recentTools: _sessionState.toolCalls.slice(-20), learningHealth: wiki.learningHealth(), cdpConnected: cdp ? cdp.isConnected() : false, cdpSessions: cdp ? cdp.getSessionCount() : 0, roi: roi.getSummary(), idle: idle.isIdle() };
};

const refreshBar = () => {
    if (!_sbMain) return;

    if (_enabled) {
        const cdpSessions = cdp ? cdp.getSessionCount() : 0;
        const cdpInfo = cdp && cdp.isConnected() ? (cdpSessions > 0 ? ` $(${_scrollOn ? 'fold-down' : 'fold-up'}) $(plug) ${cdpSessions}` : ` $(${_scrollOn ? 'fold-down' : 'fold-up'})`) : ' $(debug-disconnect)';
        _sbMain.text = _acceptPaused ? `$(debug-pause) Grav` : `$(rocket) Grav${cdpInfo}`;
        _sbMain.color = _acceptPaused ? '#fbbf24' : '#6ee7b7';
        _sbMain.backgroundColor = undefined;
    } else {
        _sbMain.text = `$(circle-slash) Grav`;
        _sbMain.color = '#f87171';
        _sbMain.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    _sbMain.tooltip = `Grav ${_enabled ? (_acceptPaused ? '[Paused]' : _dryRun ? '[Dry Run]' : '[Active]') : '[Off]'} | ${_totalClicks} clicks\nClick to open Grav Menu`;
    if (_dryRun) { _sbMain.text = `$(eye) Grav DRY`; _sbMain.color = '#a78bfa'; }
};

const onStatsUpdated = () => { _totalClicks = Object.values(_stats).reduce((a, b) => a + b, 0); refreshBar(); if (_ctx) { _ctx.globalState.update('stats', _stats); _ctx.globalState.update('totalClicks', _totalClicks); } };
const onClickLogged = (d) => { if (_ctx) _ctx.globalState.update('clickLog', _log); dashboard.postMessage({ command: 'logUpdated', log: _log }); if (d.pattern) roi.recordClick(d.pattern); if (cfg('learnEnabled', true) && d.button) { const btn = d.button.trim(); const cmdMatch = btn.match(/[`']([^`']+)[`']/) || btn.match(/^(?:Run|Allow|Execute)\s+(.+)/i); if (cmdMatch) learning.recordAction(cmdMatch[1].trim(), 'approve', { project: vscode.workspace.workspaceFolders?.[0]?.name }); } };
const onQuotaDetected = () => {};
const onChatEvent = (d) => {
    const now = Date.now();
    _sessionState.lastActivityMs = now;
    if (d.type === 'message-start') _sessionState.aiTyping = true;
    else if (d.type === 'message-end') { _sessionState.aiTyping = false; _sessionState.msgCount++; if (d.responseMs > 0) { _sessionState.responseTimes.push(d.responseMs); if (_sessionState.responseTimes.length > 50) _sessionState.responseTimes.shift(); } }
    else if (d.type === 'tool-call') {
        const tool = d.tool || 'tool-call';
        _sessionState.toolCalls.push({ tool, startMs: now, endMs: 0, durationMs: 0 });
        if (_sessionState.toolCalls.length > 100) _sessionState.toolCalls.shift();
        // Adaptive boost: run_command approval dialog may appear in next few seconds
        if (tool === 'run_command' || tool === 'tool-call') boostAcceptLoop();
    }
    else if (d.type === 'tool-result') { const tool = d.tool || 'tool-call'; for (let i = _sessionState.toolCalls.length - 1; i >= 0; i--) { const tc = _sessionState.toolCalls[i]; if (tc.tool === tool && tc.endMs === 0) { tc.endMs = now; tc.durationMs = d.durationMs || (now - tc.startMs); break; } } if (!_sessionState.toolBreakdown[tool]) _sessionState.toolBreakdown[tool] = { count: 0, totalMs: 0 }; _sessionState.toolBreakdown[tool].count++; _sessionState.toolBreakdown[tool].totalMs += d.durationMs || 0; }
    dashboard.postMessage({ command: 'sessionUpdated', session: getSessionSafe() });
};
const onTerminalEvent = (d) => {
    const cmd = (d.cmd || '').trim();
    if (!cmd || cmd.length < 2) return;
    const now = Date.now();
    const recent = _termLog.find(t => t.cmd === cmd && (now - t._ts) < 10000);
    if (recent) return;
    _termLog.unshift({ time: new Date(now).toISOString().slice(11, 19), cmd, source: d.source || 'ui', _ts: now });
    if (_termLog.length > 100) _termLog.pop();
    if (cfg('learnEnabled', true)) learning.recordAction(cmd, 'approve', { project: vscode.workspace.workspaceFolders?.[0]?.name });
    dashboard.postMessage({ command: 'termLogUpdated', termLog: _termLog.slice(0, 30) });
};
const onPatternsDiscovered = (patterns) => {
    const discovered = _ctx ? _ctx.globalState.get('discoveredPatterns', []) : [];
    let changed = false;
    for (const p of patterns) { if (!discovered.includes(p) && !DEFAULT_PATTERNS.includes(p)) { discovered.push(p); changed = true; } }
    if (changed && _ctx) {
        _ctx.globalState.update('discoveredPatterns', discovered.slice(-50));
        vscode.window.showInformationMessage(`[Grav] Discovered: ${patterns.slice(0, 3).join(', ')}`, 'Add to auto-click', 'Ignore').then(pick => {
            if (pick === 'Add to auto-click') { const currentPatterns = cfg('approvePatterns', DEFAULT_PATTERNS); const dp = _ctx.globalState.get('disabledPatterns', []); for (const p of patterns) { if (!currentPatterns.includes(p) && !dp.includes(p)) currentPatterns.push(p); } vscode.workspace.getConfiguration('grav').update('approvePatterns', currentPatterns, vscode.ConfigurationTarget.Global); if (cdp) cdp.hotUpdate(); }
        });
    }
};
const onSave = () => { injection.writeRuntimeConfig(_ctx); if (cdp) cdp.hotUpdate(); refreshBar(); };
const onProjectConfigChange = () => { loadProjectConfig(); if (cdp) cdp.hotUpdate(); injection.writeRuntimeConfig(_ctx); };

// ── Per-project patterns (.vscode/grav.json) ─────────────────
let _projectPatterns = [];
const PROJ_CONFIG_FILE = '.vscode/grav.json';

const loadProjectConfig = () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { _projectPatterns = []; return; }
    const cfgPath = path.join(folders[0].uri.fsPath, PROJ_CONFIG_FILE);
    try {
        if (fs.existsSync(cfgPath)) {
            const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            _projectPatterns = Array.isArray(raw.patterns) ? raw.patterns.filter(p => typeof p === 'string' && p.length > 0 && p.length <= 60) : [];
            if (_projectPatterns.length > 0) console.log(`[Grav] Project patterns (${_projectPatterns.length}):`, _projectPatterns.slice(0, 5));
        } else { _projectPatterns = []; }
    } catch (e) { _projectPatterns = []; console.warn('[Grav] grav.json parse error:', e.message); }
};

const getEffectivePatterns = () => {
    const global = cfg('approvePatterns', DEFAULT_PATTERNS);
    if (_projectPatterns.length === 0) return global;
    const merged = [...new Set([..._projectPatterns, ...global])];
    return merged;
};

// ── Accept Loop ───────────────────────────────────────────────
const discoverAcceptCommands = async () => {
    try {
        const allCmds = await vscode.commands.getCommands(true);
        // Expanded SKIP list to catch commands requiring input
        const SKIP = ['setting', 'config', 'preference', 'browser', 'permission', 'manage', 'open', 'show', 'toggle', 'enable', 'disable', 'edit', 'view', 'list', 'reset', 'clear', 'input', 'prompt', 'dialog', 'confirm', 'ask', 'select', 'pick', 'choose'];

        // Whitelist of known safe commands (specific to Antigravity/Windsurf/Copilot/Native Chat)
        const WHITELIST = [
            'antigravity.accept',
            'antigravity.acceptAll',
            'windsurf.accept',
            'windsurf.acceptAll',
            'cascade.accept',
            'cascade.acceptAll',
            'codeium.accept',
            'workbench.action.chat.applyAll',
            'workbench.action.chat.accept',
            'inlineChat.accept',
            'chatEditor.action.accept',
            'github.copilot.acceptWorkspaceEdit'
        ];

        _dynamicAcceptCmds = allCmds.filter(c => {
            const l = c.toLowerCase();

            // First check whitelist (highest priority)
            if (WHITELIST.some(w => l === w.toLowerCase())) return true;

            // Then apply filters for discovered commands
            const ns = l.includes('antigravity') || l.includes('windsurf') || l.includes('cascade') || l.includes('codeium') || l.includes('agent') || l.includes('copilot') || l.includes('chat') || l.includes('inlinechat');
            const act = l.includes('accept') || l.includes('approve') || l.includes('allow') || l.includes('keep') || l.includes('apply');

            if (SKIP.some(s => l.includes(s))) return false;

            return ns && act;
        });

        // Force include all whitelist commands even if hidden from getCommands
        for (const w of WHITELIST) {
            if (!_dynamicAcceptCmds.some(c => c.toLowerCase() === w.toLowerCase())) {
                _dynamicAcceptCmds.push(w);
            }
        }

        console.log(`[Grav] Discovered ${_dynamicAcceptCmds.length} accept commands:`, _dynamicAcceptCmds.slice(0, 10));
    } catch (_) { /* non-critical */ }
};

let _adaptiveBoostUntil = 0; // ms timestamp until which to use fast interval

const boostAcceptLoop = () => {
    _adaptiveBoostUntil = Date.now() + 10000; // boost for 10s
};

const startAcceptLoop = () => {
    if (_acceptTimer) clearInterval(_acceptTimer);
    const BASE_INTERVAL = Math.max(cfg('approveIntervalMs', 3000), 3000);
    const FAST_INTERVAL = 800;
    _acceptTimer = setInterval(() => {
        if (!_enabled || _acceptPaused || !idle.isIdle()) return;
        const now = Date.now();
        // Adaptive: if a run_command/tool event just fired, skip slow cycles
        if (now < _adaptiveBoostUntil) {
            // Running fast — do the accept work
        } else {
            // Slow cycle: only run every BASE_INTERVAL effectively
            // We run the timer at FAST_INTERVAL but skip if not due
            if (!_nextAcceptDue) _nextAcceptDue = now + BASE_INTERVAL;
            if (now < _nextAcceptDue) return;
            _nextAcceptDue = now + BASE_INTERVAL;
        }
        for (const cmd of _dynamicAcceptCmds) {
            if (_failedCmds.has(cmd)) continue;
            vscode.commands.executeCommand(cmd).catch((err) => {
                const errMsg = (err?.message || '').toLowerCase();

                // Silently ignore permission / interaction errors — Antigravity throws these
                // intermittently even for valid accept commands. Do not blacklist.
                const isNoise = errMsg.includes('not permission') ||
                    errMsg.includes('unexpected user interaction') ||
                    errMsg.includes('permission');

                if (isNoise) return; // suppress without logging

                // Only blacklist commands that explicitly need user input arguments
                const needsInput = errMsg.includes('requires') || errMsg.includes('argument') ||
                    errMsg.includes('parameter') || errMsg.includes('input');

                const isCore = cmd.includes('acceptall') || cmd.includes('antigravity.accept') ||
                    cmd.includes('windsurf.accept') || cmd.includes('cascade.accept');

                if (!isCore && needsInput) {
                    _failedCmds.add(cmd);
                    console.log(`[Grav] Excluded command (needs input): ${cmd}`);
                }
            });
        }
    }, FAST_INTERVAL);
};
let _nextAcceptDue = 0;

// ── Activate ─────────────────────────────────────────────────
async function activate(ctx) {
    _ctx = ctx;
    _isAntigravity = isAntigravity();
    console.log(`[Grav] IDE: "${vscode.env.appName}" | Antigravity: ${_isAntigravity}`);
    if (!_isAntigravity) { console.log('[Grav] Not Antigravity — disabled.'); return; }

    _stats = ctx.globalState.get('stats', {});
    _totalClicks = ctx.globalState.get('totalClicks', 0);
    _log = ctx.globalState.get('clickLog', []) || [];
    _enabled = cfg('enabled', true);
    _scrollOn = cfg('autoScroll', true);
    _sessionState.startMs = Date.now();

    // Pattern migration
    const userPatterns = cfg('approvePatterns', null);
    const isFirstInstall = !userPatterns;
    const VALID_PATTERNS = [...DEFAULT_PATTERNS, ...RISKY_PATTERNS];

    if (isFirstInstall) {
        const safePatterns = DEFAULT_PATTERNS.filter(p => !RISKY_PATTERNS.includes(p));
        await vscode.workspace.getConfiguration('grav').update('approvePatterns', [...safePatterns], vscode.ConfigurationTarget.Global);
        await ctx.globalState.update('disabledPatterns', [...RISKY_PATTERNS]);

        vscode.window.showInformationMessage('Welcome to Grav! Autopilot for Antigravity installed.', 'Open Dashboard').then(pick => {
            if (pick === 'Open Dashboard') vscode.commands.executeCommand('grav.dashboard');
        });
    } else if (Array.isArray(userPatterns)) {
        let merged = userPatterns.filter(p => VALID_PATTERNS.includes(p));
        let dp = ctx.globalState.get('disabledPatterns', []).filter(p => VALID_PATTERNS.includes(p));
        let changed = merged.length !== userPatterns.length || dp.length !== ctx.globalState.get('disabledPatterns', []).length;
        for (const p of DEFAULT_PATTERNS) { if (!merged.includes(p) && !dp.includes(p)) { RISKY_PATTERNS.includes(p) ? dp.push(p) : merged.push(p); changed = true; } }
        for (const p of RISKY_PATTERNS) { if (!merged.includes(p) && !dp.includes(p)) { dp.push(p); changed = true; } }
        if (changed) { await vscode.workspace.getConfiguration('grav').update('approvePatterns', merged, vscode.ConfigurationTarget.Global); await ctx.globalState.update('disabledPatterns', dp); }
    }

    // Load project config
    loadProjectConfig();
    _dryRun = cfg('dryRun', false);

    wiki.init(ctx, () => learning.getData(), () => learning.getEpoch());
    learning.init(ctx, wiki);

    // Auto-purge bad learning entries on startup (numbers, flags, versions learned incorrectly)
    setTimeout(() => {
        const purged = learning.purgeBadEntries();
        if (purged > 0) console.log(`[Grav] Auto-purged ${purged} bad learning entries on startup`);
    }, 3000);
    roi.init(ctx);

    idle.init(ctx, { onIdleChange: (isIdle) => { console.log('[Grav] Idle:', isIdle); dashboard.postMessage({ command: 'idleChanged', idle: isIdle }); } });

    // CDP + Injection
    if (ensureCdpInArgv()) vscode.window.showInformationMessage('[Grav] CDP configured. Quit & restart Antigravity fully.', 'OK');
    if (cdp) {
        cdp.init({ onBlocked: (cmd, reason) => { console.log(`[Grav Safety] Blocked: ${reason}`); dashboard.postMessage({ command: 'commandBlocked', cmd: cmd.slice(0, 200), reason }); }, onClicked: (data) => { _sessionState.approveCount++; if (data.p) roi.recordClick(data.p); refreshBar(); dashboard.postMessage({ command: 'logUpdated', log: cdp.getClickLog() }); }, onChatEvent });
        const currentVer = ctx.extension?.packageJSON?.version || '0';
        const lastCdpVer = ctx.globalState.get('grav-cdp-version', '0');
        if (currentVer !== lastCdpVer) { ctx.globalState.update('grav-cdp-version', currentVer); setTimeout(() => { if (cdp.isConnected()) cdp.hotUpdate(); }, 3000); }
    }

    injection.hotUpdateRuntime(ctx);
    const ver = ctx.extension?.packageJSON?.version || '0';
    const lastVer = ctx.globalState.get('grav-version', '0');
    if (!injection.isInjected() || ver !== lastVer) {
        try { injection.inject(ctx); ctx.globalState.update('grav-version', ver); injection.clearCodeCache(); injection.patchChecksums(); if (!cdp || !cdp.isConnected()) setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 1000); } catch (e) { console.error('[Grav] inject:', e.message); }
    } else { injection.patchChecksums(); }

    // Bridge
    bridge.start(ctx, { learning, wiki, injection, getState, setState, getSessionSafe, onStatsUpdated, onClickLogged, onQuotaDetected, onChatEvent, onTerminalEvent, onPatternsDiscovered, onCommandBlocked: (cmd, reason) => { console.log(`[Grav Safety] Blocked: ${reason}`); dashboard.postMessage({ command: 'commandBlocked', cmd: cmd.slice(0, 200), reason }); } });

    // Start
    await discoverAcceptCommands();
    startAcceptLoop();
    injection.writeRuntimeConfig(ctx);
    terminal.setup(ctx, learning);

    // Status bar
    _sbMain = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    _sbMain.command = 'grav.statusMenu';
    _ctx.subscriptions.push(_sbMain);
    refreshBar();
    _sbMain.show();

    const cdpRefresh = setInterval(refreshBar, 5000);
    ctx.subscriptions.push({ dispose: () => clearInterval(cdpRefresh) });

    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('grav')) { _enabled = cfg('enabled', true); _scrollOn = cfg('autoScroll', true); _dryRun = cfg('dryRun', false); refreshBar(); if (cdp) cdp.hotUpdate(); }
    }));

    // Watch .vscode/grav.json for per-project pattern changes
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folders[0], PROJ_CONFIG_FILE)
        );
        watcher.onDidChange(onProjectConfigChange);
        watcher.onDidCreate(onProjectConfigChange);
        watcher.onDidDelete(() => { _projectPatterns = []; if (cdp) cdp.hotUpdate(); injection.writeRuntimeConfig(ctx); });
        ctx.subscriptions.push(watcher);
    }

    // Commands
    ctx.subscriptions.push(
        vscode.commands.registerCommand('grav.statusMenu', async () => {
            const cdpCount = cdp ? cdp.getSessionCount() : 0;
            const items = [
                { label: '$(dashboard) Open Dashboard', description: 'View metrics & logic', command: 'grav.dashboard' },
                { label: _scrollOn ? '$(fold-up) Disable Auto-Scroll' : '$(fold-down) Enable Auto-Scroll', command: 'grav.toggleScroll' },
                { label: `$(plug) CDP Sessions (${cdpCount}) - Force Reconnect`, command: 'grav.forceReconnect' },
                { label: _acceptPaused ? '$(play) Resume Auto-Accept' : '$(debug-pause) Pause Auto-Accept', command: _acceptPaused ? 'grav.resumeAccept' : 'grav.pauseAccept' },
            ];
            const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Grav Menu' });
            if (pick) vscode.commands.executeCommand(pick.command);
        }),
        vscode.commands.registerCommand('grav.dashboard', () => dashboard.toggle(ctx, { learning, wiki, injection, roi, idle, getState, setState, getSessionSafe, onSave, refreshBar })),
        vscode.commands.registerCommand('grav.diagnostics', async () => {
            const stats = learning.getStats();
            const lastTargets = cdp && cdp.getLastTargets ? cdp.getLastTargets() : [];
            const sessions = cdp && cdp.getSessionSummaries ? cdp.getSessionSummaries() : [];
            const debugLog = cdp && cdp.getDebugLog ? cdp.getDebugLog() : [];
            const webviewCount = lastTargets.filter(t => (t.url || '').includes('vscode-webview://')).length;

            // Conflict detection: commands in both SAFE_TERMINAL_CMDS and terminalBlacklist
            const { SAFE_TERMINAL_CMDS } = require('./constants');
            const userBlacklist = cfg('terminalBlacklist', []);
            const conflicts = SAFE_TERMINAL_CMDS.filter(c => userBlacklist.some(b => b === c || c.startsWith(b)));

            const lines = [
                `Grav v${ctx.extension?.packageJSON?.version || '3.4.2'}`,
                `Platform: ${process.platform}`,
                ``,
                `── CDP Engine ──`,
                `Connected: ${cdp ? cdp.isConnected() : 'N/A'}`,
                `Sessions: ${cdp ? cdp.getSessionCount() : 0}`,
                `WEBVIEW: ${webviewCount}`,
                `Clicks: ${cdp ? cdp.getTotalClicks() : 0}`,
                `Error: ${cdp && cdp.getLastError ? cdp.getLastError() : 'none'}`,
                ``,
                `── Active Sessions ──`,
                ...(sessions.length ? sessions.map(s => `  [${s.alive ? 'alive' : 'DEAD'}] ${s.url.slice(0, 90) || '(no url)'}  title=${s.title.slice(0, 40) || '(none)'}`) : ['  (none)']),
                ``,
                `── All Discovered Targets (${lastTargets.length}) ──`,
                ...lastTargets.slice(0, 30).map(t => `  [${t.type}] ${(t.url || '(blank)').slice(0, 90)}  title=${(t.title || '').slice(0, 40)}`),
                ``,
                `── Extension ──`,
                `Bridge: ${bridge.getPort() || 'not started'}`,
                `Enabled: ${_enabled}`,
                `Total clicks: ${_totalClicks}`,
                `Injected: ${injection.isInjected()}`,
                ``,
                `── Learning ──`,
                `Epoch: ${stats.epoch}`,
                `Tracking: ${stats.totalTracked}`,
                `Promoted: ${learning.getPromotedCommands().length}`,
                ``,
                `── ⚠️  Conflict Report ──`,
                conflicts.length > 0
                    ? `SAFE cmds blocked by terminalBlacklist: ${conflicts.join(', ')}`
                    : `No conflicts detected ✓`,
                ``,
                `── Observer Debug Log (last ${debugLog.length}) ──`,
                ...(debugLog.length ? debugLog.slice(0, 15).map(d => `  [${d.type}] ${JSON.stringify(d).slice(0, 120)}`) : ['  (no debug events yet — run Grav: Refresh Observer to trigger)']),
            ];
            const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('grav.manageTerminal', async () => {
            const actions = [{ label: '$(add) Add to Whitelist', action: 'addWhite' }, { label: '$(shield) Add to Blacklist', action: 'addBlack' }, { label: '$(search) Test Command', action: 'test' }, { label: '$(book) View Lists', action: 'viewAll' }];
            const pick = await vscode.window.showQuickPick(actions, { placeHolder: 'Manage Terminal Commands' });
            if (!pick) return;
            if (pick.action === 'addWhite') { const cmd = await vscode.window.showInputBox({ prompt: 'Enter safe command' }); if (cmd) { const wl = cfg('terminalWhitelist', []); wl.push(cmd); await vscode.workspace.getConfiguration('grav').update('terminalWhitelist', wl, vscode.ConfigurationTarget.Global); vscode.window.showInformationMessage(`[Grav] Added "${cmd}" to Whitelist.`); } }
            else if (pick.action === 'addBlack') { const cmd = await vscode.window.showInputBox({ prompt: 'Enter dangerous command' }); if (cmd) { const bl = cfg('terminalBlacklist', []); bl.push(cmd); await vscode.workspace.getConfiguration('grav').update('terminalBlacklist', bl, vscode.ConfigurationTarget.Global); vscode.window.showInformationMessage(`[Grav] Added "${cmd}" to Blacklist.`); } }
            else if (pick.action === 'test') { const cmd = await vscode.window.showInputBox({ prompt: 'Enter command to test' }); if (cmd) { const result = learning.evaluateCommand(cmd); const doc = await vscode.workspace.openTextDocument({ content: `${result.allowed ? 'ALLOWED' : 'BLOCKED'}\nReason: ${result.reason}\nCommands: ${result.commands.join(', ')}`, language: 'text' }); await vscode.window.showTextDocument(doc); } }
            else if (pick.action === 'viewAll') { const doc = await vscode.workspace.openTextDocument({ content: `── Whitelist ──\n${cfg('terminalWhitelist', []).join('\n')}\n\n── Blacklist ──\n${cfg('terminalBlacklist', []).join('\n')}`, language: 'text' }); await vscode.window.showTextDocument(doc); }
        }),
        vscode.commands.registerCommand('grav.learnStats', async () => {
            const stats = learning.getStats();
            if (stats.commands.length === 0) { vscode.window.showInformationMessage('[Grav] No learning data yet'); return; }
            const rows = stats.commands.map(s => `${s.cmd.padEnd(22)} conf:${String(s.conf).padEnd(7)} obs:${String(s.obs).padEnd(5)} ${s.status}`);
            const doc = await vscode.workspace.openTextDocument({ content: `Epoch: ${stats.epoch} | Tracking: ${stats.totalTracked}\n\n${rows.join('\n')}`, language: 'text' });
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('grav.refreshObserver', async () => { if (!cdp || !cdp.isConnected()) { vscode.window.showWarningMessage('[Grav] CDP not connected.'); return; } cdp.hotUpdate(); vscode.window.showInformationMessage('[Grav] Observer refreshed.'); }),
        vscode.commands.registerCommand('grav.forceReconnect', async () => {
            vscode.window.showInformationMessage('[Grav] Force reconnecting CDP...');
            if (cdp && cdp.forceReconnect) {
                const ok = await cdp.forceReconnect();
                if (ok) vscode.window.showInformationMessage('[Grav] CDP reconnected successfully.');
                else vscode.window.showWarningMessage('[Grav] CDP reconnect failed. Check Output panel.');
            }
        }),
        vscode.commands.registerCommand('grav.pauseAccept', () => { _acceptPaused = true; vscode.window.showInformationMessage('[Grav] Auto-accept paused.'); refreshBar(); }),
        vscode.commands.registerCommand('grav.resumeAccept', () => { _acceptPaused = false; vscode.window.showInformationMessage('[Grav] Auto-accept resumed.'); refreshBar(); }),
        vscode.commands.registerCommand('grav.purgeLearning', async () => {
            const count = learning.purgeBadEntries();
            const msg = count > 0
                ? `[Grav] Purged ${count} invalid entries (numbers, flags, versions, filenames) from learning data.`
                : '[Grav] No bad entries found — learning data is clean.';
            vscode.window.showInformationMessage(msg);
        }),
        vscode.commands.registerCommand('grav.toggleDryRun', async () => { _dryRun = !_dryRun; await vscode.workspace.getConfiguration('grav').update('dryRun', _dryRun, vscode.ConfigurationTarget.Global); refreshBar(); vscode.window.showInformationMessage(`[Grav] Dry Run ${_dryRun ? 'ON — scanning buttons without clicking' : 'OFF — normal mode'}`); }),
        vscode.commands.registerCommand('grav.initProjectConfig', async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders) { vscode.window.showWarningMessage('[Grav] No workspace folder open.'); return; }
            const cfgPath = path.join(folders[0].uri.fsPath, PROJ_CONFIG_FILE);
            if (fs.existsSync(cfgPath)) { const doc = await vscode.workspace.openTextDocument(cfgPath); await vscode.window.showTextDocument(doc); return; }
            const vscodePath = path.join(folders[0].uri.fsPath, '.vscode');
            if (!fs.existsSync(vscodePath)) fs.mkdirSync(vscodePath, { recursive: true });
            const template = JSON.stringify({ patterns: [], blacklist: [], dryRun: false }, null, 2);
            fs.writeFileSync(cfgPath, template, 'utf8');
            const doc = await vscode.workspace.openTextDocument(cfgPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage('[Grav] Created .vscode/grav.json — add custom patterns here.');
        }),
        vscode.commands.registerCommand('grav.toggleScroll', async () => { _scrollOn = !_scrollOn; await vscode.workspace.getConfiguration('grav').update('autoScroll', _scrollOn, vscode.ConfigurationTarget.Global); onSave(); refreshBar(); }),
        vscode.commands.registerCommand('grav.stopAllTerminals', () => { 
            let count = 0; 
            for (const term of vscode.window.terminals) { 
                const name = term.name.toLowerCase();
                // Protect common dev server names unless explicitly marked as agent
                const isAgent = name.includes('agent') || name.includes('task') || name.includes('cascade') || name.includes('windsurf') || name.includes('antigravity');
                const isDev = name.includes('dev') || name.includes('serve') || name.includes('watch') || name.includes('start') || name.includes('npm');
                const isSystem = name === 'extension' || name === 'output';
                
                if (isSystem || (isDev && !isAgent)) continue;

                try { term.sendText('\x03', false); count++; } catch (_) { } 
            } 
            if (count > 0) vscode.window.setStatusBarMessage(`[Grav] Auto-Killed ${count} terminal(s) to prevent deadlock`, 3000); 
        }),
        vscode.commands.registerCommand('grav.acceptAll', async () => { for (const cmd of _dynamicAcceptCmds) { try { await vscode.commands.executeCommand(cmd); } catch (_) { } } if (cdp && cdp.isConnected()) cdp.hotUpdate(); refreshBar(); }),
        vscode.commands.registerCommand('grav.resetLearningData', async () => {
            const confirm = await vscode.window.showWarningMessage('[Grav] Bạn có chắc chắn muốn xóa TOÀN BỘ dữ liệu học máy không?', 'Có, Xóa', 'Hủy');
            if (confirm === 'Có, Xóa') {
                await ctx.globalState.update('learnData', {});
                await ctx.globalState.update('learnEpoch', 0);
                if (learning) learning.init(ctx, wiki);
                vscode.window.showInformationMessage('[Grav] Đã reset toàn bộ dữ liệu học máy về 0.');
            }
        })
    );
}

function deactivate() {
    if (_sbMain) _sbMain.dispose();
    if (_acceptTimer) clearInterval(_acceptTimer);
    bridge.stop();

    idle.stop();
    if (cdp) try { cdp.disconnect(); } catch (_) { }
    learning.flush();
    wiki.flush();
    roi.flush();
    if (_ctx) { try { _ctx.globalState.update('stats', _stats); _ctx.globalState.update('totalClicks', _totalClicks); _ctx.globalState.update('clickLog', _log); } catch (_) { } }
}

module.exports = { activate, deactivate };