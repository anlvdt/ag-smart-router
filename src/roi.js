'use strict';

// Time saved per click type (seconds) — based on user research
const CLICK_COST = {
    'Accept all': 3, 'Accept All': 3, 'Accept': 2,
    'Run': 5, 'Approve': 3, 'Retry': 4, 'Proceed': 2, 'Expand': 1,
    'Resume': 6, 'Try Again': 8, 'Always Allow': 2,
    'Allow in this Workspace': 2, 'Allow This Conversation': 2,
    'Allow this Conversation': 2, 'Allow Once': 2, 'Allow once': 2,
    'OK': 1, 'Confirm': 2,
    _default: 2,
};

let _ctx = null;
let _session = { startMs: 0, clicks: {}, totalClicks: 0, savedSec: 0 };
let _lifetime = { totalClicks: 0, savedSec: 0, sessions: 0, totalSessionMs: 0 };

function init(ctx) {
    _ctx = ctx;
    _session.startMs = Date.now();
    // Load lifetime stats
    const saved = ctx.globalState.get('roiLifetime', null);
    if (saved) _lifetime = saved;
    _lifetime.sessions++;
    save();
}

function recordClick(pattern) {
    const cost = CLICK_COST[pattern] || CLICK_COST._default;
    _session.totalClicks++;
    _session.savedSec += cost;
    _session.clicks[pattern] = (_session.clicks[pattern] || 0) + 1;
    _lifetime.totalClicks++;
    _lifetime.savedSec += cost;
    save();
}

function save() {
    if (!_ctx) return;
    _lifetime.totalSessionMs += 0; // updated on flush
    try { _ctx.globalState.update('roiLifetime', _lifetime); } catch (_) {}
}

function flush() {
    if (!_ctx) return;
    _lifetime.totalSessionMs += Date.now() - _session.startMs;
    try { _ctx.globalState.update('roiLifetime', _lifetime); } catch (_) {}
}

function getSessionROI() {
    const now = Date.now();
    const sessionMs = now - _session.startMs;
    const sessionMin = sessionMs / 60000;
    const savedMin = _session.savedSec / 60;
    return {
        sessionMin: Math.round(sessionMin),
        clicks: _session.totalClicks,
        savedSec: _session.savedSec,
        savedMin: Math.round(savedMin * 10) / 10,
        clickBreakdown: { ..._session.clicks },
        // Productivity gain: time saved / session time
        gainPct: sessionMin > 0 ? Math.round(savedMin / sessionMin * 100) : 0,
        // Projected daily savings (8h workday)
        dailySavedMin: sessionMin > 0 ? Math.round(savedMin / sessionMin * 480) : 0,
    };
}

function getLifetimeROI() {
    return {
        totalClicks: _lifetime.totalClicks,
        savedSec: _lifetime.savedSec,
        savedMin: Math.round(_lifetime.savedSec / 60 * 10) / 10,
        savedHours: Math.round(_lifetime.savedSec / 3600 * 10) / 10,
        sessions: _lifetime.sessions,
        avgSessionMin: _lifetime.sessions > 0 ? Math.round(_lifetime.totalSessionMs / _lifetime.sessions / 60000) : 0,
    };
}

function getSummary() {
    return { session: getSessionROI(), lifetime: getLifetimeROI() };
}

module.exports = { init, recordClick, flush, getSessionROI, getLifetimeROI, getSummary };