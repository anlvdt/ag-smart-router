// ═══════════════════════════════════════════════════════════════
//  Grav v1.0.0 — Autopilot for Antigravity
//
//  Architecture:
//    Runtime (injected into workbench.html)
//      → Auto-approve buttons in main DOM
//      → Stick-to-bottom scroll
//      → Quota radar (detect exhaustion banners)
//      → Corrupt-banner suppression
//
//    Host (this file, runs in extension process)
//      → Accept loop via VS Code command API
//      → HTTP bridge for runtime ↔ host sync
//      → Safe terminal auto-approve (whitelist/blacklist)
//      → Dashboard (webview)
//      → AI Learning Engine (Karpathy-inspired)
//      → Language Server quota monitoring
//      → Win32 native button handler
// ═══════════════════════════════════════════════════════════════
const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const http   = require('http');
const { execSync, execFile } = require('child_process');

// ── Constants ────────────────────────────────────────────────
const TAG = { open: '<!-- GRAV-RUNTIME-START -->', close: '<!-- GRAV-RUNTIME-END -->' };
const LEGACY_TAGS = [
    ['<!-- AG-AUTOPILOT-START -->',          '<!-- AG-AUTOPILOT-END -->'],
    ['<!-- AG-AUTO-CLICK-SCROLL-START -->',  '<!-- AG-AUTO-CLICK-SCROLL-END -->'],
    ['<!-- AG-MODEL-SWITCH-START -->',       '<!-- AG-MODEL-SWITCH-END -->'],
    ['<!-- AG-TOOLKIT-START -->',            '<!-- AG-TOOLKIT-END -->'],
];
const LEGACY_SCRIPTS = ['ag-auto-script.js', 'ag-modelswitch-client.js'];
const RUNTIME_FILE   = 'grav-runtime.js';
const CONFIG_FILE    = 'grav-config.json';
const PORT_START     = 48787;
const PORT_END       = 48850;

const ACCEPT_CMDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion',
];

const SAFE_TERMINAL_CMDS = [
    'ls','dir','cat','echo','pwd','cd','mkdir','cp','mv','touch',
    'npm','npx','yarn','pnpm','bun','deno','node','python','python3','pip','pip3',
    'git','which','where','type','file','stat','readlink',
    'head','tail','wc','sort','uniq','diff','grep','find','xargs',
    'sed','awk','tr','cut','tee','date','whoami','id',
    'env','printenv','uname','hostname','df','du','free',
    'ps','top','htop','lsof','netstat','ss','ping','dig','nslookup','host',
    'cargo','rustc','go','java','javac','mvn','gradle',
    'docker','docker-compose','podman','kubectl','helm','terraform','ansible',
    'make','cmake','gcc','g++','clang',
    'jq','yq','base64','md5','sha256sum','openssl',
    'tar','zip','unzip','gzip','gunzip','bzip2','xz',
    'curl','wget','http','httpie',
    'brew','apt','apt-get','yum','dnf','pacman','snap',
    'sqlite3','psql','mysql','mongosh','redis-cli',
    'tsc','eslint','prettier','jest','vitest','mocha','playwright',
    'sass','postcss','webpack','vite','esbuild','rollup','turbo',
    'uvx','uv','pipx','poetry','pdm','ruff','black','mypy',
    'code','antigravity',
];

const DEFAULT_BLACKLIST = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf *',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'chmod -R 777 /',
    'wget|sh',
    'curl|sh',
    'curl|bash',
    'wget|bash',
    '> /dev/sda',
    'shutdown',
    'reboot',
    'init 0',
    'init 6',
    'kill -9 -1',
    'killall',
    'format c:',
];

// ── Adaptive Learning Constants (Karpathy-inspired) ─────────
// Inspired by Andrej Karpathy's principles:
//   1. RLVR: Verifiable rewards — command exit code = ground truth
//   2. Gradient descent: confidence updated via learning rate
//   3. Overfit→Regularize: memorize exact commands, then generalize patterns
//   4. "Become one with the data": rich context per observation
//   5. Decay + momentum: temporal awareness, recent data matters more
//   6. Loss visualization: track confidence trajectory over time
const LEARN = {
    ALPHA:           0.15,   // learning rate — how fast confidence moves per event
    MOMENTUM:        0.9,    // exponential moving average factor for smoothing
    GAMMA:           0.97,   // daily decay factor (like weight decay / regularization)
    PROMOTE_THRESH:  0.75,   // confidence threshold to auto-suggest whitelist
    DEMOTE_THRESH:  -0.50,   // confidence threshold to auto-suggest blacklist
    OBSERVE_MIN:     5,      // minimum observations before any suggestion (avoid overfitting)
    MAX_ENTRIES:     1000,   // max tracked commands
    MAX_HISTORY:     50,     // confidence history length per command (for visualization)
    CONTEXT_WEIGHT:  0.1,    // bonus/penalty weight for contextual signals
    GENERALIZE_MIN:  3,      // min commands in a cluster to generalize a pattern
    BATCH_SIZE:      10,     // process learning updates in mini-batches
};

// ── State ────────────────────────────────────────────────────
let _ctx          = null;
let _enabled      = true;
let _scrollOn     = true;
let _patterns     = [];
let _stats        = {};
let _log          = [];
let _totalClicks  = 0;
let _httpServer   = null;
let _httpPort     = 0;
let _acceptTimer  = null;
let _dashboard    = null;
let _lsPort       = 0;
let _lsCsrf       = '';
let _lsOk         = false;
let _lastQuotaMs  = 0;

// Adaptive learning state (Karpathy-inspired neural model)
let _learnData    = {};  // { cmdName: { conf, velocity, obs, rewards, history[], contexts{} } }
let _learnEpoch   = 0;   // global training step counter
let _userWhitelist = [];
let _userBlacklist = [];
let _patternCache  = []; // generalized patterns discovered from data

// ── Second Brain state (Karpathy LLM Wiki pattern) ──────────
// 3-layer architecture:
//   Layer 1: Raw events (_learnData) — immutable observations
//   Layer 2: Wiki (_wiki) — compiled, cross-referenced knowledge
//   Layer 3: Schema (LEARN constants) — rules for the system
let _wiki = {
    index: {},       // { cmdName: { page, links[], sources, confidence } }
    concepts: {},    // { conceptName: { description, commands[], evidence[], contradictions[] } }
    log: [],         // chronological activity log
    synthesis: {},   // high-level patterns: { patternName: { description, members[], strength } }
    contradictions: [], // detected contradictions between observations
    lastLint: 0,     // timestamp of last lint pass
};

// status bar items
let _sbMain, _sbClicks, _sbScroll;

// ═════════════════════════════════════════════════════════════
//  Utilities
// ═════════════════════════════════════════════════════════════
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function elevatedWrite(fp, content) {
    try { fs.writeFileSync(fp, content, 'utf8'); return; } catch (e) {
        if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    }
    const tmp = path.join(os.tmpdir(), 'grav-' + Date.now() + '.tmp');
    fs.writeFileSync(tmp, content, 'utf8');
    try {
        if (process.platform === 'darwin')
            execSync(`osascript -e 'do shell script "cp \\"${tmp}\\" \\"${fp}\\" && chmod 644 \\"${fp}\\"" with administrator privileges'`, { timeout: 30000 });
        else if (process.platform === 'linux')
            execSync(`pkexec bash -c "cp '${tmp}' '${fp}' && chmod 644 '${fp}'"`, { timeout: 30000 });
        else throw new Error('Permission denied — restart as admin');
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

function workbenchPath() {
    const root = vscode.env.appRoot;
    const candidates = [
        'out/vs/code/electron-sandbox/workbench/workbench.html',
        'out/vs/code/electron-browser/workbench/workbench.html',
        'out/vs/workbench/workbench.html',
        'out/vs/code/browser/workbench/workbench.html',
        'out/vs/code/electron-main/workbench/workbench.html',
    ];
    for (const c of candidates) {
        const p = path.join(root, c);
        if (fs.existsSync(p)) return p;
    }
    return deepFind(path.join(root, 'out'), 'workbench.html', 6);
}

function deepFind(dir, name, depth) {
    if (depth <= 0) return null;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const fp = path.join(dir, e.name);
            if (e.isFile() && e.name === name) return fp;
            if (e.isDirectory()) { const r = deepFind(fp, name, depth - 1); if (r) return r; }
        }
    } catch (_) {}
    return null;
}

function cfg(key, fallback) {
    return vscode.workspace.getConfiguration('grav').get(key, fallback);
}

// ═════════════════════════════════════════════════════════════
//  Runtime injection (Layer 0)
// ═════════════════════════════════════════════════════════════
function buildRuntime() {
    const dp = _ctx.globalState.get('disabledPatterns', []);
    const pats = cfg('approvePatterns', ['Run','Allow','Always Allow','Keep Waiting','Continue','Retry'])
        .filter(p => !dp.includes(p) && p !== 'Accept');
    let src = fs.readFileSync(path.join(_ctx.extensionPath, 'media', 'runtime.js'), 'utf8');
    src = src.replace(/\/\*\{\{PAUSE_MS\}\}\*\/\d+/,    String(cfg('scrollPauseMs', 7000)));
    src = src.replace(/\/\*\{\{SCROLL_MS\}\}\*\/\d+/,   String(cfg('scrollIntervalMs', 500)));
    src = src.replace(/\/\*\{\{APPROVE_MS\}\}\*\/\d+/,  String(cfg('approveIntervalMs', 1000)));
    src = src.replace(/\/\*\{\{PATTERNS\}\}\*\/\[.*?\]/, JSON.stringify(pats));
    src = src.replace(/\/\*\{\{ENABLED\}\}\*\/\w+/,     String(cfg('enabled', true)));
    return src;
}

function inject() {
    const wb = workbenchPath();
    if (!wb) { vscode.window.showErrorMessage('[Grav] workbench.html not found'); return false; }
    const dir = path.dirname(wb);
    try {
        let html = fs.readFileSync(wb, 'utf8');
        // strip legacy + own tags
        for (const [s, e] of [[TAG.open, TAG.close], ...LEGACY_TAGS])
            html = html.replace(new RegExp(esc(s) + '[\\s\\S]*?' + esc(e), 'g'), '');
        // remove legacy script files
        for (const f of [...LEGACY_SCRIPTS, RUNTIME_FILE]) {
            const p = path.join(dir, f);
            if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {}
        }
        // write runtime
        elevatedWrite(path.join(dir, RUNTIME_FILE), buildRuntime());
        html = html.replace('</html>',
            `\n${TAG.open}\n<script src="${RUNTIME_FILE}?v=${Date.now()}"></script>\n${TAG.close}\n</html>`);
        elevatedWrite(wb, html);
    } catch (e) { console.error('[Grav] inject:', e.message); return false; }
    return true;
}

function eject() {
    const wb = workbenchPath();
    if (!wb) return false;
    const dir = path.dirname(wb);
    try {
        let html = fs.readFileSync(wb, 'utf8');
        for (const [s, e] of [[TAG.open, TAG.close], ...LEGACY_TAGS])
            html = html.replace(new RegExp(esc(s) + '[\\s\\S]*?' + esc(e), 'g'), '');
        elevatedWrite(wb, html);
        for (const f of [...LEGACY_SCRIPTS, RUNTIME_FILE]) {
            const p = path.join(dir, f);
            if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {}
        }
        return true;
    } catch (e) { vscode.window.showErrorMessage('[Grav] eject failed: ' + e.message); return false; }
}

function isInjected() {
    try { const wb = workbenchPath(); return wb ? fs.readFileSync(wb, 'utf8').includes(TAG.open) : false; }
    catch (_) { return false; }
}

