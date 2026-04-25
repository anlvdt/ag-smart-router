// ═══════════════════════════════════════════════════════════════
//  Grav — AI Learning Engine + Second Brain Wiki
//
//  Karpathy-inspired architecture:
//    Layer 1 (Raw): learnData — individual command observations
//    Layer 2 (Wiki): wiki — compiled knowledge pages
//    Layer 3 (Schema): LEARN constants — system rules
// ═══════════════════════════════════════════════════════════════
const vscode = require('vscode');
const { state, createEmptyWiki } = require('./state');
const { SAFE_TERMINAL_CMDS, LEARN } = require('./constants');
const { cfg } = require('./utils');

// ── Concept categories for command classification ────────────
const CATEGORIES = {
    'package-manager': ['npm','npx','yarn','pnpm','bun','pip','pip3','cargo','go','mvn','gradle','brew','apt','apt-get','yum','dnf','pacman','snap','uvx','uv','pipx','poetry','pdm'],
    'version-control': ['git'],
    'container-ops': ['docker','docker-compose','podman','kubectl','helm'],
    'build-tool': ['make','cmake','gcc','g++','clang','tsc','webpack','vite','esbuild','rollup','turbo'],
    'test-runner': ['jest','vitest','mocha','playwright','pytest','unittest'],
    'linter-formatter': ['eslint','prettier','ruff','black','mypy','pylint','flake8'],
    'file-ops': ['ls','dir','cat','cp','mv','touch','mkdir','rm','find','head','tail','wc','sort','uniq','diff','tar','zip','unzip','gzip','chmod','chown'],
    'network': ['curl','wget','ping','dig','nslookup','host','netstat','ss','ssh','scp','rsync'],
    'system-info': ['ps','top','htop','lsof','df','du','free','uname','hostname','whoami','id','env','printenv','date'],
    'text-processing': ['grep','sed','awk','tr','cut','tee','xargs','jq','yq'],
    'database': ['sqlite3','psql','mysql','mongosh','redis-cli'],
    'language-runtime': ['node','python','python3','deno','java','javac','rustc','ruby','perl','php','lua'],
    'infra': ['terraform','ansible','pulumi','cdk'],
    'crypto-encoding': ['base64','md5','sha256sum','openssl'],
    'shell-script': ['bash','sh','zsh'],
};

function classifyCommand(cmd) {
    for (const [concept, cmds] of Object.entries(CATEGORIES)) {
        if (cmds.includes(cmd)) return concept;
    }
    const stripped = cmd.replace(/[\d.]+$/, '');
    if (stripped !== cmd && stripped.length >= 2) {
        for (const [concept, cmds] of Object.entries(CATEGORIES)) {
            if (cmds.includes(stripped)) return concept;
        }
    }
    if (/\.(sh|bash|zsh)$/i.test(cmd)) return 'shell-script';
    if (/\.(py|pyw)$/i.test(cmd)) return 'language-runtime';
    if (/\.(js|ts|mjs|cjs)$/i.test(cmd)) return 'language-runtime';
    if (/\.(rb|pl|php|lua)$/i.test(cmd)) return 'language-runtime';
    if (cmd.startsWith('./') || cmd.startsWith('/')) {
        if (/dev|start|run|build|test|deploy|serve/i.test(cmd)) return 'shell-script';
    }
    return null;
}

function findSimilarCommands(cmd) {
    const similar = [];
    const allCmds = Object.keys(state.wiki.index);
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
    if (myConcept) {
        const cp = state.wiki.concepts[myConcept];
        if (cp) {
            for (const other of cp.commands) {
                if (other !== cmd && !similar.includes(other)) similar.push(other);
            }
        }
    }
    return similar.slice(0, 5);
}

// ── Wiki operations ──────────────────────────────────────────

function loadWiki() {
    if (!state.ctx) return;
    const saved = state.ctx.globalState.get('wiki', null);
    if (saved && saved.index) {
        state.wiki = saved;
    } else {
        state.wiki = createEmptyWiki();
    }
}

