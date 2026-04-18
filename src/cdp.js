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
let _lastError      = '';       // last connect/WS error (for diagnostics)
let _lastPhase      = 'init';   // init|disabled|discoverPort|fetchVersion|connecting|open|closed|error
let _debugLog       = [];       // observer debug payloads (last N)
const MAX_DEBUG_LOG = 20;
let _connectWatchdog = null;
let _lastTargets    = [];       // last discovered targets (for diagnostics)

const CDP_PORTS     = [9333, 9222, 9229, 9230, 9234, 9235, 9236];
const WS_TIMEOUT    = 5000;
const HEARTBEAT_MS  = 5000;     // 5s — aggressive self-healing
const RECONNECT_MS  = 3000;     // 3s — fast reconnect
const MAX_BLOCKED   = 50;
const DEAD_AFTER_MS = 15000;    // prune dead sessions after 15s

let _reconnectAttempts = 0;
let _phaseAtMs = 0;

function setPhase(p) {
    _lastPhase = p;
    _phaseAtMs = Date.now();
}

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
function isConnected() { return !!(_ws && _ws.readyState === 1); }
function getLastError() { return _lastError || ''; }
function getDebugLog() { return _debugLog; }
function getLastTargets() { return _lastTargets; }
function getSessionSummaries() {
    const out = [];
    for (const [targetId, s] of _sessions) {
        out.push({
            targetId,
            sessionId: s.sessionId,
            url: s.url || '',
            title: s.title || '',
            alive: !!s.alive,
        });
    }
    return out;
}
function getDebugState() {
    return {
        enabled: _enabled,
        port: _port,
        phase: _lastPhase,
        phaseAgeMs: _phaseAtMs ? (Date.now() - _phaseAtMs) : 0,
        lastError: _lastError || '',
        reconnectAttempts: _reconnectAttempts,
        wsReadyState: _ws ? _ws.readyState : null,
        sessions: _sessions.size,
    };
}
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
    if (!_enabled) {
        _lastError = 'disabled (grav.cdpEnabled=false)';
        setPhase('disabled');
        return false;
    }
    if (_ws && _ws.readyState === 1) return true; // already connected
    if (_ws) disconnect();

    setPhase('discoverPort');
    const port = _port || await discoverPort();
    if (!port) {
        _reconnectAttempts++;
        _lastError = 'no debug port found';
        setPhase('discoverPort');
        console.log(`[Grav CDP] No debug port found (attempt ${_reconnectAttempts}) — will retry`);
        if (_reconnectAttempts === 5) {
            vscode.window.showWarningMessage(
                '[Grav] CDP không kết nối được sau 5 lần thử. Hãy QUIT hoàn toàn Antigravity (Cmd+Q / Alt+F4) rồi mở lại.',
                'OK'
            );
        } else if (_reconnectAttempts >= 20) {
            // After many failures, slow down significantly
            console.log('[Grav CDP] Too many failures — backing off');
        }
        scheduleReconnect();
        return false;
    }
    _port = port;

    try {
        setPhase('fetchVersion');
        const info = await httpGet(`http://127.0.0.1:${port}/json/version`);
        let parsed;
        try { parsed = JSON.parse(info); }
        catch (e) { throw new Error('Invalid /json/version JSON: ' + String(info).slice(0, 200)); }
        const wsUrl = parsed.webSocketDebuggerUrl;
        if (!wsUrl) throw new Error('No webSocketDebuggerUrl in /json/version response');

        return new Promise((resolve) => {
            const WebSocket = require('ws');
            _lastError = '';
            console.log('[Grav CDP] Connecting WS:', wsUrl);
            setPhase('connecting');
            _ws = new WebSocket(wsUrl, { handshakeTimeout: WS_TIMEOUT });

            // Watchdog: sometimes sockets stay stuck in CONNECTING without error/close.
            if (_connectWatchdog) clearTimeout(_connectWatchdog);
            _connectWatchdog = setTimeout(() => {
                try {
                    if (_ws && _ws.readyState === 0) {
                        _lastError = 'handshake stuck (watchdog timeout)';
                        setPhase('error');
                        console.error('[Grav CDP] WS stuck in CONNECTING — forcing close');
                        try { _ws.terminate(); } catch (_) { try { _ws.close(); } catch (_) {} }
                        cleanup();
                        if (_enabled) scheduleReconnect();
                    }
                } catch (_) {}
            }, WS_TIMEOUT + 1000);

            _ws.on('open', () => {
                console.log('[Grav CDP] Connected on port', port);
                _reconnectAttempts = 0; // Reset only on successful connection
                _lastError = '';
                setPhase('open');
                if (_connectWatchdog) clearTimeout(_connectWatchdog);
                _connectWatchdog = null;
                startHeartbeat();
                discoverTargets();
                resolve(true);
            });

            _ws.on('message', (data) => {
                try { handleMessage(JSON.parse(data.toString())); } catch (_) {}
            });

            _ws.on('close', (code, reason) => {
                console.log(`[Grav CDP] Disconnected (code: ${code}, reason: ${reason || 'none'})`);
                _lastError = `closed (code ${code})`;
                setPhase('closed');
                if (_connectWatchdog) clearTimeout(_connectWatchdog);
                _connectWatchdog = null;
                cleanup();
                if (_enabled) scheduleReconnect();
            });

            _ws.on('error', (err) => {
                console.error('[Grav CDP] WS error:', err.message);
                _lastError = err && err.message ? err.message : 'ws error';
                setPhase('error');
                if (_connectWatchdog) clearTimeout(_connectWatchdog);
                _connectWatchdog = null;
                cleanup();
                if (_enabled) scheduleReconnect();
                resolve(false);
            });
        });
    } catch (e) {
        console.error('[Grav CDP] Connect failed:', e.message);
        _lastError = e && e.message ? e.message : 'connect failed';
        setPhase('error');
        _reconnectAttempts++;
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
    if (_connectWatchdog) clearTimeout(_connectWatchdog);
    _connectWatchdog = null;
    // NOTE: Do NOT reset _reconnectAttempts here — it must persist across
    // disconnect/reconnect cycles so the warning message triggers after 5 fails.
    // It's reset only on successful connection in connect().
    _sessions.clear();
    for (const [, cb] of _callbacks) {
        clearTimeout(cb.timer);
        try { cb.reject(new Error('closed')); } catch (_) {}
    }
    _callbacks.clear();
}

