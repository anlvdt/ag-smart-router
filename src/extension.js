// ===========================================================
// AG Autopilot v6.0.0
// Auto Click & Scroll (Layer 0) + Smart Router & Quota Fallback (Extension Host)
// CDP: single persistent WS to browser endpoint + Target.attachToTarget
// Smart Router + Quota Fallback run entirely in Extension Host via CDP
// Layer 0 only handles Auto Click, Auto Scroll, and thin Enter stub
//
// v6.0.0 improvements:
//   - Quota-aware Smart Router: checks exhaustion before routing
//   - Tier-aware fallback: prefers same-tier models before downgrading
//   - Token cost estimation: weighs model cost vs prompt complexity
//   - Adaptive cooldown: escalates based on failure patterns
//   - Expanded regex patterns: frameworks, languages, Chinese keywords
//   - Routing history: learns from recent switch success/failure
//   - Weekly baseline awareness: tracks 7-day lockout patterns
//   - Proactive quota detection: monitors quota bar before hitting wall
//   - Stale session cleanup: prunes dead CDP sessions
//   - Bug fixes: escapeRegex, race conditions, memory leaks
// ===========================================================
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const http = require('http');

const TAG_START = '<!-- AG-AUTOPILOT-START -->';
const TAG_END = '<!-- AG-AUTOPILOT-END -->';
const OLD_TAGS = [
    ['<!-- AG-AUTO-CLICK-SCROLL-START -->', '<!-- AG-AUTO-CLICK-SCROLL-END -->'],
    ['<!-- AG-MODEL-SWITCH-START -->', '<!-- AG-MODEL-SWITCH-END -->'],
    ['<!-- AG-TOOLKIT-START -->', '<!-- AG-TOOLKIT-END -->']
];

let statusBarItem, statusBarScroll, statusBarQuota, statusBarModel, _settingsPanel = null;
let _autoAcceptEnabled = true, _httpScrollEnabled = true, _httpClickPatterns = [];
let _httpScrollConfig = { pauseScrollMs: 5000, scrollIntervalMs: 500, clickIntervalMs: 2000 };
let _clickStats = {}, _clickLog = [], _totalClicks = 0, _resetStatsRequested = false;
let _extensionContext = null, _httpServer = null, _actualPort = 0, _autoAcceptInterval = null;
const AG_HTTP_PORT_START = 48787, AG_HTTP_PORT_END = 48850;
const CHAT_ACCEPT_COMMANDS = ['antigravity.agent.acceptAgentStep','antigravity.prioritized.supercompleteAccept','antigravity.terminalCommand.accept','antigravity.acceptCompletion'];

// --- CDP state: browser-level persistent WS ---
const CDP_PORT = 9333;
let _cdpWs = null;
let _cdpConnected = false;
let _cdpMsgId = 1;
let _cdpCallbacks = {};       // id -> {resolve, reject}
let _cdpSessions = {};        // targetId -> sessionId
let _cdpAllSessionIds = new Set();
let _cdpReconnectTimer = null;
let _cdpQuotaSwitchInProgress = false, _cdpLastSwitchAt = 0;
let _cdpExhaustedModels = {};  // model -> { time, type: 'sprint'|'weekly' }
let _cdpConsecutiveHits = 0;
const EXHAUSTED_TTL_SPRINT = 30 * 60 * 1000;   // 30 min for sprint limit
const EXHAUSTED_TTL_WEEKLY = 7 * 24 * 60 * 60 * 1000; // 7 days for weekly baseline
let _quotaPollTimer = null;
let _quotaSwitchInProgress = false;

// --- Routing history for learning ---
let _routeHistory = [];        // [{time, prompt_len, tier, model, success}]
const ROUTE_HISTORY_MAX = 100;
let _routeStats = {};          // model -> {success: N, fail: N, lastUsed: ts}

// --- Adaptive cooldown state ---
let _cooldownLevel = 0;        // escalation level
let _lastCooldownReset = Date.now();
const COOLDOWN_LEVELS = [3000, 5000, 15000, 30000, 60000, 120000]; // escalating cooldowns

// --- Model tiers for tier-aware fallback ---
const MODEL_TIERS = {
    "Claude Opus 4.7 (Thinking)": { tier: 'extreme', cost: 10, family: 'claude' },
    "Claude Opus 4.6 (Thinking)": { tier: 'extreme', cost: 9, family: 'claude' },
    "Claude Sonnet 4.6":          { tier: 'high',    cost: 5, family: 'claude' },
    "Claude Sonnet 4.5":          { tier: 'high',    cost: 4, family: 'claude' },
    "Gemini 3.5 Pro":             { tier: 'high',    cost: 4, family: 'gemini' },
    "Gemini 3.1 Pro (High)":      { tier: 'default', cost: 3, family: 'gemini' },
    "Gemini 3 Flash (New)":       { tier: 'cheap',   cost: 1, family: 'gemini' },
    "Gemini 3 Flash":             { tier: 'cheap',   cost: 1, family: 'gemini' },
    "GPT-OSS 120B (Medium)":      { tier: 'default', cost: 3, family: 'gpt' },
    "GPT-OSS 100B":               { tier: 'default', cost: 2, family: 'gpt' }
};

const FALLBACK_MODELS = [
    "Claude Opus 4.7 (Thinking)", "Claude Opus 4.6 (Thinking)",
    "Claude Sonnet 4.6", "Claude Sonnet 4.5",
    "Gemini 3.5 Pro", "Gemini 3.1 Pro (High)", "Gemini 3 Flash (New)", "Gemini 3 Flash",
    "GPT-OSS 120B (Medium)", "GPT-OSS 100B"
];
const MODEL_KEYWORDS = ["Claude", "Gemini", "GPT", "GPT-OSS"];
const QUOTA_PHRASES = [
    'exhausted your capacity', 'quota will reset', 'baseline model quota reached',
    'exhausted your capacity on this model', 'model quota exceeded', 'rate limit exceeded',
    'monthly usage limit', 'daily limit reached', 'insufficient credits',
    'quota exhausted', 'capacity exceeded', 'model at capacity', 'too many requests',
    'weekly limit reached', 'credit balance', 'credits exhausted',
    'usage limit exceeded', 'request limit reached', 'try again later'
];

// =============================================================
// UTILITIES
// =============================================================
function writeFileElevated(fp, content) {
    try { fs.writeFileSync(fp, content, 'utf8'); } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
        const tmp = path.join(os.tmpdir(), 'ag-autopilot-' + Date.now() + '.tmp');
        fs.writeFileSync(tmp, content, 'utf8');
        try {
            if (process.platform === 'linux') execSync('pkexec bash -c "cp \'' + tmp + '\' \'' + fp + '\' && chmod 644 \'' + fp + '\'"', { timeout: 30000 });
            else if (process.platform === 'darwin') execSync('osascript -e \'do shell script "cp \'' + tmp + '\' \'' + fp + '\' && chmod 644 \'' + fp + '\'" with administrator privileges\'', { timeout: 30000 });
            else throw err;
        } catch (_) { try { fs.unlinkSync(tmp); } catch (__) {} throw new Error('Permission denied. Restart as Admin.'); }
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}
function getWorkbenchPath() {
    const r = vscode.env.appRoot;
    for (const p of [
        path.join(r,'out','vs','code','electron-browser','workbench','workbench.html'),
        path.join(r,'out','vs','code','electron-sandbox','workbench','workbench.html'),
        path.join(r,'out','vs','workbench','workbench.html'),
        path.join(r,'out','vs','code','browser','workbench','workbench.html'),
        path.join(r,'out','vs','code','electron-main','workbench','workbench.html'),
    ]) { if (fs.existsSync(p)) return p; }
    return findRec(path.join(r, 'out'), 'workbench.html', 6);
}
function findRec(dir, name, depth) {
    if (depth <= 0) return null;
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isFile() && e.name === name) return f;
        if (e.isDirectory()) { const r = findRec(f, name, depth - 1); if (r) return r; }
    }} catch (_) {} return null;
}
// FIX: escapeRegex was using wrong replacement string
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// =============================================================
// EXHAUSTION TRACKING (dual-limit aware)
// =============================================================
function _markExhausted(m, type) {
    type = type || 'sprint';
    for (const f of FALLBACK_MODELS) {
        if (m.indexOf(f) !== -1) {
            const existing = _cdpExhaustedModels[f];
            // Don't downgrade weekly to sprint
            if (existing && existing.type === 'weekly' && type === 'sprint') return;
            _cdpExhaustedModels[f] = { time: Date.now(), type: type };
            _recordRouteResult(f, false);
            console.log('[AG] Marked ' + f + ' as exhausted (' + type + ')');
            return;
        }
    }
}
function _isExhausted(m) {
    const n = Date.now();
    // Cleanup expired entries
    for (const k in _cdpExhaustedModels) {
        const entry = _cdpExhaustedModels[k];
        if (!entry || !entry.time) { delete _cdpExhaustedModels[k]; continue; }
        const ttl = entry.type === 'weekly' ? EXHAUSTED_TTL_WEEKLY : EXHAUSTED_TTL_SPRINT;
        if (n - entry.time > ttl) delete _cdpExhaustedModels[k];
    }
    return !!_cdpExhaustedModels[m];
}
function _getExhaustionType(m) {
    const entry = _cdpExhaustedModels[m];
    return entry ? entry.type : null;
}
function _countAvailable() {
    let c = 0;
    for (const f of FALLBACK_MODELS) { if (!_isExhausted(f)) c++; }
    return c;
}

// Adaptive cooldown: escalates on consecutive failures, resets on success
function _getCooldown() {
    // Reset escalation after 10 minutes of no hits
    if (Date.now() - _lastCooldownReset > 600000) {
        _cooldownLevel = 0;
        _lastCooldownReset = Date.now();
    }
    if (_countAvailable() === 0) return COOLDOWN_LEVELS[COOLDOWN_LEVELS.length - 1]; // max cooldown
    const level = Math.min(_cooldownLevel, COOLDOWN_LEVELS.length - 1);
    return COOLDOWN_LEVELS[level];
}
function _escalateCooldown() {
    _cooldownLevel = Math.min(_cooldownLevel + 1, COOLDOWN_LEVELS.length - 1);
}
function _resetCooldown() {
    _cooldownLevel = 0;
    _lastCooldownReset = Date.now();
}

// =============================================================
// ROUTING HISTORY & LEARNING
// =============================================================
function _recordRouteResult(model, success) {
    const entry = { time: Date.now(), model, success };
    _routeHistory.push(entry);
    if (_routeHistory.length > ROUTE_HISTORY_MAX) _routeHistory.shift();
    if (!_routeStats[model]) _routeStats[model] = { success: 0, fail: 0, lastUsed: 0 };
    if (success) _routeStats[model].success++;
    else _routeStats[model].fail++;
    _routeStats[model].lastUsed = Date.now();
}
function _getModelReliability(model) {
    const s = _routeStats[model];
    if (!s || (s.success + s.fail) === 0) return 0.5; // unknown = neutral
    return s.success / (s.success + s.fail);
}

