'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { DEFAULT_PATTERNS, RISKY_PATTERNS, SAFE_TERMINAL_CMDS } = require('./constants');
const { deriveDynamicAcceptCommands, partitionAcceptCommands } = require('./accept-commands');
const { cfg } = require('./utils');
const injection = require('./injection');
const learning = require('./learning');
const wiki = require('./wiki');
const bridge = require('./bridge');
const terminal = require('./terminal');
const dashboard = require('./dashboard');
const { buildOperationPreset, getOperationPresets, normalizeOperationMode } = require('./operation-presets');
const { createObservabilityState } = require('./observability');

const roi = require('./roi');
const idle = require('./idle');

let cdp = null;
try { cdp = require('./cdp'); } catch (_) { /* optional CDP module */ }

const CDP_PORT = 9333;
let _ctx, _enabled = true, _scrollOn = true, _stats = {}, _log = [], _totalClicks = 0;
let _acceptTimer, _termLog = [], _acceptPaused = false, _dynamicAcceptCmds = [], _failedCmds = new Set();
let _dryRun = false;  // Dry run: scan buttons but don't click
let _skipBrowserAgent = false;  // Skip auto-click when browser agent is active
let _nextAcceptDue = 0;         // Timestamp for next slow-cycle accept tick
let _sessionState = { startMs: 0, msgCount: 0, toolCalls: [], responseTimes: [], lastActivityMs: 0, aiTyping: false, approveCount: 0, rejectCount: 0, toolBreakdown: {} };
let _sbMain, _sbCdp, _sbScroll, _sbSkip, _sbDry, _isAntigravity = false;
let _observability = createObservabilityState();
let _lastFilteredSignature = '';
const _nativeTraceCooldown = new Map();

// ── Detection & Config ───────────────────────────────────────
const isAntigravity = (() => {
    const checkPaths = ['.antigravity', '.antigravity-ide', '.windsurf'];
    return () => {
        const n = (vscode.env.appName || '') + ' ' + (vscode.env.appRoot || '');
        const l = n.toLowerCase();
        if (l.includes('antigravity') || l.includes('windsurf') || (l.includes('codeium') && !l.includes('codeium.codeium'))) return true;
        return checkPaths.some(p => fs.existsSync(path.join(os.homedir(), p, 'argv.json')));
    };
})();