function wikiQuery(cmd) {
    const page = state.wiki.index[cmd];
    if (!page) return null;
    const related = page.links
        .map(link => ({ cmd: link, conf: state.wiki.index[link]?.confidence || 0 }))
        .sort((a, b) => b.conf - a.conf);
    const concept = Object.entries(state.wiki.concepts)
        .find(([, c]) => c.commands.includes(cmd));
    const contradictions = state.wiki.contradictions
        .filter(c => c.cmd === cmd && !c.resolved);
    return {
        ...page,
        related,
        concept: concept ? { name: concept[0], ...concept[1] } : null,
        contradictions,
        synthesis: Object.values(state.wiki.synthesis),
    };
}

function wikiIngest(cmd, action, data, context) {
    const now = Date.now();

    if (!state.wiki.index[cmd]) {
        state.wiki.index[cmd] = {
            firstSeen: now, lastUpdated: now, totalEvents: 0,
            approves: 0, rejects: 0, confidence: 0,
            links: [], sources: [], tags: [], summary: '',
            riskLevel: 'unknown',
        };
    }
    const page = state.wiki.index[cmd];
    page.lastUpdated = now;
    page.totalEvents++;
    if (action === 'approve') page.approves++;
    else page.rejects++;
    page.confidence = data.conf;
    page.sources.push(now);
    if (page.sources.length > LEARN.MAX_SOURCES) page.sources.shift();

    // Compile summary with weighted risk score
    const ratio = page.totalEvents > 0 ? page.approves / page.totalEvents : 0;
    const dataMaturity = Math.min(1, page.totalEvents / 20);
    const riskScore = ratio * 0.4 + ((data.conf + 1) / 2) * 0.4 + dataMaturity * 0.2;

    if (riskScore >= 0.8 && page.totalEvents >= 5) {
        page.summary = `Highly trusted. ${page.approves}/${page.totalEvents} approved (${Math.round(ratio * 100)}%), conf: ${Math.round(data.conf * 100)}%.`;
        page.riskLevel = 'safe';
        page.tags = [...new Set([...page.tags.filter(t => t !== 'suspicious' && t !== 'blocked' && t !== 'mixed'), 'trusted', 'auto-approve'])];
    } else if (riskScore >= 0.55) {
        page.summary = `Generally safe. ${page.approves}/${page.totalEvents} approved. Confidence trending ${data.velocity > 0 ? 'up' : 'down'}.`;
        page.riskLevel = 'safe';
        page.tags = [...new Set([...page.tags.filter(t => t !== 'suspicious' && t !== 'blocked'), 'learning'])];
    } else if (riskScore >= 0.3) {
        page.summary = `Mixed signals. ${page.approves} approves vs ${page.rejects} rejects. Conf: ${Math.round(data.conf * 100)}%.`;
        page.riskLevel = 'caution';
        page.tags = [...new Set([...page.tags.filter(t => t !== 'trusted' && t !== 'auto-approve'), 'mixed', 'review'])];
    } else {
        page.summary = `Frequently rejected (${page.rejects}/${page.totalEvents}). Conf: ${Math.round(data.conf * 100)}%.`;
        page.riskLevel = 'danger';
        page.tags = [...new Set([...page.tags.filter(t => t !== 'trusted' && t !== 'auto-approve'), 'suspicious', 'blocked'])];
    }

    // Update concept pages
    const concept = classifyCommand(cmd);
    if (concept) {
        if (!state.wiki.concepts[concept]) {
            state.wiki.concepts[concept] = {
                description: '', commands: [], evidence: [],
                avgConfidence: 0, riskLevel: 'unknown',
            };
        }
        const cp = state.wiki.concepts[concept];
        if (!cp.commands.includes(cmd)) cp.commands.push(cmd);
        cp.evidence.push({ cmd, action, time: now, conf: data.conf });
        if (cp.evidence.length > LEARN.MAX_EVIDENCE) cp.evidence.shift();
        const confs = cp.commands.map(c => state.wiki.index[c]?.confidence || 0);
        cp.avgConfidence = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
        cp.riskLevel = cp.avgConfidence >= 0.5 ? 'safe' : cp.avgConfidence >= 0 ? 'caution' : 'danger';
        cp.description = `${cp.commands.length} commands in this category. Avg confidence: ${Math.round(cp.avgConfidence * 100)}%. Risk: ${cp.riskLevel}.`;
    }

    // Cross-references
    if (context.project) {
        if (!page.tags.includes('proj:' + context.project)) {
            page.tags.push('proj:' + context.project);
        }
        const projectCmds = Object.entries(state.wiki.index)
            .filter(([k, v]) => k !== cmd && v.tags.includes('proj:' + context.project))
            .map(([k]) => k);
        for (const related of projectCmds.slice(0, 5)) {
            if (!page.links.includes(related)) page.links.push(related);
            const relPage = state.wiki.index[related];
            if (relPage && !relPage.links.includes(cmd)) relPage.links.push(cmd);
        }
    }

    // Sequence learning
    if (!state.wiki._lastCmd) state.wiki._lastCmd = { cmd: null, time: 0 };
    if (state.wiki._lastCmd.cmd && state.wiki._lastCmd.cmd !== cmd && (now - state.wiki._lastCmd.time) < 30000) {
        const prevCmd = state.wiki._lastCmd.cmd;
        if (!page.links.includes(prevCmd)) page.links.push(prevCmd);
        const prevPage = state.wiki.index[prevCmd];
        if (prevPage && !prevPage.links.includes(cmd)) prevPage.links.push(cmd);
        if (!state.wiki.sequences) state.wiki.sequences = {};
        const seqKey = prevCmd + ' \u2192 ' + cmd;
        state.wiki.sequences[seqKey] = (state.wiki.sequences[seqKey] || 0) + 1;
    }
    state.wiki._lastCmd = { cmd, time: now };

    // Similar command inference
    const similar = findSimilarCommands(cmd);
    for (const sim of similar) {
        if (!page.links.includes(sim)) page.links.push(sim);
        const simPage = state.wiki.index[sim];
        if (simPage && !simPage.links.includes(cmd)) simPage.links.push(cmd);
    }

    // Trim links
    if (page.links.length > LEARN.MAX_LINKS) {
        page.links = page.links
            .map(l => ({ cmd: l, conf: Math.abs(state.wiki.index[l]?.confidence || 0) }))
            .sort((a, b) => b.conf - a.conf)
            .slice(0, LEARN.TRIM_LINKS)
            .map(l => l.cmd);
    }

    detectContradictions(cmd, action, data);

    if (state.learnEpoch % 5 === 0) updateSynthesis();

    // Activity log
    const ts = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
    state.wiki.log.push({
        time: ts, op: 'ingest', cmd, action,
        conf: Math.round(data.conf * 100) / 100,
        concept: concept || '-',
    });
    if (state.wiki.log.length > LEARN.MAX_LOG) state.wiki.log = state.wiki.log.slice(-LEARN.MAX_LOG);

    // Periodic lint
    if (state.learnEpoch % 50 === 0 && now - state.wiki.lastLint > 300000) {
        wikiLint();
    }
}

