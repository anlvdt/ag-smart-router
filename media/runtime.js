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
    if (window.__gravApproveObserver) { try { window.__gravApproveObserver.disconnect(); } catch (_) {} }
    window.__gravTimers = [];

    // ── Config (injected at build time) ──────────────────────
    var PAUSE_MS   = /*{{PAUSE_MS}}*/7000;
    var APPROVE_MS = /*{{APPROVE_MS}}*/500;
    var SCROLL_MS  = /*{{SCROLL_MS}}*/500;
    var PATTERNS   = /*{{PATTERNS}}*/["Accept all","Accept All","Accept","Accept & Run","Keep All Edits","Keep All","Keep & Continue","Keep","Continue","Retry","Keep Waiting","Proceed","Run Task","Run","Allow","Allow Once","Allow in this Session","Allow this conversation","Allow and Review","Approve Tool Result","Approve all"];
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
        // Antigravity agent panel (primary target)
        '.antigravity-agent-side-panel',
        '[id*="antigravity"][class*="panel"]',
        '.react-app-container',                    // Antigravity React root (from YazanBaker)
        // Generic VS Code chat selectors
        '[id*="chat"][class*="panel"]',
        '.chat-widget',
        '[data-testid*="chat"]',
        '[role="complementary"][class*="panel"]',
        // Antigravity agent panel (generic selectors)
        '[class*="agent-panel"]',
        '[class*="agentic-panel"]',
        // Generic VS Code chat selectors
        '[id*="workbench.panel.chat"]',
        '.interactive-session',
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
    //  Module 4: Auto-approve engine v3.0
    //  Hybrid: MutationObserver (event-driven, ~50ms) + polling fallback
    //  Features from best-in-class competitors:
    //    - YazanBaker: MutationObserver event-driven, priority matching, self-healing
    //    - fhgffy: Multi-tier detection, notification interception
    //    - timteh: Accessibility tree awareness (aria-label fallback)
    //    - cotamatcotam: Iframe class-name matching for Antigravity React UI
    // ═════════════════════════════════════════════════════════
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline', 'Reject all', 'Reject All'];
    var EDITOR_SKIP  = ['Accept Changes', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var NEVER_SKIP = { 'Accept All': 1, 'Accept all': 1, 'Accept & Run': 1, 'Keep All Edits': 1, 'Keep All': 1, 'Keep & Continue': 1 };

    var _clickedAt   = new WeakSet();   // Track clicked buttons — click once only (like zixfel)
    var _COOLDOWN_MS = 1500;  // only used for re-scan timing, not re-click
    var _FAST_COOLDOWN_MS = 500; // faster cooldown for safe actions like Accept All

    // User activity tracking
    var _lastUserClick = 0;
    document.addEventListener('mousedown', function (e) {
        if (e.isTrusted) _lastUserClick = Date.now();
    }, true);

    window.__gravAiTyping = false;

    var TYPING_SELECTORS = [
        // Antigravity agent panel typing indicators
        '[aria-label*="thinking"]', '[aria-label*="generating"]',
        '[class*=streaming]', '[class*=typing-indicator]', '[class*=loading-dots]',
        '.codicon-loading', '[data-state="streaming"]',
        '.chat-widget [class*=spinner]',
        '.antigravity-agent-side-panel [class*=spinner]',
        '.react-app-container [class*=spinner]',     // Antigravity React root
        '[class*=progress-indicator]', '[aria-busy="true"]',
        '[class*=agent][class*=loading]',
        '[class*=agent][class*=thinking]',
    ];

    // ALWAYS_CLICK: buttons that are safe to click immediately without
    // needing a Reject/Deny sibling nearby. These are patterns that ONLY
    // appear in agent panel approval contexts, never in editor/toolbar.
    // NOTE: "Run" is NOT here — it must have Reject nearby to be safe
    // (prevents clicking "Run Python File", "Run Task" in editor toolbar)
    var ALWAYS_CLICK = {
        'Accept all': 1, 'Accept All': 1, 'Accept': 1, 'Accept & Run': 1,
        'Always Allow': 1, 'Allow': 1, 'Allow Once': 1,
        'Allow in this Session': 1, 'Allow in this Workspace': 1,
        'Allow this conversation': 1,
        'Always Allow Without Review': 1, 'Allow and Review': 1,
        'Allow and Skip Reviewing Result': 1,
        'Approve Tool Result': 1, 'Approve all': 1, 'Approve': 1,
        'Trust': 1,
        'Keep All Edits': 1, 'Keep All': 1, 'Keep & Continue': 1, 'Keep': 1,
        'Proceed': 1, 'Continue': 1, 'Retry': 1, 'Keep Waiting': 1,
        'Expand': 1,
    };

    function isAiTyping() {
        if (window.__gravAiTyping) return true;
        for (var i = 0; i < TYPING_SELECTORS.length; i++) {
            try { if (document.querySelector(TYPING_SELECTORS[i])) return true; } catch (_) {}
        }
        return false;
    }

    /**
     * Extract button label — multi-strategy (from timteh accessibility approach):
     * 1. Direct text nodes (most accurate, avoids child element text)
     * 2. First line of innerText
     * 3. aria-label attribute
     * 4. title attribute
     * 5. Deep text from nested spans (Antigravity React UI)
     */
    function labelOf(btn) {
        // Strategy 1: Direct text nodes only
        var direct = '';
        for (var i = 0; i < btn.childNodes.length; i++) {
            if (btn.childNodes[i].nodeType === 3) direct += btn.childNodes[i].nodeValue || '';
        }
        direct = direct.trim();
        if (direct && direct.length >= 2 && direct.length <= 60) return direct;

        // Strategy 2: First line of visible text
        var raw = (btn.innerText || btn.textContent || '').trim();
        var first = raw.split('\n')[0].trim();
        if (first && first.length >= 2 && first.length <= 60) return first;

        // Strategy 3: aria-label (accessibility tree — from timteh)
        var aria = (btn.getAttribute('aria-label') || '').trim();
        if (aria && aria.length >= 2 && aria.length <= 60) return aria;

        // Strategy 4: title attribute
        var title = (btn.getAttribute('title') || '').trim();
        if (title && title.length >= 2 && title.length <= 60) return title;

        // Strategy 5: Concatenate text from all nested spans/divs
        // Antigravity React UI often wraps button text in <span> inside <span>
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

    /**
     * Word-boundary matching — from YazanBaker.
     * Prevents false positives: "Running diagnostics" won't match "Run",
     * but "Run Alt+D" will match "Run".
     * Uses startsWith + word boundary check.
     */
    function matchPattern(text, pattern) {
        if (text === pattern) return true;
        if (text.length <= pattern.length) return false;
        if (text.indexOf(pattern) !== 0) return false;
        // Word boundary: char after pattern must be space, punctuation, or non-alpha
        var nextChar = text.charAt(pattern.length);
        return /[\s\u00a0.,;:!?\-–—()[\]{}|/\\<>'"@#$%^&*+=~`]/.test(nextChar);
    }

    /**
     * Match text against all patterns — longest match first with word boundary.
     * Returns matched pattern or empty string.
     */
    function findMatch(text) {
        var matched = '';
        var matchLen = 0;
        for (var p = 0; p < PATTERNS.length; p++) {
            if (PATTERNS[p].length > matchLen && matchPattern(text, PATTERNS[p])) {
                matched = PATTERNS[p];
                matchLen = PATTERNS[p].length;
            }
        }
        return matched;
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

    function isEditorButton(btn, text, matched) {
        // NEVER skip buttons that are explicitly in NEVER_SKIP
        // (Accept All, Accept & Run, Keep All Edits, etc.)
        if (NEVER_SKIP[matched]) return false;

        // ── FIX: Skip ALL buttons outside the agent/chat panel ──
        // This prevents clicking "Run" in editor toolbar, context menus,
        // notification toasts, sidebar, terminal tabs, etc.
        // Only buttons inside the chat/agent panel should be auto-clicked.
        if (btn.closest) {
            // Context menus, dropdowns, quick-input (the screenshot bug)
            if (btn.closest('.context-view') ||
                btn.closest('.monaco-menu') ||
                btn.closest('.menubar-menu-container') ||
                btn.closest('[class*=context-menu]') ||
                btn.closest('.quick-input-widget') ||
                btn.closest('[class*=quick-pick]')) return true;

            // Editor toolbar (Run ▶ button at top-right of editor)
            if (btn.closest('.editor-actions') ||
                btn.closest('.title-actions') ||
                btn.closest('.editor-toolbar') ||
                btn.closest('[class*=editor-group-header]') ||
                btn.closest('.monaco-toolbar')) return true;

            // Editor area (diff, merge, code)
            if (btn.closest('.monaco-diff-editor') ||
                btn.closest('.merge-editor-view') ||
                btn.closest('.view-zones') ||
                btn.closest('.view-lines') ||
                btn.closest('.monaco-editor') ||
                btn.closest('.editor-scrollable')) return true;

            // Sidebar, panel tabs, terminal
            if (btn.closest('.sidebar') ||
                btn.closest('[class*=sidebar]') ||
                btn.closest('.panel-header') ||
                btn.closest('.terminal-tab') ||
                btn.closest('[class*=explorer]') ||
                btn.closest('[class*=extensions-list]')) return true;

            // Notification toasts (except Accept/Allow patterns)
            if (btn.closest('.notifications-toasts') && matched === 'Run') return true;
        }

        // Editor-specific Accept patterns (merge/diff)
        for (var s = 0; s < EDITOR_SKIP.length; s++) {
            if (matchPattern(text, EDITOR_SKIP[s])) return true;
        }
        return false;
    }

    /**
     * Antigravity React UI class matching — from cotamatcotam gist.
     * Antigravity buttons use Tailwind-like classes: hover:bg-ide-button-hover, bg-ide-button-bac
     * Also matches .react-app-container buttons (from YazanBaker Webview Guard)
     */
    function isAntigravityButton(btn) {
        var cls = (btn.className || '').toString();
        return cls.indexOf('bg-ide-button') !== -1 ||
               cls.indexOf('hover:bg-ide') !== -1 ||
               cls.indexOf('ide-button') !== -1;
    }

    /**
     * SAFETY GUARD: Extract command text from code block near a Run button.
     * Walks up DOM tree to find <code>, <pre>, or terminal-like elements.
     */
    function extractCommandNearButton(btn) {
        var container = btn.parentElement;
        for (var lv = 0; lv < 6 && container; lv++) {
            var codeEls = container.querySelectorAll('code, pre, [class*=terminal], [class*=command], [class*=shell], [class*=code-block]');
            for (var ci = codeEls.length - 1; ci >= 0; ci--) {
                var txt = (codeEls[ci].textContent || '').trim();
                if (txt.length >= 2 && txt.length <= 2000) return txt;
            }
            container = container.parentElement;
        }
        return '';
    }

    /**
     * SAFETY GUARD: Check if a command matches the danger blacklist.
     * Returns matched pattern string or null.
     */
    var DANGER_BLACKLIST = [
        'rm -rf /','rm -rf ~','rm -rf *','rm -rf .','rm -rf .git',
        'rmdir /s /q c:\\','rd /s /q c:\\',
        'del /f /s /q c:\\','remove-item -recurse -force c:\\',
        'mkfs','dd if=/dev/zero','dd if=/dev/urandom','dd if=',
        'wipefs','diskpart','format c:',
        ':(){:|:&};:','shutdown','reboot','init 0','init 6',
        'kill -9 -1','killall','stop-computer',
        'chmod -R 777 /','sudo su','su -',
        'wget|sh','curl|sh','curl|bash','wget|bash',
        '| bash','| sh','| zsh',
        'git push --force','git push -f','git clean -fdx',
        'drop database','drop table','truncate table',
        'docker system prune -a --volumes',
        'npm publish',
    ];

    function isDangerousCommand(cmdText) {
        if (!cmdText) return null;
        var lower = cmdText.toLowerCase().trim();
        for (var i = 0; i < DANGER_BLACKLIST.length; i++) {
            var p = DANGER_BLACKLIST[i].toLowerCase().trim();
            if (p && lower.indexOf(p) !== -1) return DANGER_BLACKLIST[i];
        }
        return null;
    }

    /**
     * Core scan function — processes a single button element.
     * Returns { target, matched, text } or null.
     * Includes SAFETY GUARD: blocks dangerous commands before clicking Run.
     *
     * Safe Click logic (same approach as zixfel/ag-auto-click-scroll):
     *   A button is safe to click if it's in an approval dialog —
     *   detected by having a Reject/Deny/Cancel sibling nearby.
     *   This is more reliable than whitelisting CSS selectors because
     *   Antigravity can change class names anytime.
     */
    function tryButton(b, aiTyping) {
        // Visibility — relaxed for overlays/dialogs/notifications
        if (b.offsetParent === null && b.offsetWidth === 0) {
            if (!b.closest('[class*=overlay],[class*=popup],[class*=dialog],[class*=notification],[class*=quick-input],[class*=context-view]')) return null;
        }
        if (b.disabled) return null;

        // ── BLOCK: Never click inside editor, toolbar, context menu, sidebar ──
        // (Aligned with zixfel/ag-auto-click-scroll editor protection)
        if (b.closest) {
            if (b.closest('.monaco-editor') ||
                b.closest('.monaco-diff-editor') ||
                b.closest('.merge-editor-view') ||
                b.closest('.inline-merge-region') ||
                b.closest('.merged-editor') ||
                b.closest('.editor-scrollable') ||
                b.closest('.editor-actions') ||
                b.closest('.title-actions') ||
                b.closest('.monaco-toolbar') ||
                b.closest('[class*=editor-group-header]') ||
                b.closest('.view-zones') ||
                b.closest('.view-lines') ||
                b.closest('[id*="workbench.parts.editor"]') ||
                b.closest('.context-view') ||
                b.closest('.monaco-menu') ||
                b.closest('.menubar-menu-container') ||
                b.closest('[class*=context-menu]') ||
                b.closest('.quick-input-widget') ||
                b.closest('[class*=quick-pick]') ||
                b.closest('.sidebar') ||
                b.closest('[class*=sidebar]') ||
                b.closest('[class*=explorer]') ||
                b.closest('[class*=extensions-list]') ||
                b.closest('.panel-header') ||
                b.closest('.terminal-tab')) return null;
        }
        // Block diff-hunk and revert buttons inside any editor context
        if (b.classList && (b.classList.contains('diff-hunk-button') ||
            b.classList.contains('accept') || b.classList.contains('revert'))) {
            if (b.closest && b.closest('[class*="editor"], [id*="editor"]')) return null;
        }

        // Already clicked — skip (WeakSet one-shot, like zixfel)
        if (_clickedAt.has(b)) return null;

        var text = labelOf(b);
        if (!text) return null;
        // Cap text length (zixfel uses 40, we use 60 for longer Antigravity labels)
        if (text.length > 60) return null;

        var matched = findMatch(text);
        if (!matched) return null;

        // AI typing gate — only click ALWAYS_CLICK patterns during generation
        if (aiTyping && !ALWAYS_CLICK[matched]) return null;

        // ── SAFETY GUARD: Check command before clicking Run ──
        if (matched === 'Run' || matched === 'Run Task') {
            var cmd = extractCommandNearButton(b);
            if (cmd) {
                var blocked = isDangerousCommand(cmd);
                if (blocked) {
                    _clickedAt.add(b); // mark as clicked
                    console.warn('[Grav Safety] BLOCKED: ' + cmd.slice(0, 100) + ' (matched: ' + blocked + ')');
                    bridgePost('/api/command-blocked', { cmd: cmd.slice(0, 500), reason: blocked, ts: Date.now() });
                    return null; // DO NOT CLICK
                }
            }
        }

        // ALWAYS_CLICK → immediate, or reject-sibling confirmation
        if (ALWAYS_CLICK[matched] || hasRejectNearby(b)) {
            return { target: b, matched: matched, text: text };
        }

        return null;
    }

    /**
     * Full scan — called by both MutationObserver and polling fallback.
     * Multi-layer detection inspired by fhgffy 4-tier approach.
     */
    function scanAndClick() {
        if (!window.__gravEnabled) return;
        if (Date.now() - _lastUserClick < 200) return;

        var aiTyping = isAiTyping();
        var result = null;

        // ── Layer 1: Fast DOM scan (main document) ──
        var btns = document.querySelectorAll('button, vscode-button, a.action-label, [role="button"], span.cursor-pointer');
        for (var i = 0; i < btns.length && !result; i++) {
            result = tryButton(btns[i], aiTyping);
        }

        // ── Layer 2: Shadow DOM walk (slower, catches hidden panels) ──
        // FIX: Don't skip shadow DOM during AI typing — Accept All buttons
        // can appear in shadow DOM while AI is still generating
        if (!result) {
            var shadowBtns = deepQuery('button, vscode-button, [role="button"]', document);
            for (var i = 0; i < shadowBtns.length && !result; i++) {
                result = tryButton(shadowBtns[i], aiTyping);
            }
        }

        // ── Layer 3: Iframe scan — Antigravity OOPIF + same-origin iframes ──
        if (!result) {
            try {
                var iframes = document.querySelectorAll('iframe, webview');
                for (var fi = 0; fi < iframes.length && !result; fi++) {
                    try {
                        var iDoc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
                        if (!iDoc) continue;
                        var iBtns = iDoc.querySelectorAll('button, [role="button"], a.action-label');
                        for (var bi = 0; bi < iBtns.length && !result; bi++) {
                            result = tryButton(iBtns[bi], aiTyping);
                        }
                    } catch (_) { /* cross-origin — skip */ }
                }
            } catch (_) {}
        }

        // ── Layer 4: Antigravity React class matching (cotamatcotam approach) ──
        if (!result) {
            try {
                var iframes = document.querySelectorAll('iframe');
                for (var fi = 0; fi < iframes.length && !result; fi++) {
                    try {
                        var iDoc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
                        if (!iDoc) continue;
                        var allBtns = iDoc.querySelectorAll('button');
                        for (var bi = 0; bi < allBtns.length && !result; bi++) {
                            var b = allBtns[bi];
                            if (!isAntigravityButton(b)) continue;
                            if (b.offsetWidth === 0 || b.disabled) continue;
                            var text = (b.textContent || '').trim().toLowerCase();
                            if (text.indexOf('accept') !== -1 || text.indexOf('allow') !== -1 ||
                                text.indexOf('run') !== -1 || text.indexOf('proceed') !== -1) {
                                if (_clickedAt.has(b)) continue;
                                var label = (b.textContent || '').trim().split('\n')[0].trim();
                                var matched = findMatch(label);
                                if (matched) result = { target: b, matched: matched, text: label };
                            }
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }

        // ── Layer 5: Chat-only Accept mode ──
        if (!result && window.__gravAcceptChat && !aiTyping) {
            var btns = document.querySelectorAll('button, vscode-button, [role="button"]');
            for (var i = 0; i < btns.length && !result; i++) {
                var b = btns[i];
                if (_clickedAt.has(b)) continue;
                if (b.offsetParent === null) continue;
                var t = labelOf(b);
                if (!matchPattern(t, 'Accept')) continue;
                if (/^Accept\s+(changes|incoming|current|both|combination)/i.test(t)) continue;
                if (b.closest && (b.closest('.editor-scrollable') || b.closest('.monaco-diff-editor'))) continue;
                result = { target: b, matched: 'Accept', text: t };
            }
        }

        // ── Execute click ──
        if (result) {
            _clickedAt.add(result.target);
            // Primary: standard .click()
            result.target.click();
            // Fallback: dispatch full mouse event sequence for frameworks
            // that ignore synthetic .click() (React, Lit, etc.)
            try {
                var rect = result.target.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function(type) {
                    var Ctor = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
                    result.target.dispatchEvent(new Ctor(type, {
                        bubbles: true, cancelable: true, view: window,
                        clientX: cx, clientY: cy, button: 0, isPrimary: true
                    }));
                });
            } catch(_) {}
            bridgePost('/api/click-log', { button: result.text, pattern: result.matched, source: 'grav' });
            _sessionTotal++;
            _sessionStats[result.matched] = (_sessionStats[result.matched] || 0) + 1;
        }
    }

    // ── Primary: MutationObserver-driven detection (from YazanBaker) ──
    // React instantly when DOM changes instead of polling every 500ms.
    // Leading-edge throttle at 100ms to prevent CPU spikes during streaming.
    var _approveFlushTimer = null;
    var _approveObserver = null;
    var _approveObserverAlive = true;

    function setupApproveObserver() {
        try {
            _approveObserver = new MutationObserver(function () {
                if (!window.__gravEnabled) return;
                // Leading-edge throttle: fire immediately, then suppress for 100ms
                if (!_approveFlushTimer) {
                    scanAndClick();
                    _approveFlushTimer = setTimeout(function () { _approveFlushTimer = null; }, 100);
                }
            });
            _approveObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'aria-label', 'disabled', 'aria-hidden'],
            });
            _approveObserverAlive = true;
            window.__gravApproveObserver = _approveObserver;
        } catch (_) {
            _approveObserverAlive = false;
        }
    }

    setupApproveObserver();

    // ── Secondary: Polling fallback (catches what MutationObserver misses) ──
    // Runs at reduced frequency (2s) since MutationObserver handles most cases.
    // Also serves as self-healing: if observer dies, polling keeps working.
    var approvePolling = setInterval(function () {
        if (!window.__gravEnabled) return;
        scanAndClick();
    }, Math.max(APPROVE_MS, 1500));  // minimum 1.5s to avoid CPU waste
    window.__gravTimers.push(approvePolling);

    // ── Self-healing: re-attach observer if it dies (from YazanBaker heartbeat) ──
    var _healingTick = 0;
    var healingTimer = setInterval(function () {
        _healingTick++;
        // Check every 10s if observer is still alive
        if (_healingTick % 10 === 0) {
            if (!_approveObserverAlive || !_approveObserver) {
                console.log('[Grav] Self-healing: re-attaching approve observer');
                if (_approveObserver) try { _approveObserver.disconnect(); } catch (_) {}
                setupApproveObserver();
            }
        }
        // Force re-attach every 5 minutes (webview navigation can silently kill observers)
        if (_healingTick >= 300) {
            _healingTick = 0;
            if (_approveObserver) try { _approveObserver.disconnect(); } catch (_) {}
            setupApproveObserver();
            console.log('[Grav] Self-healing: periodic observer refresh');
        }
    }, 1000);
    window.__gravTimers.push(healingTimer);

    // ═════════════════════════════════════════════════════════
    //  Module 5: Stick-to-bottom scroll
    //  FIX: Only scroll the PRIMARY chat message container,
    //  not every scrollable element (code blocks, sidebars, etc.)
    // ═════════════════════════════════════════════════════════
    var _wasBottom    = new WeakMap();
    var _justScrolled = new WeakSet();
    var _autoScrolling = false;

    // Selectors for the actual message list / conversation container
    // These are the ONLY elements we should auto-scroll
    var MSG_CONTAINER_SELECTORS = [
        '[class*=messages-container]',
        '[class*=message-list]',
        '[class*=conversation-list]',
        '[class*=chat-messages]',
        '[class*=interactive-list]',
        '.interactive-session .monaco-scrollable-element',
        '[class*=scroller][class*=chat]',
        '[class*=agent-panel] > [class*=scroll]',
        '[class*=chat-widget] > [class*=scroll]',
    ];

    // Elements we should NEVER auto-scroll
    var SCROLL_BLACKLIST_SELECTORS = [
        'code', 'pre', '.monaco-editor', '.view-lines',
        '[class*=code-block]', '[class*=codeBlock]',
        '[class*=terminal]', '.xterm', '[class*=diff]',
        '[class*=sidebar]', '[class*=tree-container]',
        '[class*=explorer]', '[class*=outline]',
    ];

    function isScrollBlacklisted(el) {
        for (var i = 0; i < SCROLL_BLACKLIST_SELECTORS.length; i++) {
            try {
                if (el.matches && el.matches(SCROLL_BLACKLIST_SELECTORS[i])) return true;
                if (el.closest && el.closest(SCROLL_BLACKLIST_SELECTORS[i])) return true;
            } catch (_) {}
        }
        return false;
    }

    function findMainScrollContainer(panel) {
        // Strategy 1: Try specific message container selectors
        for (var i = 0; i < MSG_CONTAINER_SELECTORS.length; i++) {
            try {
                var el = panel.querySelector(MSG_CONTAINER_SELECTORS[i]);
                if (el && el.scrollHeight > el.clientHeight) return el;
            } catch (_) {}
        }
        // Strategy 2: Find the LARGEST scrollable child (likely the message area)
        // but exclude code blocks, terminals, editors, etc.
        var best = null, bestHeight = 0;
        var candidates = Array.from(panel.querySelectorAll('*')).filter(function (el) {
            var s = window.getComputedStyle(el);
            return el.scrollHeight > el.clientHeight + 50
                && (s.overflowY === 'auto' || s.overflowY === 'scroll')
                && el.tagName !== 'TEXTAREA'
                && !isScrollBlacklisted(el);
        });
        for (var j = 0; j < candidates.length; j++) {
            if (candidates[j].clientHeight > bestHeight) {
                bestHeight = candidates[j].clientHeight;
                best = candidates[j];
            }
        }
        return best;
    }

    var scrollEngine = setInterval(function () {
        if (!window.__gravEnabled || !window.__gravScrollEnabled) return;
        var panel = findChatPanel();
        if (!panel) return;

        var mainScroller = findMainScrollContainer(panel);
        if (!mainScroller) return;

        _autoScrolling = true;
        var gap = mainScroller.scrollHeight - mainScroller.scrollTop - mainScroller.clientHeight;
        var was = _wasBottom.get(mainScroller);
        if (was === undefined) { was = gap <= 150; _wasBottom.set(mainScroller, was); }
        if (was && gap > 5) {
            _justScrolled.add(mainScroller);
            mainScroller.scrollTop = mainScroller.scrollHeight;
        }
        setTimeout(function () { _autoScrolling = false; }, 200);
    }, SCROLL_MS);
    window.__gravTimers.push(scrollEngine);

    window.__gravScrollHandler = function (e) {
        var el = e.target;
        if (!el || el.nodeType !== 1) return;
        // Only track scroll state for elements inside chat panels
        var inPanel = false;
        for (var i = 0; i < CHAT_SELECTORS.length; i++) {
            if (el.closest && el.closest(CHAT_SELECTORS[i])) { inPanel = true; break; }
        }
        if (!inPanel) return;
        // Ignore scroll events on blacklisted elements (code blocks, etc.)
        if (isScrollBlacklisted(el)) return;
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
    console.log('[Grav] v3.0.0 runtime loaded | Patterns:', JSON.stringify(PATTERNS),
                '| MutationObserver: ON | Self-healing: ON | Chat monitor: ON | Terminal capture: ON | Pattern discovery: ON');
})();