const ensureCdpInArgv = (() => {
    const candidates = () => ['.antigravity-ide', '.antigravity', '.windsurf'].map(p => path.join(os.homedir(), p, 'argv.json')).filter(fs.existsSync);
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
const getState = () => ({
    enabled: _enabled,
    scrollOn: _scrollOn,
    stats: _stats,
    log: _log,
    totalClicks: _totalClicks,
    session: _sessionState,
    termLog: _termLog,
    cdpConnected: cdp ? cdp.isConnected() : false,
    cdpSessions: cdp ? cdp.getSessionCount() : 0,
    dryRun: _dryRun,
    projectPatterns: _projectPatterns,
    operationMode: normalizeOperationMode(cfg('operationMode', 'custom')),
});
const setState = (p) => { if (p.enabled !== undefined) _enabled = p.enabled; if (p.scrollOn !== undefined) _scrollOn = p.scrollOn; };
const getSessionSafe = () => {
    const now = Date.now();
    const sessionMs = _sessionState.startMs ? now - _sessionState.startMs : 0;
    const avgResponseMs = _sessionState.responseTimes.length > 0 ? Math.round(_sessionState.responseTimes.reduce((a, b) => a + b, 0) / _sessionState.responseTimes.length) : 0;
    return {
        sessionMs,
        msgCount: _sessionState.msgCount,
        approveCount: _sessionState.approveCount,
        aiTyping: _sessionState.aiTyping,
        avgResponseMs,
        toolBreakdown: _sessionState.toolBreakdown,
        recentTools: _sessionState.toolCalls.slice(-20),
        learningHealth: wiki.learningHealth(),
        cdpConnected: cdp ? cdp.isConnected() : false,
        cdpSessions: cdp ? cdp.getSessionCount() : 0,
        roi: roi.getSummary(),
        idle: idle.isIdle(),
        operationMode: normalizeOperationMode(cfg('operationMode', 'custom')),
    };
};

const refreshBar = () => {
    if (!_sbMain) return;

    // ── Main: Grav ON/OFF/Paused ──
    if (!_enabled) {
        _sbMain.text = `$(circle-slash) Grav`;
        _sbMain.color = '#f87171';
        _sbMain.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        _sbMain.tooltip = `Grav [Off] | ${_totalClicks} clicks — click to open menu`;
    } else if (_acceptPaused) {
        _sbMain.text = `$(debug-pause) Grav`;
        _sbMain.color = '#fbbf24';
        _sbMain.backgroundColor = undefined;
        _sbMain.tooltip = `Grav [Paused] | ${_totalClicks} clicks — click to open menu`;
    } else {
        _sbMain.text = `$(rocket) Grav`;
        _sbMain.color = '#6ee7b7';
        _sbMain.backgroundColor = undefined;
        _sbMain.tooltip = `Grav [Active] | ${_totalClicks} clicks — click to open menu`;
    }

    // ── CDP: connection + scroll ──
    if (_sbCdp) {
        const cdpConnected = cdp && cdp.isConnected();
        const cdpSessions = cdp ? cdp.getSessionCount() : 0;
        const cdpPhase = cdp ? (cdp.getPhase ? cdp.getPhase() : '') : '';
        const cdpReconnecting = !cdpConnected && (cdpPhase === 'reconnecting' || cdpPhase === 'connecting' || cdpPhase === 'discoverPort' || cdpPhase === 'fetchVersion');
        if (cdpConnected) {
            const scrollIcon = _scrollOn ? '$(fold-down)' : '$(fold-up)';
            _sbCdp.text = `$(plug) ${cdpSessions > 0 ? cdpSessions : ''} ${scrollIcon}`.trim();
            _sbCdp.color = '#6ee7b7';
            _sbCdp.tooltip = `CDP: ${cdpSessions} session(s) — Auto-Scroll: ${_scrollOn ? 'ON' : 'OFF'}\nClick to force reconnect`;
        } else if (cdpReconnecting) {
            const attempts = cdp.getReconnectAttempts ? cdp.getReconnectAttempts() : '';
            _sbCdp.text = `$(sync~spin)`;
            _sbCdp.color = '#fbbf24';
            _sbCdp.tooltip = `CDP: reconnecting${attempts ? ` (attempt ${attempts})` : ''}…\nClick to force reconnect`;
        } else {
            _sbCdp.text = `$(debug-disconnect)`;
            _sbCdp.color = '#f87171';
            _sbCdp.tooltip = `CDP: disconnected\nClick to reconnect`;
        }
        _sbCdp.show();
    }

    // ── Skip SubAgent ──
    if (_sbSkip) {
        if (_skipBrowserAgent) {
            _sbSkip.text = `$(debug-step-over) Browser Skip`;
            _sbSkip.color = '#94a3b8';
            _sbSkip.tooltip = `Browser SubAgent: auto-skip\nClick to disable`;
            _sbSkip.show();
        } else {
            _sbSkip.hide();
        }
    }

    // ── Dry Run ──
    if (_sbDry) {
        if (_dryRun) {
            _sbDry.text = `$(eye) DRY`;
            _sbDry.color = '#a78bfa';
            _sbDry.tooltip = `Dry Run: ON — scanning buttons without clicking\nClick to disable`;
            _sbDry.show();
        } else {
            _sbDry.hide();
        }
    }
};

const onStatsUpdated = () => { _totalClicks = Object.values(_stats).reduce((a, b) => a + b, 0); refreshBar(); if (_ctx) { _ctx.globalState.update('stats', _stats); _ctx.globalState.update('totalClicks', _totalClicks); } };
const onClickLogged = (d) => { if (_ctx) _ctx.globalState.update('clickLog', _log); dashboard.postMessage({ command: 'logUpdated', log: _log }); if (d.pattern) roi.recordClick(d.pattern); if (cfg('learnEnabled', true) && d.button) { const btn = d.button.trim(); const cmdMatch = btn.match(/[`']([^`']+)[`']/) || btn.match(/^(?:Run|Allow|Execute)\s+(.+)/i); if (cmdMatch) learning.recordAction(cmdMatch[1].trim(), 'approve', { project: vscode.workspace.workspaceFolders?.[0]?.name }); } };

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
        if (tool === 'run_command' || tool.includes('browser') || tool.includes('computer')) {
            recordTrace({ source: 'bridge', action: 'tool-call', label: tool, tool, reason: 'tool started' });
        }
    }
    else if (d.type === 'tool-result') {
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
        if (tool === 'run_command' || tool.includes('browser') || tool.includes('computer')) {
            recordTrace({
                source: 'bridge',
                action: 'tool-result',
                label: tool,
                tool,
                reason: `${d.durationMs || 0}ms`,
            });
        }
    }
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
    recordTrace({ source: 'terminal', action: 'approved-command', label: cmd, cmd, reason: d.source || 'ui' });
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
const onSave = () => { injection.writeRuntimeConfig(_ctx); if (cdp) cdp.hotUpdate(); refreshBar(); maybeTraceFilteredNative('save'); publishTrace(); };
const onProjectConfigChange = () => { loadProjectConfig(); if (cdp) cdp.hotUpdate(); injection.writeRuntimeConfig(_ctx); maybeTraceFilteredNative('project'); publishTrace(); };

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

const getDynamicAcceptPolicy = () => ({
    skipTerminalAccept: cfg('skipTerminalAccept', true),
    skipBrowserAgent: _skipBrowserAgent,
});

const getRunnableDynamicAcceptCmds = () => partitionAcceptCommands(_dynamicAcceptCmds, getDynamicAcceptPolicy());

const persistObservability = () => {
    if (_ctx) _ctx.globalState.update('observabilityState', _observability.exportState());
};

const getTraceSnapshot = () => {
    const dynamicAccept = getRunnableDynamicAcceptCmds();
    return _observability.snapshot({
        operationMode: normalizeOperationMode(cfg('operationMode', 'custom')),
        operationPresets: getOperationPresets(),
        filteredCommands: dynamicAccept.filtered,
        allowedNativeCount: dynamicAccept.allowed.length,
        totalNativeCount: _dynamicAcceptCmds.length,
        skipTerminalAccept: cfg('skipTerminalAccept', true),
        skipBrowserAgent: _skipBrowserAgent,
        cdpConnected: cdp ? cdp.isConnected() : false,
        cdpSessions: cdp ? cdp.getSessionCount() : 0,
    });
};

const publishTrace = () => {
    dashboard.postMessage({ command: 'traceUpdated', trace: getTraceSnapshot() });
};

const recordTrace = (event) => {
    _observability.push(event);
    persistObservability();
    publishTrace();
};

const recordFeedback = (kind, meta = {}) => {
    _observability.recordFeedback(kind, meta);
    persistObservability();
    publishTrace();
};

const maybeTraceFilteredNative = (source = 'config') => {
    const { filtered } = getRunnableDynamicAcceptCmds();
    const signature = filtered.join('|');
    if (!signature) {
        _lastFilteredSignature = '';
        return;
    }
    const scopedSignature = source + ':' + signature;
    if (scopedSignature === _lastFilteredSignature) return;
    _lastFilteredSignature = scopedSignature;
    recordTrace({
        source: 'native',
        action: 'filtered',
        label: `${filtered.length} native accept command(s) filtered`,
        cmd: filtered.join(', '),
        reason: `policy/${source}`,
    });
};

const traceNativeAccept = (cmd, reason) => {
    const key = `${reason}:${cmd}`;
    const now = Date.now();
    const lastTs = _nativeTraceCooldown.get(key) || 0;
    if (now - lastTs < 15000) return;
    _nativeTraceCooldown.set(key, now);
    recordTrace({
        source: 'native',
        action: 'native-accept',
        label: cmd,
        cmd,
        reason,
    });
};

const applyOperationPreset = async (mode, source = 'command') => {
    const preset = buildOperationPreset(mode);
    if (!preset) return false;
    const config = vscode.workspace.getConfiguration('grav');

    await config.update('enabled', preset.enabled, vscode.ConfigurationTarget.Global);
    await config.update('autoScroll', preset.autoScroll, vscode.ConfigurationTarget.Global);
    await config.update('skipBrowserAgent', preset.skipBrowserAgent, vscode.ConfigurationTarget.Global);
    await config.update('skipTerminalAccept', preset.skipTerminalAccept, vscode.ConfigurationTarget.Global);
    await config.update('approveIntervalMs', preset.approveIntervalMs, vscode.ConfigurationTarget.Global);
    await config.update('approvePatterns', preset.approvePatterns, vscode.ConfigurationTarget.Global);
    await config.update('presetMode', preset.presetMode, vscode.ConfigurationTarget.Global);
    await config.update('operationMode', preset.operationMode, vscode.ConfigurationTarget.Global);
    await _ctx.globalState.update('disabledPatterns', preset.disabledPatterns);

    _enabled = preset.enabled;
    _scrollOn = preset.autoScroll;
    _skipBrowserAgent = preset.skipBrowserAgent;
    _dryRun = preset.dryRun;

    onSave();
    maybeTraceFilteredNative(`preset:${mode}`);
    recordTrace({
        source: 'preset',
        action: 'preset-applied',
        label: preset.label,
        reason: `${preset.description} (${source})`,
        cmd: preset.approvePatterns.join(', '),
    });
    return true;
};

// ── Accept Loop ───────────────────────────────────────────────
const discoverAcceptCommands = async () => {
    try {
        const allCmds = await vscode.commands.getCommands(true);
        _dynamicAcceptCmds = deriveDynamicAcceptCommands(allCmds);
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
        const { allowed } = getRunnableDynamicAcceptCmds();
        for (const cmd of allowed) {
            if (_failedCmds.has(cmd)) continue;
            traceNativeAccept(cmd, 'accept-loop');
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
                    recordTrace({ source: 'native', action: 'needs-input', label: cmd, cmd, reason: 'command requires user input' });
                }
            });
        }
    }, FAST_INTERVAL);
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
    _observability = createObservabilityState(ctx.globalState.get('observabilityState', {}));
    _sessionState.startMs = Date.now();

    // Pattern migration
    const userPatterns = cfg('approvePatterns', null);
    const isFirstInstall = !userPatterns;
    const VALID_PATTERNS = [...DEFAULT_PATTERNS, ...RISKY_PATTERNS];

    if (isFirstInstall) {
        const safePatterns = DEFAULT_PATTERNS.filter(p => !RISKY_PATTERNS.includes(p));
        await vscode.workspace.getConfiguration('grav').update('approvePatterns', [...safePatterns], vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('grav').update('operationMode', 'custom', vscode.ConfigurationTarget.Global);
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
    _skipBrowserAgent = cfg('skipBrowserAgent', false);

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
        cdp.init({
            onBlocked: (cmd, reason) => {
                console.log(`[Grav Safety] Blocked: ${reason}`);
                recordTrace({ source: 'cdp', action: 'blocked', label: reason, cmd: cmd.slice(0, 200), reason });
                dashboard.postMessage({ command: 'commandBlocked', cmd: cmd.slice(0, 200), reason });
            },
            onClicked: (data) => {
                _sessionState.approveCount++;
                if (data.p) roi.recordClick(data.p);
                recordTrace({
                    source: 'cdp',
                    action: data.dryRun ? 'dry-run' : 'clicked',
                    pattern: data.p || '',
                    label: data.b || data.p || '',
                    cmd: data.cmd || '',
                    dryRun: !!data.dryRun,
                    reason: data.dryRun ? 'observer scan only' : 'observer click',
                });
                refreshBar();
                dashboard.postMessage({ command: 'logUpdated', log: cdp.getClickLog() });
            },
            onChatEvent,
        });
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
    bridge.start(ctx, {
        learning, wiki, injection, getState, setState, getSessionSafe,
        onStatsUpdated, onClickLogged, onChatEvent,
        onTerminalEvent, onPatternsDiscovered,
        onCommandBlocked: (cmd, reason) => {
            console.log(`[Grav Safety] Blocked: ${reason}`);
            recordTrace({ source: 'bridge', action: 'blocked', label: reason, cmd: cmd.slice(0, 200), reason });
            dashboard.postMessage({ command: 'commandBlocked', cmd: cmd.slice(0, 200), reason });
        },
    });

    // Start
    await discoverAcceptCommands();
    maybeTraceFilteredNative('activate');
    startAcceptLoop();
    injection.writeRuntimeConfig(ctx);
    try { terminal.setup(ctx, learning); } catch (e) { console.warn('[Grav] terminal.setup skipped:', e.message); }

    // Status bar — multiple items
    const SB_BASE = -10000;
    _sbMain = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_BASE);
    _sbMain.command = 'grav.statusMenu';
    _ctx.subscriptions.push(_sbMain);
    _sbMain.show();

    _sbCdp = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_BASE - 1);
    _sbCdp.command = 'grav.forceReconnect';
    _ctx.subscriptions.push(_sbCdp);

    _sbSkip = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_BASE - 2);
    _sbSkip.command = 'grav.toggleSkipBrowserAgent';
    _ctx.subscriptions.push(_sbSkip);

    _sbDry = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_BASE - 3);
    _sbDry.command = 'grav.toggleDryRun';
    _ctx.subscriptions.push(_sbDry);

    refreshBar();
    _sbMain.show();

    const cdpRefresh = setInterval(refreshBar, 5000);
    ctx.subscriptions.push({ dispose: () => clearInterval(cdpRefresh) });

    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('grav')) {
            _enabled = cfg('enabled', true);
            _scrollOn = cfg('autoScroll', true);
            _dryRun = cfg('dryRun', false);
            _skipBrowserAgent = cfg('skipBrowserAgent', false);
            refreshBar();
            if (cdp) cdp.hotUpdate();
            maybeTraceFilteredNative('config');
            publishTrace();
        }
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
            const operationMode = normalizeOperationMode(cfg('operationMode', 'custom'));
            const items = [
                { label: '$(dashboard) Open Dashboard', description: 'View metrics & logic', command: 'grav.dashboard' },
                { label: _scrollOn ? '$(fold-up) Disable Auto-Scroll' : '$(fold-down) Enable Auto-Scroll', command: 'grav.toggleScroll' },
                { label: `$(plug) CDP Sessions (${cdpCount}) - Force Reconnect`, command: 'grav.forceReconnect' },
                { label: _acceptPaused ? '$(play) Resume Auto-Accept' : '$(debug-pause) Pause Auto-Accept', command: _acceptPaused ? 'grav.resumeAccept' : 'grav.pauseAccept' },
                { label: _skipBrowserAgent ? '$(debug-step-over) Browser Skip: ON' : '$(debug-step-over) Browser Skip: OFF', description: 'Auto-skip browser subagent steps', command: 'grav.toggleSkipBrowserAgent' },
                { label: `$(settings-gear) Operation Mode: ${operationMode}`, description: 'Apply Safe / Balanced / Fast preset', command: 'grav.applyOperationPreset' },
            ];
            const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Grav Menu' });
            if (pick) vscode.commands.executeCommand(pick.command);
        }),
        vscode.commands.registerCommand('grav.dashboard', () => dashboard.toggle(ctx, {
            learning, wiki, injection, roi, idle, getState, setState, getSessionSafe,
            getTraceSnapshot, onSave, refreshBar, recordFeedback, getOperationPresets,
        })),
        vscode.commands.registerCommand('grav.diagnostics', async () => {
            const stats = learning.getStats();
            const lastTargets = cdp && cdp.getLastTargets ? cdp.getLastTargets() : [];
            const sessions = cdp && cdp.getSessionSummaries ? cdp.getSessionSummaries() : [];
            const debugLog = cdp && cdp.getDebugLog ? cdp.getDebugLog() : [];
            const webviewCount = lastTargets.filter(t => (t.url || '').includes('vscode-webview://')).length;

            // Conflict detection: commands in both SAFE_TERMINAL_CMDS and terminalBlacklist
            const userBlacklist = cfg('terminalBlacklist', []);
            const conflicts = SAFE_TERMINAL_CMDS.filter(c => userBlacklist.some(b => b === c || c.startsWith(b)));
            const dynamicAccept = getRunnableDynamicAcceptCmds();
            const trace = getTraceSnapshot();

            const lines = [
                `Grav v${ctx.extension?.packageJSON?.version || '0'}`,
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
                `Dynamic Accept: ${dynamicAccept.allowed.length}/${_dynamicAcceptCmds.length} active`,
                `skipTerminalAccept: ${cfg('skipTerminalAccept', true)}`,
                `skipBrowserAgent: ${_skipBrowserAgent}`,
                `operationMode: ${trace.operationMode}`,
                ...(dynamicAccept.filtered.length ? [`Filtered Accept Cmds: ${dynamicAccept.filtered.join(', ')}`] : []),
                ``,
                `── Learning ──`,
                `Epoch: ${stats.epoch}`,
                `Tracking: ${stats.totalTracked}`,
                `Promoted: ${learning.getPromotedCommands().length}`,
                ``,
                `── Local Telemetry ──`,
                `False positives: ${trace.feedback.falsePositive}`,
                `False negatives: ${trace.feedback.falseNegative}`,
                ...(trace.lastBlocked ? [`Last blocked: ${trace.lastBlocked.cmd || trace.lastBlocked.label} (${trace.lastBlocked.reason || 'blocked'})`] : ['Last blocked: none']),
                ``,
                `── ⚠️  Conflict Report ──`,
                conflicts.length > 0
                    ? `SAFE cmds blocked by terminalBlacklist: ${conflicts.join(', ')}`
                    : `No conflicts detected ✓`,
                ``,
                `── Observer Debug Log (last ${debugLog.length}) ──`,
                ...(debugLog.length ? debugLog.slice(0, 15).map(d => `  [${d.type}] ${JSON.stringify(d).slice(0, 120)}`) : ['  (no debug events yet — run Grav: Refresh Observer to trigger)']),
                ``,
                `── Decision Trace (last ${trace.trace.length}) ──`,
                ...(trace.trace.length ? trace.trace.slice(0, 12).map(t => `  [${t.time}] ${t.source}/${t.action} ${t.label || t.cmd || ''} ${t.reason ? `— ${t.reason}` : ''}`) : ['  (no trace events yet)']),
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
        vscode.commands.registerCommand('grav.applyOperationPreset', async () => {
            const items = getOperationPresets().map((preset) => ({
                label: preset.label,
                description: preset.description,
                mode: preset.id,
            }));
            const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select Grav operation mode' });
            if (!pick) return;
            const ok = await applyOperationPreset(pick.mode, 'command');
            if (ok) vscode.window.showInformationMessage(`[Grav] Applied ${pick.label} mode.`);
        }),
        vscode.commands.registerCommand('grav.recordFalsePositive', async () => {
            recordFeedback('falsePositive', { reason: 'manual feedback' });
            vscode.window.showInformationMessage('[Grav] Logged local feedback: false positive.');
        }),
        vscode.commands.registerCommand('grav.recordMissedAction', async () => {
            recordFeedback('falseNegative', { reason: 'manual feedback' });
            vscode.window.showInformationMessage('[Grav] Logged local feedback: missed click.');
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
        vscode.commands.registerCommand('grav.acceptAll', async () => {
            const { allowed } = getRunnableDynamicAcceptCmds();
            for (const cmd of allowed) {
                traceNativeAccept(cmd, 'manual-accept-all');
                try { await vscode.commands.executeCommand(cmd); } catch (_) { }
            }
            maybeTraceFilteredNative('manual-accept-all');
            if (cdp && cdp.isConnected()) cdp.hotUpdate();
            refreshBar();
        }),
        vscode.commands.registerCommand('grav.toggleSkipBrowserAgent', async () => {
            _skipBrowserAgent = !_skipBrowserAgent;
            await vscode.workspace.getConfiguration('grav').update('skipBrowserAgent', _skipBrowserAgent, vscode.ConfigurationTarget.Global);
            refreshBar();
            if (cdp) cdp.hotUpdate();
            vscode.window.showInformationMessage(`[Grav] Browser Skip ${_skipBrowserAgent ? 'ON' : 'OFF'}`);
        }),
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
    if (_sbCdp) _sbCdp.dispose();
    if (_sbSkip) _sbSkip.dispose();
    if (_sbDry) _sbDry.dispose();
    if (_acceptTimer) clearInterval(_acceptTimer);
    bridge.stop();

    idle.stop();
    if (cdp) try { cdp.disconnect(); } catch (_) { }
    learning.flush();
    wiki.flush();
    roi.flush();
    persistObservability();
    if (_ctx) { try { _ctx.globalState.update('stats', _stats); _ctx.globalState.update('totalClicks', _totalClicks); _ctx.globalState.update('clickLog', _log); } catch (_) { } }
}

module.exports = { activate, deactivate };