function patchChecksums() {
    try {
        let pjp = null;
        if (process.resourcesPath) {
            const c = path.join(process.resourcesPath, 'app', 'product.json');
            if (fs.existsSync(c)) pjp = c;
        }
        if (!pjp) {
            const wb = workbenchPath(); if (!wb) return;
            let d = path.dirname(wb);
            for (let i = 0; i < 8; i++) {
                const c = path.join(d, 'product.json');
                if (fs.existsSync(c)) { pjp = c; break; }
                d = path.dirname(d);
            }
        }
        if (!pjp) return;
        const pj = JSON.parse(fs.readFileSync(pjp, 'utf8'));
        if (!pj.checksums) return;
        const root = path.dirname(pjp), outDir = path.join(root, 'out');
        let dirty = false;
        for (const rp in pj.checksums) {
            const rel = rp.split('/').join(path.sep);
            let fp = path.join(outDir, rel);
            if (!fs.existsSync(fp)) fp = path.join(root, rel);
            if (!fs.existsSync(fp)) continue;
            const h = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('base64').replace(/=+$/, '');
            if (pj.checksums[rp] !== h) { pj.checksums[rp] = h; dirty = true; }
        }
        if (dirty) elevatedWrite(pjp, JSON.stringify(pj, null, '\t'));
    } catch (_) {}
}

function clearCodeCache() {
    try {
        const base = process.platform === 'win32'
            ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity')
            : process.platform === 'darwin'
                ? path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity')
                : path.join(os.homedir(), '.config', 'Antigravity');
        const d = path.join(base, 'Code Cache', 'js');
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
}

function writeRuntimeConfig() {
    try {
        const wb = workbenchPath(); if (!wb) return;
        const dp = _ctx.globalState.get('disabledPatterns', []);
        const pats = cfg('approvePatterns', ['Run','Allow','Always Allow','Keep Waiting','Continue','Retry'])
            .filter(p => !dp.includes(p) && p !== 'Accept');
        elevatedWrite(path.join(path.dirname(wb), CONFIG_FILE), JSON.stringify({
            enabled: cfg('enabled', true),
            patterns: pats,
            acceptInChatOnly: cfg('approvePatterns', []).includes('Accept') && !dp.includes('Accept'),
            pauseMs: cfg('scrollPauseMs', 7000),
            scrollMs: cfg('scrollIntervalMs', 500),
            approveMs: cfg('approveIntervalMs', 1000),
        }));
    } catch (_) {}
}

// ═════════════════════════════════════════════════════════════
//  Language Server — quota monitoring
// ═════════════════════════════════════════════════════════════
function discoverLS() {
    try {
        const cmd = process.platform === 'win32'
            ? 'wmic process where "name like \'%language_server%\'" get CommandLine /format:list 2>nul'
            : 'ps aux | grep language_server_macos | grep -v grep | grep -v enable_lsp';
        const out = execSync(cmd, { timeout: 5000 }).toString();
        if (!out) return false;
        const csrf = out.match(/--csrf_token\s+([a-f0-9-]+)/);
        if (!csrf) return false;
        _lsCsrf = csrf[1];
        const pid = out.match(/^\S+\s+(\d+)/m);
        if (!pid) return false;
        const portsCmd = process.platform === 'win32'
            ? 'netstat -ano | findstr ' + pid[1] + ' | findstr LISTENING'
            : 'lsof -p ' + pid[1] + ' -iTCP -sTCP:LISTEN -P -n 2>/dev/null';
        const portsOut = execSync(portsCmd, { timeout: 5000 }).toString();
        const ports = [...portsOut.matchAll(/127\.0\.0\.1:(\d+)/g)].map(m => parseInt(m[1]));
        for (const port of ports) {
            try {
                const ok = execSync(
                    `curl -sk --connect-timeout 2 -X POST -H "Content-Type: application/json" -H "X-Codeium-Csrf-Token: ${_lsCsrf}" -H "Connect-Protocol-Version: 1" "https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUnleashData" -d '{"wrapper_data":{}}'`,
                    { timeout: 5000 }
                ).toString();
                if (ok && ok.startsWith('{')) { _lsPort = port; _lsOk = true; return true; }
            } catch (_) {}
        }
    } catch (_) {}
    return false;
}

// ═════════════════════════════════════════════════════════════
//  Accept loop — fires VS Code commands
// ═════════════════════════════════════════════════════════════
function startAcceptLoop() {
    if (_acceptTimer) clearInterval(_acceptTimer);
    const ms = cfg('approveIntervalMs', 2000);
    _acceptTimer = setInterval(() => {
        if (!_enabled) return;
        for (const cmd of ACCEPT_CMDS) vscode.commands.executeCommand(cmd).catch(() => {});
    }, ms);
}

// ═════════════════════════════════════════════════════════════
//  Command analysis — parse compound commands
// ═════════════════════════════════════════════════════════════

/**
 * Extract individual command names from a compound command string.
 * Handles: pipes (|), chains (&&, ||, ;), subshells ($(...)), xargs, etc.
 */
function extractCommands(cmdLine) {
    if (!cmdLine || typeof cmdLine !== 'string') return [];
    // Split on shell operators: |, &&, ||, ;, &
    const parts = cmdLine.split(/\s*(?:\|\||&&|[|;&])\s*/);
    const cmds = [];
    for (const part of parts) {
        let p = part.trim();
        if (!p) continue;
        // Strip leading env vars (FOO=bar cmd), sudo, nohup, time, nice, etc.
        p = p.replace(/^(?:(?:sudo|nohup|time|nice|ionice|strace|ltrace|env)\s+)+/gi, '');
        p = p.replace(/^(?:\w+=\S+\s+)+/, '');
        // Strip subshell wrappers
        p = p.replace(/^\$\(\s*/, '').replace(/^\(\s*/, '').replace(/\)\s*$/, '');
        // Get the first word (the command name)
        const match = p.match(/^([^\s]+)/);
        if (match) {
            let cmd = match[1];
            // Strip path prefix: /usr/bin/git → git
            cmd = cmd.replace(/^.*[/\\]/, '');
            if (cmd) cmds.push(cmd.toLowerCase());
        }
    }
    return [...new Set(cmds)];
}

/**
 * Check if a full command line matches any blacklist pattern.
 */
function matchesBlacklist(cmdLine, blacklist) {
    const lower = cmdLine.toLowerCase().trim();
    for (const pattern of blacklist) {
        const p = pattern.toLowerCase().trim();
        if (!p) continue;
        // Exact substring match
        if (lower.includes(p)) return pattern;
        // Regex pattern (starts with /)
        if (p.startsWith('/') && p.endsWith('/')) {
            try {
                if (new RegExp(p.slice(1, -1), 'i').test(cmdLine)) return pattern;
            } catch (_) {}
        }
    }
    return null;
}

/**
 * Evaluate a command line against whitelist + blacklist + learned data.
 * Returns: { allowed: bool, reason: string, commands: string[], confidence: number }
 */
function evaluateCommand(cmdLine) {
    const blacklist = [...DEFAULT_BLACKLIST, ..._userBlacklist];
    const whitelist = [...SAFE_TERMINAL_CMDS, ..._userWhitelist];

    // 1. Blacklist = hard constraint (highest priority, like gradient clipping)
    const blocked = matchesBlacklist(cmdLine, blacklist);
    if (blocked) return { allowed: false, reason: `Blocked by blacklist: "${blocked}"`, commands: [], confidence: -1, wiki: null };

    // 2. Extract all commands from compound line
    const cmds = extractCommands(cmdLine);
    if (cmds.length === 0) return { allowed: false, reason: 'Could not parse command', commands: [], confidence: 0, wiki: null };

    // 3. Query the Second Brain wiki for compiled knowledge (not raw data)
    //    Like Karpathy's: "The LLM reads the index first to find relevant pages"
    const promotedCmds = getPromotedCommands();
    const fullWhitelist = [...whitelist, ...promotedCmds, ..._patternCache];
    const unknown = [];
    let minConf = 1.0;
    const wikiInsights = [];

    for (const cmd of cmds) {
        if (fullWhitelist.includes(cmd)) continue;

        // Query wiki for compiled knowledge about this command
        const wikiPage = wikiQuery(cmd);
        if (wikiPage) {
            wikiInsights.push({ cmd, riskLevel: wikiPage.riskLevel, summary: wikiPage.summary });
            // Wiki says it's safe and has enough evidence
            if (wikiPage.riskLevel === 'safe' && wikiPage.totalEvents >= LEARN.OBSERVE_MIN) {
                minConf = Math.min(minConf, wikiPage.confidence);
                continue;
            }
            // Wiki says caution — allow but with low confidence
            if (wikiPage.riskLevel === 'caution' && wikiPage.confidence > 0) {
                minConf = Math.min(minConf, wikiPage.confidence * 0.5);
                continue;
            }
        }

        // Fallback: check raw learnData
        const entry = _learnData[cmd];
        if (entry && entry.conf > 0) {
            minConf = Math.min(minConf, entry.conf);
            continue;
        }
        unknown.push(cmd);
    }

    if (unknown.length > 0) {
        return { allowed: false, reason: `Unknown commands: ${unknown.join(', ')}`, commands: cmds, confidence: 0, wiki: wikiInsights };
    }

    return { allowed: true, reason: 'All commands whitelisted', commands: cmds, confidence: minConf, wiki: wikiInsights };
}

/** Get commands that have been promoted by the learning system (confidence >= threshold) */
function getPromotedCommands() {
    return Object.entries(_learnData)
        .filter(([, d]) => d.conf >= LEARN.PROMOTE_THRESH && d.obs >= LEARN.OBSERVE_MIN)
        .map(([k]) => k);
}

// ═════════════════════════════════════════════════════════════
//  Karpathy-inspired Adaptive Learning Engine
//
//  Architecture mirrors neural network training:
//    - Each command = a "neuron" with a confidence weight
//    - User approve/reject = reward signal (RLVR: verifiable reward)
//    - Confidence update = gradient step with momentum
//    - Time decay = weight decay / regularization
//    - Context features = input features (time-of-day, project, exit code)
//    - Pattern generalization = learned representations
//    - Confidence history = loss curve for visualization
//
//  Training loop per event:
//    1. Observe (collect data point with context)
//    2. Compute reward (approve=+1, reject=-1, exit_code=0 → bonus)
//    3. Gradient step: conf += α * reward (with momentum)
//    4. Regularize: daily decay, prune low-confidence stale entries
//    5. Generalize: cluster similar commands into patterns
//    6. Suggest: promote/demote when confidence crosses threshold
// ═════════════════════════════════════════════════════════════

function loadLearnData() {
    if (!_ctx) return;
    const raw = _ctx.globalState.get('learnData', {});
    _learnEpoch   = _ctx.globalState.get('learnEpoch', 0);
    _userWhitelist = cfg('terminalWhitelist', []);
    _userBlacklist = cfg('terminalBlacklist', []);

    // Migrate old format (approves/rejects) → new format (conf/velocity/obs)
    _learnData = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v.conf === 'number') {
            _learnData[k] = v; // already new format
        } else if (typeof v.approves === 'number') {
            // Migration: convert old approve/reject counts to confidence
            const total = (v.approves || 0) + (v.rejects || 0);
            const ratio = total > 0 ? (v.approves || 0) / total : 0.5;
            _learnData[k] = {
                conf: (ratio - 0.5) * 2,  // map [0,1] → [-1,1]
                velocity: 0,
                obs: total,
                rewards: [],
                history: [{ t: v.lastSeen || Date.now(), c: (ratio - 0.5) * 2 }],
                contexts: {},
                lastSeen: v.lastSeen || Date.now(),
                promoted: false,
                demoted: false,
            };
        }
    }

    // Step 4: Regularize — time-based weight decay (like Karpathy's weight decay)
    applyDecay();

    // Step 5: Generalize — discover patterns from data
    generalizePatterns();

    // Prune to max entries (keep highest-observed, like keeping best checkpoints)
    pruneEntries();

    // Load Second Brain wiki
    loadWiki();

    saveLearnData();
}

