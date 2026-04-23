'use strict';

const vscode = require('vscode');
const { LEARN, SAFE_TERMINAL_CMDS, DEFAULT_BLACKLIST, COMMAND_CATEGORIES } = require('./constants');
const { cfg, extractCommands, matchesBlacklist } = require('./utils');

let _learnData = {}, _learnEpoch = 0, _userWhitelist = [], _userBlacklist = [], _patternCache = [], _ctx = null, _wiki = null, _saveTimer = null;

const init = (ctx, wikiRef) => { _ctx = ctx; _wiki = wikiRef; _userWhitelist = cfg('terminalWhitelist', []); _userBlacklist = cfg('terminalBlacklist', []); load(); };

const load = () => {
    if (!_ctx) return;
    const raw = _ctx.globalState.get('learnData', {});
    _learnEpoch = _ctx.globalState.get('learnEpoch', 0);
    _learnData = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v.conf === 'number') { _learnData[k] = v; }
        else if (typeof v.approves === 'number') {
            const total = (v.approves || 0) + (v.rejects || 0);
            const ratio = total > 0 ? (v.approves || 0) / total : 0.5;
            _learnData[k] = { conf: (ratio - 0.5) * 2, velocity: 0, obs: total, rewards: [], history: [], contexts: {}, lastSeen: v.lastSeen || Date.now(), promoted: false, demoted: false };
        }
    }
    applyDecay();
    generalizePatterns();
    pruneEntries();
    save();
};

const save = () => {
    if (!_ctx || _saveTimer) return;
    _saveTimer = setTimeout(() => { _saveTimer = null; try { _ctx.globalState.update('learnData', _learnData); _ctx.globalState.update('learnEpoch', _learnEpoch); } catch (_) { } }, 2000);
};

const flush = () => { if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; } if (!_ctx) return; try { _ctx.globalState.update('learnData', _learnData); _ctx.globalState.update('learnEpoch', _learnEpoch); } catch (_) { } };

const recordAction = (cmdLine, action, context = {}) => {
    if (!cfg('learnEnabled', true)) return;
    const cmds = extractCommands(cmdLine);
    const now = Date.now();
    _learnEpoch++;

    for (const cmd of cmds) {
        if (!_learnData[cmd]) { _learnData[cmd] = { conf: 0, velocity: 0, obs: 0, rewards: [], history: [], contexts: {}, lastSeen: now, promoted: false, demoted: false }; }
        const d = _learnData[cmd];
        d.obs++;
        d.lastSeen = now;

        let reward = action === 'approve' ? 1.0 : -1.0;
        if (context.exitCode !== undefined) { if (context.exitCode === 0 && action === 'approve') reward += LEARN.CONTEXT_WEIGHT; else if (context.exitCode !== 0 && action === 'approve') reward -= LEARN.CONTEXT_WEIGHT; }
        if (action === 'reject') { if (!d.rejectTimes) d.rejectTimes = []; d.rejectTimes.push(now); d.rejectTimes = d.rejectTimes.filter(t => now - t < 600000); if (d.rejectTimes.length >= 2) reward *= 3.0; }
        if (action === 'approve' && context.project) { const sessionKey = 'sess:' + context.project; d.contexts[sessionKey] = (d.contexts[sessionKey] || 0) + 1; if (d.contexts[sessionKey] >= 3) reward += LEARN.CONTEXT_WEIGHT * 0.5; }

        const hour = new Date().getHours();
        const timeSlot = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
        d.contexts[timeSlot] = (d.contexts[timeSlot] || 0) + 1;
        if (context.project) { const projKey = 'proj:' + context.project; d.contexts[projKey] = (d.contexts[projKey] || 0) + 1; }

        // Mini-batch SGD with momentum - bounded arrays to prevent memory leak
        d.rewards.push(reward);
        if (d.rewards.length > LEARN.BATCH_SIZE) d.rewards = d.rewards.slice(-LEARN.BATCH_SIZE); // FIX: bounded array

        const batchReward = d.rewards.reduce((a, b) => a + b, 0) / d.rewards.length;
        const gradient = LEARN.ALPHA * batchReward;
        d.velocity = LEARN.MOMENTUM * d.velocity + gradient;
        d.conf = Math.max(-1, Math.min(1, d.conf + d.velocity * (1 - LEARN.MOMENTUM)));

        // History bounded
        d.history.push({ t: now, c: d.conf, r: reward, e: _learnEpoch });
        if (d.history.length > LEARN.MAX_HISTORY) d.history = d.history.slice(-LEARN.MAX_HISTORY); // FIX: bounded

        if (d.obs >= LEARN.OBSERVE_MIN) {
            if (d.conf >= LEARN.PROMOTE_THRESH && !d.promoted && !SAFE_TERMINAL_CMDS.includes(cmd) && !_userWhitelist.includes(cmd)) { d.promoted = true; suggestPromotion(cmd, d); }
            if (d.conf <= LEARN.DEMOTE_THRESH && !d.demoted && !_userBlacklist.includes(cmd)) { d.demoted = true; suggestDemotion(cmd, d); }
        }
    }

    if (_learnEpoch % 20 === 0) generalizePatterns();
    if (_wiki) { for (const cmd of cmds) { _wiki.ingest(cmd, action, _learnData[cmd], context); } }
    save();
};

