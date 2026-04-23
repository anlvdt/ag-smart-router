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
const quota = require('./quota');
const roi = require('./roi');
const idle = require('./idle');

let cdp = null;
try { cdp = require('./cdp'); } catch (_) {}

const CDP_PORT = 9333;
let _ctx, _enabled = true, _scrollOn = true, _stats = {}, _log = [], _totalClicks = 0;
let _acceptTimer, _lastQuotaMs = 0, _termLog = [], _acceptPaused = false, _dynamicAcceptCmds = [];
let _sessionState = { startMs: 0, msgCount: 0, toolCalls: [], responseTimes: [], lastActivityMs: 0, aiTyping: false, approveCount: 0, rejectCount: 0, toolBreakdown: {} };
let _sbMain, _sbScroll, _sbCdp, _isAntigravity = false;

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
const getState = () => ({ enabled: _enabled, scrollOn: _scrollOn, stats: _stats, log: _log, totalClicks: _totalClicks, session: _sessionState, termLog: _termLog, cdpConnected: cdp ? cdp.isConnected() : false, cdpSessions: cdp ? cdp.getSessionCount() : 0 });
const setState = (p) => { if (p.enabled !== undefined) _enabled = p.enabled; if (p.scrollOn !== undefined) _scrollOn = p.scrollOn; };
const getSessionSafe = () => {
    const now = Date.now();
    const sessionMs = _sessionState.startMs ? now - _sessionState.startMs : 0;
    const avgResponseMs = _sessionState.responseTimes.length > 0 ? Math.round(_sessionState.responseTimes.reduce((a, b) => a + b, 0) / _sessionState.responseTimes.length) : 0;
    return { sessionMs, msgCount: _sessionState.msgCount, approveCount: _sessionState.approveCount, aiTyping: _sessionState.aiTyping, avgResponseMs, toolBreakdown: _sessionState.toolBreakdown, recentTools: _sessionState.toolCalls.slice(-20), learningHealth: wiki.learningHealth(), cdpConnected: cdp ? cdp.isConnected() : false, cdpSessions: cdp ? cdp.getSessionCount() : 0, quota: quota.getSummary(), roi: roi.getSummary(), idle: idle.isIdle() };
};

const refreshBar = () => {
    if (!_sbMain) return;
    _sbMain.text = _enabled ? '$(rocket) Grav' : '$(circle-slash) Grav';
    _sbMain.color = _enabled ? '#94e2d5' : '#f38ba8';
    _sbMain.backgroundColor = _enabled ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
    if (_sbScroll) { _sbScroll.text = _scrollOn ? '$(fold-down) Scroll' : '$(circle-slash) Scroll'; _sbScroll.color = _scrollOn ? '#94e2d5' : '#f38ba8'; }
    if (_sbCdp) { const connected = cdp && cdp.isConnected(); _sbCdp.text = connected ? '$(plug) CDP:' + cdp.getSessionCount() : '$(debug-disconnect) CDP'; _sbCdp.color = connected ? '#94e2d5' : '#f38ba8'; }
};

