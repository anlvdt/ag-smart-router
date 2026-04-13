// ═══════════════════════════════════════════════════════════
//  Grav Runtime v1.1.0
//  Injected into workbench.html — runs in renderer process
//
//  Modules:
//    1. Corrupt-banner suppression
//    2. Bridge sync (HTTP ↔ extension host)
//    3. Quota radar (targeted — no full-body scan)
//    4. Auto-approve (AI-typing-aware, 8s cooldown, user-diff)
//    5. Stick-to-bottom scroll
//    6. Chat Activity Monitor (MutationObserver + tool detection)
//    7. Inline terminal event capture
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
    if (window.__gravObserver) { try { window.__gravObserver.disconnect(); } catch (_) {} }
    window.__gravTimers = [];

    // ── Config (injected at build time) ──────────────────────
    var PAUSE_MS   = /*{{PAUSE_MS}}*/7000;
    var APPROVE_MS = /*{{APPROVE_MS}}*/500;
    var SCROLL_MS  = /*{{SCROLL_MS}}*/500;
    var PATTERNS   = /*{{PATTERNS}}*/["Run", "Allow", "Always Allow", "Keep Waiting", "Continue"];
    var ENABLED    = /*{{ENABLED}}*/true;

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

    /** Find chat panel with multi-selector fallback */
    var _chatPanel = null, _chatPanelTick = 0;
    var CHAT_SELECTORS = [
        '.antigravity-agent-side-panel',
        '[id*="antigravity"][class*="panel"]',
        '[id*="chat"][class*="panel"]',
        '.chat-widget',
        '[data-testid*="chat"]',
        '[role="complementary"][class*="panel"]',
    ];
    function findChatPanel() {
        if (_chatPanel && _chatPanel.isConnected && ++_chatPanelTick < 30) return _chatPanel;
        _chatPanelTick = 0;
        for (var i = 0; i < CHAT_SELECTORS.length; i++) {
            var el = document.querySelector(CHAT_SELECTORS[i]);
            if (el) { _chatPanel = el; return el; }
        }
        _chatPanel = null;
        return null;
    }

    /** Bridge POST helper */
    function bridgePost(path, payload) {
        if (BRIDGE_PORT <= 0) return;
        try {
            var x = new XMLHttpRequest();
            x.open('POST', 'http://127.0.0.1:' + BRIDGE_PORT + path, true);
            x.setRequestHeader('Content-Type', 'application/json');
            x.timeout = 2000;
            x.send(JSON.stringify(payload));
        } catch (_) {}
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
        if (typeof c.acceptInChatOnly === 'boolean') window.__gravAcceptChat = c.acceptInChatOnly;
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
            x.timeout = 1500;
            x.onload = function () { if (x.status === 200) { _pollErrors = 0; applyConfig(JSON.parse(x.responseText)); } };
            x.onerror = x.ontimeout = function () { _pollErrors++; };
            x.send();
        } catch (_) { _pollErrors++; }
    }, 2000);
    window.__gravTimers.push(syncTimer);

    // ═════════════════════════════════════════════════════════
    //  Module 3: Quota radar — targeted scan (no full body.innerText)
    //  Strategy: only scan known high-signal DOM zones to avoid
    //  triggering expensive layout recalculations.
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

    // High-signal zones — only scan these, not full body
    var QUOTA_ZONE_SELECTORS = [
        '.notifications-toasts .notification-toast',
        '.notification-list-item',
        '[class*=notification]',
        '[class*=toast]',
        '[class*=alert]',
        '[class*=error-message]',
        '[class*=quota]',
        '[class*=limit]',
        '.chat-widget [class*=message]:last-child',
        '.antigravity-agent-side-panel [class*=message]:last-child',
        '[role="alert"]',
        '[aria-live]',
    ];

    var _lastQuotaPing = 0;
    // MutationObserver-driven: scan only when DOM actually changes
    var _domMutatedRecently = false;
    var _lastDomMutation = 0;

    function scanQuotaZones() {
        for (var si = 0; si < QUOTA_ZONE_SELECTORS.length; si++) {
            try {
                var nodes = document.querySelectorAll(QUOTA_ZONE_SELECTORS[si]);
                for (var ni = 0; ni < nodes.length; ni++) {
                    var txt = (nodes[ni].textContent || '').toLowerCase();
                    for (var pi = 0; pi < QUOTA_PHRASES.length; pi++) {
                        if (txt.indexOf(QUOTA_PHRASES[pi]) !== -1) return QUOTA_PHRASES[pi];
                    }
                }
            } catch (_) {}
        }
        // Iframe scan (lightweight — check length before scanning)
        try {
            var frames = document.querySelectorAll('iframe, webview');
            for (var f = 0; f < frames.length; f++) {
                try {
                    var doc = frames[f].contentDocument || (frames[f].contentWindow && frames[f].contentWindow.document);
                    if (doc && doc.body) {
                        var ft = (doc.body.textContent || '').toLowerCase();
                        if (ft.length > 10000) ft = ft.slice(-3000); // only tail
                        for (var pi = 0; pi < QUOTA_PHRASES.length; pi++) {
                            if (ft.indexOf(QUOTA_PHRASES[pi]) !== -1) return QUOTA_PHRASES[pi];
                        }
                    }
                } catch (_) {}
            }
        } catch (_) {}
        return null;
    }

    // Lightweight DOM mutation observer to trigger quota scan only when needed
    (function setupQuotaMutationWatch() {
        try {
            var mo = new MutationObserver(function () {
                _lastDomMutation = Date.now();
            });
            mo.observe(document.body, { childList: true, subtree: true, characterData: false, attributes: false });
        } catch (_) {}
    })();

    var quotaRadar = setInterval(function () {
        if (!window.__gravEnabled) return;
        if (Date.now() - _lastQuotaPing < 15000) return;
        // Skip scan if DOM hasn't changed recently (saves CPU)
        if (Date.now() - _lastDomMutation > 30000) return;
        var phrase = scanQuotaZones();
        if (!phrase) return;
        _lastQuotaPing = Date.now();
        bridgePost('/api/quota-detected', { phrase: phrase });
    }, 3000);
    window.__gravTimers.push(quotaRadar);

    // ═════════════════════════════════════════════════════════
    //  Module 4: Auto-approve engine
    //  v2: Optimized for speed — removed AI-typing gate for
    //  "Accept all" buttons, reduced cooldown, faster scan.
    // ═════════════════════════════════════════════════════════
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline', 'Reject all'];
    // Only skip editor merge/diff buttons — NOT chat panel buttons
    var EDITOR_SKIP  = ['Accept Changes', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];

    // Cooldown: reduced from 8s to 2s — fast enough to prevent double-click
    var _clickedAt   = new WeakMap();
    var _COOLDOWN_MS = 2000;

    // User activity tracking
    var _lastUserClick = 0;
    document.addEventListener('mousedown', function (e) {
        if (e.isTrusted) _lastUserClick = Date.now();
    }, true);

    // AI typing state — updated by Module 6
    window.__gravAiTyping = false;

    // Selectors indicating AI is still generating
    var TYPING_SELECTORS = [
        '[aria-label*="thinking"]',
        '[aria-label*="generating"]',
        '[class*=streaming]',
        '[class*=typing-indicator]',
        '[class*=loading-dots]',
        '.codicon-loading',
        '[data-state="streaming"]',
        '.chat-widget [class*=spinner]',
        '.antigravity-agent-side-panel [class*=spinner]',
        '[class*=progress-indicator]',
        '[aria-busy="true"]',
    ];

    // Patterns that should ALWAYS be clicked even while AI is typing
    // These are user-facing approval dialogs that block the AI pipeline
    var ALWAYS_CLICK = {
        'Accept all': 1, 'Allow': 1, 'Run': 1, 'Always Allow': 1,
        'Allow in this Session': 1, 'Allow in this Workspace': 1,
        'Always Allow Without Review': 1, 'Allow and Review': 1,
        'Allow and Skip Reviewing Result': 1,
        'Approve Tool Result': 1, 'Approve all': 1,
        'Trust': 1, 'Run Task': 1, 'Accept & Run': 1,
        'Accept': 1, 'Allow Once': 1,
        'Keep All Edits': 1, 'Keep & Continue': 1, 'Keep': 1,
        'Proceed': 1, 'Continue': 1,
    };

    function isAiTyping() {
        if (window.__gravAiTyping) return true;
        for (var i = 0; i < TYPING_SELECTORS.length; i++) {
            try { if (document.querySelector(TYPING_SELECTORS[i])) return true; } catch (_) {}
        }
        return false;
    }

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

    // Fast scan: use querySelectorAll instead of deepQuery for speed
    // deepQuery walks shadow DOM which is very slow on complex UIs
    var _fastScanSelectors = 'button, vscode-button, a.action-label, [role="button"]';

    var approveEngine = setInterval(function () {
        if (!window.__gravEnabled) return;

        var aiTyping = isAiTyping();

        // Gate: User just clicked something (< 300ms ago)
        if (Date.now() - _lastUserClick < 300) return;

        // Fast scan first (no shadow DOM walk)
        var btns = document.querySelectorAll(_fastScanSelectors);
        var target = null, matched = '', text = '';

        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];

            // Cooldown check
            var lastClick = _clickedAt.get(b);
            if (lastClick && (Date.now() - lastClick) < _COOLDOWN_MS) continue;

            // Visibility check (relaxed for overlays/dialogs)
            if (b.offsetParent === null && !b.closest('[class*=overlay],[class*=popup],[class*=dialog],[class*=notification],[class*=quick-input],[class*=context-view]')) continue;

            text = labelOf(b);
            if (!text || text.length > 60) continue;

            // Skip editor merge/diff buttons
            var skip = false;
            var inEditor = b.closest && (b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view') || b.closest('.view-zones') || b.closest('.view-lines'));
            if (inEditor) {
                if (text.indexOf('Accept') === 0) { skip = true; }
            } else {
                for (var s = 0; s < EDITOR_SKIP.length; s++) {
                    if (text.indexOf(EDITOR_SKIP[s]) === 0) { skip = true; break; }
                }
            }
            if (skip) continue;

            // Match against patterns (longest match first)
            matched = '';
            var matchLen = 0;
            for (var p = 0; p < PATTERNS.length; p++) {
                if ((text === PATTERNS[p] || text.indexOf(PATTERNS[p]) === 0) && PATTERNS[p].length > matchLen) {
                    matched = PATTERNS[p]; matchLen = PATTERNS[p].length;
                }
            }
            if (!matched) continue;

            // KEY FIX: If AI is typing, only click ALWAYS_CLICK patterns
            // These are approval dialogs that BLOCK the AI — must click to unblock
            if (aiTyping && !ALWAYS_CLICK[matched]) continue;

            // All matched patterns with ALWAYS_CLICK → click immediately
            if (ALWAYS_CLICK[matched]) {
                target = b; break;
            }
            // Others: only if there's a reject sibling (confirms it's a permission dialog)
            if (hasRejectNearby(b)) { target = b; break; }
        }

        // If fast scan missed, try shadow DOM scan (slower, less frequent)
        if (!target && !aiTyping) {
            var shadowBtns = deepQuery('button, vscode-button, [role="button"]', document);
            for (var i = 0; i < shadowBtns.length; i++) {
                var b = shadowBtns[i];
                var lastClick = _clickedAt.get(b);
                if (lastClick && (Date.now() - lastClick) < _COOLDOWN_MS) continue;
                if (b.offsetParent === null) continue;
                text = labelOf(b);
                if (!text || text.length > 60) continue;
                matched = '';
                var matchLen = 0;
                for (var p = 0; p < PATTERNS.length; p++) {
                    if ((text === PATTERNS[p] || text.indexOf(PATTERNS[p]) === 0) && PATTERNS[p].length > matchLen) {
                        matched = PATTERNS[p]; matchLen = PATTERNS[p].length;
                    }
                }
                if (!matched) continue;
                if (ALWAYS_CLICK[matched] || hasRejectNearby(b)) { target = b; break; }
            }
        }

        // Accept (chat-only mode)
        if (!target && window.__gravAcceptChat && !aiTyping) {
            for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                var lastClick = _clickedAt.get(b);
                if (lastClick && (Date.now() - lastClick) < _COOLDOWN_MS) continue;
                if (b.offsetParent === null) continue;
                var t = labelOf(b);
                if (t.indexOf('Accept') !== 0 || /^Accept\s+(changes|incoming|current|both|combination)/i.test(t)) continue;
                if (b.closest && (b.closest('.editor-scrollable') || b.closest('.monaco-diff-editor'))) continue;
                target = b; matched = 'Accept'; text = t; break;
            }
        }

        if (target) {
            _clickedAt.set(target, Date.now()); // record cooldown timestamp
            target.click();
            // Report to host with source tag
            bridgePost('/api/click-log', { button: text, pattern: matched, source: 'grav' });
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

    var scrollEngine = setInterval(function () {
        if (!window.__gravEnabled || !window.__gravScrollEnabled) return;
        var panel = findChatPanel();
        if (!panel) return;

        var scrollables = Array.from(panel.querySelectorAll('*')).filter(function (el) {
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
        if (!el || el.nodeType !== 1) return;
        // Check against all known chat panel selectors
        var inPanel = false;
        for (var i = 0; i < CHAT_SELECTORS.length; i++) {
            if (el.closest && el.closest(CHAT_SELECTORS[i])) { inPanel = true; break; }
        }
        if (!inPanel) return;
        if (_justScrolled.has(el)) { _justScrolled.delete(el); return; }
        if (_autoScrolling) return;
        _wasBottom.set(el, (el.scrollHeight - el.scrollTop - el.clientHeight) <= 150);
    };
    window.addEventListener('scroll', window.__gravScrollHandler, true);

    // ═════════════════════════════════════════════════════════
    //  Module 6: Chat Activity Monitor
    //  Uses MutationObserver on chat panel to detect:
    //    - New AI messages (message-start, message-end)
    //    - Tool calls (tool-call, tool-result, file-edit)
    //    - AI typing state changes
    //  Posts events to /api/chat-event for learning + session tracking.
    // ═════════════════════════════════════════════════════════
    (function setupChatMonitor() {
        var _msgCount    = 0;
        var _msgStartMs  = 0;
        var _toolCallMs  = {};  // tool → startMs
        var _lastMsgHash = '';   // avoid duplicate events for same message

        // Tool-call selectors (Antigravity-specific + generic)
        var TOOL_SELECTORS = [
            '[class*=tool-call]',
            '[class*=toolCall]',
            '[data-tool]',
            '[class*=function-call]',
            '[class*=tool-result]',
            '[class*=toolResult]',
            '[class*=file-edit]',
            '[class*=fileEdit]',
            '[class*=code-action]',
            '[class*=terminal-command]',
            '[class*=search-result][class*=tool]',
        ];

        // Labels/aria patterns indicating tool types
        function detectToolType(el) {
            var text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('data-tool') || '').toLowerCase().slice(0, 200);
            if (/edit|write|creat|modif|replac|file/.test(text)) return 'file-edit';
            if (/terminal|shell|exec|run|command/.test(text)) return 'terminal';
            if (/search|web|fetch|read/.test(text)) return 'search';
            if (/think|analy|plan|reason/.test(text)) return 'think';
            return 'tool-call';
        }

        // Detect AI typing state from DOM
        function detectAiState(panel) {
            for (var i = 0; i < TYPING_SELECTORS.length; i++) {
                try { if (panel.querySelector(TYPING_SELECTORS[i])) return true; } catch (_) {}
            }
            return false;
        }

        // Hash last visible message content to avoid duplicate events
        function msgHash(panel) {
            var msgs = panel.querySelectorAll('[class*=message],[class*=response],[class*=assistant]');
            if (!msgs.length) return '';
            var last = msgs[msgs.length - 1];
            var txt = (last.textContent || '').trim().slice(-100);
            return txt.length + ':' + txt.slice(-20);
        }

        var _observerActive = false;
        var _lastPanelCheck = 0;

        function attachObserver() {
            var panel = findChatPanel();
            if (!panel) {
                // Retry every 3s until panel found
                setTimeout(attachObserver, 3000);
                return;
            }

            if (_observerActive) return;
            _observerActive = true;

            var _pendingFlush = null;
            var _mutations = 0;

            var observer = new MutationObserver(function (records) {
                _lastDomMutation = Date.now(); // feed quota radar
                _mutations += records.length;

                // Debounce: flush after 200ms of silence
                clearTimeout(_pendingFlush);
                _pendingFlush = setTimeout(function () {
                    processMutations(panel);
                    _mutations = 0;
                }, 200);
            });

            observer.observe(panel, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ['aria-busy', 'aria-label', 'data-state', 'class'],
            });

            window.__gravObserver = observer;
            console.log('[Grav] Chat monitor attached to', panel.className || panel.id || 'panel');
        }

        function processMutations(panel) {
            if (!BRIDGE_PORT) return;

            // 1. Detect AI typing state change
            var nowTyping = detectAiState(panel);
            if (nowTyping !== window.__gravAiTyping) {
                window.__gravAiTyping = nowTyping;
                if (nowTyping) {
                    // AI started generating
                    _msgStartMs = Date.now();
                    bridgePost('/api/chat-event', { type: 'message-start', ts: _msgStartMs });
                } else {
                    // AI finished generating
                    var responseMs = _msgStartMs ? Date.now() - _msgStartMs : 0;
                    _msgCount++;
                    var hash = msgHash(panel);
                    if (hash !== _lastMsgHash) {
                        _lastMsgHash = hash;
                        bridgePost('/api/chat-event', {
                            type: 'message-end',
                            msgCount: _msgCount,
                            responseMs: responseMs,
                            ts: Date.now(),
                        });
                    }
                }
            }

            // 2. Detect tool calls (snapshot current state)
            for (var si = 0; si < TOOL_SELECTORS.length; si++) {
                try {
                    var toolEls = panel.querySelectorAll(TOOL_SELECTORS[si]);
                    for (var ti = 0; ti < toolEls.length; ti++) {
                        var el = toolEls[ti];
                        var toolType = detectToolType(el);
                        // Use element identity (via attribute or generated key)
                        var key = el.getAttribute('data-grav-tracked');
                        if (!key) {
                            key = toolType + '-' + Date.now() + '-' + ti;
                            el.setAttribute('data-grav-tracked', key);
                            _toolCallMs[key] = Date.now();
                            bridgePost('/api/chat-event', { type: 'tool-call', tool: toolType, ts: Date.now() });
                        }
                        // Detect tool result/completion
                        var isDone = el.querySelector('[class*=done],[class*=success],[class*=complete],[class*=result]') ||
                                     el.getAttribute('data-state') === 'done' ||
                                     el.classList.contains('done') ||
                                     el.classList.contains('complete');
                        if (isDone && _toolCallMs[key]) {
                            var durationMs = Date.now() - _toolCallMs[key];
                            delete _toolCallMs[key];
                            bridgePost('/api/chat-event', { type: 'tool-result', tool: toolType, durationMs: durationMs, ts: Date.now() });
                        }
                    }
                } catch (_) {}
            }
        }

        // Start attaching observer (delayed to let panel render)
        setTimeout(attachObserver, 2000);

        // Re-attach if panel is replaced (e.g., after reload)
        var reattachTimer = setInterval(function () {
            if (!window.__gravObserver || !window.__gravObserver._connected) {
                _observerActive = false;
                attachObserver();
            }
            // Also check if panel changed
            var panel = findChatPanel();
            if (panel && window.__gravObserver) {
                // Force re-check every 60s
                _lastPanelCheck++;
                if (_lastPanelCheck > 60) {
                    _lastPanelCheck = 0;
                    try { window.__gravObserver.disconnect(); } catch (_) {}
                    _observerActive = false;
                    attachObserver();
                }
            }
        }, 1000);
        window.__gravTimers.push(reattachTimer);
    })();

    // ═════════════════════════════════════════════════════════
    //  Module 7: Inline Terminal Event Capture
    //  Captures terminal commands visible in the UI panel
    //  (complements VS Code API capture in extension host)
    //  Posts to /api/terminal-event for learning.
    // ═════════════════════════════════════════════════════════
    (function setupTerminalCapture() {
        // Terminal output zones in the UI
        var TERMINAL_SELECTORS = [
            '.xterm-rows',
            '.terminal-container [class*=line]',
            '[class*=terminal-output]',
            '[class*=terminalOutput]',
            '.chat-widget [class*=terminal]',
            '.antigravity-agent-side-panel [class*=terminal]',
            '[data-tool="terminal"] [class*=content]',
            '[class*=shell-output]',
        ];

        var _seenTermCmds = new Set();  // dedup
        var _lastTermScan = 0;

        // Scan for command lines in visible terminal nodes
        function scanTerminalCmds() {
            if (Date.now() - _lastTermScan < 2000) return;  // max 0.5 Hz
            _lastTermScan = Date.now();

            if (!BRIDGE_PORT) return;

            for (var si = 0; si < TERMINAL_SELECTORS.length; si++) {
                try {
                    var nodes = document.querySelectorAll(TERMINAL_SELECTORS[si]);
                    for (var ni = 0; ni < nodes.length; ni++) {
                        var lines = nodes[ni].querySelectorAll('[class*=row],[class*=line]');
                        for (var li = 0; li < lines.length && li < 10; li++) {
                            var txt = (lines[li].textContent || '').trim();
                            // Match prompt patterns: $ cmd, > cmd, ❯ cmd
                            var m = txt.match(/^[\$>❯%#]\s+(.+)/) || txt.match(/^\s*\$\s+(.+)/);
                            if (!m) continue;
                            var cmd = m[1].trim();
                            if (!cmd || cmd.length < 2 || cmd.length > 500) continue;
                            // Dedup by content (not by element — elements recycle in xterm)
                            var key = cmd.slice(0, 100);
                            if (_seenTermCmds.has(key)) continue;
                            _seenTermCmds.add(key);
                            if (_seenTermCmds.size > 500) {
                                // Trim oldest entries
                                var arr = Array.from(_seenTermCmds);
                                _seenTermCmds = new Set(arr.slice(-300));
                            }
                            bridgePost('/api/terminal-event', { cmd: cmd, source: 'ui-scan', ts: Date.now() });
                        }
                    }
                } catch (_) {}
            }
        }

        var termTimer = setInterval(scanTerminalCmds, 2500);
        window.__gravTimers.push(termTimer);
    })();

    // ═════════════════════════════════════════════════════════
    //  Module 8: GEPA-inspired Pattern Discovery
    //  Scans DOM for potential approval buttons not yet in PATTERNS.
    //  Reports discovered candidates to extension host for learning.
    //  Inspired by GEPA's "Actionable Side Information" concept:
    //  instead of hardcoding button labels, observe the actual DOM
    //  and let the system adapt.
    // ═════════════════════════════════════════════════════════
    (function setupPatternDiscovery() {
        var _discoveredPatterns = new Set();
        var _lastDiscoveryScan = 0;

        // Heuristic: words that suggest an approval/action button
        var APPROVAL_HINTS = /^(allow|accept|approve|run|keep|proceed|trust|continue|retry|confirm|enable|grant|ok|yes)/i;
        // Words that suggest rejection (skip these)
        var REJECT_HINTS = /^(deny|reject|cancel|dismiss|close|no|don't|decline|disallow|block|stop|abort|skip|remove|delete|undo|revert)/i;
        // Words that are too generic or editor-specific
        var IGNORE_HINTS = /^(accept changes|accept incoming|accept current|accept both|accept combination|accept merge)/i;

        function scanForNewPatterns() {
            if (Date.now() - _lastDiscoveryScan < 10000) return; // max every 10s
            _lastDiscoveryScan = Date.now();
            if (!BRIDGE_PORT) return;

            var btns = deepQuery('button, vscode-button, a.action-label, [role="button"]', document);
            var newFound = [];

            for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                if (b.offsetParent === null && !b.closest('[class*=overlay],[class*=popup],[class*=dialog],[class*=notification],[class*=quick-input],[class*=context-view]')) continue;

                var text = labelOf(b);
                if (!text || text.length < 2 || text.length > 60) continue;

                // Skip if already in PATTERNS
                var known = false;
                for (var p = 0; p < PATTERNS.length; p++) {
                    if (text === PATTERNS[p] || text.indexOf(PATTERNS[p]) === 0) { known = true; break; }
                }
                if (known) continue;

                // Must look like an approval button
                if (!APPROVAL_HINTS.test(text)) continue;
                if (REJECT_HINTS.test(text)) continue;
                if (IGNORE_HINTS.test(text)) continue;

                // Skip if in editor context
                if (b.closest && (b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view'))) continue;

                var key = text.slice(0, 50);
                if (_discoveredPatterns.has(key)) continue;
                _discoveredPatterns.add(key);
                newFound.push(key);
            }

            if (newFound.length > 0) {
                bridgePost('/api/pattern-discovered', { patterns: newFound, ts: Date.now() });
                console.log('[Grav] Discovered new approval patterns:', newFound);
            }
        }

        var discoveryTimer = setInterval(scanForNewPatterns, 5000);
        window.__gravTimers.push(discoveryTimer);
    })();

    // ── Boot log ─────────────────────────────────────────────
    console.log('[Grav] v1.2.0 runtime loaded | Patterns:', JSON.stringify(PATTERNS),
                '| Chat monitor: ON | Terminal capture: ON | Pattern discovery: ON');
})();
