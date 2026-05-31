// ═══════════════════════════════════════════════════════════════
//  Grav — Dashboard (webview panel management)
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DEFAULT_PATTERNS, SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST, PATTERN_GROUPS, PATTERN_DISPLAY, RISKY_PATTERNS } = require('./constants');
const { cfg } = require('./utils');
const { buildOperationPreset, getOperationPresets, normalizeOperationMode } = require('./operation-presets');

let _panel = null;
let _ctx = null;
let _deps = null;
let _statsTicker = null;
let _brainTicker = null;
let _lastSentStatsState = '';
let _lastSentBrainState = '';

/**
 * Get unique display patterns (hide variants, show only primary name)
 */
function getDisplayPatterns(allPatterns) {
    const seen = new Set();
    const result = [];
    for (const p of allPatterns) {
        const display = PATTERN_DISPLAY[p] || p;
        if (!seen.has(display)) {
            seen.add(display);
            result.push(display);
        }
    }
    return result;
}



/**
 * Open or close the dashboard panel.
 * @param {vscode.ExtensionContext} ctx
 * @param {object} deps - { learning, wiki, injection, getState, setState, onSave, refreshBar }
 */
function toggle(ctx, deps) {
    if (_panel) { _panel.dispose(); _panel = null; return; }
    _ctx = ctx;
    _deps = deps;

    const mediaPath = vscode.Uri.file(path.join(_ctx.extensionPath, 'media'));
    _panel = vscode.window.createWebviewPanel(
        'gravDashboard', 'Grav — Dashboard',
        vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [mediaPath],
        }
    );
    _panel.onDidDispose(() => {
        _panel = null;
        _lastSentStatsState = '';
        _lastSentBrainState = '';
        if (_statsTicker) clearInterval(_statsTicker);
        if (_brainTicker) clearInterval(_brainTicker);
    });

    render();
    setupMessageHandler();
    startTickers();
}

/** Get the panel reference (for external push messages). */
function getPanel() { return _panel; }

/** Push a message to the dashboard if open. */
function postMessage(msg) {
    if (_panel) try { _panel.webview.postMessage(msg); } catch (_) { }
}

function render() {
    if (!_panel) return;
    const state = _deps.getState();
    const learning = _deps.learning;
    const wiki = _deps.wiki;
    const dp = _ctx.globalState.get('disabledPatterns', []);
    const w = wiki.getWiki();

    _panel.webview.html = buildHtml({
        version: _ctx?.extension?.packageJSON?.version || '0',
        enabled: cfg('enabled', true),
        scrollOn: cfg('autoScroll', true),
        dryRun: cfg('dryRun', false),
        skipBrowser: cfg('skipBrowserAgent', false),
        skipTerminalAccept: cfg('skipTerminalAccept', true),
        pauseMs: cfg('scrollPauseMs', 7000),
        scrollMs: cfg('scrollIntervalMs', 500),
        patterns: cfg('approvePatterns', DEFAULT_PATTERNS),
        disabledPatterns: dp,
        projectPatterns: state.projectPatterns || [],
        language: 'en',
        stats: state.stats,
        totalClicks: state.totalClicks,
        whiteCount: SAFE_TERMINAL_CMDS.length + learning.getWhitelist().length,
        blackCount: DEFAULT_BLACKLIST.length + learning.getBlacklist().length,
        terminalWhitelist: [...SAFE_TERMINAL_CMDS, ...learning.getWhitelist()],
        terminalBlacklist: [...DEFAULT_BLACKLIST, ...learning.getBlacklist()],
        learnCount: learning.getPromotedCommands().length,
        learnEpoch: learning.getEpoch(),
        learnTracking: Object.keys(learning.getData()).length,
        learnPatterns: learning.getPatternCache().length,
        wikiPages: Object.keys(w.index).length,
        wikiConcepts: Object.keys(w.concepts).length,
        wikiContradictions: wiki.getContradictions().length,
        concepts: w.concepts,
        wikiLog: (w.log || []).slice(-30),
        allPatterns: getDisplayPatterns([...DEFAULT_PATTERNS, ...RISKY_PATTERNS]),
        patternGroups: PATTERN_GROUPS,
        operationMode: normalizeOperationMode(cfg('operationMode', 'custom')),
        operationPresets: getOperationPresets(),
        operationPresetConfigs: ['safe', 'balanced', 'fast'].map((mode) => buildOperationPreset(mode)).filter(Boolean),
        trace: _deps.getTraceSnapshot ? _deps.getTraceSnapshot() : {},
        roi: _deps.roi ? _deps.roi.getSummary() : {},
        session: _deps.getSessionSafe ? _deps.getSessionSafe() : {},
    });
}