function detectContradictions(cmd, action, data) {
    const page = state.wiki.index[cmd];
    if (!page || page.totalEvents < 3) return;
    const ratio = page.approves / page.totalEvents;

    if (action === 'reject' && ratio > 0.7 && page.totalEvents >= 5) {
        addContradiction('behavior-shift', cmd,
            `"${cmd}" was trusted (${Math.round(ratio * 100)}% approve) but just got rejected.`,
            `${cmd} is safe (conf: ${Math.round(page.confidence * 100)}%)`,
            `Rejected at epoch ${state.learnEpoch}`);
    }
    if (action === 'approve' && ratio < 0.4 && page.totalEvents >= 5) {
        addContradiction('rehabilitation', cmd,
            `"${cmd}" was distrusted (${Math.round(ratio * 100)}% approve) but just got approved.`,
            `${cmd} is suspicious`,
            `Approved at epoch ${state.learnEpoch}`);
    }
    if (data.history && data.history.length >= 3) {
        const recent = data.history.slice(-3);
        const prevDir = recent[1].c - recent[0].c;
        const currDir = recent[2].c - recent[1].c;
        if (Math.abs(prevDir) > 0.1 && Math.abs(currDir) > 0.1 && Math.sign(prevDir) !== Math.sign(currDir)) {
            addContradiction('velocity-reversal', cmd,
                `"${cmd}" confidence reversed direction: was ${prevDir > 0 ? 'rising' : 'falling'}, now ${currDir > 0 ? 'rising' : 'falling'}.`,
                `Trend was ${prevDir > 0 ? 'positive' : 'negative'}`,
                `Reversed at epoch ${state.learnEpoch}, conf: ${Math.round(data.conf * 100)}%`);
        }
    }
    if (action === 'approve' && data.rewards && data.rewards.length >= 3) {
        const recentRewards = data.rewards.slice(-3);
        const allNegContext = recentRewards.every(r => r < 1.0 && r > 0);
        if (allNegContext && page.riskLevel === 'safe') {
            addContradiction('exit-code-mismatch', cmd,
                `"${cmd}" is marked safe but last 3 executions had non-zero exit codes.`,
                `${cmd} is safe`,
                `Consistently failing despite approval`);
        }
    }
    const concept = classifyCommand(cmd);
    if (concept && state.wiki.concepts[concept]) {
        const cp = state.wiki.concepts[concept];
        if (cp.avgConfidence > 0.5 && data.conf < -0.2) {
            addContradiction('concept-outlier', cmd,
                `"${cmd}" (conf: ${Math.round(data.conf * 100)}%) is an outlier in "${concept}" (avg: ${Math.round(cp.avgConfidence * 100)}%).`,
                `${concept} category is generally safe`,
                `${cmd} is significantly below category average`);
        }
    }
}