const onStatsUpdated = () => { _totalClicks = Object.values(_stats).reduce((a, b) => a + b, 0); refreshBar(); if (_ctx) { _ctx.globalState.update('stats', _stats); _ctx.globalState.update('totalClicks', _totalClicks); }};
const onClickLogged = (d) => { if (_ctx) _ctx.globalState.update('clickLog', _log); dashboard.postMessage({ command: 'logUpdated', log: _log }); if (d.pattern) roi.recordClick(d.pattern); if (cfg('learnEnabled', true) && d.button) { const btn = d.button.trim(); const cmdMatch = btn.match(/[`']([^`']+)[`']/) || btn.match(/^(?:Run|Allow|Execute)\s+(.+)/i); if (cmdMatch) learning.recordAction(cmdMatch[1].trim(), 'approve', { project: vscode.workspace.workspaceFolders?.[0]?.name }); }};
const onQuotaDetected = () => { if (Date.now() - _lastQuotaMs > 60000) { _lastQuotaMs = Date.now(); console.log('[Grav] Quota'); dashboard.postMessage({ command: 'quotaDetected', ts: Date.now() }); }};
const onChatEvent = (d) => {
    const now = Date.now();
    _sessionState.lastActivityMs = now;
    if (d.type === 'message-start') _sessionState.aiTyping = true;
    else if (d.type === 'message-end') { _sessionState.aiTyping = false; _sessionState.msgCount++; if (d.responseMs > 0) { _sessionState.responseTimes.push(d.responseMs); if (_sessionState.responseTimes.length > 50) _sessionState.responseTimes.shift(); } }
    else if (d.type === 'tool-call') { const tool = d.tool || 'tool-call'; _sessionState.toolCalls.push({ tool, startMs: now, endMs: 0, durationMs: 0 }); if (_sessionState.toolCalls.length > 100) _sessionState.toolCalls.shift(); }
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

// ── Accept Loop ───────────────────────────────────────────────
const discoverAcceptCommands = async () => {
    try {
        const allCmds = await vscode.commands.getCommands(true);
        const SKIP = ['setting', 'config', 'preference', 'browser', 'permission', 'manage', 'open', 'show', 'toggle', 'enable', 'disable', 'edit', 'view', 'list', 'reset', 'clear'];
        _dynamicAcceptCmds = allCmds.filter(c => {
            const l = c.toLowerCase();
            const ns = l.includes('antigravity') || l.includes('windsurf') || l.includes('cascade') || l.includes('codeium') || l.includes('agent');
            const act = l.includes('accept') || l.includes('approve') || l.includes('allow') || l.includes('keep');
            if (cfg('skipTerminalAccept', true) && l.includes('terminal')) return false;
            return ns && act && !SKIP.some(s => l.includes(s));
        });
    } catch (_) {}
};

const startAcceptLoop = () => {
    if (_acceptTimer) clearInterval(_acceptTimer);
    // Minimum 3s interval to prevent "requires input" errors (was 2s default)
    const interval = Math.max(cfg('approveIntervalMs', 3000), 3000);
    _acceptTimer = setInterval(() => { if (!_enabled || _acceptPaused || !idle.isIdle()) return; for (const cmd of _dynamicAcceptCmds) vscode.commands.executeCommand(cmd).catch(() => {}); }, interval);
};

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
    } else if (Array.isArray(userPatterns)) {
        let merged = userPatterns.filter(p => VALID_PATTERNS.includes(p));
        let dp = ctx.globalState.get('disabledPatterns', []).filter(p => VALID_PATTERNS.includes(p));
        let changed = merged.length !== userPatterns.length || dp.length !== ctx.globalState.get('disabledPatterns', []).length;
        for (const p of DEFAULT_PATTERNS) { if (!merged.includes(p) && !dp.includes(p)) { RISKY_PATTERNS.includes(p) ? dp.push(p) : merged.push(p); changed = true; } }
        for (const p of RISKY_PATTERNS) { if (!merged.includes(p) && !dp.includes(p)) { dp.push(p); changed = true; } }
        if (changed) { await vscode.workspace.getConfiguration('grav').update('approvePatterns', merged, vscode.ConfigurationTarget.Global); await ctx.globalState.update('disabledPatterns', dp); }
    }

    wiki.init(ctx, () => learning.getData(), () => learning.getEpoch());
    learning.init(ctx, wiki);
    roi.init(ctx);
    quota.init({ onChange: (data) => dashboard.postMessage({ command: 'quotaUpdated', quota: quota.getSummary() }) });
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
    _sbScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10002);
    _sbCdp = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10003);
    _sbMain.command = _sbScroll.command = _sbCdp.command = 'grav.dashboard';
    _ctx.subscriptions.push(_sbMain, _sbScroll, _sbCdp);
    refreshBar();
    _sbMain.show(); _sbScroll.show(); _sbCdp.show();

    const cdpRefresh = setInterval(refreshBar, 5000);
    ctx.subscriptions.push({ dispose: () => clearInterval(cdpRefresh) });

    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('grav')) { _enabled = cfg('enabled', true); _scrollOn = cfg('autoScroll', true); refreshBar(); if (cdp) cdp.hotUpdate(); }
    }));

    // Commands
    ctx.subscriptions.push(
        vscode.commands.registerCommand('grav.dashboard', () => dashboard.toggle(ctx, { learning, wiki, injection, quota, roi, idle, getState, setState, getSessionSafe, onSave, refreshBar })),
        vscode.commands.registerCommand('grav.diagnostics', async () => {
            const stats = learning.getStats();
            const lastTargets = cdp && cdp.getLastTargets ? cdp.getLastTargets() : [];
            const webviewCount = lastTargets.filter(t => (t.url || '').includes('vscode-webview://')).length;
            const lines = [`Grav v3.4.1`, `Platform: ${process.platform}`, ``, `── CDP Engine ──`, `Connected: ${cdp ? cdp.isConnected() : 'N/A'}`, `Sessions: ${cdp ? cdp.getSessionCount() : 0}`, `WEBVIEW: ${webviewCount}`, `Clicks: ${cdp ? cdp.getTotalClicks() : 0}`, `Error: ${cdp && cdp.getLastError ? cdp.getLastError() : 'none'}`, ``, `── Extension ──`, `Bridge: ${bridge.getPort() || 'not started'}`, `Enabled: ${_enabled}`, `Total clicks: ${_totalClicks}`, `Injected: ${injection.isInjected()}`, ``, `── Learning ──`, `Epoch: ${stats.epoch}`, `Tracking: ${stats.totalTracked}`, `Promoted: ${learning.getPromotedCommands().length}`];
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
        vscode.commands.registerCommand('grav.stopAllTerminals', () => { let count = 0; for (const term of vscode.window.terminals) { try { term.sendText('\x03', false); count++; } catch (_) { } } vscode.window.showInformationMessage(`[Grav] Sent Ctrl+C to ${count} terminal(s).`); }),
        vscode.commands.registerCommand('grav.acceptAll', async () => { for (const cmd of _dynamicAcceptCmds) { try { await vscode.commands.executeCommand(cmd); } catch (_) { } } if (cdp && cdp.isConnected()) cdp.hotUpdate(); refreshBar(); }),
    );
}

function deactivate() {
    if (_sbMain) _sbMain.dispose();
    if (_sbScroll) _sbScroll.dispose();
    if (_sbCdp) _sbCdp.dispose();
    if (_acceptTimer) clearInterval(_acceptTimer);
    bridge.stop();
    quota.stop();
    idle.stop();
    if (cdp) try { cdp.disconnect(); } catch (_) { }
    learning.flush();
    wiki.flush();
    roi.flush();
    if (_ctx) { try { _ctx.globalState.update('stats', _stats); _ctx.globalState.update('totalClicks', _totalClicks); _ctx.globalState.update('clickLog', _log); } catch (_) { } }
}

module.exports = { activate, deactivate };