/** Apply temporal decay — recent observations matter more (exponential decay) */
function applyDecay() {
    const now = Date.now();
    let changed = false;
    for (const [k, d] of Object.entries(_learnData)) {
        const daysSince = (now - d.lastSeen) / 86400000;
        if (daysSince > 1) {
            // Decay confidence toward 0 (neutral) — like weight decay toward origin
            const decayFactor = Math.pow(LEARN.GAMMA, daysSince);
            const oldConf = d.conf;
            d.conf *= decayFactor;
            d.velocity *= decayFactor;
            // If decayed to near-zero and few observations, prune
            if (Math.abs(d.conf) < 0.01 && d.obs < LEARN.OBSERVE_MIN && daysSince > 60) {
                delete _learnData[k];
            }
            if (d.conf !== oldConf) changed = true;
        }
    }
    return changed;
}

/** Prune to max entries — keep most valuable (highest |conf| × obs) */
function pruneEntries() {
    const keys = Object.keys(_learnData);
    if (keys.length <= LEARN.MAX_ENTRIES) return;
    // Score = |confidence| × log(observations+1) — like importance sampling
    const scored = keys.map(k => ({
        key: k,
        score: Math.abs(_learnData[k].conf) * Math.log(_learnData[k].obs + 1),
    }));
    scored.sort((a, b) => b.score - a.score);
    for (let i = LEARN.MAX_ENTRIES; i < scored.length; i++) {
        delete _learnData[scored[i].key];
    }
}

/**
 * Generalize — discover command patterns from data.
 * Enhanced: prefix groups, subcommand patterns, co-occurrence clusters.
 */
function generalizePatterns() {
    _patternCache = [];

    // Method 1: Prefix grouping (npm-*, docker-*, etc.)
    const groups = {};
    for (const [cmd, d] of Object.entries(_learnData)) {
        if (d.conf < 0.2 || d.obs < 2) continue;
        const prefix = cmd.replace(/[-_].*$/, '').replace(/\d+$/, '');
        if (prefix && prefix.length >= 2) {
            if (!groups[prefix]) groups[prefix] = [];
            groups[prefix].push(cmd);
        }
    }
    for (const [prefix, members] of Object.entries(groups)) {
        if (members.length >= LEARN.GENERALIZE_MIN && !SAFE_TERMINAL_CMDS.includes(prefix)) {
            _patternCache.push(prefix);
        }
    }

    // Method 2: Subcommand patterns — if "npm run build", "npm run test", "npm run dev"
    // all approved → generalize "npm" subcommands as safe
    const subCmdGroups = {};
    for (const [cmd, d] of Object.entries(_learnData)) {
        if (d.conf < 0.3) continue;
        // Check if this looks like a subcommand (contains spaces in original cmdLine)
        // We track base commands, so look for similar base commands with high confidence
        const concept = classifyCommand(cmd);
        if (concept) {
            if (!subCmdGroups[concept]) subCmdGroups[concept] = { safe: 0, total: 0 };
            subCmdGroups[concept].total++;
            if (d.conf > 0.5) subCmdGroups[concept].safe++;
        }
    }

    // Method 3: Co-occurrence clusters from sequences
    if (_wiki.sequences) {
        const coOccur = {};
        for (const [seq, count] of Object.entries(_wiki.sequences)) {
            if (count < 2) continue;
            const [a, b] = seq.split(' → ');
            if (a && b) {
                if (!coOccur[a]) coOccur[a] = new Set();
                if (!coOccur[b]) coOccur[b] = new Set();
                coOccur[a].add(b);
                coOccur[b].add(a);
            }
        }
        // Commands that frequently co-occur with trusted commands get a boost
        for (const [cmd, peers] of Object.entries(coOccur)) {
            if (_learnData[cmd] && _learnData[cmd].conf < 0.3) {
                const trustedPeers = [...peers].filter(p => _learnData[p]?.conf > 0.5);
                if (trustedPeers.length >= 2) {
                    // Boost confidence slightly — "guilt by association" (positive)
                    _learnData[cmd].conf = Math.min(1, _learnData[cmd].conf + 0.05);
                }
            }
        }
    }
}

/**
 * Core learning function — process a single training example.
 *
 * Mirrors Karpathy's training loop:
 *   reward = verifiable signal (approve/reject + exit code)
 *   gradient = α * reward
 *   velocity = momentum * velocity + gradient  (SGD with momentum)
 *   confidence += velocity
 *   confidence = clamp(confidence, -1, 1)
 *
 * @param {string} cmdLine - full command line
 * @param {string} action - 'approve' | 'reject'
 * @param {object} context - { exitCode, project, timeOfDay, duration }
 */
function recordCommandAction(cmdLine, action, context = {}) {
    if (!cfg('learnEnabled', true)) return;

    const cmds = extractCommands(cmdLine);
    const now = Date.now();
    _learnEpoch++;

    for (const cmd of cmds) {
        // Initialize new entry (like weight initialization — start at 0, neutral)
        if (!_learnData[cmd]) {
            _learnData[cmd] = {
                conf: 0,          // confidence weight ∈ [-1, 1]
                velocity: 0,      // momentum term
                obs: 0,           // total observations
                rewards: [],      // recent reward history (mini-batch)
                history: [],      // confidence trajectory (for loss curve visualization)
                contexts: {},     // contextual features
                lastSeen: now,
                promoted: false,  // already suggested for whitelist?
                demoted: false,   // already suggested for blacklist?
            };
        }

        const d = _learnData[cmd];
        d.obs++;
        d.lastSeen = now;

        // Step 1: Compute reward (RLVR — verifiable reward signal)
        let reward = action === 'approve' ? 1.0 : -1.0;

        // Contextual reward modifiers (like input features)
        if (context.exitCode !== undefined) {
            if (context.exitCode === 0 && action === 'approve') {
                reward += LEARN.CONTEXT_WEIGHT;  // verified success = bonus reward
            } else if (context.exitCode !== 0 && action === 'approve') {
                reward -= LEARN.CONTEXT_WEIGHT;  // approved but failed = slight penalty
            }
        }

        // Time-of-day context (track when user uses this command)
        const hour = new Date().getHours();
        const timeSlot = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
        d.contexts[timeSlot] = (d.contexts[timeSlot] || 0) + 1;

        // Project context
        if (context.project) {
            const projKey = 'proj:' + context.project;
            d.contexts[projKey] = (d.contexts[projKey] || 0) + 1;
        }

        // Step 2: Store reward in mini-batch
        d.rewards.push(reward);
        if (d.rewards.length > LEARN.BATCH_SIZE) d.rewards.shift();

        // Step 3: Gradient step with momentum (SGD + momentum)
        // Average reward over mini-batch (reduces variance, like mini-batch SGD)
        const batchReward = d.rewards.reduce((a, b) => a + b, 0) / d.rewards.length;
        const gradient = LEARN.ALPHA * batchReward;
        d.velocity = LEARN.MOMENTUM * d.velocity + gradient;
        d.conf = Math.max(-1, Math.min(1, d.conf + d.velocity * (1 - LEARN.MOMENTUM)));

        // Step 4: Record confidence history (loss curve)
        d.history.push({ t: now, c: d.conf, r: reward, e: _learnEpoch });
        if (d.history.length > LEARN.MAX_HISTORY) d.history.shift();

        // Step 6: Suggest promotion/demotion when crossing threshold
        if (d.obs >= LEARN.OBSERVE_MIN) {
            if (d.conf >= LEARN.PROMOTE_THRESH && !d.promoted
                && !SAFE_TERMINAL_CMDS.includes(cmd) && !_userWhitelist.includes(cmd)) {
                d.promoted = true;
                suggestPromotion(cmd, d);
            }
            if (d.conf <= LEARN.DEMOTE_THRESH && !d.demoted
                && !_userBlacklist.includes(cmd)) {
                d.demoted = true;
                suggestDemotion(cmd, d);
            }
        }
    }

    // Periodically re-generalize patterns (every 20 epochs)
    if (_learnEpoch % 20 === 0) generalizePatterns();

    // Second Brain: ingest each command event into the wiki
    for (const cmd of cmds) {
        wikiIngest(cmd, action, _learnData[cmd], context);
    }

    saveLearnData();
}

function saveLearnData() {
    if (!_ctx) return;
    // Throttle saves — max once per 2 seconds to avoid settings API timeout
    if (saveLearnData._pending) return;
    saveLearnData._pending = true;
    setTimeout(() => {
        saveLearnData._pending = false;
        try {
            _ctx.globalState.update('learnData', _learnData);
            _ctx.globalState.update('learnEpoch', _learnEpoch);
            _ctx.globalState.update('wiki', _wiki);
        } catch (_) {}
    }, 2000);
}

// ═════════════════════════════════════════════════════════════
//  Second Brain — Karpathy LLM Wiki Pattern
//
//  "Instead of re-deriving knowledge on every query, the LLM
//   incrementally builds and maintains a persistent wiki."
//
//  Architecture:
//    Layer 1 (Raw): _learnData — individual command observations
//    Layer 2 (Wiki): _wiki — compiled knowledge pages
//    Layer 3 (Schema): LEARN constants — system rules
//
//  Operations:
//    Ingest: new event → update wiki pages, cross-references
//    Query: evaluateCommand reads wiki, not raw data
//    Lint: periodic health check, find contradictions/orphans
// ═════════════════════════════════════════════════════════════

function loadWiki() {
    if (!_ctx) return;
    const saved = _ctx.globalState.get('wiki', null);
    if (saved && saved.index) {
        _wiki = saved;
    } else {
        // Initialize empty wiki
        _wiki = {
            index: {},
            concepts: {},
            log: [],
            synthesis: {},
            contradictions: [],
            lastLint: 0,
        };
    }
}

/**
 * INGEST — Core wiki operation.
 * When a new command event arrives, compile it into the wiki.
 * Like Karpathy's ingest: "A single source might touch 10-15 wiki pages."
 *
 * @param {string} cmd - command name
 * @param {string} action - 'approve' | 'reject'
 * @param {object} data - the learnData entry for this command
 * @param {object} context - contextual signals
 */