function addContradiction(type, cmd, detail, oldClaim, newEvidence) {
    const recent = state.wiki.contradictions.find(c =>
        c.cmd === cmd && c.type === type && !c.resolved && (Date.now() - c.time) < 300000);
    if (recent) return;
    state.wiki.contradictions.push({
        time: Date.now(), type, cmd, detail, oldClaim, newEvidence, resolved: false,
    });
    if (state.wiki.contradictions.length > LEARN.MAX_CONTRADICTIONS) {
        const unresolved = state.wiki.contradictions.filter(c => !c.resolved);
        const resolved = state.wiki.contradictions.filter(c => c.resolved).slice(-20);
        state.wiki.contradictions = [...resolved, ...unresolved];
    }
}

function updateSynthesis() {
    const timeSlots = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const [, d] of Object.entries(state.learnData)) {
        for (const [slot, count] of Object.entries(d.contexts || {})) {
            if (timeSlots[slot] !== undefined) timeSlots[slot] += count;
        }
    }
    const peakTime = Object.entries(timeSlots).sort((a, b) => b[1] - a[1])[0];
    state.wiki.synthesis['peak-activity'] = {
        description: `Most active: ${peakTime[0]} (${peakTime[1]} events)`,
        members: Object.keys(timeSlots), strength: peakTime[1],
    };

    const conceptRanking = Object.entries(state.wiki.concepts)
        .filter(([, c]) => c.commands.length > 0)
        .sort((a, b) => b[1].avgConfidence - a[1].avgConfidence);
    if (conceptRanking.length > 0) {
        state.wiki.synthesis['trusted-categories'] = {
            description: conceptRanking.map(([k, v]) => `${k}: ${Math.round(v.avgConfidence * 100)}%`).join(', '),
            members: conceptRanking.map(([k]) => k),
            strength: conceptRanking[0][1].avgConfidence,
        };
    }

    const totalObs = Object.values(state.learnData).reduce((a, d) => a + d.obs, 0);
    const avgConf = Object.values(state.learnData).length > 0
        ? Object.values(state.learnData).reduce((a, d) => a + d.conf, 0) / Object.values(state.learnData).length : 0;
    state.wiki.synthesis['learning-health'] = {
        description: `Epoch ${state.learnEpoch}: ${Object.keys(state.learnData).length} cmds, ${totalObs} obs, avg conf ${Math.round(avgConf * 100)}%`,
        members: [], strength: avgConf,
    };

    if (state.wiki.sequences) {
        const topSeqs = Object.entries(state.wiki.sequences)
            .sort((a, b) => b[1] - a[1]).slice(0, 5);
        if (topSeqs.length > 0) {
            state.wiki.synthesis['common-sequences'] = {
                description: topSeqs.map(([seq, n]) => `${seq} (\u00d7${n})`).join(', '),
                members: topSeqs.map(([seq]) => seq), strength: topSeqs[0][1],
            };
        }
    }

    const recentHistory = [];
    for (const [, d] of Object.entries(state.learnData)) {
        if (d.history && d.history.length >= 2) {
            const last = d.history[d.history.length - 1];
            const prev = d.history[Math.max(0, d.history.length - 5)];
            recentHistory.push(last.c - prev.c);
        }
    }
    if (recentHistory.length > 0) {
        const avgTrend = recentHistory.reduce((a, b) => a + b, 0) / recentHistory.length;
        state.wiki.synthesis['risk-trend'] = {
            description: avgTrend > 0.05 ? 'Improving \u2014 confidence rising across commands' :
                         avgTrend < -0.05 ? 'Degrading \u2014 confidence falling, review needed' :
                         'Stable \u2014 no significant changes',
            members: [], strength: avgTrend,
        };
    }

    const projects = {};
    for (const [cmd, d] of Object.entries(state.learnData)) {
        for (const [key, count] of Object.entries(d.contexts || {})) {
            if (key.startsWith('proj:')) {
                const proj = key.slice(5);
                if (!projects[proj]) projects[proj] = [];
                projects[proj].push({ cmd, count, conf: d.conf });
            }
        }
    }
    const projEntries = Object.entries(projects).sort((a, b) => b[1].length - a[1].length);
    if (projEntries.length > 0) {
        state.wiki.synthesis['project-profiles'] = {
            description: projEntries.map(([p, cmds]) => `${p}: ${cmds.length} cmds`).join(', '),
            members: projEntries.map(([p]) => p), strength: projEntries[0][1].length,
        };
    }
}