// =============================================================
// TIER-AWARE FALLBACK (prefers same-tier, then adjacent tiers)
// =============================================================
const TIER_ORDER = ['extreme', 'high', 'default', 'cheap'];

function getNextFallbackModel(cur) {
    _markExhausted(cur, 'sprint');

    // Find current model's tier info
    let curTier = null, curFamily = null;
    for (const f of FALLBACK_MODELS) {
        if (cur.indexOf(f) !== -1) {
            const info = MODEL_TIERS[f];
            if (info) { curTier = info.tier; curFamily = info.family; }
            break;
        }
    }

    // Build candidates: available models sorted by preference
    const candidates = FALLBACK_MODELS.filter(m => !_isExhausted(m) && cur.indexOf(m) === -1);

    if (candidates.length === 0) {
        // All exhausted — pick the one exhausted longest ago
        let oldest = Infinity, pick = FALLBACK_MODELS[0];
        for (const k in _cdpExhaustedModels) {
            const entry = _cdpExhaustedModels[k];
            if (entry && entry.time < oldest) { oldest = entry.time; pick = k; }
        }
        return pick;
    }

    // Score each candidate
    const scored = candidates.map(m => {
        const info = MODEL_TIERS[m] || { tier: 'default', cost: 3, family: 'other' };
        let score = 100;

        // Prefer same tier (0 penalty), adjacent tier (-10 per step), far tier (-20 per step)
        if (curTier) {
            const curIdx = TIER_ORDER.indexOf(curTier);
            const mIdx = TIER_ORDER.indexOf(info.tier);
            const tierDist = Math.abs(curIdx - mIdx);
            score -= tierDist * 15;
        }

        // Prefer different family (quota pools are separate per family)
        if (curFamily && info.family !== curFamily) score += 20;

        // Prefer lower cost models (save quota)
        score -= info.cost * 2;

        // Prefer models with better reliability history
        const reliability = _getModelReliability(m);
        score += reliability * 15;

        // Penalize models that were recently used and failed
        const stats = _routeStats[m];
        if (stats && stats.lastUsed && (Date.now() - stats.lastUsed < 300000) && stats.fail > stats.success) {
            score -= 30;
        }

        return { model: m, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].model;
}

// =============================================================
// SMART ROUTER — Enhanced Tier evaluation (runs in Extension Host)
// =============================================================
const TIER_CHEAP = "Gemini 3 Flash (New)";
const TIER_DEFAULT = "Gemini 3.1 Pro (High)";
const TIER_HIGH = "Gemini 3.5 Pro";
const TIER_EXTREME = "Claude Opus 4.7 (Thinking)";

// Expanded regex patterns with framework keywords, Chinese, more Vietnamese
const REGEX_CHEAP = /(explain|giải thích|hỏi|comment|format|typo|spell|rename|lint|clean|tóm tắt|summary|translate|what is|là gì|解释|翻译|格式化|重命名|log|print|debug message|hello world|simple question|quick fix|minor|trivial)/i;
const REGEX_DEFAULT = /(implement|add|create|make|generate|build|write|code|function|class|module|component|api|service|route|controller|file|project|folder|directory|react|vue|angular|next\.?js|nuxt|svelte|express|fastapi|flask|django|spring|nest\.?js|laravel|rails|tạo|viết|thêm|xây dựng|创建|编写|生成|构建|添加)/i;
const REGEX_HIGH = /(database|sql|mongodb|postgres|mysql|redis|migration|schema|authentication|auth|oauth|jwt|security|ssl|tls|performance|optimize|benchmark|profil|test|testing|unit test|e2e|ci\/cd|pipeline|docker|kubernetes|k8s|infrastructure|devops|cloud|aws|gcp|azure|terraform|ansible|helm|graphql|websocket|grpc|caching|indexing|数据库|安全|性能|测试|部署)/i;
const REGEX_EXTREME = /(architecture|kiến trúc|design pattern|microservice|distributed|system design|enterprise|scale|scalab|ml|ai|machine learning|deep learning|neural|complex refactor|rewrite|legacy|monolith|event.?driven|cqrs|saga|domain.?driven|ddd|hexagonal|clean architecture|架构|设计模式|微服务|分布式|重构|migration strategy|data pipeline|streaming|kafka|rabbitmq|concurrent|parallel|thread|async pattern|state machine)/i;

// Token cost multipliers per tier
const TIER_COSTS = { cheap: 1, default: 3, high: 5, extreme: 10 };

function evaluateTargetModel(promptText) {
    if (!promptText || promptText.trim() === '') return TIER_DEFAULT;
    const trimmed = promptText.trim();

    // Length-based heuristics (improved thresholds)
    if (trimmed.length > 3000) return TIER_EXTREME;
    if (trimmed.length > 1500) {
        // Long prompt but check if it's just pasted code/logs
        const codeRatio = (trimmed.match(/[{}();=<>]/g) || []).length / trimmed.length;
        if (codeRatio > 0.05) return TIER_HIGH; // mostly code paste
        return TIER_EXTREME;
    }
    if (trimmed.length < 15) return TIER_CHEAP;

    // Regex-based tier detection (highest tier wins)
    if (REGEX_EXTREME.test(trimmed)) return TIER_EXTREME;
    if (REGEX_HIGH.test(trimmed)) return TIER_HIGH;
    if (REGEX_DEFAULT.test(trimmed)) return TIER_DEFAULT;
    if (REGEX_CHEAP.test(trimmed)) return TIER_CHEAP;

    // Default based on moderate length
    if (trimmed.length < 50) return TIER_CHEAP;
    return TIER_DEFAULT;
}

/** Find best available model for a tier, considering quota state */
function findBestModelForTier(targetTier) {
    // Tier preference order: exact match → adjacent → any available
    const tierModels = FALLBACK_MODELS.filter(m => {
        const info = MODEL_TIERS[m];
        return info && info.tier === targetTier && !_isExhausted(m);
    });
    if (tierModels.length > 0) {
        // Pick the one with best reliability
        tierModels.sort((a, b) => _getModelReliability(b) - _getModelReliability(a));
        return tierModels[0];
    }

    // No exact tier match — find closest available tier
    const targetIdx = TIER_ORDER.indexOf(targetTier);
    for (let dist = 1; dist < TIER_ORDER.length; dist++) {
        for (const dir of [-1, 1]) { // try higher tier first, then lower
            const idx = targetIdx + (dir * dist);
            if (idx < 0 || idx >= TIER_ORDER.length) continue;
            const adjTier = TIER_ORDER[idx];
            const adjModels = FALLBACK_MODELS.filter(m => {
                const info = MODEL_TIERS[m];
                return info && info.tier === adjTier && !_isExhausted(m);
            });
            if (adjModels.length > 0) {
                adjModels.sort((a, b) => _getModelReliability(b) - _getModelReliability(a));
                return adjModels[0];
            }
        }
    }

    // Everything exhausted — return the original tier target
    const tierMap = { cheap: TIER_CHEAP, default: TIER_DEFAULT, high: TIER_HIGH, extreme: TIER_EXTREME };
    return tierMap[targetTier] || TIER_DEFAULT;
}

/** Smart Route: evaluate prompt → quota-aware model selection → switch if needed */
async function handleSmartRoute(prompt) {
    if (!_cdpConnected) return { switched: false, reason: 'cdp_disconnected' };

    const rawTarget = evaluateTargetModel(prompt);
    const rawTierInfo = Object.entries(MODEL_TIERS).find(([m]) => rawTarget.indexOf(m) !== -1);
    const rawTier = rawTierInfo ? rawTierInfo[1].tier : 'default';

    // Quota-aware: if target model is exhausted, find best alternative in same tier
    let targetModel = rawTarget;
    if (_isExhausted(rawTarget)) {
        targetModel = findBestModelForTier(rawTier);
        console.log('[AG] Smart Route: target ' + rawTarget + ' exhausted, using ' + targetModel);
    }

    try {
        const cur = await cdpGetCurrentModel();
        if (!cur) return { switched: false, reason: 'model_not_found', target: targetModel };
        if (cur.indexOf(targetModel) !== -1) return { switched: false, reason: 'already_on_target', target: targetModel, current: cur };

        // Cost check: don't switch to more expensive model for short prompts
        const curInfo = Object.entries(MODEL_TIERS).find(([m]) => cur.indexOf(m) !== -1);
        const tgtInfo = MODEL_TIERS[targetModel];
        if (curInfo && tgtInfo && prompt.trim().length < 100) {
            if (tgtInfo.cost > curInfo[1].cost + 2) {
                // Prompt too short for expensive model, stay on current
                return { switched: false, reason: 'cost_skip', target: targetModel, current: cur };
            }
        }

        console.log('[AG] Smart Route: "' + cur.substring(0, 30) + '" -> ' + targetModel + ' (tier: ' + rawTier + ')');
        const ok = await cdpSwitchModel(targetModel);
        if (ok) _recordRouteResult(targetModel, true);
        return { switched: ok, target: targetModel, current: cur, tier: rawTier };
    } catch (e) {
        console.error('[AG] Smart Route error:', e.message);
        return { switched: false, reason: 'error', error: e.message, target: targetModel };
    }
}

// =============================================================
// CDP CORE: Browser-level persistent WebSocket
// =============================================================

/** Get browser WS endpoint from /json/version */
function cdpGetBrowserWsUrl() {
    return new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:' + CDP_PORT + '/json/version', res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).webSocketDebuggerUrl); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

/** Connect persistent WS to browser endpoint */
function cdpConnect() {
    return new Promise((resolve, reject) => {
        let WS;
        try { WS = require('ws'); } catch (_) { reject(new Error('ws not installed')); return; }
        cdpGetBrowserWsUrl().then(wsUrl => {
            if (_cdpWs) { try { _cdpWs.close(); } catch(_){} }
            _cdpWs = null; _cdpConnected = false; _cdpSessions = {}; _cdpAllSessionIds = new Set();
            const ws = new WS(wsUrl, { handshakeTimeout: 5000 });
            let ok = false;
            ws.on('open', () => {
                ok = true; _cdpWs = ws; _cdpConnected = true;
                console.log('[AG] CDP browser WS connected');
                resolve();
            });
            ws.on('message', data => {
                try {
                    const msg = JSON.parse(data.toString());
                    // Handle detached targets — clean up stale sessions
                    if (msg.method === 'Target.detachedFromTarget' && msg.params && msg.params.sessionId) {
                        _cdpAllSessionIds.delete(msg.params.sessionId);
                        for (const tid in _cdpSessions) {
                            if (_cdpSessions[tid] === msg.params.sessionId) { delete _cdpSessions[tid]; break; }
                        }
                    }
                    if (msg.method === 'Target.attachedToTarget' && msg.params && msg.params.sessionId) {
                        _cdpAllSessionIds.add(msg.params.sessionId);
                        cdpSend('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, msg.params.sessionId).catch(()=>{});
                    }
                    if (msg.id && _cdpCallbacks[msg.id]) {
                        const cb = _cdpCallbacks[msg.id]; delete _cdpCallbacks[msg.id];
                        if (msg.error) cb.reject(new Error(msg.error.message));
                        else cb.resolve(msg.result);
                    }
                } catch(_){}
            });
            ws.on('close', () => { _cdpConnected = false; _cdpWs = null; _cdpSessions = {}; _cdpAllSessionIds = new Set(); scheduleCdpReconnect(); });
            ws.on('error', e => { if (!ok) { ok = true; reject(e); } _cdpConnected = false; _cdpWs = null; });
            setTimeout(() => { if (!ok) { ok = true; ws.close(); reject(new Error('ws timeout')); } }, 6000);
        }).catch(reject);
    });
}

/** Send CDP command, optionally with sessionId for target-specific commands */
function cdpSend(method, params, sessionId) {
    return new Promise((resolve, reject) => {
        if (!_cdpWs || !_cdpConnected) { reject(new Error('not connected')); return; }
        const id = _cdpMsgId++;
        const msg = { id, method, params: params || {} };
        if (sessionId) msg.sessionId = sessionId;
        _cdpCallbacks[id] = { resolve, reject };
        try { _cdpWs.send(JSON.stringify(msg)); } catch (e) { delete _cdpCallbacks[id]; reject(e); return; }
        setTimeout(() => { if (_cdpCallbacks[id]) { delete _cdpCallbacks[id]; reject(new Error('timeout: ' + method)); } }, 10000);
    });
}

/** Get all webview targets via Target.getTargets */
async function cdpGetWebviewTargets() {
    if (!_cdpConnected) return [];
    try {
        const res = await cdpSend('Target.getTargets');
        const all = res.targetInfos || [];
        return all.filter(t => {
            const url = t.url || '';
            const type = t.type || '';
            const title = (t.title || '').toLowerCase();
            return (
                (type === 'page' || type === 'iframe' || type === 'webview') &&
                (url.startsWith('vscode-webview://') || 
                 url.includes('webview') ||
                 url.includes('workbench.html') ||
                 title.includes('antigravity') ||
                 title.includes('jetski') ||
                 title.includes('agent'))
            );
        });
    } catch (_) { return []; }
}

/** Attach to a target, get sessionId. Reuses existing session. */
async function cdpAttach(targetId) {
    if (_cdpSessions[targetId]) {
        // Verify session is still alive
        try {
            await cdpSend('Runtime.evaluate', { expression: '1', returnByValue: true }, _cdpSessions[targetId]);
            return _cdpSessions[targetId];
        } catch (_) {
            // Session is dead, clean up
            _cdpAllSessionIds.delete(_cdpSessions[targetId]);
            delete _cdpSessions[targetId];
        }
    }
    try {
        const res = await cdpSend('Target.attachToTarget', { targetId, flatten: true });
        const sid = res.sessionId;
        _cdpSessions[targetId] = sid;
        _cdpAllSessionIds.add(sid);
        await cdpSend('Runtime.enable', {}, sid);
        await cdpSend('Page.enable', {}, sid);
        await cdpSend('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(()=>{});
        return sid;
    } catch (e) {
        console.log('[AG] CDP attach failed for ' + targetId + ': ' + e.message);
        return null;
    }
}

/** Eval JS on a specific target via its sessionId */
async function cdpEvalOn(sessionId, expression) {
    try {
        const res = await cdpSend('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: true, userGesture: true
        }, sessionId);
        return (res && res.result) ? res.result.value : null;
    } catch (_) { return null; }
}

/** Eval JS on ALL webview targets, return array of {targetId, sessionId, value} */
async function cdpEvalAll(expression) {
    const targets = await cdpGetWebviewTargets();
    if (targets.length === 0) return [];
    const results = [];
    for (const t of targets) {
        const sid = await cdpAttach(t.targetId);
        if (!sid) continue;
        const val = await cdpEvalOn(sid, expression);
        results.push({ targetId: t.targetId, sessionId: sid, value: val, url: t.url, title: t.title });
    }
    return results;
}

/** Eval on all targets, return first truthy value */
async function cdpEvalFirst(expression) {
    const results = await cdpEvalAll(expression);
    for (const r of results) { if (r.value) return r; }
    return null;
}

/** Eval on all targets, return true if any returned true */
async function cdpEvalAny(expression) {
    const results = await cdpEvalAll(expression);
    return results.some(r => r.value === true);
}

/** Find Antigravity-specific webview targets */
async function cdpFindAGTargets() {
    if (!_cdpConnected) return [];
    try {
        const res = await cdpSend('Target.getTargets');
        const all = res.targetInfos || [];
        return all.filter(t => {
            const url = t.url || '';
            const title = (t.title || '').toLowerCase();
            return (
                url.includes('jetski') ||
                url.includes('agent') ||
                url.includes('antigravity') ||
                title.includes('jetski') ||
                title.includes('agent') ||
                title.includes('antigravity')
            );
        });
    } catch (_) { return []; }
}

/** Eval on Antigravity webview specifically */
async function cdpEvalOnAG(expression) {
    const targets = await cdpFindAGTargets();
    for (const t of targets) {
        const sid = await cdpAttach(t.targetId);
        if (!sid) continue;
        const val = await cdpEvalOn(sid, expression);
        if (val !== null && val !== undefined) return { targetId: t.targetId, sessionId: sid, value: val, url: t.url, title: t.title };
    }
    return null;
}

/** Init CDP connection */
async function initCdpConnection() {
    try {
        await cdpConnect();
        await cdpSend('Target.setDiscoverTargets', { discover: true });
        const targets = await cdpGetWebviewTargets();
        console.log('[AG] CDP ready, ' + targets.length + ' webview target(s)');
    } catch (e) {
        console.log('[AG] CDP connect failed: ' + e.message + '. Retry in 15s');
        _cdpConnected = false;
        scheduleCdpReconnect();
    }
}

function scheduleCdpReconnect() {
    if (_cdpReconnectTimer) return;
    _cdpReconnectTimer = setTimeout(() => {
        _cdpReconnectTimer = null;
        const cfg = vscode.workspace.getConfiguration('ag-auto');
        if (cfg.get('smartRouter', true) || cfg.get('quotaFallback', true)) initCdpConnection();
    }, 15000);
}

// =============================================================
// CDP DOM functions: quota, model switch, dismiss, continue
// =============================================================

/** Check for quota error — also detects weekly vs sprint limit */
async function cdpCheckQuotaError() {
    const js = '(function(){var p=' + JSON.stringify(QUOTA_PHRASES) + ';var t=(document.body&&document.body.innerText||"").toLowerCase();var found=[];for(var i=0;i<p.length;i++){if(t.indexOf(p[i])!==-1)found.push(p[i]);}return found.length>0?JSON.stringify(found):null;})()';
    const r = await cdpEvalOnAG(js);
    if (r && r.value) {
        try {
            const phrases = JSON.parse(r.value);
            // Detect weekly vs sprint
            const isWeekly = phrases.some(p => p.includes('weekly') || p.includes('baseline') || p.includes('credit'));
            return { detected: true, phrases, type: isWeekly ? 'weekly' : 'sprint' };
        } catch (_) { return { detected: true, phrases: [], type: 'sprint' }; }
    }
    // Fallback: check all webviews
    const js2 = '(function(){var p=' + JSON.stringify(QUOTA_PHRASES) + ';var t=(document.body&&document.body.innerText||"").toLowerCase();for(var i=0;i<p.length;i++){if(t.indexOf(p[i])!==-1)return true;}return false;})()';
    const any = await cdpEvalAny(js2);
    return any ? { detected: true, phrases: [], type: 'sprint' } : { detected: false };
}

/** Proactive quota monitoring — check quota bar levels */
async function cdpCheckQuotaLevel() {
    const js = '(function(){'
        + 'var bars=document.querySelectorAll("[class*=quota],[class*=progress],[class*=usage],[role=progressbar]");'
        + 'for(var i=0;i<bars.length;i++){'
        + 'var el=bars[i];var val=el.getAttribute("aria-valuenow")||el.getAttribute("value")||el.style.width;'
        + 'if(val){var n=parseFloat(val);if(!isNaN(n)){var max=parseFloat(el.getAttribute("aria-valuemax")||el.getAttribute("max")||"100");'
        + 'var pct=n/max*100;if(pct<20)return JSON.stringify({level:pct,low:true});}}'
        + '}return null;})()';
    const r = await cdpEvalOnAG(js);
    if (r && r.value) {
        try { return JSON.parse(r.value); } catch (_) {}
    }
    return null;
}

async function cdpDismissQuota() {
    const js = '(function(){var p=' + JSON.stringify(QUOTA_PHRASES) + ';var ok=false;'
        + 'var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);'
        + 'while(w.nextNode()){var v=(w.currentNode.nodeValue||"").toLowerCase();if(!v)continue;'
        + 'for(var q=0;q<p.length;q++){if(v.indexOf(p[q])!==-1){var el=w.currentNode.parentElement;'
        + 'for(var l=0;l<10&&el;l++){var bs=el.querySelectorAll("button,a.action-label,[role=button],.codicon-close,.codicon-notifications-clear");'
        + 'for(var b=0;b<bs.length;b++){var bt=(bs[b].innerText||bs[b].textContent||"").trim().toLowerCase();'
        + 'if(bt==="dismiss"||bt==="close"||bt==="ok"||bt==="got it"||bt==="understand"||bs[b].classList.contains("codicon-close")||bs[b].classList.contains("codicon-notifications-clear"))'
        + '{bs[b].click();ok=true;}}el=el.parentElement;}}}}'
        + 'var ts=document.querySelectorAll(".notifications-toasts .notification-toast,.notification-list-item,.notification-center-item");'
        + 'for(var i=0;i<ts.length;i++){var tt=(ts[i].textContent||"").toLowerCase();'
        + 'for(var q=0;q<p.length;q++){if(tt.indexOf(p[q])!==-1){var cb=ts[i].querySelector(".codicon-notifications-clear,.codicon-close,button[aria-label*=Clear],button[aria-label*=close],button[aria-label*=Dismiss]");'
        + 'if(cb){cb.click();ok=true;}}}}return ok;})()';
    await cdpEvalAll(js);
}

async function cdpGetCurrentModel() {
    const js = '(function(){var M=' + JSON.stringify(FALLBACK_MODELS) + ';var K=' + JSON.stringify(MODEL_KEYWORDS) + ';'
        + 'var selectors=["button","[role=button]","[role=combobox]","[role=listbox]","[role=menuitem]","[role=option]",".monaco-button",".monaco-dropdown",".monaco-select-box","select",'
        + '"[class*=model]","[class*=selector]","[class*=picker]","[class*=dropdown]","[class*=model-selector]","[class*=model-switcher]","[class*=provider]",'
        + '"[data-model]","[data-provider]","[data-testid*=model]","[aria-label*=model i]","[title*=model i]"];'
        + 'var c=document.querySelectorAll(selectors.join(","));'
        + 'for(var i=0;i<c.length;i++){var el=c[i];var t=(el.innerText||el.textContent||"").trim();'
        + 'if(!t||t.length>120||t.length<3)continue;'
        + 'for(var m=0;m<M.length;m++)if(t.indexOf(M[m])!==-1)return t;'
        + 'for(var k=0;k<K.length;k++)if(t.indexOf(K[k])!==-1)return t;'
        + 'var sel=el.querySelector(":scope > span, :scope > .label, :scope > .title");'
        + 'if(sel){var st=(sel.innerText||sel.textContent||"").trim();for(var m=0;m<M.length;m++)if(st.indexOf(M[m])!==-1)return st;}'
        + '}return null;})()';
    const r = await cdpEvalOnAG(js);
    if (r && r.value) { console.log('[AG] Found model in AG webview: ' + r.value); return r.value; }
    const r2 = await cdpEvalFirst(js);
    return r2 ? r2.value : null;
}

async function cdpClickModelSelector() {
    const js = '(function(){var M=' + JSON.stringify(FALLBACK_MODELS) + ';var K=' + JSON.stringify(MODEL_KEYWORDS) + ';'
        + 'var selectors=["button","[role=button]","[role=combobox]","[role=listbox]","[role=menuitem]","[role=option]",".monaco-button",".monaco-dropdown",".monaco-select-box",".monaco-action-bar",".select-box",'
        + '"[class*=model]","[class*=selector]","[class*=picker]","[class*=dropdown]","[class*=model-selector]","[class*=model-switcher]","[class*=provider]",'
        + '"[data-model]","[data-provider]","[data-testid*=model]","[aria-label*=model i]","[title*=model i]"];'
        + 'var c=document.querySelectorAll(selectors.join(","));'
        + 'for(var i=0;i<c.length;i++){var el=c[i];var t=(el.innerText||el.textContent||"").trim();'
        + 'if(!t||t.length>120||t.length<3)continue;'
        + 'for(var m=0;m<M.length;m++){if(t.indexOf(M[m])!==-1){if(el.offsetParent!==null){el.click();return true;}}}'
        + 'for(var k=0;k<K.length;k++){if(t.indexOf(K[k])!==-1){if(el.offsetParent!==null){el.click();return true;}}}'
        + 'var sel=el.querySelector(":scope > span, :scope > .label, :scope > .title");'
        + 'if(sel){var st=(sel.innerText||sel.textContent||"").trim();for(var m=0;m<M.length;m++)if(st.indexOf(M[m])!==-1&&el.offsetParent!==null){el.click();return true;}}'
        + '}return false;})()';
    return await cdpEvalAny(js);
}

async function cdpSelectModelInDropdown(targetModel) {
    const js = '(function(){var tgt=' + JSON.stringify(targetModel) + ';var sn=tgt.split(" ").slice(0,3).join(" ");'
        + 'var itemSelectors=["[role=menuitem]","[role=option]","[role=menu] [role=menuitem]","[role=listbox] [role=option]",'
        + '".monaco-list-row",".monaco-list-item",".action-item .action-label",".context-view .action-label",'
        + '".quick-input-list .monaco-list-row",".quick-pick-list .monaco-list-row",".select-dropdown-list .monaco-list-row",'
        + '"[class*=list-row]","[class*=dropdown-item]","[class*=menu-item]","[class*=option-item]","[class*=model-option]"];'
        + 'var items=document.querySelectorAll(itemSelectors.join(","));'
        + 'for(var i=0;i<items.length;i++){var t=(items[i].innerText||items[i].textContent||"").trim();'
        + 'if(t.indexOf(tgt)!==-1&&items[i].offsetParent!==null){items[i].click();return true;}}'
        + 'for(var i=0;i<items.length;i++){var t=(items[i].innerText||items[i].textContent||"").trim();'
        + 'if(sn&&t.indexOf(sn)!==-1&&items[i].offsetParent!==null){items[i].click();return true;}}'
        + 'var firstWord=tgt.split(" ")[0];'
        + 'for(var i=0;i<items.length;i++){var t=(items[i].innerText||items[i].textContent||"").trim();'
        + 'if(t.indexOf(firstWord)!==-1&&items[i].offsetParent!==null){items[i].click();return true;}}'
        + 'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:27,bubbles:true}));return false;})()';
    return await cdpEvalAny(js);
}

async function cdpSwitchModel(targetModel) {
    console.log('[AG] Attempting to switch model to: ' + targetModel);
    if (!(await cdpClickModelSelector())) {
        console.log('[AG] Failed to click model selector');
        return false;
    }
    console.log('[AG] Model selector clicked, searching for: ' + targetModel);
    for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (await cdpSelectModelInDropdown(targetModel)) {
            console.log('[AG] Model selection successful: ' + targetModel);
            // Update status bar with current model
            if (statusBarModel) {
                statusBarModel.text = '$(symbol-enum) ' + targetModel.split(' ').slice(0, 3).join(' ');
                statusBarModel.tooltip = 'Current model: ' + targetModel;
            }
            return true;
        }
    }
    console.log('[AG] Model selection failed after 12 attempts');
    return false;
}

async function cdpSendContinue() {
    const js = '(function(){var ta=document.querySelector("textarea");if(!ta)return false;ta.focus();'
        + 'var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value");'
        + 'if(s&&s.set)s.set.call(ta,"Continue");else ta.value="Continue";'
        + 'ta.dispatchEvent(new Event("input",{bubbles:true}));ta.dispatchEvent(new Event("change",{bubbles:true}));'
        + 'setTimeout(function(){var o={key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true};'
        + 'ta.dispatchEvent(new KeyboardEvent("keydown",o));ta.dispatchEvent(new KeyboardEvent("keypress",o));ta.dispatchEvent(new KeyboardEvent("keyup",o));'
        + 'setTimeout(function(){var bs=document.querySelectorAll("button,[role=button]");'
        + 'for(var i=0;i<bs.length;i++){var t=(bs[i].innerText||"").trim().toLowerCase();var a=(bs[i].getAttribute("aria-label")||"").toLowerCase();'
        + 'if(t==="send"||t==="submit"||a.indexOf("send")!==-1){if(bs[i].offsetParent!==null){bs[i].click();break;}}}},500);},800);return true;})()';
    await cdpEvalAll(js);
}

// =============================================================
// CDP Quota Fallback Polling (enhanced with dual-limit awareness)
// =============================================================
function startCdpQuotaFallback() {
    if (_quotaPollTimer) clearInterval(_quotaPollTimer);
    _quotaPollTimer = setInterval(async () => {
        const cfg = vscode.workspace.getConfiguration('ag-auto');
        if (!cfg.get('quotaFallback', true) || !cfg.get('enabled', true)) return;
        if (_cdpQuotaSwitchInProgress || !_cdpConnected) return;
        if (Date.now() - _cdpLastSwitchAt < _getCooldown()) return;
        try {
            // Check quota error with type detection
            const quotaResult = await cdpCheckQuotaError();
            if (!quotaResult.detected || _cdpQuotaSwitchInProgress) return;

            _cdpQuotaSwitchInProgress = true;
            _cdpLastSwitchAt = Date.now();
            _cdpConsecutiveHits++;
            _escalateCooldown();
            console.log('[AG] Quota error detected (#' + _cdpConsecutiveHits + ', type: ' + quotaResult.type + ')');

            // Dismiss quota notifications (3 attempts with delays)
            await cdpDismissQuota(); await new Promise(r => setTimeout(r, 600));
            await cdpDismissQuota(); await new Promise(r => setTimeout(r, 600));
            await cdpDismissQuota();

            const cur = await cdpGetCurrentModel();
            if (!cur) { _cdpQuotaSwitchInProgress = false; return; }

            // Mark with correct exhaustion type
            _markExhausted(cur, quotaResult.type);

            const tgt = getNextFallbackModel(cur);
            console.log('[AG] Switching "' + cur.substring(0, 30) + '" -> ' + tgt + ' (type: ' + quotaResult.type + ')');
            vscode.window.setStatusBarMessage('$(sync~spin) Switching to ' + tgt + '...', 5000);

            if (await cdpSwitchModel(tgt)) {
                vscode.window.setStatusBarMessage('$(check) Switched to ' + tgt, 3000);
                _resetCooldown();
                _cdpConsecutiveHits = 0;
                _recordRouteResult(tgt, true);
                await new Promise(r => setTimeout(r, 2000));
                await cdpSendContinue();
                await new Promise(r => setTimeout(r, 3000));
            } else {
                _recordRouteResult(tgt, false);
            }
            _cdpQuotaSwitchInProgress = false;
        } catch (e) {
            console.error('[AG] Quota poll error:', e.message);
            _cdpQuotaSwitchInProgress = false;
        }
    }, 2000);

    // Proactive quota monitoring (every 30s)
    setInterval(async () => {
        if (!_cdpConnected) return;
        const cfg = vscode.workspace.getConfiguration('ag-auto');
        if (!cfg.get('quotaFallback', true)) return;
        try {
            const level = await cdpCheckQuotaLevel();
            if (level && level.low) {
                console.log('[AG] Proactive: quota level low (' + level.level.toFixed(1) + '%)');
                vscode.window.setStatusBarMessage('$(warning) Quota low: ' + level.level.toFixed(0) + '%', 5000);
            }
        } catch (_) {}
    }, 30000);
}

// =============================================================
// SCRIPT BUILD & INJECT
// =============================================================
function buildScriptContent(ctx) {
    const c = vscode.workspace.getConfiguration('ag-auto');
    const dp = ctx.globalState.get('disabledClickPatterns', []);
    const pats = c.get('clickPatterns', ['Allow','Always Allow','Run','Keep Waiting','Accept all','Accept']).filter(p => !dp.includes(p) && p !== 'Accept');
    const tpl = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'autoScript.js'), 'utf8');
    const wb = getWorkbenchPath();
    const cfgPath = wb ? path.join(path.dirname(wb), 'ag-auto-config.json').replace(/\\/g, '/') : '';
    let s = tpl;
    s = s.replace(/\/\*\{\{PAUSE_SCROLL_MS\}\}\*\/\d+/, String(c.get('scrollPauseMs', 7000)));
    s = s.replace(/\/\*\{\{SCROLL_INTERVAL_MS\}\}\*\/\d+/, String(c.get('scrollIntervalMs', 500)));
    s = s.replace(/\/\*\{\{CLICK_INTERVAL_MS\}\}\*\/\d+/, String(c.get('clickIntervalMs', 1000)));
    s = s.replace(/\/\*\{\{CLICK_PATTERNS\}\}\*\/\[.*?\]/, JSON.stringify(pats));
    s = s.replace(/\/\*\{\{ENABLED\}\}\*\/\w+/, String(c.get('enabled', true)));
    s = s.replace(/\/\*\{\{CONFIG_PATH\}\}\*\//, cfgPath);
    s = s.replace(/\/\*\{\{SMART_ROUTER\}\}\*\/\w+/, String(c.get('smartRouter', true)));
    s = s.replace(/\/\*\{\{QUOTA_FALLBACK\}\}\*\/\w+/, String(c.get('quotaFallback', true)));
    return s;
}
function writeConfigJson(ctx) {
    try {
        const wb = getWorkbenchPath(); if (!wb) return;
        const c = vscode.workspace.getConfiguration('ag-auto');
        const dp = ctx.globalState.get('disabledClickPatterns', []);
        const ap = c.get('clickPatterns', ['Allow','Always Allow','Run','Keep Waiting','Accept']).filter(p => !dp.includes(p) && p !== 'Accept');
        writeFileElevated(path.join(path.dirname(wb), 'ag-auto-config.json'), JSON.stringify({
            enabled: c.get('enabled', true), clickPatterns: ap,
            acceptInChatOnly: c.get('clickPatterns', []).includes('Accept') && !dp.includes('Accept'),
            pauseScrollMs: c.get('scrollPauseMs', 7000), scrollIntervalMs: c.get('scrollIntervalMs', 500),
            clickIntervalMs: c.get('clickIntervalMs', 1000), smartRouter: c.get('smartRouter', true), quotaFallback: c.get('quotaFallback', true)
        }));
    } catch (e) { console.error('[AG] Config JSON error:', e.message); }
}
function installScript(ctx) {
    const wb = getWorkbenchPath();
    if (!wb) { vscode.window.showErrorMessage('[AG Autopilot] workbench.html not found!'); return false; }
    const dir = path.dirname(wb), sc = buildScriptContent(ctx);
    const JS_S = '/* AG-AUTO-CLICK-SCROLL-JS-START */', JS_E = '/* AG-AUTO-CLICK-SCROLL-JS-END */';
    try {
        const html = fs.readFileSync(wb, 'utf8');
        const sm = html.match(/src="([^"]*\.js)"/g) || [];
        const jsf = new Set();
        for (const m of sm) { const mm = m.match(/src="([^"]*\.js)"/); if (mm) { const n = path.basename(mm[1].split('?')[0]); if (n === 'ag-auto-script.js' || n === 'ag-modelswitch-client.js') continue; const s = path.join(dir, n); if (fs.existsSync(s)) jsf.add(s); const p1 = path.join(dir, '..', n); if (fs.existsSync(p1)) jsf.add(path.resolve(p1)); } }
        if (jsf.size === 0) { for (const n of ['workbench.desktop.main.js','workbench.js']) { const f = findRec(path.join(dir,'..'), n, 3); if (f) { jsf.add(f); break; } } }
        for (const jp of jsf) { let jc = fs.readFileSync(jp, 'utf8'); const jr = new RegExp(escapeRegex(JS_S)+'[\\s\\S]*?'+escapeRegex(JS_E), 'g'); if (jr.test(jc)) { jc = jc.replace(jr, ''); writeFileElevated(jp, jc); } }
    } catch (e) { console.error('[AG] Cleanup error:', e.message); }
    try {
        let h = fs.readFileSync(wb, 'utf8');
        for (const [s, e] of [[TAG_START, TAG_END], ...OLD_TAGS]) h = h.replace(new RegExp(escapeRegex(s)+'[\\s\\S]*?'+escapeRegex(e), 'g'), '');
        for (const f of ['ag-modelswitch-client.js','ag-auto-script.js']) { const p = path.join(dir, f); if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {} }
        writeFileElevated(path.join(dir, 'ag-auto-script.js'), sc);
        h = h.replace('</html>', '\n'+TAG_START+'\n<script src="ag-auto-script.js?v='+Date.now()+'"></script>\n'+TAG_END+'\n</html>');
        writeFileElevated(wb, h);
    } catch (e) { console.error('[AG] Inject error:', e.message); return false; }
    return true;
}
function updateChecksums() {
    try {
        let pjp = null;
        if (process.resourcesPath) { const c = path.join(process.resourcesPath,'app','product.json'); if (fs.existsSync(c)) pjp = c; }
        if (!pjp) { const w = getWorkbenchPath(); if (!w) return; let d = path.dirname(w); for (let i = 0; i < 8; i++) { const c = path.join(d,'product.json'); if (fs.existsSync(c)) { pjp = c; break; } d = path.dirname(d); } }
        if (!pjp) return;
        const pj = JSON.parse(fs.readFileSync(pjp, 'utf8')); if (!pj.checksums) return;
        const ar = path.dirname(pjp), od = path.join(ar, 'out'); let upd = false;
        for (const rp in pj.checksums) { const np = rp.split('/').join(path.sep); let fp = path.join(od, np); if (!fs.existsSync(fp)) fp = path.join(ar, np); if (fs.existsSync(fp)) { const h = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('base64').replace(/=+$/, ''); if (pj.checksums[rp] !== h) { pj.checksums[rp] = h; upd = true; } } }
        if (upd) writeFileElevated(pjp, JSON.stringify(pj, null, '\t'));
    } catch (_) {}
}
function clearCache() {
    try {
        let d;
        if (process.platform === 'win32') d = path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'), 'Antigravity','Code Cache','js');
        else if (process.platform === 'darwin') d = path.join(os.homedir(),'Library','Application Support','Antigravity','Code Cache','js');
        else d = path.join(os.homedir(),'.config','Antigravity','Code Cache','js');
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
}
function uninstallScript() {
    const wb = getWorkbenchPath(); if (!wb) return false;
    const dir = path.dirname(wb), JS_S = '/* AG-AUTO-CLICK-SCROLL-JS-START */', JS_E = '/* AG-AUTO-CLICK-SCROLL-JS-END */';
    try {
        let h = fs.readFileSync(wb, 'utf8');
        for (const [s, e] of [[TAG_START, TAG_END], ...OLD_TAGS]) h = h.replace(new RegExp(escapeRegex(s)+'[\\s\\S]*?'+escapeRegex(e), 'g'), '');
        writeFileElevated(wb, h);
        for (const f of ['ag-auto-script.js','ag-modelswitch-client.js']) { const p = path.join(dir, f); if (fs.existsSync(p)) fs.unlinkSync(p); }
        for (const n of ['workbench.desktop.main.js','workbench.js']) { const p = path.join(dir, n); if (fs.existsSync(p)) { let js = fs.readFileSync(p, 'utf8'); js = js.replace(new RegExp(escapeRegex(JS_S)+'[\\s\\S]*?'+escapeRegex(JS_E), 'g'), ''); writeFileElevated(p, js); } }
        return true;
    } catch (e) { vscode.window.showErrorMessage('[AG] Uninstall failed: ' + e.message); return false; }
}
function isInjected() { try { const w = getWorkbenchPath(); return w ? fs.readFileSync(w, 'utf8').includes(TAG_START) : false; } catch (_) { return false; } }

// =============================================================
// SETTINGS PANEL
// =============================================================
function openSettingsPanel(ctx) {
    if (_settingsPanel) { _settingsPanel.dispose(); _settingsPanel = null; return; }
    const panel = vscode.window.createWebviewPanel('agAutoSettings', 'AG Autopilot - Settings', vscode.ViewColumn.One, { enableScripts: true });
    _settingsPanel = panel;
    panel.onDidDispose(() => { _settingsPanel = null; });
    const c = vscode.workspace.getConfiguration('ag-auto');
    panel.webview.html = getSettingsHtml({
        enabled: c.get('enabled', true), scrollEnabled: c.get('scrollEnabled', true),
        smartRouter: c.get('smartRouter', true), quotaFallback: c.get('quotaFallback', true),
        scrollPauseMs: c.get('scrollPauseMs', 7000), scrollIntervalMs: c.get('scrollIntervalMs', 500),
        clickIntervalMs: c.get('clickIntervalMs', 1000),
        clickPatterns: c.get('clickPatterns', ['Allow','Always Allow','Run','Keep Waiting','Accept']),
        disabledClickPatterns: ctx.globalState.get('disabledClickPatterns', []),
        language: c.get('language', 'vi'), clickStats: _clickStats, totalClicks: _totalClicks
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
        const cfg = vscode.workspace.getConfiguration('ag-auto');
        if (msg.command === 'changeLang') {
            await cfg.update('language', msg.lang, vscode.ConfigurationTarget.Global);
            panel.webview.html = getSettingsHtml({ enabled: cfg.get('enabled', true), scrollEnabled: cfg.get('scrollEnabled', true), smartRouter: cfg.get('smartRouter', true), quotaFallback: cfg.get('quotaFallback', true), scrollPauseMs: cfg.get('scrollPauseMs', 7000), scrollIntervalMs: cfg.get('scrollIntervalMs', 500), clickIntervalMs: cfg.get('clickIntervalMs', 1000), clickPatterns: cfg.get('clickPatterns', ['Run','Allow','Always Allow','Keep Waiting','Accept']), disabledClickPatterns: ctx.globalState.get('disabledClickPatterns', []), language: msg.lang, clickStats: _clickStats, totalClicks: _totalClicks });
        }
        if (msg.command === 'toggle') { _autoAcceptEnabled = msg.enabled; await cfg.update('enabled', msg.enabled, vscode.ConfigurationTarget.Global); writeConfigJson(ctx); updateStatusBar(); }
        if (msg.command === 'scrollToggle') { _httpScrollEnabled = msg.enabled; await cfg.update('scrollEnabled', msg.enabled, vscode.ConfigurationTarget.Global); writeConfigJson(ctx); updateStatusBar(); }
        if (msg.command === 'routerToggle') { await cfg.update('smartRouter', msg.enabled, vscode.ConfigurationTarget.Global); writeConfigJson(ctx); }
        if (msg.command === 'quotaToggle') { await cfg.update('quotaFallback', msg.enabled, vscode.ConfigurationTarget.Global); writeConfigJson(ctx); }
        if (msg.command === 'save') {
            const d = msg.data;
            await cfg.update('enabled', d.enabled, vscode.ConfigurationTarget.Global);
            await cfg.update('scrollEnabled', d.scrollEnabled, vscode.ConfigurationTarget.Global);
            await cfg.update('scrollPauseMs', d.scrollPauseMs, vscode.ConfigurationTarget.Global);
            await cfg.update('scrollIntervalMs', d.scrollIntervalMs, vscode.ConfigurationTarget.Global);
            await cfg.update('clickIntervalMs', d.clickIntervalMs, vscode.ConfigurationTarget.Global);
            await cfg.update('clickPatterns', d.clickPatterns, vscode.ConfigurationTarget.Global);
            await cfg.update('smartRouter', d.smartRouter, vscode.ConfigurationTarget.Global);
            await cfg.update('quotaFallback', d.quotaFallback, vscode.ConfigurationTarget.Global);
            await ctx.globalState.update('disabledClickPatterns', d.disabledClickPatterns);
            try { await cfg.update('language', d.language, vscode.ConfigurationTarget.Global); } catch (_) {}
            _autoAcceptEnabled = d.enabled; _httpScrollEnabled = d.scrollEnabled !== false;
            _httpClickPatterns = d.clickPatterns.filter(p => !d.disabledClickPatterns.includes(p));
            writeConfigJson(ctx); updateStatusBar();
            vscode.window.setStatusBarMessage('$(check) [AG Autopilot] Saved!', 3000);
        }
        if (msg.command === 'reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
        if (msg.command === 'resetStats') { _clickStats = {}; _totalClicks = 0; ctx.globalState.update('clickStats', {}); ctx.globalState.update('totalClicks', 0); panel.webview.postMessage({ command: 'statsUpdated', clickStats: {}, totalClicks: 0 }); }
        if (msg.command === 'clearClickLog') { _clickLog = []; if (_extensionContext) _extensionContext.globalState.update('clickLog', []); panel.webview.postMessage({ command: 'clickLogUpdate', log: [] }); }
        if (msg.command === 'getClickLog') panel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
        if (msg.command === 'getStats') panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks });
    }, undefined, ctx.subscriptions);
    const st = setInterval(() => { try { panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks }); } catch (_) { clearInterval(st); } }, 2000);
    panel.onDidDispose(() => clearInterval(st));
}
function getSettingsHtml(cfg) {
    const lang = cfg.language || 'vi';
    let h = fs.readFileSync(path.join(__dirname, '..', 'media', 'settings.html'), 'utf8');
    h = h.replace(/\{\{LANG\}\}/g, lang);
    h = h.replace('{{TOTAL_CLICKS}}', String(cfg.totalClicks || 0));
    h = h.replace('{{ENABLED_CHK}}', cfg.enabled ? 'checked' : '');
    h = h.replace('{{SCROLL_CHK}}', cfg.scrollEnabled !== false ? 'checked' : '');
    h = h.replace('{{ROUTER_CHK}}', cfg.smartRouter ? 'checked' : '');
    h = h.replace('{{QUOTA_CHK}}', cfg.quotaFallback ? 'checked' : '');
    h = h.replace(/\{\{CLICK_MS\}\}/g, String(cfg.clickIntervalMs || 1000));
    h = h.replace(/\{\{SCROLL_MS\}\}/g, String(cfg.scrollIntervalMs || 500));
    h = h.replace(/\{\{PAUSE_MS\}\}/g, String(cfg.scrollPauseMs || 7000));
    h = h.replace('{{LANG_VI}}', lang === 'vi' ? 'selected' : '');
    h = h.replace('{{LANG_EN}}', lang === 'en' ? 'selected' : '');
    h = h.replace('{{LANG_ZH}}', lang === 'zh' ? 'selected' : '');
    h = h.replace('{{PATTERNS_JSON}}', JSON.stringify(cfg.clickPatterns));
    h = h.replace('{{DISABLED_JSON}}', JSON.stringify(cfg.disabledClickPatterns));
    h = h.replace('{{STATS_JSON}}', JSON.stringify(cfg.clickStats || {}));
    return h;
}