const applyDecay = () => {
    const now = Date.now();
    for (const [k, d] of Object.entries(_learnData)) {
        const daysSince = (now - d.lastSeen) / 86400000;
        if (daysSince > 1) {
            const decayFactor = Math.pow(LEARN.GAMMA, daysSince);
            d.conf *= decayFactor;
            d.velocity *= decayFactor;
            if (Math.abs(d.conf) < 0.01 && d.obs < LEARN.OBSERVE_MIN && daysSince > 60) { delete _learnData[k]; }
        }
    }
};

const pruneEntries = () => {
    const keys = Object.keys(_learnData);
    if (keys.length <= LEARN.MAX_ENTRIES) return;
    const scored = keys.map(k => ({ key: k, score: Math.abs(_learnData[k].conf) * Math.log(_learnData[k].obs + 1) }));
    scored.sort((a, b) => b.score - a.score);
    for (let i = LEARN.MAX_ENTRIES; i < scored.length; i++) { delete _learnData[scored[i].key]; }
};

const generalizePatterns = () => {
    _patternCache = [];
    const groups = {};
    for (const [cmd, d] of Object.entries(_learnData)) {
        if (d.conf < 0.2 || d.obs < 2) continue;
        const prefix = cmd.replace(/[-_].*$/, '').replace(/\d+$/, '');
        if (prefix && prefix.length >= 2) { if (!groups[prefix]) groups[prefix] = []; groups[prefix].push(cmd); }
    }
    for (const [prefix, members] of Object.entries(groups)) {
        if (members.length >= LEARN.GENERALIZE_MIN && !SAFE_TERMINAL_CMDS.includes(prefix)) { _patternCache.push(prefix); }
    }
    if (_wiki) {
        const sequences = _wiki.getSequences();
        if (sequences) {
            const coOccur = {};
            for (const [seq, count] of Object.entries(sequences)) {
                if (count < 2) continue;
                const [a, b] = seq.split(' → ');
                if (a && b) { if (!coOccur[a]) coOccur[a] = new Set(); if (!coOccur[b]) coOccur[b] = new Set(); coOccur[a].add(b); coOccur[b].add(a); }
            }
            for (const [cmd, peers] of Object.entries(coOccur)) {
                if (_learnData[cmd] && _learnData[cmd].conf < 0.3) {
                    const trustedPeers = [...peers].filter(p => _learnData[p]?.conf > 0.5);
                    if (trustedPeers.length >= 2) { _learnData[cmd].conf = Math.min(1, _learnData[cmd].conf + 0.05); }
                }
            }
        }
    }
};

const getPromotedCommands = () => Object.entries(_learnData).filter(([, d]) => d.conf >= LEARN.PROMOTE_THRESH && d.obs >= LEARN.OBSERVE_MIN).map(([k]) => k);

