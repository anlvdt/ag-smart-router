// ═══════════════════════════════════════════════════════════════
//  Grav — CDP (Chrome DevTools Protocol) Module
//
//  Optional module for reaching OOPIF (Out-of-Process Iframe)
//  buttons in Antigravity agent panel.
//
//  Architecture (inspired by YazanBaker):
//    1. Connect WebSocket to --remote-debugging-port
//    2. Discover vscode-webview:// targets
//    3. Attach to agent panel target
//    4. Inject MutationObserver via Runtime.evaluate
//    5. Observer clicks buttons + checks command safety
//    6. Heartbeat self-healing every 10s
//
//  Safety Guard:
//    Before clicking "Run", reads the command text from the
//    code block above the button. If command matches blacklist,
//    BLOCKS the click and notifies the user.
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const http   = require('http');

const { DEFAULT_BLACKLIST, DEFAULT_PATTERNS } = require('./constants');
const { cfg, matchesBlacklist } = require('./utils');

// ── State ────────────────────────────────────────────────────
let _ws           = null;
let _enabled      = false;
let _port         = 0;
let _msgId        = 0;
let _sessions     = new Map();  // sessionId → { targetId, alive, lastCheck }
let _heartbeat    = null;
let _reconnectTimer = null;
let _callbacks    = new Map();  // msgId → { resolve, reject, timer }
let _blockedLog   = [];         // [{ time, cmd, reason }]
let _onBlocked    = null;       // callback when command blocked

const CDP_PORTS = [9333, 9222, 9229];  // try these in order
const WS_TIMEOUT = 3000;
const HEARTBEAT_MS = 10000;
const MAX_BLOCKED_LOG = 50;

/**
 * Initialize CDP module.
 * @param {object} opts - { onBlocked: (cmd, reason) => void }
 */
function init(opts = {}) {
    _onBlocked = opts.onBlocked || null;
    _port = cfg('cdpPort', 0);
    _enabled = cfg('cdpEnabled', true);

    // Always try to connect — argv.json should have the debug port
    if (_enabled) {
        connect();
    } else {
        // Even if disabled, try auto-discover in case port is available
        autoDiscover().then(found => {
            if (found) {
                _enabled = true;
                console.log('[Grav CDP] Auto-discovered debug port:', _port);
            }
        });
    }
}

function isEnabled()  { return _enabled; }
function isConnected() { return _ws && _ws.readyState === 1; }
function getBlockedLog() { return _blockedLog; }

/** Enable/disable CDP mode. */
function setEnabled(val) {
    _enabled = val;
    if (val) connect();
    else disconnect();
}

// ── Connection ───────────────────────────────────────────────
async function connect() {
    if (_ws) disconnect();

    // Discover debug port
    const port = _port || await discoverPort();
    if (!port) {
        console.log('[Grav CDP] No debug port found. Launch IDE with --remote-debugging-port=9333');
        return false;
    }
    _port = port;

    // Get WebSocket URL from /json/version
    try {
        const info = await httpGet(`http://127.0.0.1:${port}/json/version`);
        const wsUrl = JSON.parse(info).webSocketDebuggerUrl;
        if (!wsUrl) throw new Error('No webSocketDebuggerUrl');

        return new Promise((resolve) => {
            const WebSocket = require('ws');
            _ws = new WebSocket(wsUrl, { handshakeTimeout: WS_TIMEOUT });

            _ws.on('open', () => {
                console.log('[Grav CDP] Connected to port', port);
                startHeartbeat();
                discoverTargets();
                resolve(true);
            });

            _ws.on('message', (data) => {
                try { handleMessage(JSON.parse(data.toString())); } catch (_) {}
            });

            _ws.on('close', () => {
                console.log('[Grav CDP] Disconnected');
                cleanup();
                if (_enabled) scheduleReconnect();
            });

            _ws.on('error', (err) => {
                console.error('[Grav CDP] Error:', err.message);
                cleanup();
                if (_enabled) scheduleReconnect();
                resolve(false);
            });
        });
    } catch (e) {
        console.error('[Grav CDP] Connect failed:', e.message);
        if (_enabled) scheduleReconnect();
        return false;
    }
}

function disconnect() {
    cleanup();
    if (_ws) try { _ws.close(); } catch (_) {}
    _ws = null;
}

function cleanup() {
    if (_heartbeat) clearInterval(_heartbeat);
    _heartbeat = null;
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
    _sessions.clear();
    for (const [, cb] of _callbacks) { clearTimeout(cb.timer); cb.reject(new Error('closed')); }
    _callbacks.clear();
}

function scheduleReconnect() {
    if (_reconnectTimer) return;
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        if (_enabled) connect();
    }, 5000);
}