function wikiIngest(cmd, action, data, context) {
    const now = Date.now();

    // 1. Update or create the command's index page
    if (!_wiki.index[cmd]) {
        _wiki.index[cmd] = {
            firstSeen: now,
            lastUpdated: now,
            totalEvents: 0,
            approves: 0,
            rejects: 0,
            confidence: 0,
            links: [],        // cross-references to related commands
            sources: [],      // raw event timestamps (last 20)
            tags: [],         // auto-generated tags
            summary: '',      // compiled summary
            riskLevel: 'unknown', // unknown → safe → caution → danger
        };
    }
    const page = _wiki.index[cmd];
    page.lastUpdated = now;
    page.totalEvents++;
    if (action === 'approve') page.approves++;
    else page.rejects++;
    page.confidence = data.conf;
    page.sources.push(now);
    if (page.sources.length > 20) page.sources.shift();

    // 2. Compile summary — enhanced with recency weighting and concept context
    const ratio = page.totalEvents > 0 ? page.approves / page.totalEvents : 0;
    const recency = Math.min(1, (Date.now() - page.firstSeen) / (7 * 86400000)); // 0-1 over first week
    const dataMaturity = Math.min(1, page.totalEvents / 20); // 0-1 over first 20 events

    // Weighted risk: combine ratio, confidence, and data maturity
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

    // 3. Update concept pages — group by semantic category
    const concept = classifyCommand(cmd);
    if (concept) {
        if (!_wiki.concepts[concept]) {
            _wiki.concepts[concept] = {
                description: '',
                commands: [],
                evidence: [],
                avgConfidence: 0,
                riskLevel: 'unknown',
            };
        }
        const cp = _wiki.concepts[concept];
        if (!cp.commands.includes(cmd)) cp.commands.push(cmd);
        cp.evidence.push({ cmd, action, time: now, conf: data.conf });
        if (cp.evidence.length > 50) cp.evidence.shift();

        // Recompile concept summary
        const confs = cp.commands.map(c => _wiki.index[c]?.confidence || 0);
        cp.avgConfidence = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
        cp.riskLevel = cp.avgConfidence >= 0.5 ? 'safe' : cp.avgConfidence >= 0 ? 'caution' : 'danger';
        cp.description = `${cp.commands.length} commands in this category. Avg confidence: ${Math.round(cp.avgConfidence * 100)}%. Risk: ${cp.riskLevel}.`;
    }

    // 4. Build cross-references (like wiki backlinks)
    // Enhanced: link by project, by time proximity, and by sequence
    if (context.project) {
        if (!page.tags.includes('proj:' + context.project)) {
            page.tags.push('proj:' + context.project);
        }
        const projectCmds = Object.entries(_wiki.index)
            .filter(([k, v]) => k !== cmd && v.tags.includes('proj:' + context.project))
            .map(([k]) => k);
        for (const related of projectCmds.slice(0, 5)) {
            if (!page.links.includes(related)) page.links.push(related);
            const relPage = _wiki.index[related];
            if (relPage && !relPage.links.includes(cmd)) relPage.links.push(cmd);
        }
    }

    // Sequence learning: link to the previous command (temporal proximity)
    // If user runs A then B, they're likely related
    if (!_wiki._lastCmd) _wiki._lastCmd = { cmd: null, time: 0 };
    if (_wiki._lastCmd.cmd && _wiki._lastCmd.cmd !== cmd && (now - _wiki._lastCmd.time) < 30000) {
        const prevCmd = _wiki._lastCmd.cmd;
        if (!page.links.includes(prevCmd)) page.links.push(prevCmd);
        const prevPage = _wiki.index[prevCmd];
        if (prevPage && !prevPage.links.includes(cmd)) prevPage.links.push(cmd);

        // Track command sequences for pattern discovery
        if (!_wiki.sequences) _wiki.sequences = {};
        const seqKey = prevCmd + ' → ' + cmd;
        _wiki.sequences[seqKey] = (_wiki.sequences[seqKey] || 0) + 1;
    }
    _wiki._lastCmd = { cmd, time: now };

    // Similar command inference: share knowledge between python/python3, node/node18, etc.
    const similar = findSimilarCommands(cmd);
    for (const sim of similar) {
        if (!page.links.includes(sim)) page.links.push(sim);
        const simPage = _wiki.index[sim];
        if (simPage && !simPage.links.includes(cmd)) simPage.links.push(cmd);
    }

    // Trim links to prevent unbounded growth
    if (page.links.length > 20) {
        // Keep links with highest confidence
        page.links = page.links
            .map(l => ({ cmd: l, conf: Math.abs(_wiki.index[l]?.confidence || 0) }))
            .sort((a, b) => b.conf - a.conf)
            .slice(0, 15)
            .map(l => l.cmd);
    }

    // 5. Detect contradictions
    detectContradictions(cmd, action, data);

    // 6. Update synthesis — throttled (every 5 events instead of every event)
    if (_learnEpoch % 5 === 0) updateSynthesis();

    // 7. Append to activity log
    const ts = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
    _wiki.log.push({
        time: ts,
        op: 'ingest',
        cmd,
        action,
        conf: Math.round(data.conf * 100) / 100,
        concept: concept || '-',
    });
    if (_wiki.log.length > 200) _wiki.log = _wiki.log.slice(-200);

    // 8. Periodic lint (every 50 events, like Karpathy's "lint the wiki")
    if (_learnEpoch % 50 === 0 && now - _wiki.lastLint > 300000) {
        wikiLint();
    }
}

/**
 * Classify a command into a semantic concept category.
 * Enhanced: fuzzy matching for versioned commands, scripts, paths.
 */
function classifyCommand(cmd) {
    const categories = {
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

    // Exact match first
    for (const [concept, cmds] of Object.entries(categories)) {
        if (cmds.includes(cmd)) return concept;
    }

    // Fuzzy match: strip version numbers (python3.11 → python3, node18 → node)
    const stripped = cmd.replace(/[\d.]+$/, '');
    if (stripped !== cmd && stripped.length >= 2) {
        for (const [concept, cmds] of Object.entries(categories)) {
            if (cmds.includes(stripped)) return concept;
        }
    }

    // Script detection: *.sh, *.py, *.js, *.ts
    if (/\.(sh|bash|zsh)$/i.test(cmd)) return 'shell-script';
    if (/\.(py|pyw)$/i.test(cmd)) return 'language-runtime';
    if (/\.(js|ts|mjs|cjs)$/i.test(cmd)) return 'language-runtime';
    if (/\.(rb|pl|php|lua)$/i.test(cmd)) return 'language-runtime';

    // Path-based detection: ./something or /usr/bin/something
    if (cmd.startsWith('./') || cmd.startsWith('/')) {
        if (/dev|start|run|build|test|deploy|serve/i.test(cmd)) return 'shell-script';
    }

    return null;
}

/**
 * Find commands similar to the given one.
 * Enables knowledge sharing: python ↔ python3, node ↔ node18, etc.
 */
function findSimilarCommands(cmd) {
    const similar = [];
    const allCmds = Object.keys(_wiki.index);

    // Strip version: python3 → python, node18 → node
    const base = cmd.replace(/[\d.]+$/, '');
    if (base !== cmd && base.length >= 2) {
        for (const other of allCmds) {
            if (other !== cmd && other.startsWith(base)) similar.push(other);
        }
    }
    // Reverse: python → python3
    for (const other of allCmds) {
        if (other !== cmd && other.replace(/[\d.]+$/, '') === cmd) similar.push(other);
    }

    // Same concept category
    const myConcept = classifyCommand(cmd);
    if (myConcept) {
        const cp = _wiki.concepts[myConcept];
        if (cp) {
            for (const other of cp.commands) {
                if (other !== cmd && !similar.includes(other)) similar.push(other);
            }
        }
    }

    return similar.slice(0, 5);
}

/**
 * Detect contradictions — when a command's behavior changes unexpectedly.
 * Enhanced: lower thresholds, velocity-based detection, concept-level contradictions.
 */
function detectContradictions(cmd, action, data) {
    const page = _wiki.index[cmd];
    if (!page || page.totalEvents < 3) return;

    const ratio = page.approves / page.totalEvents;

    // Type 1: Behavior shift — trusted command suddenly rejected
    if (action === 'reject' && ratio > 0.7 && page.totalEvents >= 5) {
        addContradiction('behavior-shift', cmd,
            `"${cmd}" was trusted (${Math.round(ratio * 100)}% approve) but just got rejected.`,
            `${cmd} is safe (conf: ${Math.round(page.confidence * 100)}%)`,
            `Rejected at epoch ${_learnEpoch}`);
    }

    // Type 2: Rehabilitation — distrusted command suddenly approved
    if (action === 'approve' && ratio < 0.4 && page.totalEvents >= 5) {
        addContradiction('rehabilitation', cmd,
            `"${cmd}" was distrusted (${Math.round(ratio * 100)}% approve) but just got approved.`,
            `${cmd} is suspicious`,
            `Approved at epoch ${_learnEpoch}`);
    }

    // Type 3: Velocity reversal — confidence was climbing but suddenly drops (or vice versa)
    if (data.history && data.history.length >= 3) {
        const recent = data.history.slice(-3);
        const prevDir = recent[1].c - recent[0].c; // was going up or down?
        const currDir = recent[2].c - recent[1].c; // now going?
        if (Math.abs(prevDir) > 0.1 && Math.abs(currDir) > 0.1 && Math.sign(prevDir) !== Math.sign(currDir)) {
            addContradiction('velocity-reversal', cmd,
                `"${cmd}" confidence reversed direction: was ${prevDir > 0 ? 'rising' : 'falling'}, now ${currDir > 0 ? 'rising' : 'falling'}.`,
                `Trend was ${prevDir > 0 ? 'positive' : 'negative'}`,
                `Reversed at epoch ${_learnEpoch}, conf: ${Math.round(data.conf * 100)}%`);
        }
    }

    // Type 4: Exit code contradiction — command approved but consistently fails
    if (action === 'approve' && data.rewards && data.rewards.length >= 3) {
        const recentRewards = data.rewards.slice(-3);
        const allNegContext = recentRewards.every(r => r < 1.0 && r > 0); // approved but with penalty (exit ≠ 0)
        if (allNegContext && page.riskLevel === 'safe') {
            addContradiction('exit-code-mismatch', cmd,
                `"${cmd}" is marked safe but last 3 executions had non-zero exit codes.`,
                `${cmd} is safe`,
                `Consistently failing despite approval`);
        }
    }

    // Type 5: Concept-level contradiction — command disagrees with its category
    const concept = classifyCommand(cmd);
    if (concept && _wiki.concepts[concept]) {
        const cp = _wiki.concepts[concept];
        if (cp.avgConfidence > 0.5 && data.conf < -0.2) {
            addContradiction('concept-outlier', cmd,
                `"${cmd}" (conf: ${Math.round(data.conf * 100)}%) is an outlier in "${concept}" (avg: ${Math.round(cp.avgConfidence * 100)}%).`,
                `${concept} category is generally safe`,
                `${cmd} is significantly below category average`);
        }
    }
}

function addContradiction(type, cmd, detail, oldClaim, newEvidence) {
    // Dedup: don't add same type+cmd within 5 minutes
    const recent = _wiki.contradictions.find(c =>
        c.cmd === cmd && c.type === type && !c.resolved && (Date.now() - c.time) < 300000);
    if (recent) return;

    _wiki.contradictions.push({
        time: Date.now(),
        type,
        cmd,
        detail,
        oldClaim,
        newEvidence,
        resolved: false,
    });
    if (_wiki.contradictions.length > 100) {
        // Keep unresolved ones, prune oldest resolved
        const unresolved = _wiki.contradictions.filter(c => !c.resolved);
        const resolved = _wiki.contradictions.filter(c => c.resolved).slice(-20);
        _wiki.contradictions = [...resolved, ...unresolved];
    }
}

/**
 * Update synthesis — discover high-level patterns across the wiki.
 * Enhanced: command sequences, risk trends, project profiles.
 */
function updateSynthesis() {
    // 1. Peak activity time
    const timeSlots = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const [, d] of Object.entries(_learnData)) {
        for (const [slot, count] of Object.entries(d.contexts || {})) {
            if (timeSlots[slot] !== undefined) timeSlots[slot] += count;
        }
    }
    const peakTime = Object.entries(timeSlots).sort((a, b) => b[1] - a[1])[0];
    _wiki.synthesis['peak-activity'] = {
        description: `Most active: ${peakTime[0]} (${peakTime[1]} events)`,
        members: Object.keys(timeSlots),
        strength: peakTime[1],
    };

    // 2. Trusted categories ranking
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

    // 3. Learning health
    const totalObs = Object.values(_learnData).reduce((a, d) => a + d.obs, 0);
    const avgConf = Object.values(_learnData).length > 0
        ? Object.values(_learnData).reduce((a, d) => a + d.conf, 0) / Object.values(_learnData).length : 0;
    _wiki.synthesis['learning-health'] = {
        description: `Epoch ${_learnEpoch}: ${Object.keys(_learnData).length} cmds, ${totalObs} obs, avg conf ${Math.round(avgConf * 100)}%`,
        members: [],
        strength: avgConf,
    };

    // 4. Top command sequences (new — Karpathy's "associative trails")
    if (_wiki.sequences) {
        const topSeqs = Object.entries(_wiki.sequences)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        if (topSeqs.length > 0) {
            _wiki.synthesis['common-sequences'] = {
                description: topSeqs.map(([seq, n]) => `${seq} (×${n})`).join(', '),
                members: topSeqs.map(([seq]) => seq),
                strength: topSeqs[0][1],
            };
        }
    }

    // 5. Risk trend — is the system getting safer or riskier over time?
    const recentHistory = [];
    for (const [, d] of Object.entries(_learnData)) {
        if (d.history && d.history.length >= 2) {
            const last = d.history[d.history.length - 1];
            const prev = d.history[Math.max(0, d.history.length - 5)];
            recentHistory.push(last.c - prev.c); // positive = improving
        }
    }
    if (recentHistory.length > 0) {
        const avgTrend = recentHistory.reduce((a, b) => a + b, 0) / recentHistory.length;
        _wiki.synthesis['risk-trend'] = {
            description: avgTrend > 0.05 ? 'Improving — confidence rising across commands' :
                         avgTrend < -0.05 ? 'Degrading — confidence falling, review needed' :
                         'Stable — no significant changes',
            members: [],
            strength: avgTrend,
        };
    }

    // 6. Project profiles — which projects use which commands
    const projects = {};
    for (const [cmd, d] of Object.entries(_learnData)) {
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
        _wiki.synthesis['project-profiles'] = {
            description: projEntries.map(([p, cmds]) => `${p}: ${cmds.length} cmds`).join(', '),
            members: projEntries.map(([p]) => p),
            strength: projEntries[0][1].length,
        };
    }
}