function scheduleReconnect() {
    if (_reconnectTimer) return;
    // Exponential backoff: 3s, 6s, 12s, 24s... capped at 30s
    const delay = Math.min(RECONNECT_MS * Math.pow(2, Math.min(_reconnectAttempts, 4)), 30000);
    console.log(`[Grav CDP] Reconnect in ${delay}ms (attempt ${_reconnectAttempts + 1})`);
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        if (_enabled) connect();
    }, delay);
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
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`http ${res.statusCode} for ${url}`));
                }
                resolve(data);
            });
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
            attachToTarget(info.targetId, info.url, info.title || '');
        }
    }

    // Event: auto-attach succeeded (OOPIF / webview subtargets)
    if (msg.method === 'Target.attachedToTarget') {
        const info = msg.params.targetInfo;
        const sessionId = msg.params.sessionId;
        try {
            console.log('[Grav CDP] Target.attachedToTarget event:', info.type, info.title || '', (info.url || '').substring(0, 80));
            if (isAgentTarget(info) && sessionId) {
                // Map by targetId so we don't double-inject
                if (!_sessions.has(info.targetId)) {
                    _sessions.set(info.targetId, {
                        sessionId, alive: true,
                        lastCheck: Date.now(), url: info.url || '', title: info.title || '',
                    });
                    console.log('[Grav CDP] Auto-attached:', info.targetId, info.title || '', info.url || '');
                    // CRITICAL: Recursively enable auto-attach on this session too
                    // This allows nested OOPIFs (webviews inside webviews) to be discovered
                    send('Target.setAutoAttach', {
                        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
                    }, sessionId).catch(() => {});
                    // Enable domains and inject observer
                    send('Runtime.enable', {}, sessionId).catch(() => {});
                    send('DOM.enable', {}, sessionId).catch(() => {});
                    send('Input.enable', {}, sessionId).catch(() => {});
                    injectObserver(sessionId);
                }
            } else if (sessionId) {
                // Even for non-agent targets, enable auto-attach to discover nested webviews
                send('Target.setAutoAttach', {
                    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
                }, sessionId).catch(() => {});
            }
        } catch (_) {}
    }

    if (msg.method === 'Target.detachedFromTarget') {
        // Best-effort: remove any target with this sessionId
        const sid = msg.params.sessionId;
        if (sid) {
            for (const [tid, s] of _sessions) {
                if (s.sessionId === sid) _sessions.delete(tid);
            }
        }
    }

    // Event: target info changed (URL update after navigation)
    if (msg.method === 'Target.targetInfoChanged') {
        const info = msg.params.targetInfo;
        if (isAgentTarget(info) && !_sessions.has(info.targetId)) {
            attachToTarget(info.targetId, info.url, info.title || '');
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

    // RETRY: Observer click failed — escalate to CDP Input.dispatchMouseEvent
    // This sends TRUSTED mouse events at the browser level, bypassing all JS interception
    if (type === 'RETRY') {
        try {
            const data = JSON.parse(payload);
            cdpNativeClick(data.p || '', data.b || '');
        } catch (_) {}
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

    // DEBUG/BOOT: capture observer introspection (labels, counts, url)
    if (type === 'DEBUG' || type === 'BOOT') {
        try {
            const obj = JSON.parse(payload);
            _debugLog.unshift({ ts: Date.now(), type, ...obj });
            if (_debugLog.length > MAX_DEBUG_LOG) _debugLog.pop();
        } catch (_) {
            _debugLog.unshift({ ts: Date.now(), type, raw: payload });
            if (_debugLog.length > MAX_DEBUG_LOG) _debugLog.pop();
        }
    }
}

// ══════════════════════════════════════════════════════════════
//  CDP Native Click — Input.dispatchMouseEvent
//  This is the nuclear option: sends trusted mouse events through
//  the browser's input pipeline, identical to real user clicks.
//  Used when JS-level clicks fail (RETRY events from observer).
//
//  Learned from Puppeteer's page.click() implementation:
//  1. DOM.querySelector to find the button
//  2. DOM.getBoxModel to get coordinates
//  3. Input.dispatchMouseEvent sequence: mouseMoved → mousePressed → mouseReleased
// ══════════════════════════════════════════════════════════════
async function cdpNativeClick(pattern, buttonText) {
    for (const [, session] of _sessions) {
        try {
            // Step 1: Find the button element via DOM.querySelector
            const { root } = await send('DOM.getDocument', { depth: 0 }, session.sessionId);
            if (!root || !root.nodeId) continue;

            // Use Runtime.evaluate to find button coordinates (more reliable than DOM.querySelector for text matching)
            const findScript = `(function() {
                var btns = document.querySelectorAll('button, [role="button"], a.action-label, vscode-button');
                for (var i = 0; i < btns.length; i++) {
                    var b = btns[i];
                    if (b.disabled || b.offsetWidth === 0) continue;
                    var text = (b.innerText || b.textContent || '').trim().split('\\n')[0].trim();
                    if (text === ${JSON.stringify(buttonText)}) {
                        var rect = b.getBoundingClientRect();
                        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
                    }
                }
                return null;
            })()`;

            const result = await send('Runtime.evaluate', {
                expression: findScript,
                returnByValue: true,
            }, session.sessionId);

            const coords = result?.result?.value;
            if (!coords || !coords.x || !coords.y) continue;

            // Step 2: Send trusted mouse events via CDP Input domain
            await send('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x: coords.x, y: coords.y,
            }, session.sessionId);

            await send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: coords.x, y: coords.y,
                button: 'left', clickCount: 1,
            }, session.sessionId);

            await send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: coords.x, y: coords.y,
                button: 'left', clickCount: 1,
            }, session.sessionId);

            _totalClicks++;
            console.log('[Grav CDP] Native click:', pattern, buttonText);
            return; // Success — stop trying other sessions
        } catch (e) {
            console.error('[Grav CDP] Native click failed:', e.message);
        }
    }
}