// ── Port Discovery ───────────────────────────────────────────
async function discoverPort() {
    for (const port of CDP_PORTS) {
        try {
            const res = await httpGet(`http://127.0.0.1:${port}/json/version`);
            if (res && res.includes('webSocketDebuggerUrl')) return port;
        } catch (_) {}
    }
    return 0;
}

/** Auto-discover debug port and connect if found. */
async function autoDiscover() {
    const port = await discoverPort();
    if (!port) return false;
    _port = port;
    try {
        const ok = await connect();
        return ok !== false;
    } catch (_) {
        return false;
    }
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ── CDP Messaging ────────────────────────────────────────────
function send(method, params = {}, sessionId = null) {
    if (!_ws || _ws.readyState !== 1) return Promise.reject(new Error('not connected'));
    const id = ++_msgId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            _callbacks.delete(id);
            reject(new Error('timeout'));
        }, WS_TIMEOUT);
        _callbacks.set(id, { resolve, reject, timer });
        _ws.send(JSON.stringify(msg));
    });
}

function handleMessage(msg) {
    // Response to our request
    if (msg.id && _callbacks.has(msg.id)) {
        const cb = _callbacks.get(msg.id);
        _callbacks.delete(msg.id);
        clearTimeout(cb.timer);
        if (msg.error) cb.reject(new Error(msg.error.message));
        else cb.resolve(msg.result);
        return;
    }

    // Event: new target created
    if (msg.method === 'Target.targetCreated') {
        const info = msg.params.targetInfo;
        if (isAgentTarget(info)) {
            attachToTarget(info.targetId);
        }
    }

    // Event: target destroyed
    if (msg.method === 'Target.targetDestroyed') {
        _sessions.delete(msg.params.targetId);
    }
}

// ── Target Discovery & Attachment ────────────────────────────
function isAgentTarget(info) {
    if (!info || !info.url) return false;
    const url = info.url.toLowerCase();
    // Antigravity agent panel runs in vscode-webview:// OOPIF targets
    // Only attach to these — never to external pages or browser sub-agent targets
    if (!url.startsWith('vscode-webview://')) return false;
    if (info.type !== 'page') return false;
    // Reject targets that look like external URLs embedded in webviews
    // (e.g. Antigravity Browser Control opens real web pages)
    if (url.includes('http://') || url.includes('https://')) return false;
    return true;
}

async function discoverTargets() {
    try {
        // Enable target discovery events
        await send('Target.setDiscoverTargets', { discover: true });
        const { targetInfos } = await send('Target.getTargets');
        for (const info of targetInfos) {
            if (isAgentTarget(info)) {
                await attachToTarget(info.targetId);
            }
        }
    } catch (e) {
        console.error('[Grav CDP] Target discovery failed:', e.message);
    }
}

async function attachToTarget(targetId) {
    if (_sessions.has(targetId)) return;
    try {
        const { sessionId } = await send('Target.attachToTarget', {
            targetId, flatten: true,
        });
        _sessions.set(targetId, { sessionId, alive: true, lastCheck: Date.now() });
        console.log('[Grav CDP] Attached to target:', targetId);

        // Enable Runtime for this session
        await send('Runtime.enable', {}, sessionId);

        // Inject the auto-approve observer
        await injectObserver(sessionId);
    } catch (e) {
        console.error('[Grav CDP] Attach failed:', e.message);
    }
}

// ── Observer Injection ───────────────────────────────────────
/**
 * Inject MutationObserver into the OOPIF webview.
 * The observer:
 *   1. Watches for new button elements
 *   2. Matches against PATTERNS with word-boundary check
 *   3. For "Run" buttons: reads command from sibling code block
 *   4. Checks command against BLACKLIST before clicking
 *   5. Reports clicks and blocks back to extension host
 */
async function injectObserver(sessionId) {
    const patterns = cfg('approvePatterns', DEFAULT_PATTERNS);
    const userBlacklist = cfg('terminalBlacklist', []);
    const allBlacklist = [...DEFAULT_BLACKLIST, ...userBlacklist];

    // Build the injection script
    const script = buildInjectionScript(patterns, allBlacklist);

    try {
        await send('Runtime.evaluate', {
            expression: script,
            awaitPromise: false,
            returnByValue: false,
        }, sessionId);
        console.log('[Grav CDP] Observer injected into session:', sessionId);
    } catch (e) {
        console.error('[Grav CDP] Inject failed:', e.message);
    }
}