// =============================================================
// STATUS BAR + QUOTA HANDLER + QUICK PICK
// =============================================================
let statusBarClicks; // click counter on status bar

function createStatusBar(ctx) {
    if (statusBarItem) statusBarItem.dispose();
    if (statusBarScroll) statusBarScroll.dispose();
    if (statusBarQuota) statusBarQuota.dispose();
    if (statusBarModel) statusBarModel.dispose();
    if (statusBarClicks) statusBarClicks.dispose();

    // Main toggle: Accept ON/OFF
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    statusBarItem.command = 'ag-auto.openSettings'; ctx.subscriptions.push(statusBarItem);

    // Click counter
    statusBarClicks = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    statusBarClicks.command = 'ag-auto.openSettings';
    statusBarClicks.text = '$(target) ' + _totalClicks;
    statusBarClicks.tooltip = 'AG Autopilot: Total auto-clicks';
    statusBarClicks.color = '#f9e2af';
    ctx.subscriptions.push(statusBarClicks);

    // Scroll toggle
    statusBarScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10002);
    statusBarScroll.command = 'ag-auto.openSettings'; ctx.subscriptions.push(statusBarScroll);

    // Switch model button
    statusBarQuota = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10003);
    statusBarQuota.command = 'ag-auto.switchModel';
    statusBarQuota.text = '$(arrow-swap)';
    statusBarQuota.tooltip = 'AG Autopilot: Switch model (quota fallback)';
    statusBarQuota.color = '#f9e2af';
    ctx.subscriptions.push(statusBarQuota);

    // Current model indicator
    statusBarModel = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10004);
    statusBarModel.command = 'ag-auto.switchModel';
    statusBarModel.text = '$(symbol-enum) ...';
    statusBarModel.tooltip = 'Current AI model';
    statusBarModel.color = '#cba6f7';
    ctx.subscriptions.push(statusBarModel);

    updateStatusBar();
    statusBarItem.show(); statusBarClicks.show(); statusBarScroll.show();
    const cfg = vscode.workspace.getConfiguration('ag-auto');
    if (cfg.get('quotaFallback', true)) statusBarQuota.show();
    if (cfg.get('smartRouter', true) || cfg.get('quotaFallback', true)) statusBarModel.show();

    // Periodically update current model display
    const modelPoll = setInterval(async () => {
        if (!_cdpConnected || !statusBarModel) return;
        try {
            const cur = await cdpGetCurrentModel();
            if (cur && statusBarModel) {
                for (const m of FALLBACK_MODELS) {
                    if (cur.indexOf(m) !== -1) {
                        statusBarModel.text = '$(symbol-enum) ' + m.split(' ').slice(0, 3).join(' ');
                        statusBarModel.tooltip = 'Current model: ' + m;
                        break;
                    }
                }
            }
        } catch (_) {}
    }, 10000);
    ctx.subscriptions.push({ dispose: () => clearInterval(modelPoll) });
}
function updateStatusBar() {
    if (!statusBarItem || !statusBarScroll) return;
    statusBarItem.text = _autoAcceptEnabled ? '$(check) AG ON' : '$(circle-slash) AG OFF';
    statusBarItem.color = _autoAcceptEnabled ? '#4EC9B0' : '#F44747';
    statusBarItem.backgroundColor = _autoAcceptEnabled ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarScroll.text = _httpScrollEnabled ? '$(fold-down) Scroll' : '$(circle-slash) Scroll';
    statusBarScroll.color = _httpScrollEnabled ? '#4EC9B0' : '#F44747';
    statusBarScroll.backgroundColor = _httpScrollEnabled ? undefined : new vscode.ThemeColor('statusBarItem.errorBackground');
    if (statusBarClicks) statusBarClicks.text = '$(target) ' + _totalClicks;
}
function updateClickCounter() {
    if (statusBarClicks) statusBarClicks.text = '$(target) ' + _totalClicks;
}