// ── Target Discovery & Attachment ────────────────────────────
/**
 * Determine if a CDP target is the Antigravity agent/chat panel.
 *
 * Antigravity 1.19.6+ architecture (OOPIF):
 *   - Main workbench: file:///...antigravity.app/.../workbench.html (type: page)
 *   - Agent panel:    vscode-webview://... (type: iframe/other/webview)
 *   - Settings:       vscode-webview://...settings... (MUST SKIP)
 *   - Browser:        vscode-webview://...simple-browser... (MUST SKIP)
 *   - Extensions:     vscode-webview://...extensions... (MUST SKIP)
 *
 * Strategy: 2-layer filtering
 *   Layer 1 (host-side): Accept workbench + agent webviews, BLOCK all non-agent panels
 *   Layer 2 (observer-side): inEditorContext() blocks buttons in wrong containers
 *
 * CRITICAL: We MUST NOT inject into Settings, Browser, Editor, Extensions
 * panels — clicking buttons there would change user preferences.
 */
function isAgentTarget(info) {
    if (!info) return false;
    const urlRaw = info.url || '';
    const url  = urlRaw.toLowerCase();
    const title = (info.title || '').toLowerCase();
    const type = info.type;

    // Only accept page, iframe, webview, other — Antigravity uses various types
    if (type !== 'page' && type !== 'iframe' && type !== 'other'
        && type !== 'webview') return false;

    // ══════════════════════════════════════════════════════════
    //  HARD BLOCK LIST — NEVER inject into these targets
    //  These are non-agent panels where clicking would be destructive
    // ══════════════════════════════════════════════════════════
    const BLOCK_URLS = [
        // Settings panels (all variants)
        'settings', 'preferences', 'preference',
        // Browser / Simple Browser panel
        'simple-browser', 'simplebrowser', 'browser-preview',
        // Extensions panel
        'extensions', 'marketplace', 'extension-editor',
        // Welcome / Walkthrough
        'welcome', 'walkthrough', 'getting-started',
        // Release notes
        'release-notes', 'releasenotes', 'changelog',
        // Output / Terminal webviews
        'output', 'terminal',
        // Markdown preview
        'markdown', 'preview',
        // Keybindings editor
        'keybinding', 'keyboard-shortcuts',
        // Accounts / Auth
        'accounts', 'authentication',
        // Diff editor webview
        'diff-editor', 'merge-editor',
        // Notebook
        'notebook', 'jupyter',
        // Webview developer tools
        'devtools', 'developer-tools',
    ];

    // Block by title too (some OOPIF targets have empty URL)
    for (const blocked of BLOCK_URLS) {
        if (title.includes(blocked)) return false;
    }

    // ── vscode-webview:// targets ──
    if (url.startsWith('vscode-webview://')) {
        // Check hard block list
        for (const blocked of BLOCK_URLS) {
            if (url.includes(blocked)) return false;
        }
        // Passed block list → likely agent/chat panel → accept
        return true;
    }

    // ── OOPIF/webview targets with empty/blank URL ──
    // Some Antigravity versions report agent iframes with url "" / about:blank.
    // In that case, fall back to target title heuristics.
    if (!url || url === 'about:blank') {
        const POSITIVE_TITLES = [
            'agent', 'chat', 'cascade', 'cortex', 'assistant', 'claude', 'copilot',
            'tool', 'approval', 'approve', 'accept',
        ];
        for (const w of POSITIVE_TITLES) {
            if (title.includes(w)) return true;
        }
        return false;
    }

    // ── Antigravity workbench page (main frame) ──
    // Agent buttons live in the main workbench — this is where Accept All, Run, etc. appear.
    // The workbench URL is typically: file:///path/to/Antigravity.app/.../workbench.html
    // On some installs, "antigravity" may not appear in the path, so also match workbench.html directly.
    if (url.includes('antigravity') && url.includes('workbench')) return true;
    if (url.includes('windsurf') && url.includes('workbench'))    return true;
    if (type === 'page' && url.includes('workbench.html'))        return true;

    // ── Antigravity-specific internal URLs ──
    if (url.includes('antigravity') && url.includes('agent'))   return true;
    if (url.includes('antigravity') && url.includes('chat'))    return true;
    if (url.includes('antigravity') && url.includes('cascade')) return true;
    if (url.includes('antigravity') && url.includes('cortex'))  return true;

    // ── Windsurf legacy URLs (Antigravity was forked from Windsurf) ──
    if (url.includes('windsurf') && url.includes('agent'))   return true;
    if (url.includes('windsurf') && url.includes('chat'))    return true;
    if (url.includes('windsurf') && url.includes('cascade')) return true;
    if (url.includes('codeium') && url.includes('agent'))    return true;
    if (url.includes('codeium') && url.includes('chat'))     return true;

    // ── SKIP: everything else ──
    if (url.startsWith('chrome-extension://')) return false;
    if (url.startsWith('devtools://'))         return false;
    if (url.startsWith('http://'))             return false;
    if (url.startsWith('https://'))            return false;
    // url blank handled above

    // Default: accept unknown internal URLs (future-proof)
    // But only if they don't match any block pattern
    for (const blocked of BLOCK_URLS) {
        if (url.includes(blocked)) return false;
    }
    return true;
}