function buildInjectionScript(patterns, blacklist) {
    // This script runs inside the OOPIF webview (Antigravity React app)
    return `(function() {
    if (window.__gravCdpLoaded) return;
    window.__gravCdpLoaded = true;

    var PATTERNS = ${JSON.stringify(patterns)};
    var BLACKLIST = ${JSON.stringify(blacklist)};
    var COOLDOWN = 1500;
    var FAST_COOLDOWN = 500;
    var _clicked = new WeakMap();
    var _expandedOnce = new WeakSet();  // Expand button loop prevention (YazanBaker v3.5.1)
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];
    var NEVER_SKIP = { 'Accept All': 1, 'Accept all': 1, 'Accept & Run': 1, 'Keep All Edits': 1, 'Keep All': 1, 'Keep & Continue': 1 };

    function matchPattern(text, pattern) {
        if (text === pattern) return true;
        if (text.length <= pattern.length) return false;
        if (text.indexOf(pattern) !== 0) return false;
        var next = text.charAt(pattern.length);
        return /[\\s.,;:!?\\-()\\[\\]{}|/<>'"@#\$%^&*+=~]/.test(next);
    }

    function findMatch(text) {
        var matched = '', len = 0;
        for (var i = 0; i < PATTERNS.length; i++) {
            if (PATTERNS[i].length > len && matchPattern(text, PATTERNS[i])) {
                matched = PATTERNS[i]; len = PATTERNS[i].length;
            }
        }
        return matched;
    }

    function labelOf(btn) {
        // Strategy 1: Direct text nodes
        var direct = '';
        for (var i = 0; i < btn.childNodes.length; i++) {
            if (btn.childNodes[i].nodeType === 3) direct += btn.childNodes[i].nodeValue || '';
        }
        direct = direct.trim();
        if (direct && direct.length >= 2 && direct.length <= 60) return direct;

        // Strategy 2: innerText first line
        var raw = (btn.innerText || btn.textContent || '').trim();
        var first = raw.split('\\n')[0].trim();
        if (first && first.length >= 2 && first.length <= 60) return first;

        // Strategy 3: aria-label
        var aria = (btn.getAttribute('aria-label') || '').trim();
        if (aria && aria.length >= 2 && aria.length <= 60) return aria;

        // Strategy 4: title
        var title = (btn.getAttribute('title') || '').trim();
        if (title && title.length >= 2 && title.length <= 60) return title;

        // Strategy 5: Nested spans (Antigravity React UI)
        var spans = btn.querySelectorAll('span, div, label');
        var spanText = '';
        for (var j = 0; j < spans.length; j++) {
            var st = '';
            for (var k = 0; k < spans[j].childNodes.length; k++) {
                if (spans[j].childNodes[k].nodeType === 3) st += spans[j].childNodes[k].nodeValue || '';
            }
            st = st.trim();
            if (st) spanText += (spanText ? ' ' : '') + st;
        }
        spanText = spanText.trim();
        if (spanText && spanText.length >= 2 && spanText.length <= 60) return spanText;

        return '';
    }

    // ── SAFETY GUARD: Read command from code block above Run button ──
    function extractCommandNearButton(btn) {
        var container = btn.parentElement;
        for (var lv = 0; lv < 6 && container; lv++) {
            var codeEls = container.querySelectorAll('code, pre, [class*=terminal], [class*=command], [class*=shell]');
            for (var i = codeEls.length - 1; i >= 0; i--) {
                var txt = (codeEls[i].textContent || '').trim();
                if (txt.length >= 2 && txt.length <= 2000) return txt;
            }
            container = container.parentElement;
        }
        return '';
    }

    function isBlocked(cmdText) {
        if (!cmdText) return null;
        var lower = cmdText.toLowerCase().trim();
        for (var i = 0; i < BLACKLIST.length; i++) {
            var p = BLACKLIST[i].toLowerCase().trim();
            if (!p) continue;
            if (lower.indexOf(p) !== -1) return BLACKLIST[i];
        }
        return null;
    }

    function scanAndClick() {
        // ── Antigravity Webview Guard (from YazanBaker) ──
        // Antigravity agent panel uses React — check .react-app-container exists
        // This avoids clicking buttons in non-agent webviews (settings, extensions, etc.)
        // Check is deferred (not at injection time) to handle React hydration race
        if (!document.querySelector('.react-app-container') &&
            !document.querySelector('[class*=agent-panel]') &&
            !document.querySelector('[class*=chat-panel]')) return;

        var btns = document.querySelectorAll('button, [role="button"], a.action-label, vscode-button');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (b.offsetWidth === 0 || b.disabled) continue;

            var text = labelOf(b);
            if (!text || text.length > 60) continue;

            var matched = findMatch(text);
            if (!matched) continue;

            // Use faster cooldown for safe actions
            var cd = NEVER_SKIP[matched] ? FAST_COOLDOWN : COOLDOWN;
            var last = _clicked.get(b);
            if (last && (Date.now() - last) < cd) continue;

            // ── Expand Button Loop Prevention (from YazanBaker v3.5.1) ──
            // Expand buttons use click-once-per-session to prevent infinite overlay re-open
            if (matched === 'Expand') {
                if (_expandedOnce.has(b)) continue;
                _expandedOnce.add(b);
            }

            // ── SAFETY GUARD for Run/Execute commands ──
            if (matched === 'Run' || matched === 'Run Task') {
                var cmd = extractCommandNearButton(b);
                if (cmd) {
                    var blocked = isBlocked(cmd);
                    if (blocked) {
                        _clicked.set(b, Date.now());
                        console.warn('[Grav Safety] BLOCKED: ' + cmd + ' (matched: ' + blocked + ')');
                        try {
                            var x = new XMLHttpRequest();
                            x.open('POST', 'http://127.0.0.1:${cfg('bridgePort', 48787)}/api/command-blocked', true);
                            x.setRequestHeader('Content-Type', 'application/json');
                            x.timeout = 1000;
                            x.send(JSON.stringify({ cmd: cmd, reason: blocked, ts: Date.now() }));
                        } catch(_) {}
                        continue; // DO NOT CLICK
                    }
                }
            }

            _clicked.set(b, Date.now());
            // Primary: standard .click()
            try { b.click(); } catch(_) {}
            // Fallback: dispatch full mouse event sequence for Antigravity React UI
            // React uses SyntheticEvent system — sometimes ignores bare .click()
            try {
                var rect = b.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function(type) {
                    var Ctor = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
                    b.dispatchEvent(new Ctor(type, {
                        bubbles: true, cancelable: true, view: window,
                        clientX: cx, clientY: cy, button: 0, isPrimary: true
                    }));
                });
            } catch(_) {}
            console.log('[Grav CDP] Clicked: ' + matched + ' (' + text + ')');

            // Report to bridge
            try {
                var x = new XMLHttpRequest();
                x.open('POST', 'http://127.0.0.1:${cfg('bridgePort', 48787)}/api/click-log', true);
                x.setRequestHeader('Content-Type', 'application/json');
                x.timeout = 1000;
                x.send(JSON.stringify({ button: text, pattern: matched, source: 'cdp', ts: Date.now() }));
            } catch(_) {}
        }
    }

    // MutationObserver — event-driven, react instantly
    var _flushTimer = null;
    var observer = new MutationObserver(function() {
        if (!_flushTimer) {
            scanAndClick();
            _flushTimer = setTimeout(function() { _flushTimer = null; }, 100);
        }
    });
    observer.observe(document.body || document.documentElement, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['class', 'disabled', 'aria-hidden', 'style'],
    });

    // Initial scan + low-frequency fallback
    scanAndClick();
    setInterval(scanAndClick, 1500);

    console.log('[Grav CDP] Observer active | Patterns: ' + PATTERNS.length + ' | Blacklist: ' + BLACKLIST.length);
})();`;
}