function wikiLint() {
    state.wiki.lastLint = Date.now();
    const issues = [];

    const orphans = Object.entries(state.wiki.index)
        .filter(([, p]) => p.links.length === 0 && p.totalEvents >= 3)
        .map(([k]) => k);
    if (orphans.length > 0) {
        issues.push({ type: 'orphans', detail: `${orphans.length} commands with no cross-references`, items: orphans.slice(0, 10) });
    }

    const staleThreshold = Date.now() - 14 * 86400000;
    const staleItems = Object.entries(state.wiki.index)
        .filter(([, p]) => p.lastUpdated < staleThreshold && Math.abs(p.confidence) < 0.3)
        .map(([k]) => k);
    if (staleItems.length > 0) {
        issues.push({ type: 'stale', detail: `${staleItems.length} stale commands (>14 days, low confidence)`, items: staleItems.slice(0, 10) });
    }

    const unresolved = state.wiki.contradictions.filter(c => !c.resolved);
    if (unresolved.length > 0) {
        issues.push({ type: 'contradictions', detail: `${unresolved.length} unresolved contradictions`, items: unresolved.slice(0, 5).map(c => c.detail) });
    }

    const thinConcepts = Object.entries(state.wiki.concepts)
        .filter(([, c]) => c.commands.length === 1)
        .map(([k]) => k);
    if (thinConcepts.length > 0) {
        issues.push({ type: 'thin-concepts', detail: `${thinConcepts.length} concepts with only 1 command`, items: thinConcepts });
    }

    const unclassified = Object.keys(state.wiki.index).filter(cmd => {
        return !Object.values(state.wiki.concepts).some(c => c.commands.includes(cmd));
    });
    if (unclassified.length > 0) {
        issues.push({ type: 'unclassified', detail: `${unclassified.length} commands not in any concept category`, items: unclassified.slice(0, 10) });
    }

    const resolveThreshold = Date.now() - 7 * 86400000;
    for (const c of state.wiki.contradictions) {
        if (!c.resolved && c.time < resolveThreshold) c.resolved = true;
    }

    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    state.wiki.log.push({
        time: ts, op: 'lint', issues: issues.length,
        detail: issues.map(i => i.type + ':' + i.items.length).join(', ') || 'clean',
    });

    return issues;
}

