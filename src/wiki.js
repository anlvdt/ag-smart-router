// ═══════════════════════════════════════════════════════════════
//  Grav — Second Brain (Karpathy LLM Wiki Pattern)
//
//  3-layer architecture:
//    Layer 1: Raw events (learnData) — individual observations
//    Layer 2: Wiki (this module) — compiled, cross-referenced knowledge
//    Layer 3: Schema (LEARN constants) — system rules
// ═══════════════════════════════════════════════════════════════
'use strict';

const { LEARN, COMMAND_CATEGORIES } = require('./constants');

// ── State ────────────────────────────────────────────────────
let _wiki = null;
let _ctx  = null;
let _learnDataRef = null;  // reference to learning module's getData()
let _learnEpochRef = null; // reference to learning module's getEpoch()
let _saveTimer = null;

function createEmptyWiki() {
    return {
        index: {},
        concepts: {},
        log: [],
        synthesis: {},
        contradictions: [],
        sequences: {},
        lastLint: 0,
    };
}

/** Initialize wiki module. */
function init(ctx, learnDataGetter, learnEpochGetter) {
    _ctx = ctx;
    _learnDataRef = learnDataGetter;
    _learnEpochRef = learnEpochGetter;
    load();
}

function load() {
    if (!_ctx) return;
    const saved = _ctx.globalState.get('wiki', null);
    if (saved && saved.index) {
        _wiki = saved;
        // Migrate: ensure newer fields exist
        if (!_wiki.sequences) _wiki.sequences = {};
        if (!_wiki.contradictions) _wiki.contradictions = [];
        if (!_wiki.synthesis) _wiki.synthesis = {};
        if (!_wiki.log) _wiki.log = [];
        // Reset transient state
        _wiki._lastCmd = { cmd: null, time: 0 };
    } else {
        _wiki = createEmptyWiki();
    }
}

// ── Persistence ──────────────────────────────────────────────
function save() {
    if (!_ctx || _saveTimer) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        try { _ctx.globalState.update('wiki', _wiki); } catch (_) {}
    }, 2000);
}

function flush() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (!_ctx) return;
    try { _ctx.globalState.update('wiki', _wiki); } catch (_) {}
}

// ── Classification ───────────────────────────────────────────
function classifyCommand(cmd) {
    for (const [concept, cmds] of Object.entries(COMMAND_CATEGORIES)) {
        if (cmds.includes(cmd)) return concept;
    }
    const stripped = cmd.replace(/[\d.]+$/, '');
    if (stripped !== cmd && stripped.length >= 2) {
        for (const [concept, cmds] of Object.entries(COMMAND_CATEGORIES)) {
            if (cmds.includes(stripped)) return concept;
        }
    }
    if (/\.(sh|bash|zsh)$/i.test(cmd)) return 'shell-script';
    if (/\.(py|pyw|js|ts|mjs|cjs|rb|pl|php|lua)$/i.test(cmd)) return 'language-runtime';
    if ((cmd.startsWith('./') || cmd.startsWith('/')) && /dev|start|run|build|test|deploy|serve/i.test(cmd)) return 'shell-script';
    return null;
}

function findSimilarCommands(cmd) {
    const similar = [];
    const allCmds = Object.keys(_wiki.index);
    const base = cmd.replace(/[\d.]+$/, '');
    if (base !== cmd && base.length >= 2) {
        for (const other of allCmds) {
            if (other !== cmd && other.startsWith(base)) similar.push(other);
        }
    }
    for (const other of allCmds) {
        if (other !== cmd && other.replace(/[\d.]+$/, '') === cmd) similar.push(other);
    }
    const myConcept = classifyCommand(cmd);
    if (myConcept && _wiki.concepts[myConcept]) {
        for (const other of _wiki.concepts[myConcept].commands) {
            if (other !== cmd && !similar.includes(other)) similar.push(other);
        }
    }
    return similar.slice(0, 5);
}