async function handleQuotaSwitch() {
    const cfg = vscode.workspace.getConfiguration('ag-auto');
    if (!cfg.get('enabled', true)) return;
    if (_quotaSwitchInProgress) return;
    if (Date.now() - _cdpLastSwitchAt < _getCooldown()) return;
    _quotaSwitchInProgress = true;
    _cdpLastSwitchAt = Date.now();
    _cdpConsecutiveHits++;
    _escalateCooldown();
    console.log('[AG] Quota switch #' + _cdpConsecutiveHits);
    if (_cdpConnected) {
        try {
            await cdpDismissQuota(); await new Promise(r => setTimeout(r, 500)); await cdpDismissQuota();
            const cur = await cdpGetCurrentModel();
            if (cur) {
                const tgt = getNextFallbackModel(cur);
                vscode.window.setStatusBarMessage('$(sync~spin) Switching to ' + tgt + '...', 5000);
                if (await cdpSwitchModel(tgt)) {
                    vscode.window.setStatusBarMessage('$(check) Switched to ' + tgt, 3000);
                    _resetCooldown();
                    _cdpConsecutiveHits = 0;
                    await new Promise(r => setTimeout(r, 2000));
                    await cdpSendContinue();
                    await new Promise(r => setTimeout(r, 3000));
                    _quotaSwitchInProgress = false; return;
                }
            }
        } catch (_) {}
    }
    _quotaSwitchInProgress = false;
    showQuickPick();
}