/**
 * LINT — Periodic wiki health check.
 * Like Karpathy's: "Look for contradictions, stale claims, orphan pages,
 * missing cross-references, data gaps."
 */
function wikiLint() {
    _wiki.lastLint = Date.now();
    const issues = [];

    // 1. Find orphan pages (commands with no cross-references)
    const orphans = Object.entries(_wiki.index)
        .filter(([, p]) => p.links.length === 0 && p.totalEvents >= 3)
        .map(([k]) => k);
    if (orphans.length > 0) {
        issues.push({ type: 'orphans', detail: `${orphans.length} commands with no cross-references`, items: orphans.slice(0, 10) });
    }

    // 2. Find stale pages (not seen in 14+ days with low confidence)
    const staleThreshold = Date.now() - 14 * 86400000;
    const stale = Object.entries(_wiki.index)
        .filter(([, p]) => p.lastUpdated < staleThreshold && Math.abs(p.confidence) < 0.3)
        .map(([k]) => k);
    if (stale.length > 0) {
        issues.push({ type: 'stale', detail: `${stale.length} stale commands (>14 days, low confidence)`, items: stale.slice(0, 10) });
    }

    // 3. Find unresolved contradictions
    const unresolved = _wiki.contradictions.filter(c => !c.resolved);
    if (unresolved.length > 0) {
        issues.push({ type: 'contradictions', detail: `${unresolved.length} unresolved contradictions`, items: unresolved.slice(0, 5).map(c => c.detail) });
    }

    // 4. Find concepts with too few members (under-represented categories)
    const thinConcepts = Object.entries(_wiki.concepts)
        .filter(([, c]) => c.commands.length === 1)
        .map(([k]) => k);
    if (thinConcepts.length > 0) {
        issues.push({ type: 'thin-concepts', detail: `${thinConcepts.length} concepts with only 1 command`, items: thinConcepts });
    }

    // 5. Find commands tracked but not in any concept (missing classification)
    const unclassified = Object.keys(_wiki.index).filter(cmd => {
        return !Object.values(_wiki.concepts).some(c => c.commands.includes(cmd));
    });
    if (unclassified.length > 0) {
        issues.push({ type: 'unclassified', detail: `${unclassified.length} commands not in any concept category`, items: unclassified.slice(0, 10) });
    }

    // Auto-resolve old contradictions (>7 days)
    const resolveThreshold = Date.now() - 7 * 86400000;
    for (const c of _wiki.contradictions) {
        if (!c.resolved && c.time < resolveThreshold) c.resolved = true;
    }

    // Log lint results
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    _wiki.log.push({
        time: ts,
        op: 'lint',
        issues: issues.length,
        detail: issues.map(i => i.type + ':' + i.items.length).join(', ') || 'clean',
    });

    return issues;
}

/**
 * QUERY — Read the wiki to answer questions about a command.
 * Like Karpathy's: "The LLM reads the index first to find relevant pages."
 * Returns compiled knowledge instead of raw data.
 */
function wikiQuery(cmd) {
    const page = _wiki.index[cmd];
    if (!page) return null;

    // Find related commands via cross-references (associative trails)
    const related = page.links
        .map(link => ({ cmd: link, conf: _wiki.index[link]?.confidence || 0 }))
        .sort((a, b) => b.conf - a.conf);

    // Find concept
    const concept = Object.entries(_wiki.concepts)
        .find(([, c]) => c.commands.includes(cmd));

    // Find relevant contradictions
    const contradictions = _wiki.contradictions
        .filter(c => c.cmd === cmd && !c.resolved);

    return {
        ...page,
        related,
        concept: concept ? { name: concept[0], ...concept[1] } : null,
        contradictions,
        synthesis: Object.values(_wiki.synthesis),
    };
}

async function suggestPromotion(cmd, data) {
    const confPct = Math.round(data.conf * 100);
    const msg = `[Grav] 🧠 "${cmd}" confidence ${confPct}% sau ${data.obs} observations. Thêm vào whitelist?`;
    const pick = await vscode.window.showInformationMessage(msg, 'Thêm', 'Bỏ qua', 'Blacklist');
    if (pick === 'Thêm') {
        _userWhitelist.push(cmd);
        await vscode.workspace.getConfiguration('grav').update('terminalWhitelist', _userWhitelist, vscode.ConfigurationTarget.Global);
        setupSafeApprove();
        vscode.window.showInformationMessage(`[Grav] ✓ "${cmd}" → whitelist (conf: ${confPct}%)`);
    } else if (pick === 'Blacklist') {
        _userBlacklist.push(cmd);
        await vscode.workspace.getConfiguration('grav').update('terminalBlacklist', _userBlacklist, vscode.ConfigurationTarget.Global);
        setupSafeApprove();
    } else {
        data.promoted = false; // allow re-suggestion later
    }
}

async function suggestDemotion(cmd, data) {
    const confPct = Math.round(data.conf * 100);
    const msg = `[Grav] ⚠️ "${cmd}" confidence ${confPct}% — thường bị reject. Thêm vào blacklist?`;
    const pick = await vscode.window.showWarningMessage(msg, 'Blacklist', 'Bỏ qua');
    if (pick === 'Blacklist') {
        _userBlacklist.push(cmd);
        await vscode.workspace.getConfiguration('grav').update('terminalBlacklist', _userBlacklist, vscode.ConfigurationTarget.Global);
        setupSafeApprove();
    } else {
        data.demoted = false;
    }
}

/**
 * Get learning stats for dashboard — like Karpathy's "visualize everything" principle.
 * Returns training metrics: confidence, velocity, observation count, trajectory, status.
 */