// ── INGEST ───────────────────────────────────────────────────
function ingest(cmd, action, data, context) {
    if (!_wiki || !data) return;
    const now = Date.now();
    const epoch = _learnEpochRef ? _learnEpochRef() : 0;

    // 1. Update index page
    if (!_wiki.index[cmd]) {
        _wiki.index[cmd] = {
            firstSeen: now, lastUpdated: now, totalEvents: 0,
            approves: 0, rejects: 0, confidence: 0,
            links: [], sources: [], tags: [],
            summary: '', riskLevel: 'unknown',
        };
    }
    const page = _wiki.index[cmd];
    page.lastUpdated = now;
    page.totalEvents++;
    if (action === 'approve') page.approves++; else page.rejects++;
    page.confidence = data.conf;
    page.sources.push(now);
    if (page.sources.length > 20) page.sources.shift();

    // 2. Compile summary
    const ratio = page.totalEvents > 0 ? page.approves / page.totalEvents : 0;
    const dataMaturity = Math.min(1, page.totalEvents / 20);
    const riskScore = ratio * 0.4 + ((data.conf + 1) / 2) * 0.4 + dataMaturity * 0.2;

    if (riskScore >= 0.8 && page.totalEvents >= 5) {
        page.summary = `Highly trusted. ${page.approves}/${page.totalEvents} approved (${Math.round(ratio * 100)}%).`;
        page.riskLevel = 'safe';
    } else if (riskScore >= 0.55) {
        page.summary = `Generally safe. ${page.approves}/${page.totalEvents} approved.`;
        page.riskLevel = 'safe';
    } else if (riskScore >= 0.3) {
        page.summary = `Mixed signals. ${page.approves} approves vs ${page.rejects} rejects.`;
        page.riskLevel = 'caution';
    } else {
        page.summary = `Frequently rejected (${page.rejects}/${page.totalEvents}).`;
        page.riskLevel = 'danger';
    }

    // 3. Update concept pages
    const concept = classifyCommand(cmd);
    if (concept) {
        if (!_wiki.concepts[concept]) {
            _wiki.concepts[concept] = {
                description: '', commands: [], evidence: [],
                avgConfidence: 0, riskLevel: 'unknown',
            };
        }
        const cp = _wiki.concepts[concept];
        if (!cp.commands.includes(cmd)) cp.commands.push(cmd);
        cp.evidence.push({ cmd, action, time: now, conf: data.conf });
        if (cp.evidence.length > 50) cp.evidence.shift();

        const confs = cp.commands.map(c => _wiki.index[c]?.confidence || 0);
        cp.avgConfidence = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
        cp.riskLevel = cp.avgConfidence >= 0.5 ? 'safe' : cp.avgConfidence >= 0 ? 'caution' : 'danger';
        cp.description = `${cp.commands.length} commands. Avg conf: ${Math.round(cp.avgConfidence * 100)}%.`;
    }

    // 4. Cross-references
    if (context.project) {
        const projTag = 'proj:' + context.project;
        if (!page.tags.includes(projTag)) {
            page.tags.push(projTag);
            // Cap project tags
            const projTags = page.tags.filter(t => t.startsWith('proj:'));
            if (projTags.length > 10) {
                const toRemove = projTags.slice(0, projTags.length - 10);
                page.tags = page.tags.filter(t => !toRemove.includes(t));
            }
        }
    }

    // Sequence learning
    if (!_wiki._lastCmd) _wiki._lastCmd = { cmd: null, time: 0 };
    if (_wiki._lastCmd.cmd && _wiki._lastCmd.cmd !== cmd && (now - _wiki._lastCmd.time) < 30000) {
        const prevCmd = _wiki._lastCmd.cmd;
        if (!page.links.includes(prevCmd)) page.links.push(prevCmd);
        const prevPage = _wiki.index[prevCmd];
        if (prevPage && !prevPage.links.includes(cmd)) prevPage.links.push(cmd);

        const seqKey = prevCmd + ' → ' + cmd;
        _wiki.sequences[seqKey] = (_wiki.sequences[seqKey] || 0) + 1;

        // Prune sequences
        const seqKeys = Object.keys(_wiki.sequences);
        if (seqKeys.length > 500) {
            const sorted = seqKeys.map(k => [k, _wiki.sequences[k]]).sort((a, b) => b[1] - a[1]);
            _wiki.sequences = {};
            for (let i = 0; i < 300 && i < sorted.length; i++) {
                _wiki.sequences[sorted[i][0]] = sorted[i][1];
            }
        }
    }
    _wiki._lastCmd = { cmd, time: now };

    // Similar commands
    const similar = findSimilarCommands(cmd);
    for (const sim of similar) {
        if (!page.links.includes(sim)) page.links.push(sim);
    }

    // Trim links
    if (page.links.length > 20) {
        page.links = page.links
            .map(l => ({ cmd: l, conf: Math.abs(_wiki.index[l]?.confidence || 0) }))
            .sort((a, b) => b.conf - a.conf)
            .slice(0, 15)
            .map(l => l.cmd);
    }

    // 5. Detect contradictions
    detectContradictions(cmd, action, data, epoch);

    // 6. Synthesis (throttled)
    if (epoch % 5 === 0) updateSynthesis();

    // 7. Activity log
    const ts = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
    _wiki.log.push({ time: ts, op: 'ingest', cmd, action, conf: Math.round(data.conf * 100) / 100, concept: concept || '-' });
    if (_wiki.log.length > 200) _wiki.log = _wiki.log.slice(-200);

    // 8. Periodic lint
    if (epoch % 50 === 0 && now - _wiki.lastLint > 300000) lint();

    save();
}