async function discoverTargets() {
    try {
        // Enable auto-attach so OOPIF/webview subtargets become reachable.
        // This is critical for Antigravity 1.19.6+ where agent UI runs in OOPIF.
        try {
            await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        } catch (_) {}
        await send('Target.setDiscoverTargets', { discover: true });
        const { targetInfos } = await send('Target.getTargets');
        _lastTargets = (targetInfos || []).map(t => ({
            type: t.type, title: t.title || '', url: t.url || '', targetId: t.targetId,
        })).slice(0, 200);

        // Count target types for diagnostics
        const typeCounts = {};
        const webviewTargets = [];
        for (const info of targetInfos) {
            typeCounts[info.type] = (typeCounts[info.type] || 0) + 1;
            if ((info.url || '').includes('vscode-webview://')) {
                webviewTargets.push(info);
            }
        }
        console.log('[Grav CDP] Found', targetInfos.length, 'targets. Types:', JSON.stringify(typeCounts),
            '| Webviews:', webviewTargets.length);

        // Log webview targets specifically (these are where agent buttons live)
        for (const wv of webviewTargets) {
            console.log('[Grav CDP] WEBVIEW:', wv.type, '|', wv.title || 'no-title', '|', (wv.url || '').substring(0, 100));
        }

        for (const info of targetInfos) {
            const match = isAgentTarget(info);
            if (match && !_sessions.has(info.targetId)) {
                console.log('[Grav CDP] Attaching:', info.type, '|', (info.title || '').substring(0, 60), '|', (info.url || '').substring(0, 100));
                await attachToTarget(info.targetId, info.url, info.title || '');
            }
        }
    } catch (e) {
        console.error('[Grav CDP] Target discovery failed:', e.message);
    }
}

