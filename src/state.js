// ═══════════════════════════════════════════════════════════════
//  Grav — Shared mutable state
// ═══════════════════════════════════════════════════════════════

function createEmptyWiki() {
    return {
        index: {},
        concepts: {},
        log: [],
        synthesis: {},
        contradictions: [],
        lastLint: 0,
    };
}

const state = {
    ctx:           null,
    enabled:       true,
    scrollOn:      true,
    patterns:      [],
    stats:         {},
    log:           [],
    totalClicks:   0,
    httpServer:    null,
    httpPort:      0,
    bridgeToken:   '',
    acceptTimer:   null,
    dashboard:     null,
    lsPort:        0,
    lsCsrf:        '',
    lsOk:          false,
    lastQuotaMs:   0,

    // Learning state
    learnData:     {},
    learnEpoch:    0,
    userWhitelist: [],
    userBlacklist: [],
    patternCache:  [],

    // Second Brain wiki
    wiki: createEmptyWiki(),

    // Status bar items
    sbMain:   null,
    sbClicks: null,
    sbScroll: null,
    sbBridge: null,
};

module.exports = { state, createEmptyWiki };