// ── QUERY ────────────────────────────────────────────────────
function query(cmd) {
    if (!_wiki) return null;
    const page = _wiki.index[cmd];
    if (!page) return null;
    return { ...page };
}

// ── Contradiction Detection ──────────────────────────────────
function detectContradictions(cmd, action, data, epoch) {
    const page = _wiki.index[cmd];
    if (!page || page.totalEvents < 3) return;
    const ratio = page.approves / page.totalEvents;

    if (action === 'reject' && ratio > 0.7 && page.totalEvents >= 5) {
        addContradiction('behavior-shift', cmd, `"${cmd}" trusted but rejected.`);
    }
    if (action === 'approve' && ratio < 0.4 && page.totalEvents >= 5) {
        addContradiction('rehabilitation', cmd, `"${cmd}" distrusted but approved.`);
    }
    if (data.history && data.history.length >= 3) {
        const recent = data.history.slice(-3);
        const prevDir = recent[1].c - recent[0].c;
        const currDir = recent[2].c - recent[1].c;
        if (Math.abs(prevDir) > 0.1 && Math.abs(currDir) > 0.1 && Math.sign(prevDir) !== Math.sign(currDir)) {
            addContradiction('velocity-reversal', cmd, `"${cmd}" confidence reversed direction.`);
        }
    }
}

function addContradiction(type, cmd, detail) {
    const recent = _wiki.contradictions.find(c =>
        c.cmd === cmd && c.type === type && !c.resolved && (Date.now() - c.time) < 300000);
    if (recent) return;
    _wiki.contradictions.push({ time: Date.now(), type, cmd, detail, resolved: false });
    if (_wiki.contradictions.length > 100) {
        const unresolved = _wiki.contradictions.filter(c => !c.resolved);
        const resolved = _wiki.contradictions.filter(c => c.resolved).slice(-20);
        _wiki.contradictions = [...resolved, ...unresolved];
    }
}