function getLearnStats() {
    const entries = Object.entries(_learnData)
        .sort((a, b) => b[1].obs - a[1].obs)
        .slice(0, 30);
    return {
        epoch: _learnEpoch,
        totalTracked: Object.keys(_learnData).length,
        promoted: getPromotedCommands().length,
        patterns: _patternCache.length,
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

// ═════════════════════════════════════════════════════════════
//  Safe terminal auto-approve (enhanced with whitelist/blacklist + learning)
// ═════════════════════════════════════════════════════════════
function setupSafeApprove() {
    // Delay to avoid timeout during IDE startup — settings API can be slow
    setTimeout(() => {
        try {
            const c = vscode.workspace.getConfiguration();
            const rules = c.get('chat.tools.terminal.autoApprove') || {};
            const allWhitelist = [...SAFE_TERMINAL_CMDS, ..._userWhitelist];
            const promoted = getPromotedCommands();
            for (const cmd of promoted) {
                if (!allWhitelist.includes(cmd)) allWhitelist.push(cmd);
            }
            for (const pat of _patternCache) {
                if (!allWhitelist.includes(pat)) allWhitelist.push(pat);
            }
            for (const cmd of allWhitelist) {
                if (!_userBlacklist.includes(cmd)) rules[cmd] = true;
            }
            for (const cmd of _userBlacklist) delete rules[cmd];
            delete rules['/^/'];
            delete rules['/.*/s'];

            // Sequential updates with catch — prevents timeout cascade
            c.update('chat.tools.terminal.autoApprove', rules, vscode.ConfigurationTarget.Global)
                .then(() => c.update('chat.tools.terminal.enableAutoApprove', true, vscode.ConfigurationTarget.Global))
                .then(() => c.update('chat.tools.terminal.ignoreDefaultAutoApproveRules', false, vscode.ConfigurationTarget.Global))
                .then(() => c.update('chat.tools.terminal.autoReplyToPrompts', true, vscode.ConfigurationTarget.Global))
                .then(() => c.update('chat.tools.edits.autoApprove', true, vscode.ConfigurationTarget.Global))
                .then(() => c.update('chat.agent.terminal.autoApprove', true, vscode.ConfigurationTarget.Global))
                .catch(() => {});
        } catch (_) {}
    }, 3000);
}

// ═════════════════════════════════════════════════════════════
//  Terminal Activity Listener — captures commands for learning
//
//  Uses multiple VS Code APIs to capture terminal commands:
//  1. onDidStartTerminalShellExecution (VS Code 1.93+)
//  2. onDidEndTerminalShellExecution (exit code = RLVR signal)
//  3. onDidWriteTerminalData fallback (older VS Code)
// ═════════════════════════════════════════════════════════════
function setupTerminalListener(ctx) {
    // Track active shell executions for RLVR (exit code matching)
    const _pendingExecs = new Map(); // executionId → { command, startTime }

    // Log which methods are available
    const hasShellExec = !!vscode.window.onDidStartTerminalShellExecution;
    const hasShellEnd  = !!vscode.window.onDidEndTerminalShellExecution;
    const hasWriteData = !!vscode.window.onDidWriteTerminalData;
    console.log(`[Grav] Terminal listener: shellExec=${hasShellExec} shellEnd=${hasShellEnd} writeData=${hasWriteData}`);

    // Method 1: Shell execution API (best — gives command + exit code)
    if (vscode.window.onDidStartTerminalShellExecution) {
        ctx.subscriptions.push(
            vscode.window.onDidStartTerminalShellExecution(e => {
                try {
                    const cmdLine = e.execution?.commandLine?.value || e.execution?.commandLine || '';
                    console.log('[Grav] shellExec START:', cmdLine);
                    if (!cmdLine || cmdLine.length < 2) return;
                    const id = e.execution?.id || Date.now().toString();
                    _pendingExecs.set(id, { command: cmdLine, startTime: Date.now() });
                    // Record as approve (user/agent initiated this command)
                    if (cfg('learnEnabled', true)) {
                        recordCommandAction(cmdLine, 'approve', {
                            project: vscode.workspace.workspaceFolders?.[0]?.name,
                        });
                    }
                } catch (err) { console.error('[Grav] shellExec error:', err.message); }
            })
        );
    }

    if (vscode.window.onDidEndTerminalShellExecution) {
        ctx.subscriptions.push(
            vscode.window.onDidEndTerminalShellExecution(e => {
                try {
                    const id = e.execution?.id || '';
                    const exitCode = e.exitCode;
                    const pending = _pendingExecs.get(id);
                    if (pending) {
                        _pendingExecs.delete(id);
                        // RLVR: feed exit code back as verifiable reward
                        if (cfg('learnEnabled', true) && typeof exitCode === 'number') {
                            recordCommandAction(pending.command, exitCode === 0 ? 'approve' : 'reject', {
                                exitCode,
                                project: vscode.workspace.workspaceFolders?.[0]?.name,
                                duration: Date.now() - pending.startTime,
                            });
                        }
                    } else {
                        // No pending match — try to get command from execution
                        const cmdLine = e.execution?.commandLine?.value || e.execution?.commandLine || '';
                        if (cmdLine && cfg('learnEnabled', true) && typeof exitCode === 'number') {
                            recordCommandAction(cmdLine, exitCode === 0 ? 'approve' : 'reject', {
                                exitCode,
                                project: vscode.workspace.workspaceFolders?.[0]?.name,
                            });
                        }
                    }
                } catch (_) {}
            })
        );
    }

    // Method 2: Terminal data write listener (fallback for older VS Code)
    // Parse command lines from terminal output
    if (!vscode.window.onDidStartTerminalShellExecution && vscode.window.onDidWriteTerminalData) {
        const _termBuffers = new Map(); // terminalId → buffer string
        ctx.subscriptions.push(
            vscode.window.onDidWriteTerminalData(e => {
                try {
                    if (!cfg('learnEnabled', true)) return;
                    const tid = e.terminal?.name || 'default';
                    const buf = (_termBuffers.get(tid) || '') + e.data;

                    // Look for command patterns: prompt followed by command then newline
                    const lines = buf.split(/\r?\n/);
                    if (lines.length > 1) {
                        // Process completed lines (all except last which may be incomplete)
                        for (let i = 0; i < lines.length - 1; i++) {
                            const line = lines[i].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
                            // Skip empty, prompts-only, or output lines
                            if (!line || line.length < 3 || line.length > 500) continue;
                            // Heuristic: lines starting with $ or > or ending with $ are prompts+commands
                            const cmdMatch = line.match(/^[\$>%#]\s+(.+)/) || line.match(/\$\s+(.+)$/);
                            if (cmdMatch) {
                                const cmdLine = cmdMatch[1].trim();
                                if (cmdLine.length >= 2) {
                                    recordCommandAction(cmdLine, 'approve', {
                                        project: vscode.workspace.workspaceFolders?.[0]?.name,
                                    });
                                }
                            }
                        }
                        _termBuffers.set(tid, lines[lines.length - 1]);
                    } else {
                        _termBuffers.set(tid, buf.slice(-1000)); // keep last 1KB
                    }
                } catch (_) {}
            })
        );
    }

    // Method 3: Terminal open/close tracking (always available)
    ctx.subscriptions.push(
        vscode.window.onDidOpenTerminal(t => {
            try {
                const name = t.name || '';
                console.log('[Grav] terminal opened:', name);
                // Agent-created terminals often have descriptive names
                if (name && cfg('learnEnabled', true)) {
                    const cmds = extractCommands(name);
                    if (cmds.length > 0 && cmds[0] !== 'terminal' && cmds[0] !== 'bash' && cmds[0] !== 'zsh' && cmds[0] !== 'sh') {
                        console.log('[Grav] learning from terminal name:', name, '→', cmds);
                        recordCommandAction(name, 'approve', {
                            project: vscode.workspace.workspaceFolders?.[0]?.name,
                        });
                    }
                }
            } catch (_) {}
        })
    );

    // Cleanup stale pending executions (>5 min)
    const cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - 300000;
        for (const [id, p] of _pendingExecs) {
            if (p.startTime < cutoff) _pendingExecs.delete(id);
        }
    }, 60000);
    ctx.subscriptions.push({ dispose: () => clearInterval(cleanupTimer) });

    // Method 4: Poll shell integration command history
    // Antigravity reuses terminals — shellExec only fires once per terminal.
    // This polls all terminals for new commands via shellIntegration API.
    const _seenCmds = new Set(); // "terminalName:cmdLine:timestamp" dedup keys
    const pollTimer = setInterval(() => {
        if (!cfg('learnEnabled', true) || !_enabled) return;
        try {
            for (const term of vscode.window.terminals) {
                const si = term.shellIntegration;
                if (!si) continue;
                // shellIntegration.executeCommand is the latest command
                // shellIntegration.cwd gives current directory
                const exec = si.executeCommand;
                if (exec) {
                    const cmdLine = exec.commandLine?.value || exec.commandLine || '';
                    if (cmdLine && cmdLine.length >= 2) {
                        const key = term.name + ':' + cmdLine + ':' + (exec.startTimestamp || 0);
                        if (!_seenCmds.has(key)) {
                            _seenCmds.add(key);
                            console.log('[Grav] poll captured:', cmdLine);
                            const exitCode = typeof exec.exitCode === 'number' ? exec.exitCode : undefined;
                            recordCommandAction(cmdLine, exitCode === undefined || exitCode === 0 ? 'approve' : 'reject', {
                                exitCode,
                                project: vscode.workspace.workspaceFolders?.[0]?.name,
                            });
                        }
                    }
                }
                // Also check command history if available
                if (si.commandDetection && si.commandDetection.commands) {
                    for (const cmd of si.commandDetection.commands) {
                        const cmdLine = cmd.command || cmd.commandLine?.value || '';
                        if (!cmdLine || cmdLine.length < 2) continue;
                        const key = term.name + ':' + cmdLine + ':' + (cmd.timestamp || cmd.startTimestamp || 0);
                        if (_seenCmds.has(key)) continue;
                        _seenCmds.add(key);
                        console.log('[Grav] history captured:', cmdLine);
                        const exitCode = typeof cmd.exitCode === 'number' ? cmd.exitCode : undefined;
                        recordCommandAction(cmdLine, exitCode === undefined || exitCode === 0 ? 'approve' : 'reject', {
                            exitCode,
                            project: vscode.workspace.workspaceFolders?.[0]?.name,
                        });
                    }
                }
            }
            // Prevent memory leak — trim seen set
            if (_seenCmds.size > 5000) {
                const arr = [..._seenCmds];
                _seenCmds.clear();
                for (let i = arr.length - 2000; i < arr.length; i++) _seenCmds.add(arr[i]);
            }
        } catch (err) { /* silent — polling should never crash */ }
    }, 3000); // poll every 3 seconds
    ctx.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

    // Method 5: Listen for shellIntegration changes on each terminal
    // When a terminal gets shell integration, subscribe to its command events
    if (vscode.window.onDidChangeTerminalShellIntegration) {
        ctx.subscriptions.push(
            vscode.window.onDidChangeTerminalShellIntegration(e => {
                try {
                    const si = e.shellIntegration;
                    if (!si || !si.onDidExecuteCommand) return;
                    console.log('[Grav] shellIntegration ready for:', e.terminal?.name);
                    ctx.subscriptions.push(
                        si.onDidExecuteCommand(cmd => {
                            try {
                                const cmdLine = cmd.commandLine?.value || cmd.commandLine || '';
                                console.log('[Grav] shellIntegration cmd:', cmdLine, 'exit:', cmd.exitCode);
                                if (!cmdLine || cmdLine.length < 2 || !cfg('learnEnabled', true)) return;
                                const key = (e.terminal?.name || '') + ':' + cmdLine + ':' + Date.now();
                                if (_seenCmds.has(key)) return;
                                _seenCmds.add(key);
                                const exitCode = typeof cmd.exitCode === 'number' ? cmd.exitCode : undefined;
                                recordCommandAction(cmdLine, exitCode === undefined || exitCode === 0 ? 'approve' : 'reject', {
                                    exitCode,
                                    project: vscode.workspace.workspaceFolders?.[0]?.name,
                                });
                            } catch (_) {}
                        })
                    );
                } catch (_) {}
            })
        );
    }
}

// ═════════════════════════════════════════════════════════════
//  HTTP bridge — runtime ↔ host
// ═════════════════════════════════════════════════════════════
function startBridge() {
    if (_httpServer) return;
    const url = require('url');
    _httpServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const u = url.parse(req.url, true);

        // Ingest click stats from runtime
        if (u.query && u.query.stats) {
            try {
                const inc = JSON.parse(decodeURIComponent(u.query.stats));
                for (const k in inc) { _stats[k] = (_stats[k] || 0) + inc[k]; }
                _totalClicks = Object.values(_stats).reduce((a, b) => a + b, 0);
                refreshBar();
                if (_ctx) { _ctx.globalState.update('stats', _stats); _ctx.globalState.update('totalClicks', _totalClicks); }
            } catch (_) {}
        }

        // Click log
        if (u.pathname === '/api/click-log' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    const now = new Date();
                    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
                        .map(n => n < 10 ? '0' + n : n).join(':');
                    _log.unshift({ time: ts, pattern: d.pattern || 'click', button: (d.button || '').substring(0, 80) });
                    if (_log.length > 50) _log.pop();
                    if (_ctx) _ctx.globalState.update('clickLog', _log);

                    // Feed auto-approve clicks to learning engine
                    // When runtime clicks "Run" or "Allow", the button text often contains the command
                    if (cfg('learnEnabled', true) && d.button) {
                        const btn = d.button.trim();
                        // "Run `npm install`" or "Allow npm to run" patterns
                        const cmdMatch = btn.match(/[`']([^`']+)[`']/) || btn.match(/^(?:Run|Allow|Execute)\s+(.+)/i);
                        if (cmdMatch) {
                            recordCommandAction(cmdMatch[1].trim(), 'approve', {
                                project: vscode.workspace.workspaceFolders?.[0]?.name,
                            });
                        }
                    }
                } catch (_) {}
                res.writeHead(200); res.end('{"ok":true}');
            });
            return;
        }

        // Terminal command evaluation
        if (u.pathname === '/api/eval-command' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    const result = evaluateCommand(d.command || '');
                    res.writeHead(200); res.end(JSON.stringify(result));
                } catch (_) { res.writeHead(400); res.end('{"error":"bad request"}'); }
            });
            return;
        }

        // Second Brain wiki query
        if (u.pathname === '/api/wiki-query' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    const result = d.command ? wikiQuery(d.command) : null;
                    res.writeHead(200); res.end(JSON.stringify(result || { error: 'not found' }));
                } catch (_) { res.writeHead(400); res.end('{"error":"bad request"}'); }
            });
            return;
        }

        // Second Brain wiki status
        if (u.pathname === '/api/wiki-status') {
            const status = {
                pages: Object.keys(_wiki.index).length,
                concepts: Object.keys(_wiki.concepts).length,
                contradictions: _wiki.contradictions.filter(c => !c.resolved).length,
                synthesis: Object.keys(_wiki.synthesis).length,
                logEntries: _wiki.log.length,
                lastLint: _wiki.lastLint,
            };
            res.writeHead(200); res.end(JSON.stringify(status));
            return;
        }

        // Terminal command learning feedback (with RLVR context)
        if (u.pathname === '/api/learn-command' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    if (cfg('learnEnabled', true) && d.command && d.action) {
                        recordCommandAction(d.command, d.action, {
                            exitCode: d.exitCode,
                            project: d.project || (vscode.workspace.workspaceFolders?.[0]?.name),
                            duration: d.duration,
                        });
                    }
                    res.writeHead(200); res.end('{"ok":true}');
                } catch (_) { res.writeHead(400); res.end('{"error":"bad request"}'); }
            });
            return;
        }

        // Quota detected
        if (u.pathname === '/api/quota-detected' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                if (Date.now() - _lastQuotaMs > 60000) {
                    _lastQuotaMs = Date.now();
                    vscode.window.showWarningMessage('Quota exhausted — consider switching model manually.', 'OK');
                }
                res.writeHead(200); res.end('{"notified":true}');
            });
            return;
        }

        // Default: serve config
        const dp = _ctx ? _ctx.globalState.get('disabledPatterns', []) : [];
        const pats = cfg('approvePatterns', ['Run','Allow','Always Allow','Keep Waiting','Continue','Retry'])
            .filter(p => !dp.includes(p) && p !== 'Accept');
        res.writeHead(200);
        res.end(JSON.stringify({
            enabled: _enabled,
            scrollEnabled: _scrollOn,
            patterns: pats,
            acceptInChatOnly: cfg('approvePatterns', []).includes('Accept') && !dp.includes('Accept'),
            pauseMs: cfg('scrollPauseMs', 7000),
            scrollMs: cfg('scrollIntervalMs', 500),
            approveMs: cfg('approveIntervalMs', 1000),
        }));
    });

    function tryPort(port) {
        if (port > PORT_END) return;
        _httpServer.removeAllListeners('error');
        _httpServer.once('error', e => { if (e.code === 'EADDRINUSE') tryPort(port + 1); });
        _httpServer.listen(port, '127.0.0.1', () => { _httpPort = port; });
    }
    tryPort(PORT_START);
}