async function showQuickPick() {
    const items = FALLBACK_MODELS.map(m => {
        const info = MODEL_TIERS[m] || {};
        const exhausted = _isExhausted(m);
        const exhaustType = _getExhaustionType(m);
        const reliability = _getModelReliability(m);
        let desc = exhausted ? ('exhausted (' + (exhaustType || 'sprint') + ')') : 'available';
        desc += ' | cost: ' + (info.cost || '?') + ' | reliability: ' + (reliability * 100).toFixed(0) + '%';
        return {
            label: exhausted ? '$(circle-slash) ' + m : '$(check) ' + m,
            description: desc,
            detail: info.family ? ('Family: ' + info.family + ' | Tier: ' + (info.tier || '?')) : '',
            model: m, exhausted
        };
    });
    items.sort((a, b) => a.exhausted - b.exhausted);
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select model (sorted by availability)', title: 'AG Autopilot — Switch Model', matchOnDescription: true, matchOnDetail: true });
    if (!pick) return;
    vscode.window.setStatusBarMessage('$(sync~spin) Switch to: ' + pick.model, 10000);
    try { if (await cdpSwitchModel(pick.model)) { vscode.window.setStatusBarMessage('$(check) Switched to ' + pick.model, 3000); return; } } catch (_) {}
    await vscode.env.clipboard.writeText('Continue');
    vscode.window.showInformationMessage('Switch to ' + pick.model + ' manually, then paste "Continue" (copied)', 'OK');
}