// ── Heartbeat & Self-Healing ─────────────────────────────────
function startHeartbeat() {
    if (_heartbeat) clearInterval(_heartbeat);
    _heartbeat = setInterval(async () => {
        if (!_ws || _ws.readyState !== 1) return;

        for (const [targetId, session] of _sessions) {
            try {
                // Ping the session to check if observer is alive
                const result = await send('Runtime.evaluate', {
                    expression: 'typeof window.__gravCdpLoaded',
                    returnByValue: true,
                }, session.sessionId);

                if (result.result.value !== 'boolean') {
                    // Observer died — re-inject
                    console.log('[Grav CDP] Self-healing: re-injecting observer for', targetId);
                    await injectObserver(session.sessionId);
                }
                session.alive = true;
                session.lastCheck = Date.now();
            } catch (e) {
                session.alive = false;
                // Session dead — remove and let target discovery re-attach
                if (Date.now() - session.lastCheck > 30000) {
                    _sessions.delete(targetId);
                    console.log('[Grav CDP] Pruned dead session:', targetId);
                }
            }
        }

        // Re-discover targets periodically (new webviews may appear)
        discoverTargets();
    }, HEARTBEAT_MS);
}

// ── Blocked Command Logging ──────────────────────────────────
function logBlocked(cmd, reason) {
    const ts = new Date().toISOString().slice(11, 19);
    _blockedLog.unshift({ time: ts, cmd: cmd.slice(0, 200), reason });
    if (_blockedLog.length > MAX_BLOCKED_LOG) _blockedLog.pop();
    if (_onBlocked) _onBlocked(cmd, reason);
}

module.exports = {
    init, connect, disconnect, isEnabled, isConnected, setEnabled,
    getBlockedLog, logBlocked,
};