// ═════════════════════════════════════════════════════════════
//  Status bar
// ═════════════════════════════════════════════════════════════
function createBar() {
    _sbMain   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    _sbClicks = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    _sbScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10002);
    _sbMain.command   = 'grav.dashboard';
    _sbClicks.command = 'grav.dashboard';
    _sbScroll.command = 'grav.dashboard';
    _sbClicks.color   = '#f9e2af';
    _ctx.subscriptions.push(_sbMain, _sbClicks, _sbScroll);
    refreshBar();
    _sbMain.show(); _sbClicks.show(); _sbScroll.show();
}

function refreshBar() {
    if (!_sbMain) return;
    _sbMain.text  = _enabled ? '$(rocket) Grav' : '$(circle-slash) Grav';
    _sbMain.color = _enabled ? '#94e2d5' : '#f38ba8';
    _sbMain.backgroundColor = _enabled ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
    if (_sbScroll) {
        _sbScroll.text  = _scrollOn ? '$(fold-down) Scroll' : '$(circle-slash) Scroll';
        _sbScroll.color = _scrollOn ? '#94e2d5' : '#f38ba8';
    }
    if (_sbClicks) _sbClicks.text = '$(target) ' + _totalClicks;
}

// ═════════════════════════════════════════════════════════════
//  Dashboard (webview)
// ═════════════════════════════════════════════════════════════
function openDashboard() {
    if (_dashboard) { _dashboard.dispose(); _dashboard = null; return; }
    const panel = vscode.window.createWebviewPanel('gravDashboard', 'Grav — Dashboard', vscode.ViewColumn.One, { enableScripts: true });
    _dashboard = panel;
    panel.onDidDispose(() => { _dashboard = null; });

    const renderPanel = () => {
        const dp = _ctx.globalState.get('disabledPatterns', []);
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
            stats: _stats,
            totalClicks: _totalClicks,
            whiteCount: SAFE_TERMINAL_CMDS.length + _userWhitelist.length,
            blackCount: DEFAULT_BLACKLIST.length + _userBlacklist.length,
            learnCount: promoted.length,
            learnEpoch: _learnEpoch,
            learnTracking: Object.keys(_learnData).length,
            learnPatterns: _patternCache.length,
            wikiPages: Object.keys(_wiki.index).length,
            wikiConcepts: Object.keys(_wiki.concepts).length,
            wikiContradictions: _wiki.contradictions.filter(c => !c.resolved).length,
            concepts: _wiki.concepts,
            wikiLog: (_wiki.log || []).slice(-30),
        });
    };
    renderPanel();

    panel.webview.onDidReceiveMessage(async (msg) => {
        const c = vscode.workspace.getConfiguration('grav');
        switch (msg.command) {
            case 'toggle':
                _enabled = msg.enabled;
                await c.update('enabled', msg.enabled, vscode.ConfigurationTarget.Global);
                writeRuntimeConfig(); refreshBar(); break;
            case 'scrollToggle':
                _scrollOn = msg.enabled;
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
                await _ctx.globalState.update('disabledPatterns', d.disabledPatterns);
                _enabled = d.enabled; _scrollOn = d.scrollOn !== false;
                _patterns = d.patterns.filter(p => !d.disabledPatterns.includes(p));
                writeRuntimeConfig(); refreshBar(); break;
            }
            case 'changeLang':
                await c.update('language', msg.lang, vscode.ConfigurationTarget.Global);
                renderPanel(); break;
            case 'reload':
                vscode.commands.executeCommand('workbench.action.reloadWindow'); break;
            case 'resetStats':
                _stats = {}; _totalClicks = 0;
                _ctx.globalState.update('stats', {}); _ctx.globalState.update('totalClicks', 0);
                panel.webview.postMessage({ command: 'statsUpdated', stats: {}, totalClicks: 0 }); break;
            case 'clearLog':
                _log = []; _ctx.globalState.update('clickLog', []);
                panel.webview.postMessage({ command: 'logUpdated', log: [] }); break;
            case 'getLog':
                panel.webview.postMessage({ command: 'logUpdated', log: _log }); break;
            case 'getStats':
                panel.webview.postMessage({ command: 'statsUpdated', stats: _stats, totalClicks: _totalClicks }); break;
            case 'manageTerminal':
                vscode.commands.executeCommand('grav.manageTerminal'); break;
        }
    }, undefined, _ctx.subscriptions);

    const ticker = setInterval(() => {
        try {
            panel.webview.postMessage({ command: 'statsUpdated', stats: _stats, totalClicks: _totalClicks });
            // Live update Second Brain — send lightweight data only
            const promoted = getPromotedCommands();
            // Strip heavy fields from concepts before sending
            const lightConcepts = {};
            for (const [k, v] of Object.entries(_wiki.concepts)) {
                lightConcepts[k] = {
                    commands: v.commands,
                    avgConfidence: v.avgConfidence,
                    riskLevel: v.riskLevel,
                    description: v.description,
                };
            }
            panel.webview.postMessage({
                command: 'brainUpdated',
                epoch: _learnEpoch,
                tracking: Object.keys(_learnData).length,
                whiteCount: SAFE_TERMINAL_CMDS.length + _userWhitelist.length,
                blackCount: DEFAULT_BLACKLIST.length + _userBlacklist.length,
                promoted: promoted.length,
                patterns: _patternCache.length,
                wikiPages: Object.keys(_wiki.index).length,
                wikiConcepts: Object.keys(_wiki.concepts).length,
                wikiContradictions: _wiki.contradictions.filter(c => !c.resolved).length,
                concepts: lightConcepts,
                wikiLog: (_wiki.log || []).slice(-30),
            });
        } catch (e) {
            // Don't kill ticker on transient errors — only stop if panel is disposed
            if (e.message && e.message.includes('disposed')) clearInterval(ticker);
        }
    }, 2000);
    panel.onDidDispose(() => clearInterval(ticker));
}