function buildHtml(c) {
    let h;
    try {
        h = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard-v2.html'), 'utf8');
    } catch (e) {
        return `<html><body style="padding:40px;color:#ccc;font-family:sans-serif"><h2>Dashboard load failed</h2><p>${e.message}</p></body></html>`;
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    
    const replacements = {
        NONCE: nonce,
        LANG: 'en',
        VERSION: c.version || '0',
        TOTAL: String(c.totalClicks || 0),
        ENABLED_CHK: c.enabled ? 'checked' : '',
        SCROLL_CHK: c.scrollOn !== false ? 'checked' : '',
        SKIP_TERMINAL_CHK: c.skipTerminalAccept !== false ? 'checked' : '',
        APPROVE_MS: String(c.approveMs || 1000),
        SCROLL_MS: String(c.scrollMs || 500),
        PAUSE_MS: String(c.pauseMs || 7000),
        PATTERNS_JSON: JSON.stringify(c.patterns || []),
        DISABLED_JSON: JSON.stringify(c.disabledPatterns || []),
        PATTERN_GROUPS_JSON: JSON.stringify(c.patternGroups || {}),
        STATS_JSON: JSON.stringify(c.stats || {}),
        WHITE_COUNT: String(c.whiteCount || 0),
        BLACK_COUNT: String(c.blackCount || 0),
        TERMINAL_WHITELIST_JSON: JSON.stringify(c.terminalWhitelist || []),
        TERMINAL_BLACKLIST_JSON: JSON.stringify(c.terminalBlacklist || []),
        LEARN_COUNT: String(c.learnCount || 0),
        LEARN_EPOCH: String(c.learnEpoch || 0),
        LEARN_TRACKING: String(c.learnTracking || 0),
        LEARN_PATTERNS: String(c.learnPatterns || 0),
        WIKI_PAGES: String(c.wikiPages || 0),
        WIKI_CONCEPTS: String(c.wikiConcepts || 0),
        WIKI_CONTRADICTIONS: String(c.wikiContradictions || 0),
        CONCEPTS_JSON: JSON.stringify(c.concepts || {}),
        WIKI_LOG_JSON: JSON.stringify(c.wikiLog || []),
        ALL_PATTERNS_JSON: JSON.stringify(c.allPatterns || []),
        PROJECT_PATTERNS_JSON: JSON.stringify(c.projectPatterns || []),
        TRACE_JSON: JSON.stringify(c.trace || {}),
        OPERATION_PRESETS_JSON: JSON.stringify(c.operationPresets || []),
        OPERATION_PRESET_CONFIGS_JSON: JSON.stringify(c.operationPresetConfigs || []),
        OPERATION_MODE_JSON: JSON.stringify(c.operationMode || 'custom'),
        DRYRUN_CHK: c.dryRun ? 'checked' : '',
        DRYRUN_VAL: c.dryRun ? 'true' : 'false',
        SKIP_BROWSER_CHK: c.skipBrowser ? 'checked' : '',
        SKIP_BROWSER_VAL: c.skipBrowser ? 'true' : 'false',
        ROI_JSON: JSON.stringify(c.roi || {}),
        SESSION_JSON: JSON.stringify(c.session || {}),
    };

    const pattern = new RegExp('\\{\\{\\s*(' + Object.keys(replacements).join('|') + ')\\s*\\}\\}', 'g');
    h = h.replace(pattern, (_, key) => replacements[key] || '');
    return h;
}

function setupMessageHandler() {
    if (!_panel) return;
    _panel.webview.onDidReceiveMessage(async (msg) => {
        const c = vscode.workspace.getConfiguration('grav');
        const state = _deps.getState();

        switch (msg.command) {
            case 'save': {
                const d = msg.data;
                try {
                    await c.update('enabled', d.enabled, vscode.ConfigurationTarget.Global);
                    await c.update('autoScroll', d.scrollOn, vscode.ConfigurationTarget.Global);
                    await c.update('skipBrowserAgent', d.skipBrowser, vscode.ConfigurationTarget.Global);
                    await c.update('skipTerminalAccept', d.skipTerminalAccept !== false, vscode.ConfigurationTarget.Global);
                    await c.update('scrollPauseMs', d.pauseMs, vscode.ConfigurationTarget.Global);
                    await c.update('scrollIntervalMs', d.scrollMs, vscode.ConfigurationTarget.Global);
                    await c.update('approveIntervalMs', d.approveMs, vscode.ConfigurationTarget.Global);
                    await c.update('approvePatterns', d.patterns, vscode.ConfigurationTarget.Global);
                    await c.update('operationMode', d.operationMode || 'custom', vscode.ConfigurationTarget.Global);
                    await _ctx.globalState.update('disabledPatterns', d.disabledPatterns);
                    _deps.setState({ enabled: d.enabled, scrollOn: d.scrollOn !== false });
                    _deps.onSave();
                    postMessage({ command: 'saveResult', success: true });
                } catch (e) {
                    postMessage({ command: 'saveResult', success: false, error: e.message || 'Save failed' });
                }
                break;
            }
            case 'reload':
                vscode.commands.executeCommand('workbench.action.reloadWindow'); break;
            case 'resetStats':
                state.stats = {}; state.totalClicks = 0;
                _ctx.globalState.update('stats', {});
                _ctx.globalState.update('totalClicks', 0);
                postMessage({ command: 'statsUpdated', stats: {}, totalClicks: 0 }); break;
            case 'clearLog':
                state.log = [];
                _ctx.globalState.update('clickLog', []);
                postMessage({ command: 'logUpdated', log: [] }); break;
            case 'getLog':
                postMessage({ command: 'logUpdated', log: state.log }); break;
            case 'getStats':
                postMessage({ command: 'statsUpdated', stats: state.stats, totalClicks: state.totalClicks }); break;
            case 'manageTerminal':
                vscode.commands.executeCommand('grav.manageTerminal'); break;
            case 'feedback':
                if (_deps.recordFeedback) _deps.recordFeedback(msg.kind, { reason: msg.reason || 'dashboard' });
                if (_deps.getTraceSnapshot) postMessage({ command: 'traceUpdated', trace: _deps.getTraceSnapshot() });
                break;
            case 'getTrace':
                if (_deps.getTraceSnapshot) postMessage({ command: 'traceUpdated', trace: _deps.getTraceSnapshot() });
                break;
            case 'refreshObserver':
                vscode.commands.executeCommand('grav.refreshObserver'); break;
            case 'openDiagnostics':
                vscode.commands.executeCommand('grav.diagnostics'); break;
        }
    }, undefined, _ctx.subscriptions);
}

function startTickers() {
    const state = _deps.getState();
    const learning = _deps.learning;
    const wiki = _deps.wiki;

    // Tier 1: Stats — 2.5s
    _statsTicker = setInterval(() => {
        if (!_panel || !_panel.visible) return; // Skip updates if tab is hidden to save CPU/IPC overhead
        const statsStr = JSON.stringify({ stats: state.stats, totalClicks: state.totalClicks });
        if (statsStr !== _lastSentStatsState) {
            _lastSentStatsState = statsStr;
            postMessage({ command: 'statsUpdated', stats: state.stats, totalClicks: state.totalClicks });
        }
    }, 2500);

    // Tier 2: Brain/Wiki — 5s
    _brainTicker = setInterval(() => {
        if (!_panel || !_panel.visible) return; // Skip updates if tab is hidden to save CPU/IPC overhead
        try {
            const w = wiki.getWiki();

            // Build current brain stats first to check if anything changed
            const currentBrain = {
                epoch: learning.getEpoch(),
                tracking: Object.keys(learning.getData()).length,
                whiteCount: SAFE_TERMINAL_CMDS.length + learning.getWhitelist().length,
                blackCount: DEFAULT_BLACKLIST.length + learning.getBlacklist().length,
                promoted: learning.getPromotedCommands().length,
                patterns: learning.getPatternCache().length,
                wikiPages: Object.keys(w.index).length,
                wikiConcepts: Object.keys(w.concepts).length,
                wikiContradictions: wiki.getContradictions().length,
                roi: _deps.roi ? _deps.roi.getSummary() : null,
                idle: _deps.idle ? _deps.idle.isIdle() : null,
                session: _deps.getSessionSafe ? _deps.getSessionSafe() : null,
            };

            // Compare with last sent brain stats + trace + logs
            const brainStr = JSON.stringify(currentBrain);
            const traceSnapshot = _deps.getTraceSnapshot ? _deps.getTraceSnapshot() : null;
            const traceStr = traceSnapshot ? JSON.stringify(traceSnapshot) : '';
            const logsStr = JSON.stringify({
                wikiLog: (w.log || []).slice(-30),
                termLog: (state.termLog || []).slice(0, 30)
            });

            const combinedState = brainStr + traceStr + logsStr;
            if (combinedState === _lastSentBrainState) {
                return; // Zero diff — skip postMessage
            }
            _lastSentBrainState = combinedState;

            // ── Build message only after diff gate ──
            const msg = {
                command: 'brainUpdated',
                epoch: currentBrain.epoch,
                tracking: currentBrain.tracking,
                whiteCount: currentBrain.whiteCount,
                blackCount: currentBrain.blackCount,
                promoted: currentBrain.promoted,
                patterns: currentBrain.patterns,
                wikiPages: currentBrain.wikiPages,
                wikiConcepts: currentBrain.wikiConcepts,
                wikiContradictions: currentBrain.wikiContradictions,
                terminalWhitelist: [...SAFE_TERMINAL_CMDS, ...learning.getWhitelist()],
                terminalBlacklist: [...DEFAULT_BLACKLIST, ...learning.getBlacklist()],
                session: currentBrain.session,
            };

            // Concept serialization (only on diff)
            const concepts = {};
            for (const ck in w.concepts) {
                const cv = w.concepts[ck];
                concepts[ck] = {
                    commands: (cv.commands || []).slice(0, 20),
                    avgConfidence: cv.avgConfidence || 0,
                    riskLevel: cv.riskLevel || 'unknown',
                    description: cv.description || '',
                };
            }
            msg.concepts = concepts;
            msg.wikiLog = (w.log || []).slice(-30).map(l => ({
                time: l.time || '', op: l.op || '', cmd: l.cmd || '',
                action: l.action || '', conf: l.conf, detail: l.detail || '',
            }));
            if (_deps.roi) msg.roi = currentBrain.roi;
            if (_deps.idle) msg.idle = currentBrain.idle;
            if (traceSnapshot) msg.trace = traceSnapshot;
            msg.termLog = (state.termLog || []).slice(0, 30).map(t => ({
                time: t.time || '', cmd: t.cmd || '', source: t.source || 'ui',
            }));

            postMessage(msg);
        } catch (e) {
            if (e.message && e.message.indexOf('disposed') >= 0) {
                clearInterval(_brainTicker);
            }
        }
    }, 5000);
}

module.exports = { toggle, getPanel, postMessage, render, buildHtml };