// ── Synthesis ────────────────────────────────────────────────
function updateSynthesis() {
    const learnData = _learnDataRef ? _learnDataRef() : {};

    // Peak activity time
    const timeSlots = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const d of Object.values(learnData)) {
        for (const [slot, count] of Object.entries(d.contexts || {})) {
            if (timeSlots[slot] !== undefined) timeSlots[slot] += count;
        }
    }
    const peakTime = Object.entries(timeSlots).sort((a, b) => b[1] - a[1])[0];
    if (peakTime) {
        _wiki.synthesis['peak-activity'] = {
            description: `Most active: ${peakTime[0]} (${peakTime[1]} events)`,
            members: Object.keys(timeSlots), strength: peakTime[1],
        };
    }

    // Trusted categories
    const conceptRanking = Object.entries(_wiki.concepts)
        .filter(([, c]) => c.commands.length > 0)
        .sort((a, b) => b[1].avgConfidence - a[1].avgConfidence);
    if (conceptRanking.length > 0) {
        _wiki.synthesis['trusted-categories'] = {
            description: conceptRanking.map(([k, v]) => `${k}: ${Math.round(v.avgConfidence * 100)}%`).join(', '),
            members: conceptRanking.map(([k]) => k),
            strength: conceptRanking[0][1].avgConfidence,
        };
    }

    // Learning health
    const totalObs = Object.values(learnData).reduce((a, d) => a + d.obs, 0);
    const vals = Object.values(learnData);
    const avgConf = vals.length > 0 ? vals.reduce((a, d) => a + d.conf, 0) / vals.length : 0;
    const epoch = _learnEpochRef ? _learnEpochRef() : 0;
    _wiki.synthesis['learning-health'] = {
        description: `Epoch ${epoch}: ${vals.length} cmds, ${totalObs} obs, avg conf ${Math.round(avgConf * 100)}%`,
        members: [], strength: avgConf,
    };

    // Top sequences
    if (Object.keys(_wiki.sequences).length > 0) {
        const topSeqs = Object.entries(_wiki.sequences).sort((a, b) => b[1] - a[1]).slice(0, 5);
        _wiki.synthesis['common-sequences'] = {
            description: topSeqs.map(([seq, n]) => `${seq} (×${n})`).join(', '),
            members: topSeqs.map(([seq]) => seq), strength: topSeqs[0][1],
        };
    }

    // Risk trend
    const recentHistory = [];
    for (const d of Object.values(learnData)) {
        if (d.history && d.history.length >= 2) {
            const last = d.history[d.history.length - 1];
            const prev = d.history[Math.max(0, d.history.length - 5)];
            recentHistory.push(last.c - prev.c);
        }
    }
    if (recentHistory.length > 0) {
        const avgTrend = recentHistory.reduce((a, b) => a + b, 0) / recentHistory.length;
        _wiki.synthesis['risk-trend'] = {
            description: avgTrend > 0.05 ? 'Improving' : avgTrend < -0.05 ? 'Degrading' : 'Stable',
            members: [], strength: avgTrend,
        };
    }
}

// ── LINT ──────────────────────────────────────────────────────
function lint() {
    _wiki.lastLint = Date.now();
    const issues = [];

    const orphans = Object.entries(_wiki.index).filter(([, p]) => p.links.length === 0 && p.totalEvents >= 3);
    if (orphans.length > 0) issues.push({ type: 'orphans', count: orphans.length });

    const staleThreshold = Date.now() - 14 * 86400000;
    const stale = Object.entries(_wiki.index).filter(([, p]) => p.lastUpdated < staleThreshold && Math.abs(p.confidence) < 0.3);
    if (stale.length > 0) issues.push({ type: 'stale', count: stale.length });

    const unresolved = _wiki.contradictions.filter(c => !c.resolved);
    if (unresolved.length > 0) issues.push({ type: 'contradictions', count: unresolved.length });

    // Auto-resolve old contradictions
    const resolveThreshold = Date.now() - 7 * 86400000;
    for (const c of _wiki.contradictions) {
        if (!c.resolved && c.time < resolveThreshold) c.resolved = true;
    }

    // Clean stale concept commands
    for (const cp of Object.values(_wiki.concepts)) {
        cp.commands = cp.commands.filter(cmd => _wiki.index[cmd]);
    }

    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    _wiki.log.push({ time: ts, op: 'lint', detail: issues.map(i => `${i.type}:${i.count}`).join(', ') || 'clean' });
    if (_wiki.log.length > 200) _wiki.log = _wiki.log.slice(-200);

    save();
    return issues;
}

// ── Accessors ────────────────────────────────────────────────
function getWiki()        { return _wiki; }
function getSequences()   { return _wiki ? _wiki.sequences : {}; }
function getConcepts()    { return _wiki ? _wiki.concepts : {}; }
function getLog()         { return _wiki ? _wiki.log : []; }
function getContradictions() { return _wiki ? _wiki.contradictions.filter(c => !c.resolved) : []; }

function learningHealth() {
    const trend = _wiki?.synthesis?.['risk-trend'];
    const learnData = _learnDataRef ? _learnDataRef() : {};
    const total = Object.keys(learnData).length;
    if (total === 0) return 'new';
    if (trend) {
        if (trend.strength > 0.05) return 'healthy';
        if (trend.strength < -0.05) return 'degrading';
    }
    const avgConf = total > 0 ? Object.values(learnData).reduce((a, d) => a + d.conf, 0) / total : 0;
    if (avgConf > 0.3) return 'healthy';
    if (avgConf > 0) return 'learning';
    return 'degrading';
}

module.exports = {
    init, flush, ingest, query, lint, classifyCommand,
    getWiki, getSequences, getConcepts, getLog, getContradictions,
    learningHealth,
};
