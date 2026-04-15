// ═══════════════════════════════════════════════════════════════
//  Grav — Dashboard (webview panel management)
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

const { DEFAULT_PATTERNS, SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST } = require('./constants');
const { cfg } = require('./utils');

let _panel = null;
let _ctx   = null;
let _deps  = null;
let _statsTicker  = null;
let _brainTicker  = null;

/**
 * Open or close the dashboard panel.
 * @param {vscode.ExtensionContext} ctx
 * @param {object} deps - { learning, wiki, injection, getState, setState, onSave, refreshBar }
 */
function toggle(ctx, deps) {
    if (_panel) { _panel.dispose(); _panel = null; return; }
    _ctx  = ctx;
    _deps = deps;

    _panel = vscode.window.createWebviewPanel(
        'gravDashboard', 'Grav — Dashboard',
        vscode.ViewColumn.One, { enableScripts: true }
    );
    _panel.onDidDispose(() => {
        _panel = null;
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
    if (_panel) try { _panel.webview.postMessage(msg); } catch (_) {}
}

function render() {
    if (!_panel) return;
    const state = _deps.getState();
    const learning = _deps.learning;
    const wiki = _deps.wiki;
    const dp = _ctx.globalState.get('disabledPatterns', []);
    const w = wiki.getWiki();

    _panel.webview.html = buildHtml({
        enabled: cfg('enabled', true),
        scrollOn: cfg('autoScroll', true),
        pauseMs: cfg('scrollPauseMs', 7000),
        scrollMs: cfg('scrollIntervalMs', 500),
        approveMs: cfg('approveIntervalMs', 1000),
        patterns: cfg('approvePatterns', DEFAULT_PATTERNS),
        disabledPatterns: dp,
        language: cfg('language', 'vi'),
        stats: state.stats,
        totalClicks: state.totalClicks,
        whiteCount: SAFE_TERMINAL_CMDS.length + learning.getWhitelist().length,
        blackCount: DEFAULT_BLACKLIST.length + learning.getBlacklist().length,
        learnCount: learning.getPromotedCommands().length,
        learnEpoch: learning.getEpoch(),
        learnTracking: Object.keys(learning.getData()).length,
        learnPatterns: learning.getPatternCache().length,
        wikiPages: Object.keys(w.index).length,
        wikiConcepts: Object.keys(w.concepts).length,
        wikiContradictions: wiki.getContradictions().length,
        concepts: w.concepts,
        wikiLog: (w.log || []).slice(-30),
    });
}

function buildHtml(c) {
    let h = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.html'), 'utf8');
    const lang = c.language || 'vi';
    h = h.replace(/\{\{LANG\}\}/g, lang);
    h = h.replace('{{TOTAL}}', String(c.totalClicks || 0));
    h = h.replace('{{ENABLED_CHK}}', c.enabled ? 'checked' : '');
    h = h.replace('{{SCROLL_CHK}}', c.scrollOn !== false ? 'checked' : '');
    h = h.replace(/\{\{APPROVE_MS\}\}/g, String(c.approveMs || 1000));
    h = h.replace(/\{\{SCROLL_MS\}\}/g, String(c.scrollMs || 500));
    h = h.replace(/\{\{PAUSE_MS\}\}/g, String(c.pauseMs || 7000));
    h = h.replace('{{LANG_VI}}', lang === 'vi' ? 'selected' : '');
    h = h.replace('{{LANG_EN}}', lang === 'en' ? 'selected' : '');
    h = h.replace('{{LANG_ZH}}', lang === 'zh' ? 'selected' : '');
    h = h.replace('{{PATTERNS_JSON}}', JSON.stringify(c.patterns));
    h = h.replace('{{DISABLED_JSON}}', JSON.stringify(c.disabledPatterns));
    h = h.replace('{{STATS_JSON}}', JSON.stringify(c.stats || {}));
    h = h.replace('{{WHITE_COUNT}}', String(c.whiteCount || 0));
    h = h.replace('{{BLACK_COUNT}}', String(c.blackCount || 0));
    h = h.replace('{{LEARN_COUNT}}', String(c.learnCount || 0));
    h = h.replace('{{LEARN_EPOCH}}', String(c.learnEpoch || 0));
    h = h.replace('{{LEARN_TRACKING}}', String(c.learnTracking || 0));
    h = h.replace('{{LEARN_PATTERNS}}', String(c.learnPatterns || 0));
    h = h.replace('{{WIKI_PAGES}}', String(c.wikiPages || 0));
    h = h.replace('{{WIKI_CONCEPTS}}', String(c.wikiConcepts || 0));
    h = h.replace('{{WIKI_CONTRADICTIONS}}', String(c.wikiContradictions || 0));
    h = h.replace('{{CONCEPTS_JSON}}', JSON.stringify(c.concepts || {}));
    h = h.replace('{{WIKI_LOG_JSON}}', JSON.stringify(c.wikiLog || []));
    return h;
}

function setupMessageHandler() {
    if (!_panel) return;
    _panel.webview.onDidReceiveMessage(async (msg) => {
        const c = vscode.workspace.getConfiguration('grav');
        const state = _deps.getState();

        switch (msg.command) {
            case 'toggle':
                _deps.setState({ enabled: msg.enabled });
                await c.update('enabled', msg.enabled, vscode.ConfigurationTarget.Global);
                _deps.onSave(); break;
            case 'scrollToggle':
                _deps.setState({ scrollOn: msg.enabled });
                await c.update('autoScroll', msg.enabled, vscode.ConfigurationTarget.Global);
                _deps.onSave(); break;
            case 'save': {
                const d = msg.data;
                await c.update('enabled', d.enabled, vscode.ConfigurationTarget.Global);
                await c.update('autoScroll', d.scrollOn, vscode.ConfigurationTarget.Global);
                await c.update('scrollPauseMs', d.pauseMs, vscode.ConfigurationTarget.Global);
                await c.update('scrollIntervalMs', d.scrollMs, vscode.ConfigurationTarget.Global);
                await c.update('approveIntervalMs', d.approveMs, vscode.ConfigurationTarget.Global);
                await c.update('approvePatterns', d.patterns, vscode.ConfigurationTarget.Global);
                await _ctx.globalState.update('disabledPatterns', d.disabledPatterns);
                _deps.setState({ enabled: d.enabled, scrollOn: d.scrollOn !== false });
                _deps.onSave(); break;
            }
            case 'changeLang':
                await c.update('language', msg.lang, vscode.ConfigurationTarget.Global);
                render(); break;
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
        }
    }, undefined, _ctx.subscriptions);
}

function startTickers() {
    const state = _deps.getState();
    const learning = _deps.learning;
    const wiki = _deps.wiki;

    // Tier 1: Stats — 1s
    _statsTicker = setInterval(() => {
        postMessage({ command: 'statsUpdated', stats: state.stats, totalClicks: state.totalClicks });
    }, 1000);

    // Tier 2: Brain/Wiki — 5s
    _brainTicker = setInterval(() => {
        try {
            const w = wiki.getWiki();
            const msg = { command: 'brainUpdated' };
            msg.epoch = learning.getEpoch();
            msg.tracking = Object.keys(learning.getData()).length;
            msg.whiteCount = SAFE_TERMINAL_CMDS.length + learning.getWhitelist().length;
            msg.blackCount = DEFAULT_BLACKLIST.length + learning.getBlacklist().length;
            msg.promoted = learning.getPromotedCommands().length;
            msg.patterns = learning.getPatternCache().length;
            msg.wikiPages = Object.keys(w.index).length;
            msg.wikiConcepts = Object.keys(w.concepts).length;
            msg.wikiContradictions = wiki.getContradictions().length;

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
            msg.session = _deps.getSessionSafe();
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

module.exports = { toggle, getPanel, postMessage, render };