// =============================================================
// HTTP SERVER
// =============================================================
function startHttpServer() {
    if (_httpServer) return;
    const cfg = vscode.workspace.getConfiguration('ag-auto');
    _httpClickPatterns = cfg.get('clickPatterns', ['Allow','Always Allow','Run','Keep Waiting','Accept']);
    ['Run','Allow','Accept','Always Allow','Keep Waiting','Retry','Continue','Allow Once','Allow This Con'].forEach(p => { if (!_httpClickPatterns.includes(p)) _httpClickPatterns.push(p); });
    _httpScrollEnabled = cfg.get('scrollEnabled', true);
    _httpScrollConfig = { pauseScrollMs: cfg.get('scrollPauseMs', 5000), scrollIntervalMs: cfg.get('scrollIntervalMs', 500), clickIntervalMs: cfg.get('clickIntervalMs', 2000) };
    try {
        const url = require('url');
        _httpServer = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
            const parsed = url.parse(req.url, true);
            if (parsed.query && parsed.query.stats) {
                try { const inc = JSON.parse(decodeURIComponent(parsed.query.stats)); for (const k in inc) { if (!_clickStats[k]) _clickStats[k] = 0; _clickStats[k] += inc[k]; } let t = 0; for (const k in _clickStats) t += _clickStats[k]; _totalClicks = t; updateClickCounter(); if (_extensionContext) { _extensionContext.globalState.update('clickStats', _clickStats); _extensionContext.globalState.update('totalClicks', _totalClicks); } } catch (_) {}
            }
            if (parsed.pathname === '/ag-reset-stats') { _clickStats = {}; _totalClicks = 0; res.writeHead(200); res.end(JSON.stringify({ reset: true })); return; }
            if (parsed.pathname === '/api/click-log' && req.method === 'POST') {
                let body = ''; req.on('data', c => body += c);
                req.on('end', () => {
                    try { const d = JSON.parse(body); const now = new Date(); const ts = [now.getHours(),now.getMinutes(),now.getSeconds()].map(n=>n<10?'0'+n:n).join(':')+' '+[now.getDate(),now.getMonth()+1].map(n=>n<10?'0'+n:n).join('/'); const entry = { time: ts, pattern: d.pattern || 'click', button: (d.button || '').substring(0, 80) }; _clickLog.unshift(entry); if (_clickLog.length > 50) _clickLog.pop(); if (_extensionContext) _extensionContext.globalState.update('clickLog', _clickLog); if (_settingsPanel) _settingsPanel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog }); res.writeHead(200); res.end(JSON.stringify({ logged: true })); } catch (e) { res.writeHead(200); res.end(JSON.stringify({ error: e.message })); }
                }); return;
            }
            if (parsed.pathname === '/api/cdp-switch-model' && req.method === 'POST') {
                let body = ''; req.on('data', c => body += c);
                req.on('end', () => {
                    try { const d = JSON.parse(body); if (d.targetModel) { cdpSwitchModel(d.targetModel).then(ok => { res.writeHead(200); res.end(JSON.stringify({ success: ok })); }).catch(() => { res.writeHead(200); res.end(JSON.stringify({ success: false })); }); return; } res.writeHead(200); res.end(JSON.stringify({ success: false })); } catch (e) { res.writeHead(200); res.end(JSON.stringify({ error: e.message })); }
                }); return;
            }
            if (parsed.pathname === '/api/cdp-status') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    connected: _cdpConnected,
                    exhaustedModels: Object.keys(_cdpExhaustedModels),
                    availableCount: _countAvailable(),
                    cooldown: _getCooldown(),
                    consecutiveHits: _cdpConsecutiveHits
                }));
                return;
            }
            if (parsed.pathname === '/api/smart-route' && req.method === 'POST') {
                let body = ''; req.on('data', c => body += c);
                req.on('end', async () => {
                    try {
                        const d = JSON.parse(body);
                        if (d.prompt) {
                            const result = await handleSmartRoute(d.prompt);
                            res.writeHead(200); res.end(JSON.stringify(result));
                        } else {
                            res.writeHead(200); res.end(JSON.stringify({ switched: false, reason: 'no_prompt' }));
                        }
                    } catch (e) { res.writeHead(200); res.end(JSON.stringify({ switched: false, error: e.message })); }
                }); return;
            }
            // New: route stats endpoint
            if (parsed.pathname === '/api/route-stats') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    routeHistory: _routeHistory.slice(-20),
                    routeStats: _routeStats,
                    exhaustedModels: Object.entries(_cdpExhaustedModels).map(([m, e]) => ({ model: m, type: e.type, since: e.time })),
                    cooldownLevel: _cooldownLevel,
                    currentCooldown: _getCooldown()
                }));
                return;
            }
            res.writeHead(200);
            const agCfg = vscode.workspace.getConfiguration('ag-auto');
            const resp = { enabled: _autoAcceptEnabled, scrollEnabled: _httpScrollEnabled, clickPatterns: _httpClickPatterns.filter(p => p !== 'Accept'), acceptInChatOnly: _httpClickPatterns.includes('Accept'), pauseScrollMs: _httpScrollConfig.pauseScrollMs, scrollIntervalMs: _httpScrollConfig.scrollIntervalMs, clickIntervalMs: _httpScrollConfig.clickIntervalMs, smartRouter: agCfg.get('smartRouter', true), quotaFallback: agCfg.get('quotaFallback', true), cdpConnected: _cdpConnected, clickStats: _clickStats, totalClicks: _totalClicks };
            if (_resetStatsRequested) { resp.resetStats = true; _resetStatsRequested = false; }
            res.end(JSON.stringify(resp));
        });
        function tryPort(port) {
            if (port > AG_HTTP_PORT_END) return;
            _httpServer.removeAllListeners('error');
            _httpServer.once('error', e => { if (e.code === 'EADDRINUSE') tryPort(port + 1); });
            _httpServer.listen(port, '127.0.0.1', () => {
                _actualPort = port; console.log('[AG] HTTP on port ' + port);
                try { const w = getWorkbenchPath(); if (w) { const d = path.dirname(w); fs.writeFileSync(path.join(d, 'ag-auto-port-' + process.pid + '.txt'), String(port), 'utf8'); const lf = path.join(d, 'ag-auto-ports.json'); let pl = []; try { pl = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch (_) {} pl = pl.filter(e => e.pid !== process.pid); pl.push({ pid: process.pid, port, time: Date.now() }); fs.writeFileSync(lf, JSON.stringify(pl), 'utf8'); } } catch (_) {}
            });
        }
        tryPort(AG_HTTP_PORT_START);
    } catch (e) { console.log('[AG] HTTP server failed:', e.message); }
}

