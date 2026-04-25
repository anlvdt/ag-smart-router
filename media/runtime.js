(function () {
    'use strict';
    if (window.__gravLoaded) return;
    window.__gravLoaded = true;

    // Cleanup existing timers and handlers
    if (window.__gravTimers) { window.__gravTimers.forEach(clearInterval); }
    window.__gravTimers = [];
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

    // Button auto-click — constants injected from shared config
    var REJECT_WORDS = /*{{REJECT_WORDS}}*/['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline', 'Reject all', 'Reject All', 'No', 'Disallow', 'Stop', 'Abort', 'Skip'];
    var EDITOR_SKIP = /*{{EDITOR_SKIP}}*/['Accept Changes', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination', 'Accept Line', 'Accept Word', 'Accept Suggestion'];
    var HIGH_CONF = /*{{HIGH_CONF}}*/{'Accept All': 1, 'Accept all': 1, 'Accept': 1, 'Approve': 1, 'Resume': 1, 'Run': 1, 'Retry': 1, 'Proceed': 1};
    var LIM = /*{{LIMITS}}*/{BUTTON_LABEL_MIN: 2, BUTTON_LABEL_MAX: 60};
    var _clickedAt = new WeakSet();
    var _clickedIds = {};
    var _globalCooldown = 0;
    var _runCooldown = 0;

    // Cooldown durations (ms) — injected from shared config
    var COOLDOWN = /*{{COOLDOWN}}*/{'Run': 5000, 'Accept': 1500, DEFAULT: 1000, GLOBAL: 500};

    var getCooldown = function(text) { return COOLDOWN[text] || COOLDOWN.DEFAULT; };

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
        // Don't set pattern cooldown for Expand — it reveals new buttons that need immediate clicking
        if (text !== 'Expand') _clickedIds['pattern:' + text] = now;
        _globalCooldown = now + (text === 'Expand' ? 200 : COOLDOWN.GLOBAL);
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
        // Strategy 1: aria-label (most explicit for accessibility)
        var aria = (btn.getAttribute('aria-label') || '').trim();
        if (aria.length >= 2 && aria.length <= 60) return aria;
        
        // Strategy 2: data-tooltip or data-title (common in VS Code)
        var dataTip = (btn.getAttribute('data-tooltip') || btn.getAttribute('data-title') || '').trim();
        if (dataTip.length >= 2 && dataTip.length <= 60) return dataTip;
        
        // Strategy 3: Direct text nodes (most accurate for simple buttons)
        var direct = '';
        for (var i = 0; i < btn.childNodes.length; i++) { 
            if (btn.childNodes[i].nodeType === 3) direct += btn.childNodes[i].nodeValue || ''; 
        }
        direct = direct.trim();
        if (direct.length >= 2 && direct.length <= 60) return direct;
        
        // Strategy 4: innerText first line (most common)
        var raw = (btn.innerText || btn.textContent || '').trim();
        var first = raw.split('\n')[0].trim();
        if (first.length >= 2 && first.length <= 60) return first;
        
        // Strategy 5: title attribute
        var title = (btn.getAttribute('title') || '').trim();
        if (title.length >= 2 && title.length <= 60) return title;
        
        // Strategy 6: value attribute (for input buttons)
        var value = (btn.getAttribute('value') || '').trim();
        if (value.length >= 2 && value.length <= 60) return value;
        
        // Strategy 7: Nested spans/divs/labels (React/Vue common pattern)
        var spans = btn.querySelectorAll('span, div, label, p, b, strong, em');
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
        
        // Strategy 8: alt attribute (for image buttons)
        var alt = (btn.getAttribute('alt') || '').trim();
        if (alt.length >= 2 && alt.length <= 60) return alt;
        
        return '';
    };

    var inEditorContext = function (btn) {
        if (!btn.closest) return false;
        
        // Check page title first
        try {
            var pageTitle = (document.title || '').toLowerCase();
            if (pageTitle.indexOf('grav') !== -1 && pageTitle.indexOf('dashboard') !== -1) return true;
        } catch(_) {}
        
        // List of selectors that indicate non-agent contexts
        var EDITOR_SELECTORS = [
            // Monaco Editor (code editor, diff, merge)
            '.monaco-editor', '.monaco-diff-editor', '.merge-editor-view',
            '.editor-actions', '.title-actions', '.monaco-toolbar', '.monaco-editor-overlaymessage',
            // Settings panels (all variants)
            '.settings-editor', '.settings-body', '.settings-tree-container',
            '[class*="settings-editor"]', '[class*="settings"]', '[class*="preference"]',
            '[id*="settings"]', '.settings-widget',
            // Browser panels
            '.simple-browser', '[class*="simple-browser"]', '[class*="browser-preview"]', '[class*="webview-browser"]',
            // Extensions
            '.extensions-editor', '.extension-editor', '[class*="extension-editor"]', 
            '[class*="extensions-list"]', '[class*="marketplace"]', '.extension-details',
            // Keybindings
            '[class*="keybinding"]', '.keybindings-editor',
            // Context menus and quick input
            '.context-view', '.monaco-menu', '.quick-input-widget', '.quick-input-list',
            '.terminal-tab', '.terminal-outer-container',
            // Auth/Accounts
            '[class*="accounts"]', '[class*="authentication"]', '.account-picker',
            // Welcome/Getting started
            '[class*="welcome"]', '[class*="walkthrough"]', '[class*="getting-started"]',
            // Output and debug
            '[class*="output"]', '[class*="debug"]', '.debug-toolbar',
            // Notebooks
            '[class*="notebook"]', '.notebook-cell',
            // Problems panel
            '[class*="problems-panel"]', '[class*="markers-panel"]',
            // Search panel
            '[class*="search-view"]', '[class*="search-widget"]'
        ];
        
        for (var i = 0; i < EDITOR_SELECTORS.length; i++) {
            if (btn.closest(EDITOR_SELECTORS[i])) return true;
        }
        return false;
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

    var isVisible = function(el) {
        if (!el) return false;
        if (el.disabled) return false;
        if (el.offsetWidth === 0 && el.offsetHeight === 0 && !el.closest('[class*="overlay"], [class*="popup"], [class*="dialog"], [class*="notification"]')) return false;
        try {
            var cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0' || cs.pointerEvents === 'none') return false;
            // Check if element is in viewport or near it
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            // Element should be within reasonable viewport bounds (allow some overflow)
            if (rect.right < -100 || rect.left > window.innerWidth + 100 || rect.bottom < -100 || rect.top > window.innerHeight + 100) return false;
        } catch (_) { return false; }
        return true;
    };

    var scanAndClick = function () {
        if (!window.__gravEnabled) return;
        // Expanded selectors to catch more button types
        var btns = document.querySelectorAll('button, vscode-button, a.action-label, [role="button"], [role="menuitem"], input[type="button"], input[type="submit"], .monaco-button, .button, [class*="button"], [class*="btn"], [class*="action-label"], [class*="cursor-pointer"], [class*="clickable"]');
        var foundButtons = [];
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (!isVisible(b)) continue;
            if (inEditorContext(b)) continue;
            var text = labelOf(b);
            if (!text || text.length < 2 || text.length > 60) continue;
            if (isAlreadyClicked(b, text)) continue;
            
            // Check editor skip patterns
            var skipThis = false;
            for (var s = 0; s < EDITOR_SKIP.length; s++) { 
                if (matchPattern(text, EDITOR_SKIP[s])) { skipThis = true; break; } 
            }
            if (skipThis) continue;
            
            var matched = findMatch(text);
            if (!matched) continue;
            
            // Run cooldown check
            if ((matched === 'Run' || matched.indexOf('Run ') === 0) && isRunCooldown()) continue;
            
            // Validation: high confidence or has reject sibling
            var isHighConf = !!HIGH_CONF[matched];
            if (!isHighConf && !hasRejectNearby(b)) {
                // Additional check: is this a standalone approval button in agent context?
                // Look for common agent panel indicators
                var inAgentPanel = false;
                try {
                    var el = b;
                    for (var up = 0; up < 5 && el; up++) {
                        var cls = (el.className || '').toLowerCase();
                        if (cls.indexOf('agent') !== -1 || cls.indexOf('chat') !== -1 || cls.indexOf('cascade') !== -1) {
                            inAgentPanel = true; break;
                        }
                        el = el.parentElement;
                    }
                } catch(_) {}
                if (!inAgentPanel) continue;
            }
            
            markClicked(b, text);
            // After Expand: quick re-scan to catch newly revealed buttons
            if (matched === 'Expand') {
                setTimeout(scanAndClick, 400);
                setTimeout(scanAndClick, 800);
            }
            try { b.click(); } catch (_) { }
            try {
                var rect = b.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                // Full event sequence: mouseover → mouseenter → pointer/mouse events → click
                b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
                b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: false, view: window, clientX: cx, clientY: cy }));
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (ev) {
                    var C = ev.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
                    b.dispatchEvent(new C(ev, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: ev.indexOf('down') !== -1 ? 1 : 0, detail: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse' }));
                });
                b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 1 }));
            } catch (_) { }
            // Focus + keyboard Enter (for accessibility-driven buttons)
            try {
                b.focus();
                b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                b.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
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

    // MutationObserver with smart throttling
    var _flushTimer = null;
    var _pendingMutations = [];
    var _observerActive = false;
    
    try {
        var observer = new MutationObserver(function (mutations) {
            // Only process if mutations actually added nodes or changed relevant attributes
            var hasRelevantChange = false;
            for (var m = 0; m < mutations.length; m++) {
                var mut = mutations[m];
                if (mut.type === 'childList' && (mut.addedNodes.length > 0 || mut.removedNodes.length > 0)) {
                    // Check if added nodes contain buttons or containers
                    for (var n = 0; n < mut.addedNodes.length; n++) {
                        var node = mut.addedNodes[n];
                        if (node.nodeType === 1) { // Element node
                            if (node.tagName === 'BUTTON' || node.tagName === 'A' || node.tagName === 'DIV' || 
                                node.tagName === 'SPAN' || node.tagName === 'VSCODE-BUTTON' ||
                                node.querySelector && node.querySelector('button, [role="button"], vscode-button')) {
                                hasRelevantChange = true;
                                break;
                            }
                        }
                    }
                } else if (mut.type === 'attributes') {
                    // Only care about class, disabled, style, aria-hidden
                    var attr = mut.attributeName || '';
                    if (attr === 'class' || attr === 'disabled' || attr === 'style' || attr === 'aria-hidden') {
                        hasRelevantChange = true;
                    }
                }
                if (hasRelevantChange) break;
            }
            
            if (!hasRelevantChange) return;
            
            // Throttle scanAndClick calls
            if (!_flushTimer) { 
                scanAndClick(); 
                _flushTimer = setTimeout(function () { _flushTimer = null; }, 150); 
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-hidden', 'style', 'hidden'] });
        window.__gravApproveObserver = observer;
        _observerActive = true;
    } catch (_) {} 

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