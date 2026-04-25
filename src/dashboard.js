// ═══════════════════════════════════════════════════════════════
//  Grav — Dashboard webview
// ═══════════════════════════════════════════════════════════════
const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const { state } = require('./state');
const { SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST, LEARN } = require('./constants');
const { cfg } = require('./utils');
const { getPromotedCommands, getLearnStats } = require('./learning');
const { writeRuntimeConfig } = require('./inject');

function refreshBar() {
    const { refreshBar: refresh } = require('./extension');
    refresh();
}

function fmtMs(v) { return v >= 1000 ? (v / 1000) + 's' : v + 'ms'; }

function getDashboardHtml(c) {
    let h = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.html'), 'utf8');
    const lang = c.language || 'vi';
    const approveMs = c.approveMs || 1000;
    const scrollMs = c.scrollMs || 500;
    const pauseMs = c.pauseMs || 7000;
    h = h.replace(/\{\{LANG\}\}/g, lang);
    h = h.replace('{{TOTAL}}', String(c.totalClicks || 0));
    h = h.replace('{{ENABLED_CHK}}', c.enabled ? 'checked' : '');
    h = h.replace('{{SCROLL_CHK}}', c.scrollOn !== false ? 'checked' : '');
    h = h.replace(/\{\{APPROVE_MS\}\}/g, String(approveMs));
    h = h.replace(/\{\{SCROLL_MS\}\}/g, String(scrollMs));
    h = h.replace(/\{\{PAUSE_MS\}\}/g, String(pauseMs));
    h = h.replace('{{APPROVE_LABEL}}', fmtMs(approveMs));
    h = h.replace('{{SCROLL_LABEL}}', fmtMs(scrollMs));
    h = h.replace('{{PAUSE_LABEL}}', fmtMs(pauseMs));
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

function openDashboard() {
    if (state.dashboard) { state.dashboard.dispose(); state.dashboard = null; return; }
    const panel = vscode.window.createWebviewPanel('gravDashboard', 'Grav \u2014 Dashboard', vscode.ViewColumn.One, { enableScripts: true });
    state.dashboard = panel;
    panel.onDidDispose(() => { state.dashboard = null; });

    const renderPanel = () => {
        const dp = state.ctx.globalState.get('disabledPatterns', []);
        const promoted = getPromotedCommands();
        panel.webview.html = getDashboardHtml({
            enabled: cfg('enabled', true),
            scrollOn: cfg('autoScroll', true),
            pauseMs: cfg('scrollPauseMs', 7000),
            scrollMs: cfg('scrollIntervalMs', 500),
            approveMs: cfg('approveIntervalMs', 1000),
            patterns: cfg('approvePatterns', ['Run','Allow','Always Allow','Keep Waiting','Continue','Retry']),
            disabledPatterns: dp,
            language: cfg('language', 'vi'),
            stats: state.stats,
            totalClicks: state.totalClicks,
            whiteCount: SAFE_TERMINAL_CMDS.length + state.userWhitelist.length,
            blackCount: DEFAULT_BLACKLIST.length + state.userBlacklist.length,
            learnCount: promoted.length,
            learnEpoch: state.learnEpoch,
            learnTracking: Object.keys(state.learnData).length,
            learnPatterns: state.patternCache.length,
            wikiPages: Object.keys(state.wiki.index).length,
            wikiConcepts: Object.keys(state.wiki.concepts).length,
            wikiContradictions: state.wiki.contradictions.filter(c => !c.resolved).length,
            concepts: state.wiki.concepts,
            wikiLog: (state.wiki.log || []).slice(-30),
        });
    };
    renderPanel();

    panel.webview.onDidReceiveMessage(async (msg) => {
        const c = vscode.workspace.getConfiguration('grav');
        switch (msg.command) {
            case 'toggle':
                state.enabled = msg.enabled;
                await c.update('enabled', msg.enabled, vscode.ConfigurationTarget.Global);
                writeRuntimeConfig(); refreshBar(); break;
            case 'scrollToggle':
                state.scrollOn = msg.enabled;
                await c.update('autoScroll', msg.enabled, vscode.ConfigurationTarget.Global);
                writeRuntimeConfig(); refreshBar(); break;
            case 'save': {
                const d = msg.data;
                await c.update('enabled', d.enabled, vscode.ConfigurationTarget.Global);
                await c.update('autoScroll', d.scrollOn, vscode.ConfigurationTarget.Global);
                await c.update('scrollPauseMs', d.pauseMs, vscode.ConfigurationTarget.Global);
                await c.update('scrollIntervalMs', d.scrollMs, vscode.ConfigurationTarget.Global);
                await c.update('approveIntervalMs', d.approveMs, vscode.ConfigurationTarget.Global);
                await c.update('approvePatterns', d.patterns, vscode.ConfigurationTarget.Global);
                await state.ctx.globalState.update('disabledPatterns', d.disabledPatterns);
                state.enabled = d.enabled; state.scrollOn = d.scrollOn !== false;
                state.patterns = d.patterns.filter(p => !d.disabledPatterns.includes(p));
                writeRuntimeConfig(); refreshBar(); break;
            }
            case 'changeLang':
                await c.update('language', msg.lang, vscode.ConfigurationTarget.Global);
                renderPanel(); break;
            case 'reload':
                vscode.commands.executeCommand('workbench.action.reloadWindow'); break;
            case 'resetStats':
                state.stats = {}; state.totalClicks = 0;
                state.ctx.globalState.update('stats', {}); state.ctx.globalState.update('totalClicks', 0);
                panel.webview.postMessage({ command: 'statsUpdated', stats: {}, totalClicks: 0 }); break;
            case 'clearLog':
                state.log = []; state.ctx.globalState.update('clickLog', []);
                panel.webview.postMessage({ command: 'logUpdated', log: [] }); break;
            case 'getLog':
                panel.webview.postMessage({ command: 'logUpdated', log: state.log }); break;
            case 'getStats':
                panel.webview.postMessage({ command: 'statsUpdated', stats: state.stats, totalClicks: state.totalClicks }); break;
            case 'manageTerminal':
                vscode.commands.executeCommand('grav.manageTerminal'); break;
            case 'viewWiki':
                vscode.commands.executeCommand('grav.viewWiki'); break;
            case 'lintWiki':
                vscode.commands.executeCommand('grav.lintWiki'); break;
        }
    }, undefined, state.ctx.subscriptions);

    const ticker = setInterval(() => {
        try { panel.webview.postMessage({ command: 'statsUpdated', stats: state.stats, totalClicks: state.totalClicks }); } catch (_) {}
        try {
            const msg = { command: 'brainUpdated' };
            msg.epoch = state.learnEpoch || 0;
            msg.tracking = Object.keys(state.learnData || {}).length;
            msg.whiteCount = SAFE_TERMINAL_CMDS.length + (state.userWhitelist || []).length;
            msg.blackCount = DEFAULT_BLACKLIST.length + (state.userBlacklist || []).length;
            msg.promoted = getPromotedCommands().length;
            msg.patterns = (state.patternCache || []).length;
            msg.wikiPages = Object.keys((state.wiki && state.wiki.index) || {}).length;
            msg.wikiConcepts = Object.keys((state.wiki && state.wiki.concepts) || {}).length;
            msg.wikiContradictions = ((state.wiki && state.wiki.contradictions) || []).filter(function(c) { return !c.resolved; }).length;

            var concepts = {};
            if (state.wiki && state.wiki.concepts) {
                for (var ck in state.wiki.concepts) {
                    var cv = state.wiki.concepts[ck];
                    concepts[ck] = { commands: (cv.commands || []).slice(0, 20), avgConfidence: cv.avgConfidence || 0, riskLevel: cv.riskLevel || 'unknown', description: cv.description || '' };
                }
            }
            msg.concepts = concepts;
            msg.wikiLog = ((state.wiki && state.wiki.log) || []).slice(-15).map(function(l) {
                return { time: l.time || '', op: l.op || '', cmd: l.cmd || '', action: l.action || '', conf: l.conf, detail: l.detail || '' };
            });
            panel.webview.postMessage(msg);
        } catch (e) {
            if (e.message && e.message.indexOf('disposed') >= 0) clearInterval(ticker);
        }
    }, 2500);
    panel.onDidDispose(function() { clearInterval(ticker); });
}

module.exports = { openDashboard, getDashboardHtml };