async function cdpAutoClick() {
    if (!_cdpConnected) return null;
    const pats = _httpClickPatterns || [];
    if (pats.length === 0) return null;
    
    const js = `(function(){
        try {
            var pats = ${JSON.stringify(pats)};
            var rejects = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];
            
            function searchWindow(w) {
                try {
                    var clickables = w.document.querySelectorAll('button, [role="button"], [class*="button"], vscode-button');
                    var hasReject = false;
                    for (var i=0; i<clickables.length; i++) {
                        if (clickables[i].offsetParent === null) continue;
                        var t = (clickables[i].innerText || clickables[i].textContent || '').trim();
                        for(var r=0; r<rejects.length; r++) {
                            if (t === rejects[r] || t.indexOf(rejects[r])===0 || t.indexOf(rejects[r]+"\\\\n")===0 || t.indexOf(rejects[r]+"\\n")===0) { hasReject = true; break; }
                        }
                        if(hasReject) break;
                    }

                    for(var i=0; i<clickables.length; i++) {
                        var b = clickables[i];
                        if (b.offsetParent === null) continue;
                        var text = (b.innerText || b.textContent || '').trim();
                        if (!text || text.length > 50) continue;
                        
                        var matchedPattern = null;
                        for(var p=0; p<pats.length; p++) {
                            if (text === pats[p] || text.indexOf(pats[p]) === 0 || text.indexOf(pats[p]+"\\\\n")===0 || text.indexOf(pats[p]+"\\n")===0) { 
                                matchedPattern = pats[p]; break; 
                            }
                        }
                        if (!matchedPattern) continue;

                        if (matchedPattern.indexOf('Accept') !== -1 || matchedPattern.indexOf('Allow') !== -1 || matchedPattern.indexOf('Run') !== -1 || hasReject) {
                            var evtOptions = { bubbles: true, cancelable: true, view: w, clientX: 1, clientY: 1 };
                            b.dispatchEvent(new MouseEvent('mousedown', evtOptions));
                            b.dispatchEvent(new MouseEvent('mouseup', evtOptions));
                            b.click();
                            return matchedPattern;
                        }
                    }
                } catch(e) {}
                
                try {
                    for(var k=0; k<w.frames.length; k++) {
                        var res = searchWindow(w.frames[k]);
                        if (res) return res;
                    }
                } catch(e) {}
                
                return null;
            }
            
            return searchWindow(window);
        } catch(_) {}
        return null;
    })()`;
    
    try {
        for (const t of await cdpGetWebviewTargets()) {
            await cdpAttach(t.targetId);
        }
        
        if (typeof _cdpAllSessionIds !== 'undefined') {
            for (const sid of Array.from(_cdpAllSessionIds)) {
                try {
                    const val = await cdpEvalOn(sid, js);
                    if (val && typeof val === 'string') {
                        console.log('[AG] CDP Auto Clicked inside session:', sid, 'val:', val);
                        return val;
                    }
                } catch(_) {}
            }
        }
    } catch(_) {}
    return null;
}

function startCommandsLoop() {
    const c = vscode.workspace.getConfiguration('ag-auto');
    _autoAcceptEnabled = c.get('enabled', true);
    const ms = c.get('clickIntervalMs', 2000);
    if (_autoAcceptInterval) clearInterval(_autoAcceptInterval);
    _autoAcceptInterval = setInterval(async () => {
        if (!_autoAcceptEnabled) return;
        
        // 1. Classic command loop for editor level accept
        if (_httpClickPatterns.some(p => p.toLowerCase().includes('accept'))) {
            Promise.allSettled(CHAT_ACCEPT_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))).catch(() => {});
        }
        
        // 2. CDP Auto Click for webview inline commands
        if (_cdpConnected) {
            const clicked = await cdpAutoClick();
            if (clicked) {
                _totalClicks++;
                updateClickCounter();
                if (!_clickStats[clicked]) _clickStats[clicked] = 0;
                _clickStats[clicked]++;
                if (_extensionContext) {
                    _extensionContext.globalState.update('clickStats', _clickStats);
                    _extensionContext.globalState.update('totalClicks', _totalClicks);
                }
                const now = new Date();
                const ts = [now.getHours(),now.getMinutes(),now.getSeconds()].map(n=>n<10?'0'+n:n).join(':')+' '+[now.getDate(),now.getMonth()+1].map(n=>n<10?'0'+n:n).join('/');
                const msg = { time: ts, pattern: clicked, button: clicked };
                _clickLog.unshift(msg); if (_clickLog.length > 50) _clickLog.pop();
                if (_extensionContext) _extensionContext.globalState.update('clickLog', _clickLog);
                if (_settingsPanel) _settingsPanel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
            }
        }
    }, ms);
}

