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
 * Check if a display pattern is enabled (any of its variants is in patterns list)
 */
function isPatternEnabled(displayName, patterns) {
    const variants = PATTERN_GROUPS[displayName] || [displayName];
    return variants.some(v => patterns.includes(v));
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
    const lang = 'en';
    function replaceTag(str, tag, val) {
        return str.replace(new RegExp('\\{\\{\\s*' + tag + '\\s*\\}\\}', 'g'), () => val);
    }
    h = replaceTag(h, 'NONCE', nonce);

    h = replaceTag(h, 'LANG', lang);
    h = replaceTag(h, 'VERSION', c.version || '0');
    h = replaceTag(h, 'TOTAL', String(c.totalClicks || 0));
    h = replaceTag(h, 'ENABLED_CHK', c.enabled ? 'checked' : '');
    h = replaceTag(h, 'SCROLL_CHK', c.scrollOn !== false ? 'checked' : '');
    h = replaceTag(h, 'SKIP_TERMINAL_CHK', c.skipTerminalAccept !== false ? 'checked' : '');
    h = replaceTag(h, 'APPROVE_MS', String(c.approveMs || 1000));
    h = replaceTag(h, 'SCROLL_MS', String(c.scrollMs || 500));
    h = replaceTag(h, 'PAUSE_MS', String(c.pauseMs || 7000));

    h = replaceTag(h, 'PATTERNS_JSON', JSON.stringify(c.patterns || []));
    h = replaceTag(h, 'DISABLED_JSON', JSON.stringify(c.disabledPatterns || []));
    h = replaceTag(h, 'PATTERN_GROUPS_JSON', JSON.stringify(c.patternGroups || {}));
    h = replaceTag(h, 'STATS_JSON', JSON.stringify(c.stats || {}));
    h = replaceTag(h, 'WHITE_COUNT', String(c.whiteCount || 0));
    h = replaceTag(h, 'BLACK_COUNT', String(c.blackCount || 0));
    h = replaceTag(h, 'TERMINAL_WHITELIST_JSON', JSON.stringify(c.terminalWhitelist || []));
    h = replaceTag(h, 'TERMINAL_BLACKLIST_JSON', JSON.stringify(c.terminalBlacklist || []));
    h = replaceTag(h, 'LEARN_COUNT', String(c.learnCount || 0));
    h = replaceTag(h, 'LEARN_EPOCH', String(c.learnEpoch || 0));
    h = replaceTag(h, 'LEARN_TRACKING', String(c.learnTracking || 0));
    h = replaceTag(h, 'LEARN_PATTERNS', String(c.learnPatterns || 0));
    h = replaceTag(h, 'WIKI_PAGES', String(c.wikiPages || 0));
    h = replaceTag(h, 'WIKI_CONCEPTS', String(c.wikiConcepts || 0));
    h = replaceTag(h, 'WIKI_CONTRADICTIONS', String(c.wikiContradictions || 0));
    h = replaceTag(h, 'CONCEPTS_JSON', JSON.stringify(c.concepts || {}));
    h = replaceTag(h, 'WIKI_LOG_JSON', JSON.stringify(c.wikiLog || []));
    h = replaceTag(h, 'ALL_PATTERNS_JSON', JSON.stringify(c.allPatterns || []));
    h = replaceTag(h, 'PROJECT_PATTERNS_JSON', JSON.stringify(c.projectPatterns || []));
    h = replaceTag(h, 'TRACE_JSON', JSON.stringify(c.trace || {}));
    h = replaceTag(h, 'OPERATION_PRESETS_JSON', JSON.stringify(c.operationPresets || []));
    h = replaceTag(h, 'OPERATION_PRESET_CONFIGS_JSON', JSON.stringify(c.operationPresetConfigs || []));
    h = replaceTag(h, 'OPERATION_MODE_JSON', JSON.stringify(c.operationMode || 'custom'));
    h = replaceTag(h, 'DRYRUN_CHK', c.dryRun ? 'checked' : '');
    h = replaceTag(h, 'DRYRUN_VAL', c.dryRun ? 'true' : 'false');
    h = replaceTag(h, 'SKIP_BROWSER_CHK', c.skipBrowser ? 'checked' : '');
    h = replaceTag(h, 'SKIP_BROWSER_VAL', c.skipBrowser ? 'true' : 'false');
    h = replaceTag(h, 'ROI_JSON', JSON.stringify(c.roi || {}));
    h = replaceTag(h, 'SESSION_JSON', JSON.stringify(c.session || {}));
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

    // Tier 1: Stats — 2.5s (reduced from 1s to avoid VSCode webview postMessage lag)
    _statsTicker = setInterval(() => {
        const statsStr = JSON.stringify({ stats: state.stats, totalClicks: state.totalClicks });
        if (statsStr !== _lastSentStatsState) {
            _lastSentStatsState = statsStr;
            postMessage({ command: 'statsUpdated', stats: state.stats, totalClicks: state.totalClicks });
        }
    }, 2500);

    // Tier 2: Brain/Wiki — 5s
    _brainTicker = setInterval(() => {
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
            const traceStr = _deps.getTraceSnapshot ? JSON.stringify(_deps.getTraceSnapshot()) : '';
            const logsStr = JSON.stringify({
                wikiLog: (w.log || []).slice(-30),
                termLog: (state.termLog || []).slice(0, 30)
            });

            const combinedState = brainStr + traceStr + logsStr;
            if (combinedState === _lastSentBrainState) {
                return; // Zero diff - skip postMessage!
            }
            _lastSentBrainState = combinedState;

            const msg = { command: 'brainUpdated' };
            msg.epoch = currentBrain.epoch;
            msg.tracking = currentBrain.tracking;
            msg.whiteCount = currentBrain.whiteCount;
            msg.blackCount = currentBrain.blackCount;
            msg.terminalWhitelist = [...SAFE_TERMINAL_CMDS, ...learning.getWhitelist()];
            msg.terminalBlacklist = [...DEFAULT_BLACKLIST, ...learning.getBlacklist()];
            msg.promoted = currentBrain.promoted;
            msg.patterns = currentBrain.patterns;
            msg.wikiPages = currentBrain.wikiPages;
            msg.wikiConcepts = currentBrain.wikiConcepts;
            msg.wikiContradictions = currentBrain.wikiContradictions;

            // Safe concept serialization
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
            msg.session = currentBrain.session;
            if (_deps.roi) msg.roi = currentBrain.roi;
            if (_deps.idle) msg.idle = currentBrain.idle;
            if (_deps.getTraceSnapshot) msg.trace = _deps.getTraceSnapshot();
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
