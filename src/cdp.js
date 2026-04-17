// ═══════════════════════════════════════════════════════════════
//  Grav v3.0 — CDP Engine (Primary Mechanism)
//
//  CDP is now the ONLY reliable way to reach Antigravity's
//  agent panel buttons (OOPIF since v1.19.6+).
//
//  Architecture:
//    1. Auto-connect to --remote-debugging-port (argv.json patched)
//    2. Discover ALL webview targets (broad matching)
//    3. Attach + inject self-contained observer
//    4. Observer handles: auto-click, auto-scroll, safety guard
//    5. Communication: console.log('[GRAV:...]') → CDP event capture
//    6. Aggressive heartbeat: 5s check, auto-re-inject dead observers
//    7. Auto-reconnect on Electron restart
//
//  Zero-config: argv.json auto-patched, CDP auto-connects.
// ═══════════════════════════════════════════════════════════════
'use strict';

const vscode = require('vscode');
const http   = require('http');

const { DEFAULT_BLACKLIST, DEFAULT_PATTERNS } = require('./constants');
const { cfg } = require('./utils');

// ── State ────────────────────────────────────────────────────
let _ws             = null;
let _enabled        = true;     // Always enabled by default
let _port           = 0;
let _msgId          = 0;
let _sessions       = new Map();  // targetId → { sessionId, alive, lastCheck, url }
let _heartbeat      = null;
let _reconnectTimer = null;
let _callbacks      = new Map();  // msgId → { resolve, reject, timer }
let _blockedLog     = [];
let _onBlocked      = null;
let _onClicked      = null;
let _onChatEvent    = null;
let _totalClicks    = 0;
let _clickLog       = [];

const CDP_PORTS     = [9333, 9222, 9229, 9230];
const WS_TIMEOUT    = 5000;
const HEARTBEAT_MS  = 5000;     // 5s — aggressive self-healing
const RECONNECT_MS  = 3000;     // 3s — fast reconnect
const MAX_BLOCKED   = 50;
const DEAD_AFTER_MS = 15000;    // prune dead sessions after 15s

let _reconnectAttempts = 0;

/**
 * Initialize CDP module — auto-connect immediately.
 */
function init(opts = {}) {
    _onBlocked   = opts.onBlocked   || null;
    _onClicked   = opts.onClicked   || null;
    _onChatEvent = opts.onChatEvent || null;
    _port        = cfg('cdpPort', 0);
    _enabled     = cfg('cdpEnabled', true);

    // Always attempt to connect — this is the primary mechanism
    connect();
}

function isEnabled()   { return _enabled; }
function isConnected() { return _ws && _ws.readyState === 1; }
function getBlockedLog() { return _blockedLog; }
function getTotalClicks() { return _totalClicks; }
function getClickLog()   { return _clickLog; }
function getSessionCount() { return _sessions.size; }

function setEnabled(val) {
    _enabled = val;
    if (val) connect();
    else disconnect();
}

