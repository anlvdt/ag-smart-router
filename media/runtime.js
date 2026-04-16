// ═══════════════════════════════════════════════════════════
//  Grav Runtime v3.0 (Fallback)
//
//  This runtime is injected into workbench.html as a FALLBACK
//  for older Antigravity versions where CDP can't reach the
//  agent panel (pre-OOPIF).
//
//  On newer versions (1.19.6+), the CDP observer in cdp.js
//  handles everything. This runtime only provides:
//    1. Corrupt-banner suppression
//    2. Bridge sync (config hot-reload)
//    3. Basic button scan in main document
//    4. Stick-to-bottom scroll (main document only)
//
//  If CDP observer is active, this runtime gracefully defers.
// ═══════════════════════════════════════════════════════════
(function () {
    'use strict';
    if (window.__gravLoaded) return;
    window.__gravLoaded = true;

    if (window.__gravTimers) {
        window.__gravTimers.forEach(clearInterval);
        window.removeEventListener('scroll', window.__gravScrollHandler, true);
    }
    if (window.__gravObserver) { try { window.__gravObserver.disconnect(); } catch (_) {} }
    window.__gravTimers = [];

    // ── Config ──────────────────────────────────────────────
    var PAUSE_MS   = /*{{PAUSE_MS}}*/7000;
    var APPROVE_MS = /*{{APPROVE_MS}}*/500;
    var SCROLL_MS  = /*{{SCROLL_MS}}*/500;
    var PATTERNS   = /*{{PATTERNS}}*/["Accept all","Accept All","Accept","Accept & Run","Keep All Edits","Keep All","Keep & Continue","Keep","Continue","Retry","Keep Waiting","Proceed","Run Task","Run","Allow","Allow Once","Allow in this Session","Allow this conversation","Allow and Review","Approve Tool Result","Approve all"];
    var ENABLED    = /*{{ENABLED}}*/true;

    window.__gravEnabled       = ENABLED;
    window.__gravScrollEnabled = true;

    // ═════════════════════════════════════════════════════════
    //  Module 1: Corrupt-banner suppression
    // ═════════════════════════════════════════════════════════
    (function() {
        function dismiss() {
            var toasts = document.querySelectorAll(
                '.notifications-toasts .notification-toast, .notification-list-item'
            );
            toasts.forEach(function (el) {
                var text = (el.textContent || '').toLowerCase();
                if (text.indexOf('corrupt') !== -1 || text.indexOf('reinstall') !== -1) {
                    var btn = el.querySelector('.codicon-notifications-clear, .codicon-close, [class*=close]');
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
    var _pollErrors = 0, _scanning = false;

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
        if (Array.isArray(c.patterns))            PATTERNS = c.patterns;
        if (c.pauseMs)   PAUSE_MS = c.pauseMs;
        if (c.scrollMs)  SCROLL_MS = c.scrollMs;
        if (c.approveMs) APPROVE_MS = c.approveMs;
    }

    discoverBridge(function (port, c) { applyConfig(c); _pollErrors = 0; });

    var syncTimer = setInterval(function () {
        if (BRIDGE_PORT === 0) {
            discoverBridge(function (p, c) { applyConfig(c); _pollErrors = 0; });
            return;
        }
        if (_pollErrors > 3) { BRIDGE_PORT = 0; _pollErrors = 0; return; }
        try {
            var x = new XMLHttpRequest();
            x.open('GET', 'http://127.0.0.1:' + BRIDGE_PORT + '/grav-status?t=' + Date.now(), true);
            x.timeout = 1500;
            x.onload = function () { if (x.status === 200) { _pollErrors = 0; applyConfig(JSON.parse(x.responseText)); } };
            x.onerror = x.ontimeout = function () { _pollErrors++; };
            x.send();
        } catch (_) { _pollErrors++; }
    }, 3000);
    window.__gravTimers.push(syncTimer);

    // ═════════════════════════════════════════════════════════
    //  Module 3: Button auto-click (fallback for pre-OOPIF)
    //  If CDP observer is active in OOPIF, buttons there are
    //  handled by CDP. This only catches buttons in main document.
    // ═════════════════════════════════════════════════════════
    var REJECT_WORDS = ['Reject','Deny','Cancel','Dismiss',"Don't Allow",'Decline'];
    var EDITOR_SKIP  = ['Accept Changes','Accept Incoming','Accept Current','Accept Both','Accept Combination'];
    var _clickedAt = new WeakSet();

    function matchPattern(text, pattern) {
        if (text === pattern) return true;
        if (text.length <= pattern.length) return false;
        if (text.indexOf(pattern) !== 0) return false;
        var c = text.charAt(pattern.length);
        return /[\s\u00a0.,;:!?\-\u2013\u2014()\[\]{}|/\\<>'"@#$%^&*+=~`]/.test(c);
    }

    function findMatch(text) {
        var best = '', len = 0;
        for (var i = 0; i < PATTERNS.length; i++) {
            if (PATTERNS[i].length > len && matchPattern(text, PATTERNS[i])) {
                best = PATTERNS[i]; len = best.length;
            }
        }
        return best;
    }

    function labelOf(btn) {
        var direct = '';
        for (var i = 0; i < btn.childNodes.length; i++) {
            if (btn.childNodes[i].nodeType === 3) direct += btn.childNodes[i].nodeValue || '';
        }
        direct = direct.trim();
        if (direct.length >= 2 && direct.length <= 60) return direct;

        var raw = (btn.innerText || btn.textContent || '').trim();
        var first = raw.split('\n')[0].trim();
        if (first.length >= 2 && first.length <= 60) return first;

        var aria = (btn.getAttribute('aria-label') || '').trim();
        if (aria.length >= 2 && aria.length <= 60) return aria;

        var title = (btn.getAttribute('title') || '').trim();
        if (title.length >= 2 && title.length <= 60) return title;

        var spans = btn.querySelectorAll('span, div, label');
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

    function inEditorContext(btn) {
        if (!btn.closest) return false;
        return !!(btn.closest('.monaco-editor') || btn.closest('.monaco-diff-editor') ||
            btn.closest('.editor-actions') || btn.closest('.title-actions') ||
            btn.closest('.monaco-toolbar') || btn.closest('.context-view') ||
            btn.closest('.monaco-menu') || btn.closest('.quick-input-widget') ||
            btn.closest('.sidebar') || btn.closest('.panel-header') || btn.closest('.terminal-tab') ||
            btn.closest('[class*=settings]') || btn.closest('[class*=preference]') ||
            btn.closest('[class*=keybinding]') || btn.closest('[class*=extension-editor]'));
    }

    function hasRejectNearby(btn) {
        var p = btn.parentElement;
        for (var lv = 0; lv < 4 && p; lv++) {
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

    function scanAndClick() {
        if (!window.__gravEnabled) return;

        var btns = document.querySelectorAll('button, vscode-button, a.action-label, [role="button"]');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (b.disabled || b.offsetWidth === 0) continue;
            if (_clickedAt.has(b)) continue;
            if (inEditorContext(b)) continue;

            var text = labelOf(b);
            if (!text || text.length > 60) continue;

            for (var s = 0; s < EDITOR_SKIP.length; s++) {
                if (matchPattern(text, EDITOR_SKIP[s])) { text = ''; break; }
            }
            if (!text) continue;

            var matched = findMatch(text);
            if (!matched) continue;

            if (!hasRejectNearby(b)) continue;

            _clickedAt.add(b);
            try { b.click(); } catch(_) {}
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

            if (BRIDGE_PORT > 0) {
                try {
                    var x = new XMLHttpRequest();
                    x.open('POST', 'http://127.0.0.1:' + BRIDGE_PORT + '/api/click-log', true);
                    x.setRequestHeader('Content-Type', 'application/json');
                    x.timeout = 1000;
                    x.send(JSON.stringify({ button: text, pattern: matched, source: 'runtime' }));
                } catch(_) {}
            }
        }
    }

    // MutationObserver + polling
    var _flushTimer = null;
    try {
        var observer = new MutationObserver(function() {
            if (!_flushTimer) {
                scanAndClick();
                _flushTimer = setTimeout(function() { _flushTimer = null; }, 100);
            }
        });
        observer.observe(document.body, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ['class','disabled','aria-hidden','style'],
        });
        window.__gravApproveObserver = observer;
    } catch(_) {}

    scanAndClick();
    var pollTimer = setInterval(scanAndClick, Math.max(APPROVE_MS, 1500));
    window.__gravTimers.push(pollTimer);

    // ═════════════════════════════════════════════════════════
    //  Module 4: Stick-to-bottom scroll (main document only)
    // ═════════════════════════════════════════════════════════
    var CHAT_SELECTORS = [
        '.antigravity-agent-side-panel',
        '.react-app-container',
        '[class*=agent-panel]',
        '[class*=chat-panel]',
        '.chat-widget',
        '.interactive-session',
    ];
    var _chatPanel = null, _chatTick = 0;
    var _wasBottom = new WeakMap();
    var _justScrolled = new WeakSet();
    var _autoScrolling = false;

    function findChatPanel() {
        if (_chatPanel && _chatPanel.isConnected && ++_chatTick < 30) return _chatPanel;
        _chatTick = 0;
        for (var i = 0; i < CHAT_SELECTORS.length; i++) {
            var el = document.querySelector(CHAT_SELECTORS[i]);
            if (el) { _chatPanel = el; return el; }
        }
        _chatPanel = null;
        return null;
    }

    var scrollTimer = setInterval(function () {
        if (!window.__gravEnabled || !window.__gravScrollEnabled) return;
        var panel = findChatPanel();
        if (!panel) return;

        // Find largest scrollable child
        var best = null, bestH = 0;
        var els = panel.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.scrollHeight <= el.clientHeight + 30) continue;
            if (el.tagName === 'CODE' || el.tagName === 'PRE' || el.tagName === 'TEXTAREA') continue;
            var cls = (el.className || '').toString().toLowerCase();
            if (/code|terminal|xterm|editor|monaco|diff/.test(cls)) continue;
            var s = window.getComputedStyle(el);
            if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
            if (el.clientHeight > bestH) { bestH = el.clientHeight; best = el; }
        }
        if (!best) return;

        _autoScrolling = true;
        var gap = best.scrollHeight - best.scrollTop - best.clientHeight;
        var was = _wasBottom.get(best);
        if (was === undefined) { was = gap <= 150; _wasBottom.set(best, was); }
        if (was && gap > 5) {
            _justScrolled.add(best);
            best.scrollTop = best.scrollHeight;
        }
        setTimeout(function () { _autoScrolling = false; }, 200);
    }, SCROLL_MS);
    window.__gravTimers.push(scrollTimer);

    window.__gravScrollHandler = function (e) {
        var el = e.target;
        if (!el || el.nodeType !== 1) return;
        if (_justScrolled.has(el)) { _justScrolled.delete(el); return; }
        if (_autoScrolling) return;
        _wasBottom.set(el, (el.scrollHeight - el.scrollTop - el.clientHeight) <= 150);
    };
    window.addEventListener('scroll', window.__gravScrollHandler, true);

    console.log('[Grav] Runtime v3.0 loaded (fallback) | Patterns:', PATTERNS.length);
})();