// ── Core learning functions ──────────────────────────────────

function applyDecay() {
    const now = Date.now();
    let changed = false;
    for (const [k, d] of Object.entries(state.learnData)) {
        const daysSince = (now - d.lastSeen) / 86400000;
        if (daysSince > 1) {
            const decayFactor = Math.pow(LEARN.GAMMA, daysSince);
            const oldConf = d.conf;
            d.conf *= decayFactor;
            d.velocity *= decayFactor;
            if (Math.abs(d.conf) < 0.01 && d.obs < LEARN.OBSERVE_MIN && daysSince > 60) {
                delete state.learnData[k];
            }
            if (d.conf !== oldConf) changed = true;
        }
    }
    return changed;
}

function pruneEntries() {
    const keys = Object.keys(state.learnData);
    if (keys.length <= LEARN.MAX_ENTRIES) return;
    const scored = keys.map(k => ({
        key: k,
        score: Math.abs(state.learnData[k].conf) * Math.log(state.learnData[k].obs + 1),
    }));
    scored.sort((a, b) => b.score - a.score);
    for (let i = LEARN.MAX_ENTRIES; i < scored.length; i++) {
        delete state.learnData[scored[i].key];
    }
}

function generalizePatterns() {
    state.patternCache = [];

    const groups = {};
    for (const [cmd, d] of Object.entries(state.learnData)) {
        if (d.conf < 0.2 || d.obs < 2) continue;
        const prefix = cmd.replace(/[-_].*$/, '').replace(/\d+$/, '');
        if (prefix && prefix.length >= 2) {
            if (!groups[prefix]) groups[prefix] = [];
            groups[prefix].push(cmd);
        }
    }
    for (const [prefix, members] of Object.entries(groups)) {
        if (members.length >= LEARN.GENERALIZE_MIN && !SAFE_TERMINAL_CMDS.includes(prefix)) {
            state.patternCache.push(prefix);
        }
    }

    const subCmdGroups = {};
    for (const [cmd, d] of Object.entries(state.learnData)) {
        if (d.conf < 0.3) continue;
        const concept = classifyCommand(cmd);
        if (concept) {
            if (!subCmdGroups[concept]) subCmdGroups[concept] = { safe: 0, total: 0 };
            subCmdGroups[concept].total++;
            if (d.conf > 0.5) subCmdGroups[concept].safe++;
        }
    }

    if (state.wiki.sequences) {
        const coOccur = {};
        for (const [seq, count] of Object.entries(state.wiki.sequences)) {
            if (count < 2) continue;
            const [a, b] = seq.split(' \u2192 ');
            if (a && b) {
                if (!coOccur[a]) coOccur[a] = new Set();
                if (!coOccur[b]) coOccur[b] = new Set();
                coOccur[a].add(b);
                coOccur[b].add(a);
            }
        }
        for (const [cmd, peers] of Object.entries(coOccur)) {
            if (state.learnData[cmd] && state.learnData[cmd].conf < 0.3) {
                const trustedPeers = [...peers].filter(p => state.learnData[p]?.conf > 0.5);
                if (trustedPeers.length >= 2) {
                    state.learnData[cmd].conf = Math.min(1, state.learnData[cmd].conf + 0.05);
                }
            }
        }
    }
}

function getPromotedCommands() {
    return Object.entries(state.learnData)
        .filter(([, d]) => d.conf >= LEARN.PROMOTE_THRESH && d.obs >= LEARN.OBSERVE_MIN)
        .map(([k]) => k);
}