const evaluateCommand = (cmdLine) => {
    const blacklist = [...DEFAULT_BLACKLIST, ..._userBlacklist];
    const whitelist = [...SAFE_TERMINAL_CMDS, ..._userWhitelist];
    const blocked = matchesBlacklist(cmdLine, blacklist);
    if (blocked) return { allowed: false, reason: `Blocked: "${blocked}"`, commands: [], confidence: -1 };
    const cmds = extractCommands(cmdLine);
    if (cmds.length === 0) return { allowed: false, reason: 'Could not parse command', commands: [], confidence: 0 };
    const promoted = getPromotedCommands();
    const fullWhitelist = [...whitelist, ...promoted, ..._patternCache];
    const unknown = [];
    let minConf = 1.0;
    for (const cmd of cmds) {
        if (fullWhitelist.includes(cmd)) continue;
        if (_wiki) { const page = _wiki.query(cmd); if (page) { if (page.riskLevel === 'safe' && page.totalEvents >= LEARN.OBSERVE_MIN) { minConf = Math.min(minConf, page.confidence); continue; } if (page.riskLevel === 'caution' && page.confidence > 0) { minConf = Math.min(minConf, page.confidence * 0.5); continue; } } }
        const entry = _learnData[cmd];
        if (entry && entry.conf > 0) { minConf = Math.min(minConf, entry.conf); continue; }
        unknown.push(cmd);
    }
    if (unknown.length > 0) return { allowed: false, reason: `Unknown: ${unknown.join(', ')}`, commands: cmds, confidence: 0 };
    return { allowed: true, reason: 'All whitelisted', commands: cmds, confidence: minConf };
};

const suggestPromotion = async (cmd, data) => {
    const confPct = Math.round(data.conf * 100);
    const pick = await vscode.window.showInformationMessage(`[Grav] "${cmd}" confidence ${confPct}% after ${data.obs} observations. Add to whitelist?`, 'Add', 'Ignore', 'Blacklist');
    if (pick === 'Add') { _userWhitelist.push(cmd); await vscode.workspace.getConfiguration('grav').update('terminalWhitelist', _userWhitelist, vscode.ConfigurationTarget.Global); }
    else if (pick === 'Blacklist') { _userBlacklist.push(cmd); await vscode.workspace.getConfiguration('grav').update('terminalBlacklist', _userBlacklist, vscode.ConfigurationTarget.Global); }
    else { data.promoted = false; }
};

const suggestDemotion = async (cmd, data) => {
    const confPct = Math.round(data.conf * 100);
    const pick = await vscode.window.showWarningMessage(`[Grav] "${cmd}" confidence ${confPct}% — frequently rejected. Add to blacklist?`, 'Blacklist', 'Ignore');
    if (pick === 'Blacklist') { _userBlacklist.push(cmd); await vscode.workspace.getConfiguration('grav').update('terminalBlacklist', _userBlacklist, vscode.ConfigurationTarget.Global); }
    else { data.demoted = false; }
};

const getStats = () => {
    const entries = Object.entries(_learnData).sort((a, b) => b[1].obs - a[1].obs).slice(0, 30);
    return { epoch: _learnEpoch, totalTracked: Object.keys(_learnData).length, promoted: getPromotedCommands().length, patterns: _patternCache.length, commands: entries.map(([cmd, d]) => ({ cmd, conf: Math.round(d.conf * 100) / 100, velocity: Math.round(d.velocity * 1000) / 1000, obs: d.obs, status: d.conf >= LEARN.PROMOTE_THRESH && d.obs >= LEARN.OBSERVE_MIN ? 'promoted' : d.conf <= LEARN.DEMOTE_THRESH && d.obs >= LEARN.OBSERVE_MIN ? 'demoted' : d.obs < LEARN.OBSERVE_MIN ? 'observing' : d.conf > 0.3 ? 'learning' : d.conf < -0.3 ? 'suspicious' : 'neutral', lastSeen: new Date(d.lastSeen).toLocaleDateString() })) };
};

const getData = () => _learnData;
const getEpoch = () => _learnEpoch;
const getWhitelist = () => _userWhitelist;
const getBlacklist = () => _userBlacklist;
const getPatternCache = () => _patternCache;

module.exports = { init, flush, recordAction, evaluateCommand, getPromotedCommands, getStats, getData, getEpoch, getWhitelist, getBlacklist, getPatternCache };