(function () {
    'use strict';
    if (window.__gravLoaded) return;
    window.__gravLoaded = true;

    // Cleanup existing timers and handlers
    if (window.__gravTimers) { window.__gravTimers.forEach(clearInterval); window.__gravTimers = []; }
    if (window.__gravScrollHandler) { window.removeEventListener('scroll', window.__gravScrollHandler, true); window.__gravScrollHandler = null; }
    if (window.__gravApproveObserver) { try { window.__gravApproveObserver.disconnect(); } catch (_) { } window.__gravApproveObserver = null; }

    // Config
    var PAUSE_MS = /*{{PAUSE_MS}}*/7000;
    var APPROVE_MS = /*{{APPROVE_MS}}*/500;
    var SCROLL_MS = /*{{SCROLL_MS}}*/500;
    var PATTERNS = /*{{PATTERNS}}*/["Accept all", "Accept All", "Accept", "Retry", "Proceed", "Run", "Approve", "Expand"];
    var ENABLED = /*{{ENABLED}}*/true;

    window.__gravEnabled = ENABLED;
    window.__gravScrollEnabled = true;

    // Corrupt-banner suppression
    (function () {
        var dismiss = function () {
            var toasts = document.querySelectorAll('.notifications-toasts .notification-toast, .notification-list-item');
            toasts.forEach(function (el) {
                var text = (el.textContent || '').toLowerCase();
                if (text.indexOf('corrupt') !== -1 || text.indexOf('reinstall') !== -1) {
                    var btn = el.querySelector('.codicon-notifications-clear, .codicon-close, [class*=close]');
                    if (btn) btn.click(); else el.style.display = 'none';
                }
            });
        };
        dismiss();
        var count = 0;
        var t = setInterval(function () { dismiss(); if (++count > 30) clearInterval(t); }, 1000);
    })();

    // Bridge sync
    var BRIDGE_PORT_START = 48787, BRIDGE_PORT_END = 48850, BRIDGE_PORT = 0;
    var _pollErrors = 0, _scanning = false;

    var discoverBridge = function (cb) {
        if (_scanning) return;
        _scanning = true;
        var found = false;
        var batch = function (from) {
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
                                if (typeof c.enabled === 'boolean') { found = true; BRIDGE_PORT = port; _scanning = false; if (cb) cb(port, c); }
                            } catch (_) { }
                        }
                        if (--pending <= 0 && !found) batch(end + 1);
                    };
                    x.onerror = x.ontimeout = function () { if (--pending <= 0 && !found) batch(end + 1); };
                    x.send();
                })(p);
            }
        };
        batch(BRIDGE_PORT_START);
    };

    var applyConfig = function (c) {
        if (typeof c.enabled === 'boolean') window.__gravEnabled = c.enabled;
        if (typeof c.scrollEnabled === 'boolean') window.__gravScrollEnabled = c.scrollEnabled;
        if (Array.isArray(c.patterns)) PATTERNS = c.patterns;
        if (c.pauseMs) PAUSE_MS = c.pauseMs;
        if (c.scrollMs) SCROLL_MS = c.scrollMs;
        if (c.approveMs) APPROVE_MS = c.approveMs;
    };

    discoverBridge(function (port, c) { applyConfig(c); _pollErrors = 0; });

    var syncTimer = setInterval(function () {
        if (BRIDGE_PORT === 0) { discoverBridge(function (p, c) { applyConfig(c); _pollErrors = 0; }); return; }
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

    // Button auto-click
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];
    var EDITOR_SKIP = ['Accept Changes', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var HIGH_CONF = { 'Accept All': 1, 'Accept all': 1, 'Approve': 1, 'Resume': 1, 'Try Again': 1, 'Reconnect': 1, 'Resume Conversation': 1, 'Continue': 1, 'Run': 1, 'Retry': 1, 'Proceed': 1 };
    var _clickedAt = new WeakSet();
    var _clickedIds = {};
    var _globalCooldown = 0;
    var _runCooldown = 0;

    // Cooldown durations (ms)
    var COOLDOWN = {
        'Run': 5000, 'Accept': 1500, 'Accept all': 1500, 'Accept All': 1500,
        'Approve': 2000, 'Allow Once': 3000, 'Allow This Conversation': 3000,
        _default: 1000, _global: 500
    };

    var getCooldown = function(text) { return COOLDOWN[text] || COOLDOWN._default; };

    var isAlreadyClicked = function(btn, text) {
        if (_clickedAt.has(btn)) return true;
        if (Date.now() < _globalCooldown) return true;
        var timeout = getCooldown(text);
        var key = text + '|' + (btn.getBoundingClientRect().top | 0);
        if (_clickedIds[key] && Date.now() - _clickedIds[key] < timeout) return true;
        var patternKey = 'pattern:' + text;
        if (_clickedIds[patternKey] && Date.now() - _clickedIds[patternKey] < timeout) return true;
        return false;
    };

    var markClicked = function(btn, text) {
        _clickedAt.add(btn);
        var now = Date.now();
        var key = text + '|' + (btn.getBoundingClientRect().top | 0);
        _clickedIds[key] = now;
        _clickedIds['pattern:' + text] = now;
        _globalCooldown = now + COOLDOWN._global;
        if (text === 'Run' || text.indexOf('Run ') === 0) _runCooldown = now + COOLDOWN['Run'];
    };

    var isRunCooldown = function() { return Date.now() < _runCooldown; };

    var matchPattern = function (text, pattern) {
        if (text === pattern) return true;
        if (text.length <= pattern.length) return false;
        if (text.indexOf(pattern) !== 0) return false;
        var c = text.charAt(pattern.length);
        return /[\s\u00a0.,;:!?\-\u2013\u2014()\[\]{}|/\\<>'"@#$%^&*+=~`]/.test(c);
    };

    var findMatch = function (text) {
        var best = '', len = 0;
        for (var i = 0; i < PATTERNS.length; i++) { if (PATTERNS[i].length > len && matchPattern(text, PATTERNS[i])) { best = PATTERNS[i]; len = best.length; } }
        return best;
    };

    var labelOf = function (btn) {
        var direct = '';
        for (var i = 0; i < btn.childNodes.length; i++) { if (btn.childNodes[i].nodeType === 3) direct += btn.childNodes[i].nodeValue || ''; }
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
            for (var k = 0; k < spans[j].childNodes.length; k++) { if (spans[j].childNodes[k].nodeType === 3) t += spans[j].childNodes[k].nodeValue || ''; }
            t = t.trim();
            if (t) st += (st ? ' ' : '') + t;
        }
        if (st.length >= 2 && st.length <= 60) return st;
        return '';
    };

    var inEditorContext = function (btn) {
        if (!btn.closest) return false;
        // Grav Dashboard detection (by page title)
        try {
            var pageTitle = (document.title || '').toLowerCase();
            if (pageTitle.indexOf('grav') !== -1 && pageTitle.indexOf('dashboard') !== -1) return true;
        } catch(_) {}
        return !!(btn.closest('.monaco-editor') || btn.closest('.monaco-diff-editor') || btn.closest('.merge-editor-view') || btn.closest('.editor-actions') || btn.closest('.title-actions') || btn.closest('.monaco-toolbar') || btn.closest('.context-view') || btn.closest('.monaco-menu') || btn.closest('.quick-input-widget') || btn.closest('.sidebar') || btn.closest('.panel-header') || btn.closest('.terminal-tab') || btn.closest('.settings-editor') || btn.closest('.settings-body') || btn.closest('[class*=settings-editor]') || btn.closest('[class*=settings]') || btn.closest('[class*=preference]') || btn.closest('[id*=settings]') || btn.closest('.simple-browser') || btn.closest('[class*=simple-browser]') || btn.closest('[class*=browser-preview]') || btn.closest('.extensions-editor') || btn.closest('.extension-editor') || btn.closest('[class*=extension-editor]') || btn.closest('[class*=keybinding]') || btn.closest('.keybindings-editor') || btn.closest('[class*=accounts]') || btn.closest('[class*=authentication]') || btn.closest('[class*=welcome]') || btn.closest('[class*=walkthrough]') || btn.closest('[class*=output]') || btn.closest('[class*=notebook]'));
    };

    var hasRejectNearby = function (btn) {
        var p = btn.parentElement;
        for (var lv = 0; lv < 4 && p; lv++) {
            var sibs = p.querySelectorAll('button, [role="button"], vscode-button');
            for (var i = 0; i < sibs.length; i++) {
                if (sibs[i] === btn) continue;
                var t = labelOf(sibs[i]);
                for (var j = 0; j < REJECT_WORDS.length; j++) { if (matchPattern(t, REJECT_WORDS[j])) return true; }
            }
            p = p.parentElement;
        }
        return false;
    };

    var scanAndClick = function () {
        if (!window.__gravEnabled) return;
        var btns = document.querySelectorAll('button, vscode-button, a.action-label, [role="button"]');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (b.disabled || b.offsetWidth === 0) continue;
            if (inEditorContext(b)) continue;
            var text = labelOf(b);
            if (!text || text.length > 60) continue;
            if (isAlreadyClicked(b, text)) continue;
            for (var s = 0; s < EDITOR_SKIP.length; s++) { if (matchPattern(text, EDITOR_SKIP[s])) { text = ''; break; } }
            if (!text) continue;
            var matched = findMatch(text);
            if (!matched) continue;
            // Run cooldown check
            if ((matched === 'Run' || matched.indexOf('Run ') === 0) && isRunCooldown()) continue;
            var isHighConf = !!HIGH_CONF[matched];
            if (!isHighConf && !hasRejectNearby(b)) continue;
            markClicked(b, text);
            try { b.click(); } catch (_) { }
            try {
                var rect = b.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (ev) {
                    var C = ev.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
                    b.dispatchEvent(new C(ev, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, isPrimary: true }));
                });
            } catch (_) { }
            if (BRIDGE_PORT > 0) {
                try {
                    var x = new XMLHttpRequest();
                    x.open('POST', 'http://127.0.0.1:' + BRIDGE_PORT + '/api/click-log', true);
                    x.setRequestHeader('Content-Type', 'application/json');
                    x.timeout = 1000;
                    x.send(JSON.stringify({ button: text, pattern: matched, source: 'runtime' }));
                } catch (_) { }
            }
        }
    };

    // MutationObserver with proper cleanup
    var _flushTimer = null;
    try {
        var observer = new MutationObserver(function () {
            if (!_flushTimer) { scanAndClick(); _flushTimer = setTimeout(function () { _flushTimer = null; }, 100); }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-hidden', 'style'] });
        window.__gravApproveObserver = observer;
    } catch (_) { }

    // Initial scan with delay
    setTimeout(scanAndClick, 1000);
    // Standard poll — 1.5s minimum (slower to prevent "requires input" errors)
    var pollTimer = setInterval(scanAndClick, Math.max(APPROVE_MS, 1500));
    window.__gravTimers.push(pollTimer);

    // Stick-to-bottom scroll
    var CHAT_SELECTORS = ['.antigravity-agent-side-panel', '.react-app-container', '[class*=agent-panel]', '[class*=chat-panel]', '.chat-widget', '.interactive-session'];
    var _chatPanel = null, _chatTick = 0;
    var _wasBottom = new WeakMap();
    var _justScrolled = new WeakSet();
    var _autoScrolling = false;

    var findChatPanel = function () {
        if (_chatPanel && _chatPanel.isConnected && ++_chatTick < 30) return _chatPanel;
        _chatTick = 0;
        for (var i = 0; i < CHAT_SELECTORS.length; i++) { var el = document.querySelector(CHAT_SELECTORS[i]); if (el) { _chatPanel = el; return el; } }
        _chatPanel = null;
        return null;
    };

    var scrollTimer = setInterval(function () {
        if (!window.__gravEnabled || !window.__gravScrollEnabled) return;
        var panel = findChatPanel();
        if (!panel) return;
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
        if (was && gap > 5) { _justScrolled.add(best); best.scrollTop = best.scrollHeight; }
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

    console.log('[Grav] Runtime v3.0 loaded | Patterns:', PATTERNS.length);
})();