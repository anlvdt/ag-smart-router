'use strict';

const http = require('http');

// Antigravity Language Server runs on localhost, ports 49100-49200 range
// It exposes quota data via internal API endpoints
const LS_PORTS = [49152, 49153, 49154, 49155, 49160, 49170, 49180, 49190, 49200];
const POLL_MS = 30000; // 30s between polls
const HISTORY_MAX = 120; // 2 hours of 1-min samples

let _port = 0;
let _timer = null;
let _data = { models: {}, credits: null, lastPoll: 0, error: null };
let _history = []; // [{ ts, totalUsedPct }]
let _onChange = null;

function init(opts = {}) {
    _onChange = opts.onChange || null;
    discover();
    _timer = setInterval(poll, POLL_MS);
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

function getData() { return _data; }
function getHistory() { return _history; }

// Discover Antigravity Language Server port
async function discover() {
    for (const port of LS_PORTS) {
        try {
            const res = await httpGet(`http://127.0.0.1:${port}/api/quota`, 1500);
            const parsed = JSON.parse(res);
            if (parsed && (parsed.models || parsed.quotas || parsed.usage)) {
                _port = port;
                console.log('[Grav Quota] Found LS on port', port);
                processResponse(parsed);
                return port;
            }
        } catch (_) { /* non-critical */ }
    }
    // Fallback: try to find port from process list via /json endpoint
    for (const port of LS_PORTS) {
        try {
            const res = await httpGet(`http://127.0.0.1:${port}/`, 1000);
            if (res && (res.includes('antigravity') || res.includes('language') || res.includes('quota'))) {
                _port = port;
                console.log('[Grav Quota] Found LS (fallback) on port', port);
                poll();
                return port;
            }
        } catch (_) { /* non-critical */ }
    }
    _data.error = 'Language Server not found';
    return 0;
}

async function poll() {
    if (!_port) { await discover(); return; }
    try {
        // Try multiple known endpoints
        let res = null;
        const endpoints = ['/api/quota', '/api/usage', '/quota', '/usage'];
        for (const ep of endpoints) {
            try {
                res = await httpGet(`http://127.0.0.1:${_port}${ep}`, 2000);
                if (res) { const p = JSON.parse(res); if (p && typeof p === 'object') { processResponse(p); return; } }
            } catch (_) { /* non-critical */ }
        }
        _data.error = 'No quota endpoint responded';
        _data.lastPoll = Date.now();
    } catch (e) {
        _data.error = e.message;
        _data.lastPoll = Date.now();
        // Port may have changed, re-discover
        _port = 0;
    }
}

function processResponse(raw) {
    const now = Date.now();
    _data.lastPoll = now;
    _data.error = null;

    // Normalize different response formats
    const models = raw.models || raw.quotas || {};
    _data.models = {};

    for (const [key, val] of Object.entries(models)) {
        const m = typeof val === 'object' ? val : {};
        const used = m.used || m.usage || m.consumed || 0;
        const limit = m.limit || m.total || m.max || m.quota || 100;
        const resetMs = m.resetAt || m.resetTime || m.reset || 0;
        const resetIn = resetMs > now ? resetMs - now : (m.resetIn || m.resetInMs || 0);

        _data.models[key] = {
            name: m.name || m.displayName || key,
            used, limit,
            pct: limit > 0 ? Math.round(used / limit * 100) : 0,
            resetIn,
            resetAt: resetMs > now ? resetMs : (resetIn > 0 ? now + resetIn : 0),
            status: limit > 0 ? (used / limit >= 0.9 ? 'critical' : used / limit >= 0.7 ? 'warning' : 'ok') : 'unknown',
        };
    }

    // Credits (prompt credits / flow credits)
    if (raw.credits || raw.promptCredits) {
        const c = raw.credits || {};
        _data.credits = {
            prompt: c.prompt || c.promptCredits || raw.promptCredits || 0,
            promptLimit: c.promptLimit || c.promptTotal || 0,
            flow: c.flow || c.flowCredits || raw.flowCredits || 0,
            flowLimit: c.flowLimit || c.flowTotal || 0,
        };
    }

    // Track history for runway prediction
    const totalPct = getOverallPct();
    _history.push({ ts: now, pct: totalPct });
    if (_history.length > HISTORY_MAX) _history = _history.slice(-HISTORY_MAX);

    if (_onChange) _onChange(_data);
}

function getOverallPct() {
    const models = Object.values(_data.models);
    if (models.length === 0) return 0;
    const totalUsed = models.reduce((a, m) => a + m.used, 0);
    const totalLimit = models.reduce((a, m) => a + m.limit, 0);
    return totalLimit > 0 ? Math.round(totalUsed / totalLimit * 100) : 0;
}

// Usage rate: %/hour based on recent history
function getUsageRate() {
    if (_history.length < 2) return 0;
    const recent = _history.slice(-10); // last ~5 min
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dtHours = (last.ts - first.ts) / 3600000;
    if (dtHours < 0.001) return 0;
    const dpct = last.pct - first.pct;
    return Math.max(0, Math.round(dpct / dtHours * 10) / 10);
}

// Runway prediction: minutes until quota exhaustion
function getRunway() {
    const rate = getUsageRate();
    if (rate <= 0) return Infinity;
    const currentPct = getOverallPct();
    const remaining = 100 - currentPct;
    if (remaining <= 0) return 0;
    const hoursLeft = remaining / rate;
    return Math.round(hoursLeft * 60); // minutes
}

// Next reset time (earliest model reset)
function getNextReset() {
    let earliest = Infinity;
    for (const m of Object.values(_data.models)) {
        if (m.resetAt > 0 && m.resetAt < earliest) earliest = m.resetAt;
    }
    return earliest === Infinity ? 0 : earliest;
}

// Summary for dashboard
function getSummary() {
    return {
        models: _data.models,
        credits: _data.credits,
        overallPct: getOverallPct(),
        usageRate: getUsageRate(),
        runwayMin: getRunway(),
        nextReset: getNextReset(),
        lastPoll: _data.lastPoll,
        error: _data.error,
        lsPort: _port,
    };
}

function httpGet(url, timeout) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                resolve(data);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

module.exports = { init, stop, poll, getData, getHistory, getSummary, getUsageRate, getRunway, getOverallPct, getNextReset };