function getDashboardHtml(c) {
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

// ═════════════════════════════════════════════════════════════
//  Activate / Deactivate
// ═════════════════════════════════════════════════════════════
function activate(ctx) {
    _ctx = ctx;
    _stats       = ctx.globalState.get('stats', {});
    _totalClicks = ctx.globalState.get('totalClicks', 0);
    _log         = ctx.globalState.get('clickLog', []) || [];
    _enabled     = cfg('enabled', true);
    _scrollOn    = cfg('autoScroll', true);

    // Inject runtime
    const ver     = ctx.extension?.packageJSON?.version || '0';
    const lastVer = ctx.globalState.get('grav-version', '0');
    if (!isInjected() || ver !== lastVer) {
        try {
            inject();
            ctx.globalState.update('grav-version', ver);
            clearCodeCache();
            patchChecksums();
            setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 1000);
        } catch (e) { console.error('[Grav] inject:', e.message); }
    } else {
        // Hot-update runtime without reload
        try {
            const wb = workbenchPath();
            if (wb) elevatedWrite(path.join(path.dirname(wb), RUNTIME_FILE), buildRuntime());
        } catch (_) {}
        patchChecksums();
    }

    startBridge();
    startAcceptLoop();
    writeRuntimeConfig();
    loadLearnData();
    setupSafeApprove();

    // LS discovery
    setTimeout(() => discoverLS(), 8000);
    setInterval(() => { if (!_lsOk) discoverLS(); }, 60000);

    // Win32 native "Keep Waiting" handler
    if (process.platform === 'win32') {
        const ps = 'Add-Type @"\nusing System;using System.Text;using System.Runtime.InteropServices;\npublic class GravWin32{\npublic delegate bool EnumWindowsProc(IntPtr hWnd,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr hwnd,EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern int GetClassName(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);\n[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hWnd,uint Msg,IntPtr w,IntPtr l);\n}\n"@\n$global:clicked=$false\n[GravWin32]::EnumWindows({param($hWnd,$lp)\nif(-not [GravWin32]::IsWindowVisible($hWnd)){return $true}\nif($global:clicked){return $false}\n[GravWin32]::EnumChildWindows($hWnd,{param($ch,$lp2)\n$cls=New-Object System.Text.StringBuilder 64\n[GravWin32]::GetClassName($ch,$cls,64)|Out-Null\nif($cls.ToString() -eq \'Button\'){$txt=New-Object System.Text.StringBuilder 256\n[GravWin32]::GetWindowText($ch,$txt,256)|Out-Null\nif($txt.ToString() -match \'Keep Waiting\'){[GravWin32]::PostMessage($ch,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);$global:clicked=$true}}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){return $false}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){Write-Output \'CLICKED\'}';
        const kwi = setInterval(() => {
            if (!_enabled) return;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 5000 }, (err, stdout) => {
                if (stdout && stdout.trim() === 'CLICKED') { _totalClicks++; refreshBar(); }
            });
        }, 3000);
        ctx.subscriptions.push({ dispose: () => clearInterval(kwi) });
    }

    createBar();
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('grav')) { _enabled = cfg('enabled', true); _scrollOn = cfg('autoScroll', true); refreshBar(); }
    }));

    // ── Terminal Activity Listener — feed data to Learning Engine ──
    setupTerminalListener(ctx);

    // ── Commands ──────────────────────────────────────────────
    ctx.subscriptions.push(
        vscode.commands.registerCommand('grav.inject', async () => {
            if (inject()) {
                const c = await vscode.window.showInformationMessage('[Grav] Runtime injected. Reload?', 'Reload');
                if (c === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
        vscode.commands.registerCommand('grav.eject', async () => {
            if (eject()) {
                const c = await vscode.window.showInformationMessage('[Grav] Runtime removed. Reload?', 'Reload');
                if (c === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
        vscode.commands.registerCommand('grav.dashboard', () => openDashboard()),
        vscode.commands.registerCommand('grav.diagnostics', async () => {
            const promoted = getPromotedCommands();
            const stats = getLearnStats();
            const lines = [
                `Grav v1.0.0`,
                `Platform: ${process.platform} (${os.arch()})`,
                `HTTP bridge: ${_httpPort || 'not started'}`,
                `Enabled: ${_enabled}  Scroll: ${_scrollOn}`,
                `Total clicks: ${_totalClicks}`,
                `LS: ${_lsOk ? 'port ' + _lsPort : 'disconnected'}`,
                `Workbench: ${workbenchPath() || 'not found'}`,
                `Injected: ${isInjected()}`,
                ``,
                `── Terminal Command Management ──`,
                `Built-in whitelist: ${SAFE_TERMINAL_CMDS.length} commands`,
                `User whitelist: ${_userWhitelist.length} (${_userWhitelist.join(', ') || 'none'})`,
                `User blacklist: ${_userBlacklist.length} (${_userBlacklist.join(', ') || 'none'})`,
                ``,
                `── Karpathy Learning Engine ──`,
                `Epoch: ${stats.epoch}`,
                `Tracking: ${stats.totalTracked} commands`,
                `Promoted (conf ≥ ${LEARN.PROMOTE_THRESH}): ${promoted.length} (${promoted.join(', ') || 'none'})`,
                `Generalized patterns: ${stats.patterns} (${_patternCache.join(', ') || 'none'})`,
                `Learning rate (α): ${LEARN.ALPHA}`,
                `Momentum: ${LEARN.MOMENTUM}`,
                `Decay (γ): ${LEARN.GAMMA}`,
                `Learning enabled: ${cfg('learnEnabled', true)}`,
            ];
            const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
            await vscode.window.showTextDocument(doc);
        }),
        vscode.commands.registerCommand('grav.manageTerminal', async () => {
            const actions = [
                { label: '$(add) Thêm vào Whitelist', description: 'Add command to whitelist', action: 'addWhite' },
                { label: '$(remove) Xóa khỏi Whitelist', description: 'Remove from whitelist', action: 'removeWhite' },
                { label: '$(shield) Thêm vào Blacklist', description: 'Block a command', action: 'addBlack' },
                { label: '$(trash) Xóa khỏi Blacklist', description: 'Unblock a command', action: 'removeBlack' },
                { label: '$(search) Kiểm tra lệnh', description: 'Test if a command would be allowed', action: 'test' },
                { label: '$(book) Xem tất cả', description: 'View all whitelist/blacklist', action: 'viewAll' },
                { label: '$(graph) Learning Stats', description: 'View adaptive learning data', action: 'learnStats' },
                { label: '$(notebook) Second Brain Wiki', description: 'View compiled knowledge wiki', action: 'viewWiki' },
                { label: '$(warning) Contradictions', description: 'View detected contradictions', action: 'viewContradictions' },
                { label: '$(checklist) Lint Wiki', description: 'Health-check the knowledge base', action: 'lintWiki' },
                { label: '$(clear-all) Reset Learning', description: 'Clear all learned data', action: 'resetLearn' },
            ];
            const pick = await vscode.window.showQuickPick(actions, { placeHolder: 'Quản lý Terminal Commands' });
            if (!pick) return;
            const c = vscode.workspace.getConfiguration('grav');

            switch (pick.action) {
                case 'addWhite': {
                    const cmd = await vscode.window.showInputBox({ prompt: 'Nhập tên lệnh (vd: terraform, ansible-playbook)', placeHolder: 'command-name' });
                    if (!cmd) return;
                    const name = cmd.trim().toLowerCase();
                    if (_userWhitelist.includes(name)) { vscode.window.showInformationMessage(`"${name}" đã có trong whitelist`); return; }
                    _userWhitelist.push(name);
                    await c.update('terminalWhitelist', _userWhitelist, vscode.ConfigurationTarget.Global);
                    setupSafeApprove();
                    vscode.window.showInformationMessage(`[Grav] ✓ "${name}" → whitelist`);
                    break;
                }
                case 'removeWhite': {
                    if (_userWhitelist.length === 0) { vscode.window.showInformationMessage('Whitelist trống'); return; }
                    const items = _userWhitelist.map(w => ({ label: w }));
                    const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Chọn lệnh để xóa', canPickMany: true });
                    if (!sel || sel.length === 0) return;
                    const toRemove = sel.map(s => s.label);
                    _userWhitelist = _userWhitelist.filter(w => !toRemove.includes(w));
                    await c.update('terminalWhitelist', _userWhitelist, vscode.ConfigurationTarget.Global);
                    setupSafeApprove();
                    vscode.window.showInformationMessage(`[Grav] Đã xóa ${toRemove.join(', ')} khỏi whitelist`);
                    break;
                }
                case 'addBlack': {
                    const cmd = await vscode.window.showInputBox({ prompt: 'Nhập lệnh/pattern cần chặn (vd: rm -rf, /eval.*/, sudo su)', placeHolder: 'command or /regex/' });
                    if (!cmd) return;
                    const pattern = cmd.trim();
                    if (_userBlacklist.includes(pattern)) { vscode.window.showInformationMessage(`"${pattern}" đã có trong blacklist`); return; }
                    _userBlacklist.push(pattern);
                    await c.update('terminalBlacklist', _userBlacklist, vscode.ConfigurationTarget.Global);
                    setupSafeApprove();
                    vscode.window.showInformationMessage(`[Grav] ✗ "${pattern}" → blacklist`);
                    break;
                }
                case 'removeBlack': {
                    if (_userBlacklist.length === 0) { vscode.window.showInformationMessage('Blacklist trống'); return; }
                    const items = _userBlacklist.map(b => ({ label: b }));
                    const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Chọn pattern để xóa', canPickMany: true });
                    if (!sel || sel.length === 0) return;
                    const toRemove = sel.map(s => s.label);
                    _userBlacklist = _userBlacklist.filter(b => !toRemove.includes(b));
                    await c.update('terminalBlacklist', _userBlacklist, vscode.ConfigurationTarget.Global);
                    setupSafeApprove();
                    vscode.window.showInformationMessage(`[Grav] Đã xóa ${toRemove.join(', ')} khỏi blacklist`);
                    break;
                }
                case 'test': {
                    const cmd = await vscode.window.showInputBox({ prompt: 'Nhập lệnh đầy đủ để kiểm tra', placeHolder: 'npm run build && docker push myapp' });
                    if (!cmd) return;
                    const result = evaluateCommand(cmd);
                    const icon = result.allowed ? '✓' : '✗';
                    const lines = [
                        `${icon} ${result.allowed ? 'ALLOWED' : 'BLOCKED'}`,
                        `Reason: ${result.reason}`,
                        `Commands found: ${result.commands.join(', ') || 'none'}`,
                        ``,
                        `Full command: ${cmd}`,
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'viewAll': {
                    const promoted = getPromotedCommands();
                    const lines = [
                        '═══ WHITELIST (Built-in) ═══',
                        SAFE_TERMINAL_CMDS.join(', '),
                        '',
                        '═══ WHITELIST (User) ═══',
                        _userWhitelist.join(', ') || '(trống)',
                        '',
                        '═══ WHITELIST (Learned — promoted by AI) ═══',
                        promoted.join(', ') || '(chưa có)',
                        '',
                        '═══ GENERALIZED PATTERNS ═══',
                        _patternCache.join(', ') || '(chưa có)',
                        '',
                        '═══ BLACKLIST (Built-in) ═══',
                        DEFAULT_BLACKLIST.join('\n'),
                        '',
                        '═══ BLACKLIST (User) ═══',
                        _userBlacklist.join('\n') || '(trống)',
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'learnStats': {
                    const stats = getLearnStats();
                    if (stats.commands.length === 0) { vscode.window.showInformationMessage('[Grav] Chưa có dữ liệu học'); return; }
                    const hdr = 'Command'.padEnd(22) + 'Conf'.padEnd(8) + 'Vel'.padEnd(8) + 'Obs'.padEnd(6) + 'Status'.padEnd(12) + 'Context'.padEnd(14) + 'Last Seen';
                    const sep = '─'.repeat(80);
                    const rows = stats.commands.map(s => {
                        const confBar = s.conf >= 0
                            ? '█'.repeat(Math.round(s.conf * 10)).padEnd(10)
                            : '░'.repeat(Math.round(Math.abs(s.conf) * 10)).padEnd(10);
                        return s.cmd.padEnd(22)
                            + (s.conf >= 0 ? '+' : '') + String(s.conf).padEnd(7)
                            + String(s.velocity).padEnd(8)
                            + String(s.obs).padEnd(6)
                            + s.status.padEnd(12)
                            + (s.topContext || '-').padEnd(14)
                            + s.lastSeen;
                    });
                    const footer = [
                        '',
                        `Epoch: ${stats.epoch} | Tracking: ${stats.totalTracked} | Promoted: ${stats.promoted} | Patterns: ${stats.patterns}`,
                        `Hyperparams: α=${LEARN.ALPHA} momentum=${LEARN.MOMENTUM} γ=${LEARN.GAMMA} promote≥${LEARN.PROMOTE_THRESH} demote≤${LEARN.DEMOTE_THRESH}`,
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: [hdr, sep, ...rows, ...footer].join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'viewWiki': {
                    const pages = Object.entries(_wiki.index)
                        .sort((a, b) => b[1].totalEvents - a[1].totalEvents);
                    if (pages.length === 0) { vscode.window.showInformationMessage('[Grav] Wiki trống — chưa có dữ liệu'); return; }
                    const lines = [
                        '═══ SECOND BRAIN — KNOWLEDGE WIKI ═══',
                        `Pages: ${pages.length} | Concepts: ${Object.keys(_wiki.concepts).length} | Contradictions: ${_wiki.contradictions.filter(c => !c.resolved).length}`,
                        '',
                        '── INDEX (sorted by activity) ──',
                        'Command'.padEnd(20) + 'Events'.padEnd(8) + 'Conf'.padEnd(8) + 'Risk'.padEnd(10) + 'Links'.padEnd(7) + 'Summary',
                        '─'.repeat(90),
                        ...pages.map(([cmd, p]) =>
                            cmd.padEnd(20) +
                            String(p.totalEvents).padEnd(8) +
                            (p.confidence >= 0 ? '+' : '') + String(Math.round(p.confidence * 100) / 100).padEnd(7) +
                            p.riskLevel.padEnd(10) +
                            String(p.links.length).padEnd(7) +
                            (p.summary || '').substring(0, 50)
                        ),
                        '',
                        '── CONCEPTS ──',
                        ...Object.entries(_wiki.concepts).map(([name, c]) =>
                            `  ${name}: ${c.commands.length} cmds, avg conf ${Math.round(c.avgConfidence * 100)}%, risk: ${c.riskLevel}`
                        ),
                        '',
                        '── SYNTHESIS ──',
                        ...Object.entries(_wiki.synthesis).map(([name, s]) =>
                            `  ${name}: ${s.description}`
                        ),
                        '',
                        '── RECENT LOG (last 15) ──',
                        ...(_wiki.log || []).slice(-15).reverse().map(l =>
                            `  [${l.time}] ${l.op} ${l.cmd || ''} ${l.action || ''} ${l.detail || ''}`
                        ),
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'viewContradictions': {
                    const unresolved = _wiki.contradictions.filter(c => !c.resolved);
                    if (unresolved.length === 0) { vscode.window.showInformationMessage('[Grav] Không có contradictions'); return; }
                    const lines = [
                        '═══ CONTRADICTIONS (unresolved) ═══',
                        '',
                        ...unresolved.map((c, i) => [
                            `#${i + 1} [${c.type}] ${c.cmd}`,
                            `  Detail: ${c.detail}`,
                            `  Old claim: ${c.oldClaim}`,
                            `  New evidence: ${c.newEvidence}`,
                            `  Time: ${new Date(c.time).toLocaleString()}`,
                            '',
                        ].join('\n')),
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'lintWiki': {
                    const issues = wikiLint();
                    if (issues.length === 0) { vscode.window.showInformationMessage('[Grav] Wiki sạch — không có vấn đề'); return; }
                    const lines = [
                        '═══ WIKI LINT REPORT ═══',
                        `Time: ${new Date().toLocaleString()}`,
                        `Issues found: ${issues.length}`,
                        '',
                        ...issues.map(issue => [
                            `⚠ ${issue.type.toUpperCase()}: ${issue.detail}`,
                            ...issue.items.map(item => `    • ${typeof item === 'string' ? item : JSON.stringify(item)}`),
                            '',
                        ].join('\n')),
                    ];
                    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
                    await vscode.window.showTextDocument(doc);
                    break;
                }
                case 'resetLearn': {
                    const confirm = await vscode.window.showWarningMessage('Xóa toàn bộ dữ liệu học + wiki?', 'Xóa', 'Hủy');
                    if (confirm !== 'Xóa') return;
                    _learnData = {};
                    _wiki = { index: {}, concepts: {}, log: [], synthesis: {}, contradictions: [], lastLint: 0 };
                    _learnEpoch = 0;
                    if (_ctx) {
                        _ctx.globalState.update('learnData', {});
                        _ctx.globalState.update('wiki', _wiki);
                        _ctx.globalState.update('learnEpoch', 0);
                    }
                    setupSafeApprove();
                    vscode.window.showInformationMessage('[Grav] Đã reset learning data + wiki');
                    break;
                }
            }
        }),
        vscode.commands.registerCommand('grav.learnStats', async () => {
            vscode.commands.executeCommand('grav.manageTerminal');
        }),
    );
}

function deactivate() {
    if (_sbMain)   _sbMain.dispose();
    if (_sbClicks) _sbClicks.dispose();
    if (_sbScroll) _sbScroll.dispose();
    if (_acceptTimer) clearInterval(_acceptTimer);
    if (_httpServer) try { _httpServer.close(); } catch (_) {}
}

module.exports = { activate, deactivate };