async function attachToTarget(targetId, url, title = '') {
    if (_sessions.has(targetId)) return;
    try {
        const { sessionId } = await send('Target.attachToTarget', {
            targetId, flatten: true,
        });
        _sessions.set(targetId, {
            sessionId, alive: true,
            lastCheck: Date.now(), url: url || '', title: title || '',
        });
        console.log('[Grav CDP] Attached:', targetId, url || '');

        // CRITICAL: Enable auto-attach recursively on THIS session
        // This allows OOPIF/webview frames nested inside this target to be discovered
        try {
            await send('Target.setAutoAttach', {
                autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
            }, sessionId);
        } catch (_) {}

        // Enable Runtime + Console + DOM + Input for this session
        await send('Runtime.enable', {}, sessionId);
        // Sanity ping: verify console events flow back to extension host
        try {
            await send('Runtime.evaluate', {
                expression: `console.log('[GRAV:DEBUG] ' + JSON.stringify({ ping: 1, ts: Date.now(), url: location && location.href ? String(location.href).slice(0,120) : '' }))`,
            }, sessionId);
        } catch (_) {}
        // DOM + Input needed for CDP native click fallback
        try { await send('DOM.enable', {}, sessionId); } catch (_) {}
        try { await send('Input.enable', {}, sessionId); } catch (_) {}

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
 * Actively probe attached targets for accept/approve-like buttons.
 * This is used by diagnostics because observer debug snapshots can miss late dialogs.
 * @returns {Promise<Array<{sessionId:string, url?:string, acceptLike:string[], sample:string[]}>>}
 */
async function probeAcceptLike() {
    const out = [];
    const expr = `(function(){
        function textOf(el){
            try{
                var t = (el.innerText || el.textContent || '').trim();
                if (!t) t = (el.getAttribute && (el.getAttribute('aria-label')||el.getAttribute('title')||'')) || '';
                t = (t||'').trim().split('\\n')[0].trim();
                if (t.length > 80) t = t.slice(0,80);
                return t;
            }catch(e){return '';}
        }
        // Prefer prefix match to avoid false positives from long sentences ("Terminal ... run ...")
        var acceptRe = /^(accept\\s+all|accept|approve|allow|keep|continue|proceed|ok|yes|apply|confirm|agree|run|chấp\\s*nhận|đồng\\s*ý|cho\\s*phép|tiếp\\s*tục|chạy|xác\\s*nhận|duyệt|giữ)\\b/i;
        var sel = 'button,[role=\"button\"],[role=\"menuitem\"],a.action-label,vscode-button,a,[tabindex],span.cursor-pointer,[class*=\"cursor-pointer\"],[class*=\"flux-button\"],[class*=\"flux-action\"],[data-testid*=\"accept\"],[data-testid*=\"approve\"],[class*=\"clickable\"]';

        function collectFromRoot(root, into){
            if (!root) return;
            try {
                var list = root.querySelectorAll(sel);
                for (var i=0;i<list.length;i++) into.push(list[i]);
            } catch(e){}
        }

        // Collect from main doc + open shadow roots + same-origin iframes
        var nodes = [];
        collectFromRoot(document, nodes);
        try {
            var all = document.querySelectorAll('*');
            for (var i=0;i<all.length;i++){
                var sr = all[i].shadowRoot;
                if (sr) collectFromRoot(sr, nodes);
            }
        } catch(e){}
        try {
            var iframes = document.querySelectorAll('iframe');
            for (var j=0;j<iframes.length;j++){
                try{
                    var doc = iframes[j].contentDocument;
                    if (doc) collectFromRoot(doc, nodes);
                } catch(e2){}
            }
        } catch(e){}

        var sample = [];
        var acceptLike = [];
        for (var i=0; i<nodes.length && (sample.length<120 || acceptLike.length<80); i++){
            var el = nodes[i];
            try{
                if (el.disabled) continue;
                var r = el.getBoundingClientRect && el.getBoundingClientRect();
                if (r && r.width===0 && r.height===0) continue;
            }catch(e){}
            var t = textOf(el);
            if (!t) continue;
            if (sample.length < 120) sample.push(t);
            if (acceptRe.test(t) && acceptLike.indexOf(t) === -1) acceptLike.push(t);
        }
        return { url: (location && location.href ? String(location.href).slice(0,140) : ''), acceptLike: acceptLike, sample: sample.slice(0,60) };
    })()`;

    for (const [, session] of _sessions) {
        try {
            const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, session.sessionId);
            const val = res?.result?.value || {};
            out.push({
                sessionId: session.sessionId,
                url: val.url || session.url || '',
                acceptLike: Array.isArray(val.acceptLike) ? val.acceptLike : [],
                sample: Array.isArray(val.sample) ? val.sample : [],
            });
        } catch (e) {
            out.push({
                sessionId: session.sessionId,
                url: session.url || '',
                acceptLike: [],
                sample: [`probe failed: ${e.message || String(e)}`],
            });
        }
    }
    return out;
}

/**
 * Build self-contained observer script.
 *
 * This runs inside the OOPIF webview. It must be completely
 * self-contained — no HTTP bridge, no external dependencies.
 * Communication back to extension host via console.log('[GRAV:...]').
 *
 * v3.1 Deep Research Upgrade — 7 solutions applied:
 *   1. Shadow DOM piercing (override attachShadow + scan open roots)
 *   2. Multi-layer click execution (click + pointer events + keyboard + verify/retry)
 *   3. Identity-based click tracking (survives React re-renders)
 *   4. Nested iframe scanning (same-origin iframes inside OOPIF)
 *   5. Unified button collector (main doc + shadow DOMs + iframes)
 *   6. Aggressive MutationObserver (30ms throttle + characterData)
 *   7. Multi-speed polling (fast 300ms near activity, slow 1500ms idle)
 *
 * Designed to work regardless of CSS class names — uses
 * heuristic button detection instead of hardcoded selectors.
 */
function buildObserverScript(patterns, blacklist, scrollEnabled, scrollPauseMs) {
    // Version tag - increment this when observer logic changes
    const OBSERVER_VERSION = 'v3.3.0';
    return `(function() {
    'use strict';
    // Version-based guard: allows new observer to replace old one
    if (window.__grav3 === '${OBSERVER_VERSION}') return;
    window.__grav3 = '${OBSERVER_VERSION}';

    var PATTERNS = ${JSON.stringify(patterns)};
    var BLACKLIST = ${JSON.stringify(blacklist)};
    var SCROLL_ON = ${scrollEnabled};
    var SCROLL_PAUSE = ${scrollPauseMs};
    var _clickId = 0;

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

    // ══════════════════════════════════════════════════════════
    //  Editor/Settings Context Detection — HARD BLOCK
    //  Antigravity 1.19.6+ DOM structure:
    //    - Agent chat panel: .antigravity-agent-side-panel, .react-app-container,
    //      [class*=agent], [class*=chat], [class*=cascade]
    //    - Settings: .settings-editor, [class*=settings], [class*=preference]
    //    - Editor: .monaco-editor, .monaco-diff-editor
    //    - Browser: .simple-browser, [class*=browser]
    //    - Extensions: .extensions-editor, [class*=extension-editor]
    //
    //  CRITICAL: We MUST NOT click buttons in Settings, Browser,
    //  Editor, Extensions — only in agent chat panel.
    // ══════════════════════════════════════════════════════════
    function inEditorContext(btn) {
        if (!btn.closest) return false;
        return !!(
            // ── Monaco Editor (code editor, diff, merge) ──
            btn.closest('.monaco-editor') ||
            btn.closest('.monaco-diff-editor') ||
            btn.closest('.merge-editor-view') ||
            btn.closest('.editor-actions') ||
            btn.closest('.title-actions') ||
            btn.closest('.monaco-toolbar') ||
            // ── Settings panels (all variants) ──
            btn.closest('.settings-editor') ||
            btn.closest('.settings-body') ||
            btn.closest('.settings-tree-container') ||
            btn.closest('[class*=settings-editor]') ||
            btn.closest('[class*=settings]') ||
            btn.closest('[class*=preference]') ||
            btn.closest('[id*=settings]') ||
            // ── Browser / Simple Browser panel ──
            btn.closest('.simple-browser') ||
            btn.closest('[class*=simple-browser]') ||
            btn.closest('[class*=browser-preview]') ||
            btn.closest('[class*=webview-browser]') ||
            // ── Extensions panel ──
            btn.closest('.extensions-editor') ||
            btn.closest('.extension-editor') ||
            btn.closest('[class*=extension-editor]') ||
            btn.closest('[class*=extensions-list]') ||
            btn.closest('[class*=marketplace]') ||
            // ── Keybindings editor ──
            btn.closest('[class*=keybinding]') ||
            btn.closest('.keybindings-editor') ||
            // ── Context menus, quick input ──
            // NOTE: Do NOT block .sidebar or .panel-header — agent panel
            // lives inside the sidebar on Antigravity 1.19.6+
            btn.closest('.context-view') ||
            btn.closest('.monaco-menu') ||
            btn.closest('.quick-input-widget') ||
            btn.closest('.terminal-tab') ||
            // ── Accounts / Auth panels ──
            btn.closest('[class*=accounts]') ||
            btn.closest('[class*=authentication]') ||
            // ── Welcome / Walkthrough ──
            btn.closest('[class*=welcome]') ||
            btn.closest('[class*=walkthrough]') ||
            btn.closest('[class*=getting-started]') ||
            // ── Output panel ──
            btn.closest('[class*=output]') ||
            // ── Notebook ──
            btn.closest('[class*=notebook]')
        );
    }

    function isEditorAccept(text) {
        for (var i = 0; i < EDITOR_SKIP.length; i++) {
            if (matchPattern(text, EDITOR_SKIP[i])) return true;
        }
        return false;
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 1: Identity-based click tracking
    //  Problem: WeakSet loses tracking when React re-renders
    //  (new DOM node = same button but WeakSet doesn't know)
    //  Fix: Use data-attribute stamping + text-based dedup
    // ══════════════════════════════════════════════════════════
    var _clicked = new WeakSet();
    var _clickedIds = {};  // text+position dedup map
    var _expandedOnce = new WeakSet();

    function isAlreadyClicked(btn, text) {
        // Layer 1: WeakSet (same DOM node)
        if (_clicked.has(btn)) return true;
        // Layer 2: text+position dedup (catches rapid double-clicks on same button)
        // Short timeout (500ms) — same button text can appear again legitimately after each tool call
        var key = text + '|' + (btn.getBoundingClientRect().top | 0);
        if (_clickedIds[key] && Date.now() - _clickedIds[key] < 500) return true;
        return false;
    }

    function markClicked(btn, text) {
        _clicked.add(btn);
        var key = text + '|' + (btn.getBoundingClientRect().top | 0);
        _clickedIds[key] = Date.now();
        // Cleanup old entries every 100 clicks
        if (++_clickId % 100 === 0) {
            var now = Date.now();
            for (var k in _clickedIds) {
                if (now - _clickedIds[k] > 10000) delete _clickedIds[k];
            }
        }
    }

    // HIGH_CONFIDENCE: patterns that ONLY appear in agent approval contexts
    // These are auto-clicked WITHOUT requiring reject-sibling or container check
    // because they are unique to agent approval dialogs
    // HIGH_CONFIDENCE: patterns that ONLY appear in agent approval contexts
    // These are auto-clicked WITHOUT requiring reject-sibling or container check
    var HIGH_CONF = {
        'Accept All':1,'Accept all':1,'Accept & Run':1,
        'Keep All Edits':1,'Keep All':1,'Keep & Continue':1,
        'Approve Tool Result':1,'Approve all':1,'Approve All':1,
        // Vietnamese
        'Chấp nhận tất cả':1,'Chấp nhận':1,'Đồng ý':1,'Duyệt tất cả':1,
    };

    // ══════════════════════════════════════════════════════════
    //  Agent Chat Context Detection — Antigravity 1.19.6+
    //  This function confirms a button is inside the agent chat panel.
    //  Antigravity's agent panel uses these containers:
    //    - .antigravity-agent-side-panel (main agent panel)
    //    - .react-app-container (React root for agent UI)
    //    - [class*=agent] (agent-related containers)
    //    - [class*=chat] (chat containers)
    //    - [class*=cascade] (Cascade flow containers)
    //    - [class*=cortex] (Cortex step containers)
    //    - [class*=dialog] (approval dialogs)
    //    - [class*=notification] (notification toasts)
    //
    //  Since this observer only runs inside agent webviews
    //  (filtered by isAgentTarget at host level), we can be
    //  permissive here — but still block known non-agent containers.
    // ══════════════════════════════════════════════════════════
    function inAgentContext(btn) {
        if (!btn.closest) return false;

        // ── HARD BLOCK: Never click in these containers ──
        // (double-safety: even if isAgentTarget let this target through)
        if (btn.closest('.settings-editor') ||
            btn.closest('.settings-body') ||
            btn.closest('[class*=settings-editor]') ||
            btn.closest('.simple-browser') ||
            btn.closest('[class*=simple-browser]') ||
            btn.closest('.extensions-editor') ||
            btn.closest('[class*=extension-editor]') ||
            btn.closest('.keybindings-editor') ||
            btn.closest('[class*=preference]') ||
            btn.closest('[class*=browser-preview]')) {
            return false;
        }

        // ── Positive match: Antigravity agent panel containers ──
        return !!(
            // Antigravity-specific
            btn.closest('.antigravity-agent-side-panel') ||
            btn.closest('[class*=agent-panel]') ||
            btn.closest('[class*=agent-side]') ||
            btn.closest('[class*=cascade]') ||
            btn.closest('[class*=cortex]') ||
            // Generic agent/chat containers
            btn.closest('[class*=agent]') ||
            btn.closest('[class*=chat]') ||
            // Approval dialogs and notifications
            btn.closest('[class*=dialog]') ||
            btn.closest('[class*=notification]') ||
            btn.closest('[class*=overlay]') ||
            btn.closest('[class*=popup]') ||
            btn.closest('[class*=modal]') ||
            btn.closest('[class*=toast]') ||
            // React app container (Antigravity agent UI root)
            btn.closest('.react-app-container') ||
            // Action bars within agent panel
            btn.closest('[class*=action-bar]') ||
            btn.closest('[class*=toolbar]') ||
            // Fallback: if inside body and not blocked above,
            // this is likely the agent webview (OOPIF isolation)
            btn.closest('body')
        );
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 2: Multi-layer click execution
    //  Learned from Puppeteer internals + chrome-accept-cookies:
    //  Layer 1: .click() — standard DOM click
    //  Layer 2: Full pointer event sequence (React SyntheticEvent)
    //  Layer 3: .focus() + Enter key (keyboard activation)
    //  Layer 4: Verify + retry after 200ms
    // ══════════════════════════════════════════════════════════
    function executeClick(btn, matched, text) {
        // Layer 1: Standard .click()
        try { btn.click(); } catch(_) {}

        // Layer 2: Full pointer event sequence (React/Vue SyntheticEvent)
        try {
            var rect = btn.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;

            // mousemove first (some frameworks need hover state)
            btn.dispatchEvent(new MouseEvent('mouseover', {
                bubbles:true, cancelable:true, view:window,
                clientX:cx, clientY:cy
            }));
            btn.dispatchEvent(new MouseEvent('mouseenter', {
                bubbles:false, cancelable:false, view:window,
                clientX:cx, clientY:cy
            }));

            // Full click sequence: pointerdown → mousedown → pointerup → mouseup → click
            ['pointerdown','mousedown','pointerup','mouseup'].forEach(function(ev) {
                var C = ev.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
                btn.dispatchEvent(new C(ev, {
                    bubbles:true, cancelable:true, view:window,
                    clientX:cx, clientY:cy, button:0, buttons:1,
                    isPrimary:true, pointerId:1, pointerType:'mouse'
                }));
            });

            // Explicit click event (some frameworks only listen to this)
            btn.dispatchEvent(new MouseEvent('click', {
                bubbles:true, cancelable:true, view:window,
                clientX:cx, clientY:cy, button:0, detail:1
            }));
        } catch(_) {}

        // Layer 3: Keyboard activation (accessibility path)
        try {
            btn.focus();
            btn.dispatchEvent(new KeyboardEvent('keydown', {
                key:'Enter', code:'Enter', keyCode:13, which:13,
                bubbles:true, cancelable:true
            }));
            btn.dispatchEvent(new KeyboardEvent('keyup', {
                key:'Enter', code:'Enter', keyCode:13, which:13,
                bubbles:true, cancelable:true
            }));
        } catch(_) {}

        report('CLICK', { p: matched, b: text });

        // Layer 4: Verify click worked — retry via CDP native click if button still visible
        // NOTE: Only report RETRY, don't click locally — CDP host will use Input.dispatchMouseEvent
        // which sends trusted browser-level events (more reliable than JS clicks)
        setTimeout(function() {
            try {
                if (btn.isConnected && btn.offsetWidth > 0 && !btn.disabled) {
                    var stillText = labelOf(btn);
                    if (stillText === text) {
                        report('RETRY', { p: matched, b: text });
                        // CDP host handles the actual click via cdpNativeClick()
                    }
                }
            } catch(_) {}
        }, 200);
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 3: Shadow DOM Piercing
    //  Learned from chrome-accept-cookies extension:
    //  Override Element.attachShadow to track all shadow roots,
    //  then scan inside them for buttons.
    // ══════════════════════════════════════════════════════════
    var _shadowRoots = [];
    var MAX_SHADOW_ROOTS = 200; // Cap to prevent memory leak
    var _origAttachShadow = Element.prototype.attachShadow;

    try {
        Element.prototype.attachShadow = function(init) {
            var opts = init || {};
            if (opts.mode === 'closed') opts = Object.assign({}, opts, { mode: 'open' });
            var shadow = _origAttachShadow.call(this, opts);
            // Cap shadow roots array to prevent memory leak
            if (_shadowRoots.length >= MAX_SHADOW_ROOTS) {
                // Remove disconnected roots first, then oldest if still over cap
                _shadowRoots = _shadowRoots.filter(function(sr) {
                    return sr.host && sr.host.isConnected;
                });
                if (_shadowRoots.length >= MAX_SHADOW_ROOTS) {
                    _shadowRoots.shift(); // Remove oldest
                }
            }
            _shadowRoots.push(shadow);
            try {
                var obs = new MutationObserver(onMutation);
                obs.observe(shadow, { childList: true, subtree: true, attributes: true,
                    attributeFilter: ['class','style','disabled','aria-hidden','aria-label','data-state'] });
            } catch(_) {}
            return shadow;
        };
    } catch(_) {}

    // Collect existing open shadow roots
    function collectShadowRoots(root) {
        if (!root) return;
        try {
            var all = root.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
                if (all[i].shadowRoot && _shadowRoots.indexOf(all[i].shadowRoot) === -1) {
                    _shadowRoots.push(all[i].shadowRoot);
                }
            }
        } catch(_) {}
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 4: Nested iframe scanning
    //  Some consent dialogs live in iframes within the OOPIF.
    // ══════════════════════════════════════════════════════════
    function getIframeDocuments() {
        var docs = [];
        try {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                try {
                    var doc = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
                    if (doc && doc.body) docs.push(doc);
                } catch(_) {} // cross-origin — skip silently
            }
        } catch(_) {}
        return docs;
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 5: Unified button collector
    //  Collects buttons from: main document + shadow DOMs + iframes
    //  NOTE: Antigravity uses <span class="cursor-pointer"> for some buttons!
    //  Also covers: flux-* components, data-testid buttons, clickable divs
    // ══════════════════════════════════════════════════════════
    function collectAllButtons() {
        var SEL = 'button, [role="button"], a.action-label, vscode-button, span.cursor-pointer, [class*="cursor-pointer"], [class*="flux-button"], [class*="flux-action"], [data-testid*="accept"], [data-testid*="approve"], [data-testid*="allow"], [data-testid*="run"], div.clickable, [class*="clickable"]';
        var btns = [];

        // Main document
        try {
            var main = document.querySelectorAll(SEL);
            for (var i = 0; i < main.length; i++) btns.push(main[i]);
        } catch(_) {}

        // Shadow DOMs
        for (var s = _shadowRoots.length - 1; s >= 0; s--) {
            try {
                if (!_shadowRoots[s].host || !_shadowRoots[s].host.isConnected) {
                    _shadowRoots.splice(s, 1);
                    continue;
                }
                var sb = _shadowRoots[s].querySelectorAll(SEL);
                for (var j = 0; j < sb.length; j++) btns.push(sb[j]);
            } catch(_) {
                _shadowRoots.splice(s, 1);
            }
        }

        // Nested iframes (same-origin only)
        var iframeDocs = getIframeDocuments();
        for (var d = 0; d < iframeDocs.length; d++) {
            try {
                var ib = iframeDocs[d].querySelectorAll(SEL);
                for (var k = 0; k < ib.length; k++) btns.push(ib[k]);
            } catch(_) {}
        }

        return btns;
    }

    // ── Core: Scan & Click (enhanced) ───────────────────────
    function scanAndClick() {
        collectShadowRoots(document.body);
        var btns = collectAllButtons();

        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];

            // Skip invisible/disabled
            if (b.disabled) continue;
            if (b.offsetWidth === 0 && b.offsetHeight === 0) {
                if (!b.closest || !b.closest('[class*=overlay],[class*=popup],[class*=dialog],[class*=notification]')) continue;
            }

            // Skip editor context
            if (inEditorContext(b)) continue;

            var text = labelOf(b);
            if (!text || text.length > 60) continue;

            // Skip already clicked (multi-layer check)
            if (isAlreadyClicked(b, text)) continue;

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
                        markClicked(b, text);
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

            // ── CLICK (multi-layer) ──
            markClicked(b, text);
            executeClick(b, matched, text);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 6: Aggressive MutationObserver
    //  Reduced throttle from 80ms → 30ms for faster response.
    //  Added characterData tracking for text changes.
    //  Observe iframes as they appear.
    // ══════════════════════════════════════════════════════════
    var _flushTimer = null;
    function onMutation(mutations) {
        // Quick-check: any added nodes or attribute changes?
        var dominated = false;
        if (mutations) {
            for (var m = 0; m < mutations.length && !dominated; m++) {
                var added = mutations[m].addedNodes;
                if (added && added.length > 0) dominated = true;
                if (mutations[m].type === 'attributes') dominated = true;
            }
        }
        if (!dominated && mutations) return; // text-only change, skip

        if (!_flushTimer) {
            scanAndClick();
            _flushTimer = setTimeout(function() { _flushTimer = null; }, 30);
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
                attributes: true, characterData: true,
                attributeFilter: ['class','style','disabled','aria-hidden','aria-label','data-state','data-visible'],
            });
        } catch(_) {}
    }
    attachObserver();

    // Also observe iframes as they load
    function observeIframes() {
        try {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                if (iframes[i].__gravObserved) continue;
                iframes[i].__gravObserved = true;
                iframes[i].addEventListener('load', function() {
                    try {
                        var doc = this.contentDocument;
                        if (doc && doc.body) {
                            var obs = new MutationObserver(onMutation);
                            obs.observe(doc.body, { childList: true, subtree: true, attributes: true,
                                attributeFilter: ['class','style','disabled','aria-hidden'] });
                        }
                    } catch(_) {}
                    setTimeout(scanAndClick, 100);
                });
            }
        } catch(_) {}
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 7: Multi-speed polling
    //  Fast poll (300ms) always active + slow poll (1500ms) safety net
    // ══════════════════════════════════════════════════════════
    var _lastClickTime = Date.now();
    var _origReport = report;
    report = function(type, data) {
        if (type === 'CLICK') _lastClickTime = Date.now();
        _origReport(type, data);
    };

    // Fast poll — catches transient buttons
    setInterval(function() {
        scanAndClick();
        observeIframes();
    }, 300);

    // Slow poll — safety net with shadow root refresh
    setInterval(function() {
        collectShadowRoots(document.body);
        scanAndClick();
    }, 1500);

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

            // Only scroll inside agent/chat containers.
            // Without this guard, we might scroll sidebars, panels, or other UI.
            var ROOT_SEL = '.antigravity-agent-side-panel,.react-app-container,[class*=agent],[class*=chat],[class*=cascade],[class*=cortex]';
            var root = null;
            try { root = document.querySelector(ROOT_SEL); } catch(_) {}
            if (!root) return;

            // Find the largest scrollable container inside the agent root
            var best = null, bestH = 0;
            var els = root.querySelectorAll('*');
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
        // Re-attach observer every 2 minutes (webview navigation kills it)
        if (_healTick >= 120) {
            _healTick = 0;
            attachObserver();
            collectShadowRoots(document.body);
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

    report('BOOT', { v:2, patterns: PATTERNS.length, blacklist: BLACKLIST.length, scroll: SCROLL_ON, shadows: _shadowRoots.length, url: location.href.substring(0, 100) });

    // Debug: log all buttons found on first scan (including shadow DOM + iframes)
    setTimeout(function() {
        var allBtns = collectAllButtons();
        var labels = [];
        var acceptLike = [];
        var acceptRe = /(accept|approve|allow|keep|continue|run|proceed)/i;
        for (var i = 0; i < allBtns.length && i < 200; i++) {
            var l = labelOf(allBtns[i]);
            if (l) {
                labels.push(l);
                if (acceptRe.test(l) && acceptLike.length < 50) acceptLike.push(l);
            }
        }
        report('DEBUG', {
            buttonCount: allBtns.length,
            shadowRoots: _shadowRoots.length,
            iframes: getIframeDocuments().length,
            labels: labels.slice(0, 80),
            acceptLike: acceptLike,
        });
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
                    expression: 'window.__grav3',
                    returnByValue: true,
                }, session.sessionId);

                if (!result || !result.result || typeof result.result.value !== 'string' || !result.result.value.startsWith('v')) {
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
    getLastError,
    getDebugState,
    getDebugLog,
    getLastTargets,
    getSessionSummaries,
    probeAcceptLike,
    hotUpdate, cdpNativeClick,
};
