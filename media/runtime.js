// ═══════════════════════════════════════════════════════════
//  Grav Runtime v1.0.0
//  Injected into workbench.html — runs in renderer process
//
//  Modules:
//    1. Corrupt-banner suppression
//    2. Bridge sync (HTTP ↔ extension host)
//    3. Quota radar (detect exhaustion banners)
//    4. Auto-approve (button click engine)
//    5. Stick-to-bottom scroll
// ═══════════════════════════════════════════════════════════
(function () {
    'use strict';
    if (window.__gravLoaded) return;
    window.__gravLoaded = true;

    // Cleanup previous instance
    if (window.__gravTimers) {
        window.__gravTimers.forEach(clearInterval);
        window.removeEventListener('scroll', window.__gravScrollHandler, true);
    }
    window.__gravTimers = [];

    // ── Config (injected at build time) ──────────────────────
    var PAUSE_MS   = /*{{PAUSE_MS}}*/7000;
    var APPROVE_MS = /*{{APPROVE_MS}}*/1000;
    var SCROLL_MS  = /*{{SCROLL_MS}}*/500;
    var PATTERNS   = /*{{PATTERNS}}*/["Run", "Allow", "Always Allow", "Keep Waiting", "Continue"];
    var ENABLED    = /*{{ENABLED}}*/true;
    var BRIDGE_TOKEN = /*{{BRIDGE_TOKEN}}*/"";

    window.__gravEnabled       = ENABLED;
    window.__gravScrollEnabled = true;
    window.__gravAcceptChat    = false;

    // ── Helpers ──────────────────────────────────────────────
    /** Shadow-DOM-piercing querySelectorAll */
    function deepQuery(sel, root) {
        var results = [];
        (function walk(node) {
            if (!node) return;
            if (node.nodeType === 1) {
                try { if (node.matches(sel)) results.push(node); } catch (_) {}
                if (node.shadowRoot) walk(node.shadowRoot);
            }
            var ch = node.childNodes;
            for (var i = 0; i < ch.length; i++) walk(ch[i]);
        })(root || document);
        return results;
    }

    // ═════════════════════════════════════════════════════════
    //  Module 1: Corrupt-banner suppression
    // ═════════════════════════════════════════════════════════
    (function suppressCorruptBanner() {
        function dismiss() {
            var toasts = document.querySelectorAll(
                '.notifications-toasts .notification-toast, .notification-list-item'
            );
            toasts.forEach(function (el) {
                var text = (el.textContent || '').toLowerCase();
                if (text.indexOf('corrupt') !== -1 || text.indexOf('reinstall') !== -1) {
                    var btn = el.querySelector('.codicon-notifications-clear, .codicon-close');
                    if (btn) btn.click(); else el.style.display = 'none';
                }
            });
        }
        dismiss();
        var count = 0;
        var t = setInterval(function () { dismiss(); if (++count > 30) clearInterval(t); }, 1000);
    })();

    // ═════════════════════════════════════════════════════════
    //  Module 2: Bridge sync
    // ═════════════════════════════════════════════════════════
    var BRIDGE_PORT_START = 48787, BRIDGE_PORT_END = 48850, BRIDGE_PORT = 0;
    var _pollCount = 0, _pollErrors = 0, _scanning = false;
    var _sessionStats = {}, _sessionTotal = 0;

    function discoverBridge(cb) {
        if (_scanning) return;
        _scanning = true;
        var found = false;
        function batch(from) {
            if (from > BRIDGE_PORT_END || found) { if (!found) _scanning = false; return; }
            var end = Math.min(from + 7, BRIDGE_PORT_END), pending = 0;
            for (var p = from; p <= end; p++) {
                (function (port) {
                    pending++;
                    var x = new XMLHttpRequest();
                    x.open('GET', 'http://127.0.0.1:' + port + '/grav-status?t=' + Date.now(), true);
                    if (BRIDGE_TOKEN) x.setRequestHeader('X-Grav-Token', BRIDGE_TOKEN);
                    x.timeout = 800;
                    x.onload = function () {
                        if (found) return;
                        if (x.status === 200) {
                            try {
                                var c = JSON.parse(x.responseText);
                                if (typeof c.enabled === 'boolean') {
                                    found = true; BRIDGE_PORT = port; _scanning = false;
                                    if (cb) cb(port, c);
                                }
                            } catch (_) {}
                        }
                        if (--pending <= 0 && !found) batch(end + 1);
                    };
                    x.onerror = x.ontimeout = function () { if (--pending <= 0 && !found) batch(end + 1); };
                    x.send();
                })(p);
            }
        }
        batch(BRIDGE_PORT_START);
    }

    function applyConfig(c) {
        if (typeof c.enabled === 'boolean')       window.__gravEnabled = c.enabled;
        if (typeof c.scrollEnabled === 'boolean') window.__gravScrollEnabled = c.scrollEnabled;
        if (Array.isArray(c.patterns))            PATTERNS = c.patterns.filter(function (p) { return p !== 'Accept'; });
        if (typeof c.acceptInChatOnly === 'boolean') window.__gravAcceptChat = c.acceptInChatOnly;
        if (c.bridgeToken) BRIDGE_TOKEN = c.bridgeToken;
        if (c.pauseMs)   PAUSE_MS = c.pauseMs;
        if (c.scrollMs)  SCROLL_MS = c.scrollMs;
        if (c.approveMs) APPROVE_MS = c.approveMs;
        if (c.resetStats) { _sessionStats = {}; _sessionTotal = 0; }
    }

    discoverBridge(function (port, c) { applyConfig(c); _pollErrors = 0; });

    var syncTimer = setInterval(function () {
        _pollCount++;
        if (BRIDGE_PORT === 0) {
            if (_pollCount % 5 === 0) discoverBridge(function (p, c) { applyConfig(c); _pollErrors = 0; });
            return;
        }
        if (_pollErrors > 3) { BRIDGE_PORT = 0; _pollErrors = 0; discoverBridge(function (p, c) { applyConfig(c); }); return; }
        try {
            var x = new XMLHttpRequest();
            var qs = '';
            if (_sessionTotal > 0) {
                qs = '&total=' + _sessionTotal + '&stats=' + encodeURIComponent(JSON.stringify(_sessionStats));
                _sessionStats = {}; _sessionTotal = 0;
            }
            x.open('GET', 'http://127.0.0.1:' + BRIDGE_PORT + '/grav-status?t=' + Date.now() + qs, true);
            if (BRIDGE_TOKEN) x.setRequestHeader('X-Grav-Token', BRIDGE_TOKEN);
            x.timeout = 1500;
            x.onload = function () { if (x.status === 200) { _pollErrors = 0; applyConfig(JSON.parse(x.responseText)); } };
            x.onerror = x.ontimeout = function () { _pollErrors++; };
            x.send();
        } catch (_) { _pollErrors++; }
    }, 2000);
    window.__gravTimers.push(syncTimer);

    // ═════════════════════════════════════════════════════════
    //  Module 3: Quota radar
    // ═════════════════════════════════════════════════════════
    var QUOTA_PHRASES = [
        'baseline model quota reached', 'exhausted your capacity', 'quota will reset',
        'model quota exceeded', 'rate limit exceeded', 'quota exhausted',
        'capacity exceeded', 'model at capacity', 'too many requests',
        'weekly limit reached', 'credits exhausted', 'usage limit exceeded',
        'quota has been reached', 'you have reached your limit',
        'please wait before sending', 'try again later',
        'request limit reached', 'daily limit reached',
        'model is currently unavailable', 'temporarily unavailable',
        'exceeded the maximum number', 'throttled',
        'resource exhausted', 'insufficient quota',
        'billing limit', 'spending limit reached',
        '168-hour lockout', 'locked for',
    ];
    var _lastQuotaPing = 0;

    function detectQuota() {
        var body = (document.body && document.body.innerText || '').toLowerCase();
        for (var i = 0; i < QUOTA_PHRASES.length; i++) {
            if (body.indexOf(QUOTA_PHRASES[i]) !== -1) return QUOTA_PHRASES[i];
        }
        // Check iframes
        try {
            var frames = document.querySelectorAll('iframe, webview');
            for (var f = 0; f < frames.length; f++) {
                try {
                    var doc = frames[f].contentDocument || (frames[f].contentWindow && frames[f].contentWindow.document);
                    if (doc && doc.body) {
                        var ft = (doc.body.innerText || '').toLowerCase();
                        for (var i = 0; i < QUOTA_PHRASES.length; i++) {
                            if (ft.indexOf(QUOTA_PHRASES[i]) !== -1) return QUOTA_PHRASES[i];
                        }
                    }
                } catch (_) {}
            }
        } catch (_) {}
        // Check notification toasts
        var toasts = document.querySelectorAll('.notifications-toasts .notification-toast, .notification-list-item, [class*=notification]');
        for (var t = 0; t < toasts.length; t++) {
            var tt = (toasts[t].textContent || '').toLowerCase();
            for (var i = 0; i < QUOTA_PHRASES.length; i++) {
                if (tt.indexOf(QUOTA_PHRASES[i]) !== -1) return QUOTA_PHRASES[i];
            }
        }
        return null;
    }

    var quotaRadar = setInterval(function () {
        if (!window.__gravEnabled) return;
        if (Date.now() - _lastQuotaPing < 15000) return;
        var phrase = detectQuota();
        if (!phrase) return;
        _lastQuotaPing = Date.now();
        if (BRIDGE_PORT > 0) {
            try {
                var x = new XMLHttpRequest();
                x.open('POST', 'http://127.0.0.1:' + BRIDGE_PORT + '/api/quota-detected', true);
                x.setRequestHeader('Content-Type', 'application/json');
                if (BRIDGE_TOKEN) x.setRequestHeader('X-Grav-Token', BRIDGE_TOKEN);
                x.timeout = 3000;
                x.send(JSON.stringify({ phrase: phrase }));
            } catch (_) {}
        }
    }, 3000);
    window.__gravTimers.push(quotaRadar);

    // ═════════════════════════════════════════════════════════
    //  Module 4: Auto-approve engine
    // ═════════════════════════════════════════════════════════
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];
    var EDITOR_SKIP  = ['Accept Changes', 'Accept All', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var _clicked = new WeakSet();

    function labelOf(btn) {
        var raw = (btn.innerText || btn.textContent || '').trim();
        var first = raw.split('\n')[0].trim();
        var aria = (btn.getAttribute('aria-label') || '').trim();
        var direct = '';
        for (var i = 0; i < btn.childNodes.length; i++) {
            if (btn.childNodes[i].nodeType === 3) direct += btn.childNodes[i].nodeValue || '';
        }
        return direct.trim() || first || aria;
    }

    function hasRejectNearby(btn) {
        var p = btn.parentElement;
        for (var lv = 0; lv < 4 && p; lv++) {
            var sibs = p.querySelectorAll('button, [role="button"], vscode-button');
            for (var i = 0; i < sibs.length; i++) {
                if (sibs[i] === btn) continue;
                var t = labelOf(sibs[i]);
                for (var j = 0; j < REJECT_WORDS.length; j++) {
                    if (t === REJECT_WORDS[j] || t.indexOf(REJECT_WORDS[j]) === 0) return true;
                }
            }
            p = p.parentElement;
        }
        return false;
    }

    var approveEngine = setInterval(function () {
        if (!window.__gravEnabled) return;
        var btns = deepQuery('button, vscode-button, a.action-label, [role="button"], span.cursor-pointer', document);
        var target = null, matched = '';

        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (_clicked.has(b)) continue;
            // Must be visible (or in overlay/dialog)
            if (b.offsetParent === null && !b.closest('[class*=overlay],[class*=popup],[class*=dialog],[class*=notification],[class*=quick-input],[class*=context-view]')) continue;
            var text = labelOf(b);
            if (!text || text.length > 50) continue;

            // Skip editor merge/diff buttons
            var skip = false;
            for (var s = 0; s < EDITOR_SKIP.length; s++) {
                if (text.indexOf(EDITOR_SKIP[s]) === 0) { skip = true; break; }
            }
            if (skip) continue;
            if (b.closest && (b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view') || b.closest('.view-zones') || b.closest('.view-lines'))) continue;

            // Match against patterns
            for (var p = 0; p < PATTERNS.length; p++) {
                if (text === PATTERNS[p] || text.indexOf(PATTERNS[p]) === 0) { matched = PATTERNS[p]; break; }
            }
            if (!matched) continue;

            // Critical patterns: click immediately
            if (matched === 'Allow' || matched === 'Run' || matched === 'Always Allow' || matched === 'Accept all') {
                target = b; break;
            }
            // Others: only if there's a reject sibling (confirms it's a permission dialog)
            if (hasRejectNearby(b)) { target = b; break; }
        }

        // Accept (chat-only mode)
        if (!target && window.__gravAcceptChat) {
            for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                if (b.offsetParent === null || _clicked.has(b)) continue;
                var t = labelOf(b);
                if (t.indexOf('Accept') !== 0 || /^Accept\s+(all|changes|incoming|current|both|combination)/i.test(t)) continue;
                if (b.closest && (b.closest('.editor-scrollable') || b.closest('.monaco-diff-editor'))) continue;
                target = b; matched = 'Accept'; break;
            }
        }

        if (target) {
            _clicked.add(target);
            target.click();
            // Report to host
            if (BRIDGE_PORT > 0) {
                try {
                    var x = new XMLHttpRequest();
                    x.open('POST', 'http://127.0.0.1:' + BRIDGE_PORT + '/api/click-log', true);
                    x.setRequestHeader('Content-Type', 'application/json');
                    if (BRIDGE_TOKEN) x.setRequestHeader('X-Grav-Token', BRIDGE_TOKEN);
                    x.timeout = 2000;
                    x.send(JSON.stringify({ button: text, pattern: matched }));
                } catch (_) {}
            }
            _sessionTotal++;
            _sessionStats[matched] = (_sessionStats[matched] || 0) + 1;
        }
        matched = '';
    }, APPROVE_MS);
    window.__gravTimers.push(approveEngine);

    // ═════════════════════════════════════════════════════════
    //  Module 5: Stick-to-bottom scroll
    // ═════════════════════════════════════════════════════════
    var _wasBottom    = new WeakMap();
    var _justScrolled = new WeakSet();
    var _autoScrolling = false;
    var _cachedPanel   = null;
    var _panelTick     = 0;

    var scrollEngine = setInterval(function () {
        if (!window.__gravEnabled || !window.__gravScrollEnabled) return;
        // Re-find panel periodically
        if (!_cachedPanel || !_cachedPanel.isConnected || ++_panelTick > 20) {
            _cachedPanel = document.querySelector('.antigravity-agent-side-panel');
            _panelTick = 0;
        }
        if (!_cachedPanel) return;

        var scrollables = Array.from(_cachedPanel.querySelectorAll('*')).filter(function (el) {
            var s = window.getComputedStyle(el);
            return el.scrollHeight > el.clientHeight
                && (s.overflowY === 'auto' || s.overflowY === 'scroll')
                && el.tagName !== 'TEXTAREA';
        });

        if (scrollables.length > 0) {
            _autoScrolling = true;
            scrollables.forEach(function (el) {
                var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                var was = _wasBottom.get(el);
                if (was === undefined) { was = gap <= 150; _wasBottom.set(el, was); }
                if (was && gap > 5) { _justScrolled.add(el); el.scrollTop = el.scrollHeight; }
            });
            setTimeout(function () { _autoScrolling = false; }, 200);
        }
    }, SCROLL_MS);
    window.__gravTimers.push(scrollEngine);

    window.__gravScrollHandler = function (e) {
        var el = e.target;
        if (!el || el.nodeType !== 1 || !el.closest || !el.closest('.antigravity-agent-side-panel')) return;
        if (_justScrolled.has(el)) { _justScrolled.delete(el); return; }
        if (_autoScrolling) return;
        _wasBottom.set(el, (el.scrollHeight - el.scrollTop - el.clientHeight) <= 150);
    };
    window.addEventListener('scroll', window.__gravScrollHandler, true);

    // ── Boot log ─────────────────────────────────────────────
    console.log('[Grav] v1.0.0 runtime loaded | Patterns:', JSON.stringify(PATTERNS));
})();