// ── Connection ───────────────────────────────────────────────
async function connect() {
    if (_ws && _ws.readyState === 1) return true; // already connected
    if (_ws) disconnect();

    const port = _port || await discoverPort();
    if (!port) {
        console.log('[Grav CDP] No debug port found — will retry');
        // After several retries, show a user-facing message
        if (!_port) {
            _reconnectAttempts = (_reconnectAttempts || 0) + 1;
            if (_reconnectAttempts === 5) {
                vscode.window.showWarningMessage(
                    '[Grav] CDP không kết nối được. Hãy QUIT hoàn toàn Antigravity (Cmd+Q / Alt+F4) rồi mở lại.',
                    'OK'
                );
            }
        }
        scheduleReconnect();
        return false;
    }
    _reconnectAttempts = 0;
    _port = port;

    try {
        const info = await httpGet(`http://127.0.0.1:${port}/json/version`);
        const parsed = JSON.parse(info);
        const wsUrl = parsed.webSocketDebuggerUrl;
        if (!wsUrl) throw new Error('No webSocketDebuggerUrl');

        return new Promise((resolve) => {
            const WebSocket = require('ws');
            _ws = new WebSocket(wsUrl, { handshakeTimeout: WS_TIMEOUT });

            _ws.on('open', () => {
                console.log('[Grav CDP] Connected on port', port);
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
                console.error('[Grav CDP] WS error:', err.message);
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
    _reconnectAttempts = 0;
    _sessions.clear();
    for (const [, cb] of _callbacks) {
        clearTimeout(cb.timer);
        try { cb.reject(new Error('closed')); } catch (_) {}
    }
    _callbacks.clear();
}

function scheduleReconnect() {
    if (_reconnectTimer) return;
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        if (_enabled) connect();
    }, RECONNECT_MS);
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
            attachToTarget(info.targetId, info.url);
        }
    }

    // Event: target info changed (URL update after navigation)
    if (msg.method === 'Target.targetInfoChanged') {
        const info = msg.params.targetInfo;
        if (isAgentTarget(info) && !_sessions.has(info.targetId)) {
            attachToTarget(info.targetId, info.url);
        }
    }

    // Event: target destroyed
    if (msg.method === 'Target.targetDestroyed') {
        _sessions.delete(msg.params.targetId);
    }

    // Event: console message from injected observer
    if (msg.method === 'Runtime.consoleAPICalled') {
        handleConsoleEvent(msg.params);
    }
}

// ── Console Event Handler (communication from observer) ──────
function handleConsoleEvent(params) {
    if (!params.args || !params.args.length) return;
    const text = params.args[0]?.value || '';
    if (typeof text !== 'string') return;

    // Parse structured messages: [GRAV:type] payload
    const m = text.match(/^\[GRAV:(\w+)\]\s*(.*)/);
    if (!m) return;

    const type = m[1];
    const payload = m[2];

    if (type === 'CLICK') {
        _totalClicks++;
        const now = new Date();
        const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map(n => n < 10 ? '0' + n : n).join(':');
        try {
            const data = JSON.parse(payload);
            _clickLog.unshift({ time: ts, pattern: data.p || '', button: data.b || '' });
            if (_clickLog.length > 50) _clickLog.pop();
            if (_onClicked) _onClicked(data);
        } catch (_) {
            _clickLog.unshift({ time: ts, pattern: payload, button: payload });
            if (_clickLog.length > 50) _clickLog.pop();
        }
    }

    if (type === 'BLOCKED') {
        try {
            const data = JSON.parse(payload);
            logBlocked(data.cmd || payload, data.reason || 'blacklisted');
        } catch (_) {
            logBlocked(payload, 'blacklisted');
        }
    }

    if (type === 'CHAT' && _onChatEvent) {
        try { _onChatEvent(JSON.parse(payload)); } catch (_) {}
    }

    if (type === 'QUOTA') {
        console.log('[Grav CDP] Quota detected:', payload);
    }
}

// ── Target Discovery & Attachment ────────────────────────────
/**
 * Determine if a CDP target is likely the Antigravity agent panel.
 *
 * v1.19.6+ changes: agent panel may use different URL schemes.
 * Strategy: accept ALL webview-like targets, let the observer
 * script decide if it should activate (by checking for buttons).
 */
function isAgentTarget(info) {
    if (!info || !info.url) return false;
    const url  = info.url.toLowerCase();
    const type = info.type;

    // Accept page, iframe, webview, other — Antigravity uses various types
    if (type !== 'page' && type !== 'iframe' && type !== 'other'
        && type !== 'webview') return false;

    // ── Positive match: ANY Antigravity workbench page ──
    // Agent buttons (Accept All, Run, etc.) live in the main workbench.html,
    // not in a separate webview. Match all Antigravity workbench pages.
    if (url.includes('antigravity.app') && url.includes('workbench')) return true;
    if (url.includes('antigravity') && url.includes('workbench'))    return true;

    // ── Positive match: vscode-webview:// inside Antigravity ──
    if (url.startsWith('vscode-webview://')) {
        // Skip known non-agent webviews
        if (url.includes('settings') || url.includes('preferences'))  return false;
        if (url.includes('extensions') || url.includes('marketplace')) return false;
        if (url.includes('welcome') || url.includes('walkthrough'))   return false;
        if (url.includes('release-notes') || url.includes('releasenotes')) return false;
        if (url.includes('output') || url.includes('terminal'))       return false;
        if (url.includes('markdown') || url.includes('preview'))      return false;
        return true;
    }

    // ── Positive match: Antigravity-specific internal URLs ──
    if (url.includes('antigravity') && url.includes('agent'))   return true;
    if (url.includes('antigravity') && url.includes('chat'))    return true;

    // ── SKIP: everything else ──
    if (url.startsWith('chrome-extension://')) return false;
    if (url.startsWith('devtools://'))         return false;
    if (url.startsWith('http://'))             return false;
    if (url.startsWith('https://'))            return false;
    if (url === '' || url === 'about:blank')   return false;

    // Default: accept unknown URLs (future-proof for new Antigravity versions)
    return true;
}

async function discoverTargets() {
    try {
        await send('Target.setDiscoverTargets', { discover: true });
        const { targetInfos } = await send('Target.getTargets');
        console.log('[Grav CDP] Found', targetInfos.length, 'targets');
        for (const info of targetInfos) {
            const match = isAgentTarget(info);
            console.log('[Grav CDP] Target:', info.type, '|', (info.url || '').substring(0, 100), '| match:', match, '| attached:', _sessions.has(info.targetId));
            if (match && !_sessions.has(info.targetId)) {
                await attachToTarget(info.targetId, info.url);
            }
        }
    } catch (e) {
        console.error('[Grav CDP] Target discovery failed:', e.message);
    }
}

async function attachToTarget(targetId, url) {
    if (_sessions.has(targetId)) return;
    try {
        const { sessionId } = await send('Target.attachToTarget', {
            targetId, flatten: true,
        });
        _sessions.set(targetId, {
            sessionId, alive: true,
            lastCheck: Date.now(), url: url || '',
        });
        console.log('[Grav CDP] Attached:', targetId, url || '');

        // Enable Runtime + Console for this session
        await send('Runtime.enable', {}, sessionId);

        // Inject the observer
        await injectObserver(sessionId);
    } catch (e) {
        console.error('[Grav CDP] Attach failed:', e.message);
    }
}

// ── Observer Injection ───────────────────────────────────────
async function injectObserver(sessionId) {
    const patterns      = cfg('approvePatterns', DEFAULT_PATTERNS);
    const userBlacklist = cfg('terminalBlacklist', []);
    const allBlacklist  = [...DEFAULT_BLACKLIST, ...userBlacklist];
    const scrollEnabled = cfg('autoScroll', true);
    const scrollPauseMs = cfg('scrollPauseMs', 7000);

    const script = buildObserverScript(patterns, allBlacklist, scrollEnabled, scrollPauseMs);

    try {
        await send('Runtime.evaluate', {
            expression: script,
            awaitPromise: false,
            returnByValue: false,
        }, sessionId);
    } catch (e) {
        console.error('[Grav CDP] Observer inject failed:', e.message);
    }
}

/**
 * Build self-contained observer script.
 *
 * This runs inside the OOPIF webview. It must be completely
 * self-contained — no HTTP bridge, no external dependencies.
 * Communication back to extension host via console.log('[GRAV:...]').
 *
 * Features:
 *   1. Auto-click buttons (pattern matching + safety guard)
 *   2. Auto-scroll chat to bottom
 *   3. Quota detection
 *   4. Activity monitoring (typing state, tool calls)
 *
 * Designed to work regardless of CSS class names — uses
 * heuristic button detection instead of hardcoded selectors.
 */
function buildObserverScript(patterns, blacklist, scrollEnabled, scrollPauseMs) {
    return `(function() {
    'use strict';
    if (window.__grav3) return;
    window.__grav3 = true;

    var PATTERNS = ${JSON.stringify(patterns)};
    var BLACKLIST = ${JSON.stringify(blacklist)};
    var SCROLL_ON = ${scrollEnabled};
    var SCROLL_PAUSE = ${scrollPauseMs};

    // ── Communication (CSP-safe: no XHR needed) ─────────────
    function report(type, data) {
        try {
            console.log('[GRAV:' + type + '] ' + (typeof data === 'string' ? data : JSON.stringify(data)));
        } catch(_) {}
    }

    // ── Pattern Matching ────────────────────────────────────
    var REJECT_WORDS = ['Reject','Deny','Cancel','Dismiss',"Don't Allow",'Decline','Reject all','Reject All'];
    var EDITOR_SKIP = ['Accept Changes','Accept Incoming','Accept Current','Accept Both','Accept Combination'];
    function matchPattern(text, pattern) {
        if (text === pattern) return true;
        if (text.length <= pattern.length) return false;
        if (text.indexOf(pattern) !== 0) return false;
        var c = text.charAt(pattern.length);
        return /[\\s\\u00a0.,;:!?\\-\\u2013\\u2014()\\[\\]{}|/\\\\<>'"@#\$%^&*+=~\`]/.test(c);
    }

    function findMatch(text) {
        var best = '', bestLen = 0;
        for (var i = 0; i < PATTERNS.length; i++) {
            if (PATTERNS[i].length > bestLen && matchPattern(text, PATTERNS[i])) {
                best = PATTERNS[i]; bestLen = best.length;
            }
        }
        return best;
    }

    // ── Button Label Extraction (multi-strategy) ────────────
    function labelOf(btn) {
        // 1. Direct text nodes (most accurate)
        var direct = '';
        for (var i = 0; i < btn.childNodes.length; i++) {
            if (btn.childNodes[i].nodeType === 3) direct += btn.childNodes[i].nodeValue || '';
        }
        direct = direct.trim();
        if (direct.length >= 2 && direct.length <= 60) return direct;

        // 2. innerText first line
        var raw = (btn.innerText || btn.textContent || '').trim();
        var first = raw.split('\\n')[0].trim();
        if (first.length >= 2 && first.length <= 60) return first;

        // 3. aria-label
        var aria = (btn.getAttribute('aria-label') || '').trim();
        if (aria.length >= 2 && aria.length <= 60) return aria;

        // 4. title
        var title = (btn.getAttribute('title') || '').trim();
        if (title.length >= 2 && title.length <= 60) return title;

        // 5. Nested spans (Antigravity React wraps text in layers)
        var spans = btn.querySelectorAll('span, div, label, p');
        var st = '';
        for (var j = 0; j < spans.length; j++) {
            var t = '';
            for (var k = 0; k < spans[j].childNodes.length; k++) {
                if (spans[j].childNodes[k].nodeType === 3) t += spans[j].childNodes[k].nodeValue || '';
            }
            t = t.trim();
            if (t) st += (st ? ' ' : '') + t;
        }
        if (st.length >= 2 && st.length <= 60) return st;

        return '';
    }

    // ── Safety Guard ────────────────────────────────────────
    function extractCmd(btn) {
        var p = btn.parentElement;
        for (var lv = 0; lv < 8 && p; lv++) {
            var els = p.querySelectorAll('code, pre, [class*=terminal], [class*=command], [class*=shell], [class*=code-block], [class*=codeBlock]');
            for (var i = els.length - 1; i >= 0; i--) {
                var txt = (els[i].textContent || '').trim();
                if (txt.length >= 2 && txt.length <= 2000) return txt;
            }
            p = p.parentElement;
        }
        return '';
    }

    function isBlocked(cmd) {
        if (!cmd) return null;
        var lower = cmd.toLowerCase();
        for (var i = 0; i < BLACKLIST.length; i++) {
            var p = BLACKLIST[i].toLowerCase().trim();
            if (p && lower.indexOf(p) !== -1) return BLACKLIST[i];
        }
        return null;
    }

    // ── Reject Sibling Detection ────────────────────────────
    function hasRejectNearby(btn) {
        var p = btn.parentElement;
        for (var lv = 0; lv < 5 && p; lv++) {
            var sibs = p.querySelectorAll('button, [role="button"], vscode-button');
            for (var i = 0; i < sibs.length; i++) {
                if (sibs[i] === btn) continue;
                var t = labelOf(sibs[i]);
                for (var j = 0; j < REJECT_WORDS.length; j++) {
                    if (matchPattern(t, REJECT_WORDS[j])) return true;
                }
            }
            p = p.parentElement;
        }
        return false;
    }

    // ── Editor Context Detection (skip non-agent buttons) ───
    function inEditorContext(btn) {
        if (!btn.closest) return false;
        return !!(
            btn.closest('.monaco-editor') ||
            btn.closest('.monaco-diff-editor') ||
            btn.closest('.merge-editor-view') ||
            btn.closest('.editor-actions') ||
            btn.closest('.title-actions') ||
            btn.closest('.monaco-toolbar') ||
            btn.closest('.context-view') ||
            btn.closest('.monaco-menu') ||
            btn.closest('.quick-input-widget') ||
            btn.closest('.sidebar') ||
            btn.closest('.panel-header') ||
            btn.closest('.terminal-tab') ||
            btn.closest('[class*=settings]') ||
            btn.closest('[class*=preference]') ||
            btn.closest('[class*=keybinding]') ||
            btn.closest('[class*=extension-editor]')
        );
    }

    function isEditorAccept(text) {
        for (var i = 0; i < EDITOR_SKIP.length; i++) {
            if (matchPattern(text, EDITOR_SKIP[i])) return true;
        }
        return false;
    }

    // ── Click Tracking ──────────────────────────────────────
    var _clicked = new WeakSet();
    var _expandedOnce = new WeakSet();

    // HIGH_CONFIDENCE: patterns that ONLY appear in agent approval contexts
    // These are auto-clicked WITHOUT requiring reject-sibling or container check
    // because they are unique to agent approval dialogs
    var HIGH_CONF = {
        'Accept All':1,'Accept all':1,'Accept & Run':1,
        'Keep All Edits':1,'Keep All':1,'Keep & Continue':1,
        'Approve Tool Result':1,'Approve all':1,'Approve All':1,
    };

    // ── Agent Context Detection (lightweight) ───────────────
    function inAgentContext(btn) {
        if (!btn.closest) return false;
        // SKIP: Settings, Extensions, and other non-agent panels
        if (btn.closest('[class*=settings]') ||
            btn.closest('[class*=preference]')) {
            return false;
        }
        // Since this observer only runs inside agent webviews (OOPIF),
        // most elements are in agent context. Be permissive here.
        return !!(
            btn.closest('[class*=agent]') ||
            btn.closest('[class*=chat]') ||
            btn.closest('[class*=panel]') ||
            btn.closest('[class*=dialog]') ||
            btn.closest('[class*=notification]') ||
            btn.closest('[class*=overlay]') ||
            btn.closest('[class*=popup]') ||
            btn.closest('[class*=action]') ||
            btn.closest('[class*=toolbar]') ||
            btn.closest('[class*=container]') ||
            btn.closest('.react-app-container') ||
            btn.closest('body')
        );
    }

    // ── Core: Scan & Click ──────────────────────────────────
    function scanAndClick() {
        var btns = document.querySelectorAll('button, [role="button"], a.action-label, vscode-button');

        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];

            // Skip invisible/disabled
            if (b.disabled) continue;
            if (b.offsetWidth === 0 && b.offsetHeight === 0) {
                if (!b.closest || !b.closest('[class*=overlay],[class*=popup],[class*=dialog],[class*=notification]')) continue;
            }

            // Skip already clicked
            if (_clicked.has(b)) continue;

            // Skip editor context
            if (inEditorContext(b)) continue;

            var text = labelOf(b);
            if (!text || text.length > 60) continue;

            // Skip editor-specific accept patterns
            if (isEditorAccept(text)) continue;

            var matched = findMatch(text);
            if (!matched) continue;

            // Expand: one-shot per element
            if (matched === 'Expand') {
                if (_expandedOnce.has(b)) continue;
                _expandedOnce.add(b);
            }

            // Safety guard for Run/Execute commands
            if (matched === 'Run' || matched === 'Run Task') {
                var cmd = extractCmd(b);
                if (cmd) {
                    var blocked = isBlocked(cmd);
                    if (blocked) {
                        _clicked.add(b);
                        report('BLOCKED', { cmd: cmd.slice(0, 500), reason: blocked });
                        continue;
                    }
                }
            }

            // ── VALIDATION: Must prove this is an approval dialog ──
            // Strategy 1: Has a Reject/Cancel sibling nearby (strongest signal)
            var hasReject = hasRejectNearby(b);
            // Strategy 2: High-confidence pattern (these ONLY appear in agent approval contexts)
            // Since CDP observer only runs inside agent webviews (filtered by isAgentTarget),
            // we don't need strict container checks — the webview itself IS the agent context.
            var isHighConf = !!HIGH_CONF[matched];
            // Strategy 3: Inside an agent-like container (for non-high-conf patterns)
            var isAgent = inAgentContext(b);

            // HIGH_CONF patterns are auto-clicked without additional validation
            // (they only appear in agent approval contexts)
            if (isHighConf) {
                // Proceed to click — no further validation needed
            } else if (!hasReject && !isAgent) {
                // Non-high-conf patterns need either reject sibling or agent context
                report('DEBUG', { skip: matched, text: text, hasReject: hasReject, isHighConf: isHighConf, isAgent: isAgent });
                continue;
            }

            // ── CLICK ──
            _clicked.add(b);

            // Primary: .click()
            try { b.click(); } catch(_) {}

            // Fallback: full pointer event sequence (React SyntheticEvent)
            try {
                var rect = b.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                ['pointerdown','mousedown','pointerup','mouseup'].forEach(function(ev) {
                    var C = ev.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
                    b.dispatchEvent(new C(ev, {
                        bubbles:true, cancelable:true, view:window,
                        clientX:cx, clientY:cy, button:0, isPrimary:true
                    }));
                });
            } catch(_) {}

            report('CLICK', { p: matched, b: text });
        }
    }

    // ── MutationObserver (primary: event-driven) ────────────
    var _flushTimer = null;
    function onMutation() {
        if (!_flushTimer) {
            scanAndClick();
            _flushTimer = setTimeout(function() { _flushTimer = null; }, 80);
        }
    }

    var _observer = null;
    function attachObserver() {
        var root = document.body || document.documentElement;
        if (!root) { setTimeout(attachObserver, 500); return; }
        try {
            if (_observer) _observer.disconnect();
            _observer = new MutationObserver(onMutation);
            _observer.observe(root, {
                childList: true, subtree: true,
                attributes: true,
                attributeFilter: ['class','style','disabled','aria-hidden','aria-label','data-state'],
            });
        } catch(_) {}
    }
    attachObserver();

    // Polling fallback (catches what MutationObserver misses)
    setInterval(scanAndClick, 1200);

    // Initial scan
    scanAndClick();

    // ── Auto-Scroll (stick-to-bottom) ───────────────────────
    if (SCROLL_ON) {
        var _scrollPaused = false;
        var _lastUserScroll = 0;
        var _autoScrolling = false;

        // Detect user scroll to pause auto-scroll temporarily
        document.addEventListener('wheel', function(e) {
            if (e.isTrusted && e.deltaY < 0) {
                _scrollPaused = true;
                _lastUserScroll = Date.now();
            }
        }, { passive: true, capture: true });

        document.addEventListener('mousedown', function(e) {
            if (e.isTrusted) _lastUserScroll = Date.now();
        }, true);

        setInterval(function() {
            if (_scrollPaused && Date.now() - _lastUserScroll > SCROLL_PAUSE) {
                _scrollPaused = false;
            }
            if (_scrollPaused) return;

            // Find the largest scrollable container (likely the chat message list)
            var best = null, bestH = 0;
            var els = document.querySelectorAll('*');
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.scrollHeight <= el.clientHeight + 30) continue;
                if (el.tagName === 'TEXTAREA' || el.tagName === 'CODE' || el.tagName === 'PRE') continue;
                var cls = (el.className || '').toString().toLowerCase();
                // Skip code blocks, terminals, editors
                if (/code|terminal|xterm|editor|monaco|diff|tree|explorer|outline/.test(cls)) continue;
                var s = window.getComputedStyle(el);
                if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
                if (el.clientHeight > bestH) { bestH = el.clientHeight; best = el; }
            }
            if (!best) return;

            var gap = best.scrollHeight - best.scrollTop - best.clientHeight;
            if (gap > 5 && gap < 5000) {
                _autoScrolling = true;
                best.scrollTop = best.scrollHeight;
                setTimeout(function() { _autoScrolling = false; }, 200);
            }
        }, 400);
    }

    // ── Quota Detection ─────────────────────────────────────
    var QUOTA_PHRASES = [
        'quota reached','exhausted your capacity','quota will reset',
        'rate limit exceeded','quota exhausted','capacity exceeded',
        'too many requests','limit reached','credits exhausted',
        'usage limit exceeded','try again later','temporarily unavailable',
        'resource exhausted','insufficient quota','spending limit',
    ];
    var _lastQuota = 0;

    setInterval(function() {
        if (Date.now() - _lastQuota < 30000) return;
        var alerts = document.querySelectorAll('[role="alert"],[aria-live],[class*=notification],[class*=toast],[class*=error],[class*=quota],[class*=limit]');
        for (var i = 0; i < alerts.length; i++) {
            var txt = (alerts[i].textContent || '').toLowerCase();
            for (var j = 0; j < QUOTA_PHRASES.length; j++) {
                if (txt.indexOf(QUOTA_PHRASES[j]) !== -1) {
                    _lastQuota = Date.now();
                    report('QUOTA', QUOTA_PHRASES[j]);
                    return;
                }
            }
        }
    }, 5000);

    // ── Self-Healing ────────────────────────────────────────
    var _healTick = 0;
    setInterval(function() {
        _healTick++;
        // Re-attach observer every 3 minutes (webview navigation kills it)
        if (_healTick >= 180) {
            _healTick = 0;
            attachObserver();
        }
    }, 1000);

    // ── Suppress Corrupt Banner ─────────────────────────────
    (function() {
        function dismiss() {
            var toasts = document.querySelectorAll('.notifications-toasts .notification-toast, .notification-list-item');
            toasts.forEach(function(el) {
                var t = (el.textContent || '').toLowerCase();
                if (t.indexOf('corrupt') !== -1 || t.indexOf('reinstall') !== -1) {
                    var btn = el.querySelector('.codicon-notifications-clear, .codicon-close, [class*=close]');
                    if (btn) btn.click(); else el.style.display = 'none';
                }
            });
        }
        dismiss();
        var c = 0;
        var t = setInterval(function() { dismiss(); if (++c > 30) clearInterval(t); }, 1000);
    })();

    report('BOOT', { patterns: PATTERNS.length, blacklist: BLACKLIST.length, scroll: SCROLL_ON, url: location.href.substring(0, 100) });

    // Debug: log all buttons found on first scan
    setTimeout(function() {
        var allBtns = document.querySelectorAll('button, [role="button"], a.action-label, vscode-button');
        var labels = [];
        for (var i = 0; i < allBtns.length && i < 30; i++) {
            var l = labelOf(allBtns[i]);
            if (l) labels.push(l);
        }
        report('DEBUG', { buttonCount: allBtns.length, labels: labels });
    }, 3000);
})();`;
}

// ── Heartbeat & Self-Healing ─────────────────────────────────
function startHeartbeat() {
    if (_heartbeat) clearInterval(_heartbeat);
    _heartbeat = setInterval(async () => {
        if (!_ws || _ws.readyState !== 1) return;

        // Check each attached session
        for (const [targetId, session] of _sessions) {
            try {
                const result = await send('Runtime.evaluate', {
                    expression: 'typeof window.__grav3',
                    returnByValue: true,
                }, session.sessionId);

                if (!result || !result.result || result.result.value !== 'boolean') {
                    // Observer died or was never injected — re-inject
                    console.log('[Grav CDP] Re-injecting observer for', targetId);
                    await injectObserver(session.sessionId);
                }
                session.alive = true;
                session.lastCheck = Date.now();
            } catch (e) {
                session.alive = false;
                if (Date.now() - session.lastCheck > DEAD_AFTER_MS) {
                    _sessions.delete(targetId);
                    console.log('[Grav CDP] Pruned dead session:', targetId);
                }
            }
        }

        // Re-discover targets (new webviews may have appeared)
        discoverTargets();
    }, HEARTBEAT_MS);
}

// ── Hot-Update Observer Config ───────────────────────────────
async function hotUpdate() {
    for (const [, session] of _sessions) {
        try {
            // Reset the flag so observer re-injects with new config
            await send('Runtime.evaluate', {
                expression: 'window.__grav3 = false',
                returnByValue: true,
            }, session.sessionId);
            await injectObserver(session.sessionId);
        } catch (_) {}
    }
}

// ── Blocked Command Logging ──────────────────────────────────
function logBlocked(cmd, reason) {
    const ts = new Date().toISOString().slice(11, 19);
    _blockedLog.unshift({ time: ts, cmd: cmd.slice(0, 200), reason });
    if (_blockedLog.length > MAX_BLOCKED) _blockedLog.pop();
    if (_onBlocked) _onBlocked(cmd, reason);
}

module.exports = {
    init, connect, disconnect,
    isEnabled, isConnected, setEnabled,
    getBlockedLog, getTotalClicks, getClickLog, getSessionCount,
    hotUpdate,
};