// =============================================================
// ACTIVATE / DEACTIVATE
// =============================================================
function activate(ctx) {
    console.log('[AG] Activating v' + ((ctx.extension && ctx.extension.packageJSON) ? ctx.extension.packageJSON.version : '1.x'));
    _extensionContext = ctx;
    _clickStats = ctx.globalState.get('clickStats', {});
    _totalClicks = ctx.globalState.get('totalClicks', 0);
    const sl = ctx.globalState.get('clickLog', []);
    if (sl && sl.length > 0) _clickLog = sl;

    // Restore routing stats from previous session
    const savedRouteStats = ctx.globalState.get('routeStats', {});
    if (savedRouteStats && Object.keys(savedRouteStats).length > 0) _routeStats = savedRouteStats;
    const savedExhausted = ctx.globalState.get('exhaustedModels', {});
    if (savedExhausted && Object.keys(savedExhausted).length > 0) {
        // Only restore entries that haven't expired
        const now = Date.now();
        for (const k in savedExhausted) {
            const entry = savedExhausted[k];
            if (entry && entry.time) {
                const ttl = entry.type === 'weekly' ? EXHAUSTED_TTL_WEEKLY : EXHAUSTED_TTL_SPRINT;
                if (now - entry.time < ttl) _cdpExhaustedModels[k] = entry;
            }
        }
    }

    // Win32 Keep Waiting
    if (process.platform === 'win32') {
        const { execFile } = require('child_process');
        const ps = 'Add-Type @"\nusing System;using System.Text;using System.Runtime.InteropServices;\npublic class AgWin32{\npublic delegate bool EnumWindowsProc(IntPtr hWnd,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr hwnd,EnumWindowsProc cb,IntPtr lParam);\n[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern int GetClassName(IntPtr hWnd,StringBuilder s,int n);\n[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);\n[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hWnd,uint Msg,IntPtr w,IntPtr l);\n}\n"@\n$global:clicked=$false\n[AgWin32]::EnumWindows({param($hWnd,$lp)\nif(-not [AgWin32]::IsWindowVisible($hWnd)){return $true}\nif($global:clicked){return $false}\n[AgWin32]::EnumChildWindows($hWnd,{param($ch,$lp2)\n$cls=New-Object System.Text.StringBuilder 64\n[AgWin32]::GetClassName($ch,$cls,64)|Out-Null\nif($cls.ToString() -eq \'Button\'){$txt=New-Object System.Text.StringBuilder 256\n[AgWin32]::GetWindowText($ch,$txt,256)|Out-Null\nif($txt.ToString() -match \'Keep Waiting\'){[AgWin32]::PostMessage($ch,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero);$global:clicked=$true}}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){return $false}\nreturn $true},[IntPtr]::Zero)|Out-Null\nif($global:clicked){Write-Output \'CLICKED\'}';
        const kwi = setInterval(() => {
            if (!_autoAcceptEnabled || !_httpClickPatterns.includes('Keep Waiting')) return;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 5000 }, (err, stdout) => {
                if (stdout && stdout.trim() === 'CLICKED') { _totalClicks++; updateClickCounter(); if (!_clickStats['Keep Waiting']) _clickStats['Keep Waiting'] = 0; _clickStats['Keep Waiting']++; if (_extensionContext) { _extensionContext.globalState.update('clickStats', _clickStats); _extensionContext.globalState.update('totalClicks', _totalClicks); } }
            });
        }, 3000);
        ctx.subscriptions.push({ dispose: () => clearInterval(kwi) });
    }

    // Inject
    const ver = (ctx.extension && ctx.extension.packageJSON) ? ctx.extension.packageJSON.version : '0';
    const lastVer = ctx.globalState.get('ag-injected-version', '0');
    if (!isInjected() || ver !== lastVer) {
        try { installScript(ctx); ctx.globalState.update('ag-injected-version', ver); clearCache(); updateChecksums(); setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 1000); } catch (e) { console.error('[AG] Inject error:', e.message); }
    } else {
        try { const wb = getWorkbenchPath(); if (wb) writeFileElevated(path.join(path.dirname(wb), 'ag-auto-script.js'), buildScriptContent(ctx)); } catch (_) {}
        updateChecksums();
    }
    startHttpServer(); startCommandsLoop(); writeConfigJson(ctx);

    // CDP init
    const cfg = vscode.workspace.getConfiguration('ag-auto');
    if (cfg.get('smartRouter', true) || cfg.get('quotaFallback', true)) {
        setTimeout(() => { initCdpConnection().then(() => startCdpQuotaFallback()); }, 5000);
    }
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('ag-auto.smartRouter') || e.affectsConfiguration('ag-auto.quotaFallback')) {
            const nc = vscode.workspace.getConfiguration('ag-auto');
            if (nc.get('smartRouter', true) || nc.get('quotaFallback', true)) {
                if (!_cdpConnected) initCdpConnection().then(() => startCdpQuotaFallback());
            }
        }
    }));

    // Persist routing stats periodically
    const persistTimer = setInterval(() => {
        if (_extensionContext) {
            _extensionContext.globalState.update('routeStats', _routeStats);
            _extensionContext.globalState.update('exhaustedModels', _cdpExhaustedModels);
        }
    }, 60000);
    ctx.subscriptions.push({ dispose: () => clearInterval(persistTimer) });

    createStatusBar(ctx);
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ag-auto')) updateStatusBar(); }));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.enable', async () => {
        if (installScript(ctx)) { updateStatusBar(); const c = await vscode.window.showInformationMessage('[AG Autopilot] Injected! Reload to activate.', 'Reload Now'); if (c === 'Reload Now') vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    }));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.disable', async () => {
        if (uninstallScript()) { updateStatusBar(); const c = await vscode.window.showInformationMessage('[AG Autopilot] Removed! Reload to finish.', 'Reload Now'); if (c === 'Reload Now') vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    }));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.openSettings', () => openSettingsPanel(ctx)));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.switchModel', () => handleQuotaSwitch()));
    ctx.subscriptions.push(vscode.commands.registerCommand('ag-auto.debugCdp', () => debugCdpDom()));
}

function deactivate() {
    // Persist state before shutdown
    if (_extensionContext) {
        _extensionContext.globalState.update('routeStats', _routeStats);
        _extensionContext.globalState.update('exhaustedModels', _cdpExhaustedModels);
    }
    if (statusBarItem) { statusBarItem.dispose(); statusBarItem = null; }
    if (statusBarClicks) { statusBarClicks.dispose(); statusBarClicks = null; }
    if (statusBarScroll) { statusBarScroll.dispose(); statusBarScroll = null; }
    if (statusBarQuota) { statusBarQuota.dispose(); statusBarQuota = null; }
    if (statusBarModel) { statusBarModel.dispose(); statusBarModel = null; }
    if (_cdpWs) { try { _cdpWs.close(); } catch (_) {} _cdpWs = null; }
    _cdpConnected = false; _cdpSessions = {};
    if (_cdpReconnectTimer) { clearTimeout(_cdpReconnectTimer); _cdpReconnectTimer = null; }
    if (_quotaPollTimer) { clearInterval(_quotaPollTimer); _quotaPollTimer = null; }
    if (_autoAcceptInterval) { clearInterval(_autoAcceptInterval); _autoAcceptInterval = null; }
    if (_httpServer) { try { _httpServer.close(); } catch (_) {} _httpServer = null; }
    try {
        const w = getWorkbenchPath();
        if (w) {
            const d = path.dirname(w);
            const pf = path.join(d, 'ag-auto-port-' + process.pid + '.txt');
            if (fs.existsSync(pf)) fs.unlinkSync(pf);
            const lf = path.join(d, 'ag-auto-ports.json');
            try { let pl = JSON.parse(fs.readFileSync(lf, 'utf8')); pl = pl.filter(e => e.pid !== process.pid); fs.writeFileSync(lf, JSON.stringify(pl), 'utf8'); } catch (_) {}
        }
    } catch (_) {}
}

module.exports = { activate, deactivate };

// =============================================================
// DEBUG: Dump DOM from all CDP targets for troubleshooting
// =============================================================
async function debugCdpDom() {
    if (!_cdpConnected) {
        vscode.window.showWarningMessage('[AG] CDP not connected. Is Antigravity running with --remote-debugging-port=9333?');
        return;
    }
    const output = vscode.window.createOutputChannel('AG Autopilot Debug');
    output.show();
    output.appendLine('=== AG Autopilot v6.0.0 CDP Debug ===');
    output.appendLine('Time: ' + new Date().toISOString());
    output.appendLine('');

    // Routing stats
    output.appendLine('--- ROUTING STATS ---');
    output.appendLine('Cooldown level: ' + _cooldownLevel + ' (' + _getCooldown() + 'ms)');
    output.appendLine('Consecutive hits: ' + _cdpConsecutiveHits);
    output.appendLine('Available models: ' + _countAvailable() + '/' + FALLBACK_MODELS.length);
    output.appendLine('Exhausted: ' + JSON.stringify(Object.entries(_cdpExhaustedModels).map(([m, e]) => m + ' (' + e.type + ')')));
    output.appendLine('Route stats: ' + JSON.stringify(_routeStats));
    output.appendLine('');

    try {
        const res = await cdpSend('Target.getTargets');
        const all = res.targetInfos || [];
        output.appendLine('--- ALL TARGETS (' + all.length + ') ---');
        for (const t of all) {
            output.appendLine('  type=' + t.type + ' title="' + (t.title||'').substring(0,60) + '" url=' + (t.url||'').substring(0,80) + ' id=' + t.targetId);
        }
        output.appendLine('');

        const webviews = all.filter(t => t.url && (t.url.startsWith('vscode-webview://') || t.type === 'iframe'));
        output.appendLine('--- WEBVIEW TARGETS (' + webviews.length + ') ---');

        for (const t of webviews) {
            output.appendLine('');
            output.appendLine('>> Target: ' + t.targetId);
            output.appendLine('   URL: ' + (t.url || ''));
            output.appendLine('   Title: ' + (t.title || ''));

            const sid = await cdpAttach(t.targetId);
            if (!sid) { output.appendLine('   FAILED to attach'); continue; }

            const btnJs = '(function(){var r=[];var bs=document.querySelectorAll("button,[role=button],[role=combobox],[role=listbox],a.action-label,.monaco-button,.codicon-close,.codicon-notifications-clear");for(var i=0;i<bs.length;i++){var t=(bs[i].innerText||bs[i].textContent||"").trim();var cl=bs[i].className||"";var ar=bs[i].getAttribute("aria-label")||"";var ro=bs[i].getAttribute("role")||"";if(t||ar||cl.indexOf("codicon")!==-1)r.push({tag:bs[i].tagName,text:t.substring(0,80),class:cl.substring(0,100),aria:ar.substring(0,60),role:ro});}return JSON.stringify(r);})()';
            const btns = await cdpEvalOn(sid, btnJs);
            output.appendLine('   BUTTONS: ' + (btns || 'null'));

            const bodyJs = '(function(){return (document.body&&document.body.innerText||"").substring(0,500);})()';
            const body = await cdpEvalOn(sid, bodyJs);
            output.appendLine('   BODY TEXT (500): ' + (body || 'null'));

            const quotaJs = '(function(){var p=' + JSON.stringify(QUOTA_PHRASES) + ';var t=(document.body&&document.body.innerText||"").toLowerCase();var found=[];for(var i=0;i<p.length;i++){if(t.indexOf(p[i])!==-1)found.push(p[i]);}return JSON.stringify(found);})()';
            const quota = await cdpEvalOn(sid, quotaJs);
            output.appendLine('   QUOTA PHRASES FOUND: ' + (quota || '[]'));

            const modelJs = '(function(){var M=' + JSON.stringify(FALLBACK_MODELS) + ';var K=' + JSON.stringify(MODEL_KEYWORDS) + ';var found=[];var c=document.querySelectorAll("button,[role=button],[role=combobox],[role=listbox],.monaco-button,.monaco-dropdown,select,[class*=model],[class*=selector],[class*=picker],[class*=dropdown]");for(var i=0;i<c.length;i++){var t=(c[i].innerText||c[i].textContent||"").trim();if(!t||t.length>100)continue;for(var m=0;m<M.length;m++)if(t.indexOf(M[m])!==-1)found.push("EXACT:"+t.substring(0,60));for(var k=0;k<K.length;k++)if(t.indexOf(K[k])!==-1&&found.indexOf("KW:"+t.substring(0,60))===-1)found.push("KW:"+t.substring(0,60));}return JSON.stringify(found);})()';
            const models = await cdpEvalOn(sid, modelJs);
            output.appendLine('   MODEL ELEMENTS: ' + (models || '[]'));

            const toastJs = '(function(){var r=[];var ts=document.querySelectorAll(".notifications-toasts .notification-toast,.notification-list-item,.notification-center-item");for(var i=0;i<ts.length;i++){r.push(ts[i].textContent.substring(0,200));}return JSON.stringify(r);})()';
            const toasts = await cdpEvalOn(sid, toastJs);
            output.appendLine('   TOASTS: ' + (toasts || '[]'));
        }
    } catch (e) {
        output.appendLine('ERROR: ' + e.message);
    }

    output.appendLine('');
    output.appendLine('=== END DEBUG ===');
    vscode.window.showInformationMessage('[AG] Debug output written to "AG Autopilot Debug" channel.');
}