function recordCommandAction(cmdLine, action, context = {}) {
    if (!cfg('learnEnabled', true)) return;

    const cmds = extractCommandsForLearning(cmdLine);
    const now = Date.now();
    state.learnEpoch++;

    for (const cmd of cmds) {
        if (!state.learnData[cmd]) {
            state.learnData[cmd] = {
                conf: 0, velocity: 0, obs: 0, rewards: [],
                history: [], contexts: {}, lastSeen: now,
                promoted: false, demoted: false,
            };
        }

        const d = state.learnData[cmd];
        d.obs++;
        d.lastSeen = now;

        let reward = action === 'approve' ? 1.0 : -1.0;
        if (context.exitCode !== undefined) {
            if (context.exitCode === 0 && action === 'approve') {
                reward += LEARN.CONTEXT_WEIGHT;
            } else if (context.exitCode !== 0 && action === 'approve') {
                reward -= LEARN.CONTEXT_WEIGHT;
            }
        }

        const hour = new Date().getHours();
        const timeSlot = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
        d.contexts[timeSlot] = (d.contexts[timeSlot] || 0) + 1;
        if (context.project) {
            const projKey = 'proj:' + context.project;
            d.contexts[projKey] = (d.contexts[projKey] || 0) + 1;
        }

        d.rewards.push(reward);
        if (d.rewards.length > LEARN.BATCH_SIZE) d.rewards.shift();

        const batchReward = d.rewards.reduce((a, b) => a + b, 0) / d.rewards.length;
        const gradient = LEARN.ALPHA * batchReward;
        d.velocity = LEARN.MOMENTUM * d.velocity + gradient;
        d.conf = Math.max(-1, Math.min(1, d.conf + d.velocity * (1 - LEARN.MOMENTUM)));

        d.history.push({ t: now, c: d.conf, r: reward, e: state.learnEpoch });
        if (d.history.length > LEARN.MAX_HISTORY) d.history.shift();

        if (d.obs >= LEARN.OBSERVE_MIN) {
            if (d.conf >= LEARN.PROMOTE_THRESH && !d.promoted
                && !SAFE_TERMINAL_CMDS.includes(cmd) && !state.userWhitelist.includes(cmd)) {
                d.promoted = true;
                suggestPromotion(cmd, d);
            }
            if (d.conf <= LEARN.DEMOTE_THRESH && !d.demoted
                && !state.userBlacklist.includes(cmd)) {
                d.demoted = true;
                suggestDemotion(cmd, d);
            }
        }
    }

    if (state.learnEpoch % 20 === 0) generalizePatterns();

    for (const cmd of cmds) {
        wikiIngest(cmd, action, state.learnData[cmd], context);
    }

    saveLearnData();
}

/** Extract commands — lightweight version for learning module */
function extractCommandsForLearning(cmdLine) {
    if (!cmdLine || typeof cmdLine !== 'string') return [];
    const parts = cmdLine.split(/\s*(?:\|\||&&|[|;&])\s*/);
    const cmds = [];
    for (const part of parts) {
        let p = part.trim();
        if (!p) continue;
        p = p.replace(/^(?:(?:sudo|nohup|time|nice|ionice|strace|ltrace|env)\s+)+/gi, '');
        p = p.replace(/^(?:\w+=\S+\s+)+/, '');
        p = p.replace(/^\$\(\s*/, '').replace(/^\(\s*/, '').replace(/\)\s*$/, '');
        const match = p.match(/^([^\s]+)/);
        if (match) {
            let cmd = match[1];
            cmd = cmd.replace(/^.*[/\\]/, '');
            if (cmd) cmds.push(cmd.toLowerCase());
        }
    }
    return [...new Set(cmds)];
}

function saveLearnData() {
    if (!state.ctx) return;
    if (saveLearnData._pending) return;
    saveLearnData._pending = true;
    setTimeout(() => {
        saveLearnData._pending = false;
        try {
            state.ctx.globalState.update('learnData', state.learnData);
            state.ctx.globalState.update('learnEpoch', state.learnEpoch);
            state.ctx.globalState.update('wiki', state.wiki);
        } catch (_) {}
    }, 2000);
}

function loadLearnData() {
    if (!state.ctx) return;
    const raw = state.ctx.globalState.get('learnData', {});
    state.learnEpoch   = state.ctx.globalState.get('learnEpoch', 0);
    state.userWhitelist = cfg('terminalWhitelist', []);
    state.userBlacklist = cfg('terminalBlacklist', []);

    state.learnData = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v.conf === 'number') {
            state.learnData[k] = v;
        } else if (typeof v.approves === 'number') {
            const total = (v.approves || 0) + (v.rejects || 0);
            const ratio = total > 0 ? (v.approves || 0) / total : 0.5;
            state.learnData[k] = {
                conf: (ratio - 0.5) * 2,
                velocity: 0, obs: total, rewards: [],
                history: [{ t: v.lastSeen || Date.now(), c: (ratio - 0.5) * 2 }],
                contexts: {}, lastSeen: v.lastSeen || Date.now(),
                promoted: false, demoted: false,
            };
        }
    }

    applyDecay();
    generalizePatterns();
    pruneEntries();
    loadWiki();
    saveLearnData();
}

async function suggestPromotion(cmd, data) {
    const confPct = Math.round(data.conf * 100);
    const msg = `[Grav] \ud83e\udde0 "${cmd}" confidence ${confPct}% sau ${data.obs} observations. Th\u00eam v\u00e0o whitelist?`;
    const pick = await vscode.window.showInformationMessage(msg, 'Th\u00eam', 'B\u1ecf qua', 'Blacklist');
    if (pick === 'Th\u00eam') {
        state.userWhitelist.push(cmd);
        await vscode.workspace.getConfiguration('grav').update('terminalWhitelist', state.userWhitelist, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`[Grav] \u2713 "${cmd}" \u2192 whitelist (conf: ${confPct}%)`);
        return 'whitelist';
    } else if (pick === 'Blacklist') {
        state.userBlacklist.push(cmd);
        await vscode.workspace.getConfiguration('grav').update('terminalBlacklist', state.userBlacklist, vscode.ConfigurationTarget.Global);
        return 'blacklist';
    } else {
        data.promoted = false;
        return 'skip';
    }
}

async function suggestDemotion(cmd, data) {
    const confPct = Math.round(data.conf * 100);
    const msg = `[Grav] \u26a0\ufe0f "${cmd}" confidence ${confPct}% \u2014 th\u01b0\u1eddng b\u1ecb reject. Th\u00eam v\u00e0o blacklist?`;
    const pick = await vscode.window.showWarningMessage(msg, 'Blacklist', 'B\u1ecf qua');
    if (pick === 'Blacklist') {
        state.userBlacklist.push(cmd);
        await vscode.workspace.getConfiguration('grav').update('terminalBlacklist', state.userBlacklist, vscode.ConfigurationTarget.Global);
        return 'blacklist';
    } else {
        data.demoted = false;
        return 'skip';
    }
}

function getLearnStats() {
    const entries = Object.entries(state.learnData)
        .sort((a, b) => b[1].obs - a[1].obs)
        .slice(0, 30);
    return {
        epoch: state.learnEpoch,
        totalTracked: Object.keys(state.learnData).length,
        promoted: getPromotedCommands().length,
        patterns: state.patternCache.length,
        commands: entries.map(([cmd, d]) => ({
            cmd,
            conf: Math.round(d.conf * 100) / 100,
            velocity: Math.round(d.velocity * 1000) / 1000,
            obs: d.obs,
            status: d.conf >= LEARN.PROMOTE_THRESH && d.obs >= LEARN.OBSERVE_MIN ? 'promoted' :
                    d.conf <= LEARN.DEMOTE_THRESH && d.obs >= LEARN.OBSERVE_MIN ? 'demoted' :
                    d.obs < LEARN.OBSERVE_MIN ? 'observing' :
                    d.conf > 0.3 ? 'learning' :
                    d.conf < -0.3 ? 'suspicious' : 'neutral',
            history: (d.history || []).map(h => ({ t: h.t, c: Math.round(h.c * 100) / 100 })),
            topContext: getTopContext(d.contexts),
            lastSeen: new Date(d.lastSeen).toLocaleDateString(),
        })),
        hyperparams: { ...LEARN },
    };
}

function getTopContext(contexts) {
    if (!contexts) return '';
    const entries = Object.entries(contexts).sort((a, b) => b[1] - a[1]);
    return entries.length > 0 ? entries[0][0] : '';
}

module.exports = {
    classifyCommand, loadLearnData, recordCommandAction, saveLearnData,
    getPromotedCommands, generalizePatterns, getLearnStats,
    wikiQuery, wikiLint, loadWiki, createEmptyWiki,
    extractCommandsForLearning,
};
