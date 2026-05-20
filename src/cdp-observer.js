// ═══════════════════════════════════════════════════════════════
//  Grav — CDP Observer Script Builder
//  Extracted from cdp.js for maintainability
// ═══════════════════════════════════════════════════════════════
'use strict';

const {
    HIGH_CONF, COOLDOWN, REJECT_WORDS, EDITOR_SKIP, SUPPRESS_KEYWORDS, LIMITS,
} = require('./constants');

function buildObserverScript(patterns, blacklist, scrollEnabled, scrollPauseMs, dryRun, skipBrowserAgent) {
    // Version tag - increment this when observer logic changes
    const OBSERVER_VERSION = 'v4.0.17';
    return `(function() {
    'use strict';
    // Version-based guard: allows new observer to replace old one
    if (window.__grav3 === '${OBSERVER_VERSION}') return;
    window.__grav3 = '${OBSERVER_VERSION}';

    var PATTERNS = ${JSON.stringify(patterns)};
    var BLACKLIST = ${JSON.stringify(blacklist)};
    var SCROLL_ON = ${scrollEnabled};
    var SCROLL_PAUSE = ${scrollPauseMs};
    var DRY_RUN = ${dryRun ? 'true' : 'false'};
    var SKIP_BROWSER_AGENT = ${skipBrowserAgent ? 'true' : 'false'};
    var _clickId = 0;

    // ── Shared Constants (from constants.js) ────────────────
    var REJECT_WORDS = ${JSON.stringify(REJECT_WORDS)};
    var EDITOR_SKIP = ${JSON.stringify(EDITOR_SKIP)};
    var SUPPRESS_KEYWORDS = ${JSON.stringify(SUPPRESS_KEYWORDS)};
    var LIM = ${JSON.stringify(LIMITS)};

    // ── Label Normalization & Shortcut Stripping ────────────
    function cleanLabel(text) {
        if (!text) return '';
        // Strip keyboard shortcuts like (Cmd+Shift+A) or [Enter] or (Ctrl+Enter) at the end
        var cleaned = text.replace(/\\s*[\\(\\[][^\\]\\)]*[\\)\\]]\\s*$/, '');
        // Strip enter symbols ↵, arrow icons, and other non-alphanumeric control marks
        cleaned = cleaned.replace(/[\\u21B5\\u23CE\\u21A9\\u2192\\u2190]/g, '');
        return cleaned.trim();
    }

    // ── Communication (CSP-safe: no XHR needed) ─────────────
    function report(type, data) {
        try {
            console.log('[GRAV:' + type + '] ' + (typeof data === 'string' ? data : JSON.stringify(data)));
        } catch(e) { console.error('[GRAV] report error:', e.message); }
    }
    function matchPattern(text, pattern) {
        var t = cleanLabel(text).toLowerCase();
        var p = cleanLabel(pattern).toLowerCase();
        if (t === p) return true;
        if (t.indexOf(p) !== 0) return false;
        if (t.length === p.length) return true;
        var c = t.charAt(p.length);
        return /[\\s\\u00a0.,;:!?\\-\\u2013\\u2014()\\[\\]{}|/\\\\<>'"@#\\$%^&*+=~\\x60]/.test(c);
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
        // 1. aria-label (most explicit — set deliberately by component)
        var aria = (btn.getAttribute('aria-label') || '').trim();
        if (aria.length >= 2 && aria.length <= 60) return aria;

        // 2. data-tooltip / data-title (VS Code common pattern)
        var dataTip = (btn.getAttribute('data-tooltip') || btn.getAttribute('data-title') || '').trim();
        if (dataTip.length >= 2 && dataTip.length <= 60) return dataTip;

        // 3. Direct text nodes (most accurate for simple buttons)
        var direct = '';
        for (var i = 0; i < btn.childNodes.length; i++) {
            if (btn.childNodes[i].nodeType === 3) direct += btn.childNodes[i].nodeValue || '';
        }
        direct = direct.trim();
        if (direct.length >= 2 && direct.length <= 60) return direct;

        // 4. innerText first line
        var raw = (btn.innerText || btn.textContent || '').trim();
        var first = raw.split('\\n')[0].trim();
        first = cleanLabel(first);
        if (first.length >= 2 && first.length <= 60) return first;

        // 5. title attribute
        var title = cleanLabel((btn.getAttribute('title') || '').trim());
        if (title.length >= 2 && title.length <= 60) return title;

        // 6. value attribute (input[type=button])
        var value = cleanLabel((btn.getAttribute('value') || '').trim());
        if (value.length >= 2 && value.length <= 60) return value;

        // 7. Nested spans (React wraps text in layers)
        var spans = btn.querySelectorAll('span, div, label, p, b, strong');
        var st = '';
        for (var j = 0; j < spans.length; j++) {
            var t = '';
            for (var k = 0; k < spans[j].childNodes.length; k++) {
                if (spans[j].childNodes[k].nodeType === 3) t += spans[j].childNodes[k].nodeValue || '';
            }
            t = t.trim();
            if (t) st += (st ? ' ' : '') + t;
        }
        st = cleanLabel(st);
        if (st.length >= 2 && st.length <= 60) return st;

        // 8. alt attribute (image buttons)
        var alt = cleanLabel((btn.getAttribute('alt') || '').trim());
        if (alt.length >= 2 && alt.length <= 60) return alt;

        // 9. data-testid / id / class mapping for icon-only buttons
        var testId = (btn.getAttribute('data-testid') || '').toLowerCase();
        if (testId) {
            if (testId.indexOf('submit') !== -1) return 'Submit';
            if (testId.indexOf('send') !== -1) return 'Submit';
            if (testId.indexOf('accept-all') !== -1 || testId.indexOf('acceptall') !== -1) return 'Accept all';
            if (testId.indexOf('accept') !== -1) return 'Accept';
            if (testId.indexOf('approve') !== -1) return 'Approve';
            if (testId.indexOf('run') !== -1) return 'Run';
            if (testId.indexOf('allow') !== -1) return 'Allow';
        }
        var id = (btn.id || '').toLowerCase();
        if (id) {
            if (id.indexOf('submit') !== -1) return 'Submit';
            if (id.indexOf('send') !== -1) return 'Submit';
            if (id.indexOf('acceptall') !== -1 || id.indexOf('accept-all') !== -1) return 'Accept all';
        }
        var cls = (btn.className || '').toString().toLowerCase();
        if (cls) {
            if (cls.indexOf('submit') !== -1) return 'Submit';
            if (cls.indexOf('send') !== -1) return 'Submit';
            if (cls.indexOf('acceptall') !== -1 || cls.indexOf('accept-all') !== -1) return 'Accept all';
        }

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
        var lower = cmd.toLowerCase().trim();
        for (var i = 0; i < BLACKLIST.length; i++) {
            var p = BLACKLIST[i].toLowerCase().trim();
            if (!p) continue;
            var isMulti = p.indexOf(' ') !== -1 || p.indexOf('|') !== -1;
            if (isMulti) {
                // Multi-word: check if command starts with pattern or contains it after sudo/separator
                if (lower.indexOf(p) === 0) return BLACKLIST[i];
                if (lower.indexOf('sudo ' + p) !== -1) return BLACKLIST[i];
                if (lower.indexOf('nohup ' + p) !== -1) return BLACKLIST[i];
                // Check after ; or && or ||
                var seps = lower.split(/[;&|]+/);
                for (var j = 0; j < seps.length; j++) {
                    var seg = seps[j].replace(/^\\s*(sudo|nohup|env)\\s+/g, '').trim();
                    if (seg.indexOf(p) === 0) return BLACKLIST[i];
                }
            }
            // Single-word patterns: skip in observer Safety Guard
            // Only multi-word destructive patterns should block Run button
        }
        return null;
    }

    // ── Reject Sibling Detection ────────────────────────────
    function hasRejectNearby(btn) {
        var p = btn.parentElement;
        var SEL = 'button, [role="button"], a.action-label, vscode-button, span.cursor-pointer, [class*="cursor-pointer"], [class*="flux-button"], [class*="flux-action"], [data-testid*="accept"], [data-testid*="approve"], [data-testid*="allow"], [data-testid*="run"], div.clickable, [class*="clickable"], .monaco-button, [class*="monaco-button"]';
        for (var lv = 0; lv < 5 && p; lv++) {
            var sibs = p.querySelectorAll(SEL);
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
    //    - Grav Dashboard: .root (Grav's own dashboard)
    //
    //  CRITICAL: We MUST NOT click buttons in Settings, Browser,
    //  Editor, Extensions, or Grav Dashboard — only in agent chat panel.
    // ══════════════════════════════════════════════════════════
    function inEditorContext(btn) {
        if (!btn.closest) return false;
        
        // ── Grav Dashboard detection (by page title or root class) ──
        // Grav dashboard has title "Grav — Dashboard" and uses .root container
        try {
            var pageTitle = (document.title || '').toLowerCase();
            if (pageTitle.indexOf('grav') !== -1 && pageTitle.indexOf('dashboard') !== -1) return true;
        } catch(_) { /* DOM op */ }
        
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
    var _globalCooldown = 0;  // Global cooldown after ANY click (prevent rapid fire)
    var _runCooldown = 0;     // Extra cooldown for Run buttons (terminal needs more time)
    var _lastClickedPattern = '';  // Track last clicked pattern

    // Cooldown durations (ms) — from shared constants
    var COOLDOWN = ${JSON.stringify(COOLDOWN)};

    function getCooldown(text) {
        return COOLDOWN[text] || COOLDOWN.DEFAULT;
    }

    function isAlreadyClicked(btn, text) {
        // Layer 1: WeakSet (same DOM node)
        if (_clicked.has(btn)) return true;
        
        // Layer 1.5: Shared DOM attribute to prevent double-clicks between runtime.js and cdp-observer.js
        if (btn.hasAttribute('data-grav-clicked')) return true;
        
        // Layer 2: Global cooldown - minimum time between ANY clicks
        if (Date.now() < _globalCooldown) return true;
        
        // Layer 3: text+position dedup with pattern-specific timeout
        var timeout = getCooldown(text);
        var key = text + '|' + (btn.getBoundingClientRect().top | 0);
        if (_clickedIds[key] && Date.now() - _clickedIds[key] < timeout) return true;
        
        // Layer 4: Same pattern cooldown (even at different positions)
        var patternKey = 'pattern:' + text;
        if (_clickedIds[patternKey] && Date.now() - _clickedIds[patternKey] < timeout) return true;
        
        return false;
    }

    function markClicked(btn, text) {
        _clicked.add(btn);
        try { btn.setAttribute('data-grav-clicked', 'true'); } catch(_) {}
        var now = Date.now();
        
        // Position-based tracking
        var key = text + '|' + (btn.getBoundingClientRect().top | 0);
        _clickedIds[key] = now;
        
        // Pattern-based tracking — but NOT for Expand (it reveals new buttons that need clicking)
        if (text !== 'Expand') {
            var patternKey = 'pattern:' + text;
            _clickedIds[patternKey] = now;
        }
        
        // Set global cooldown — shorter for Expand (200ms) so revealed buttons get clicked fast
        _globalCooldown = now + (text === 'Expand' ? 200 : COOLDOWN.GLOBAL);
        
        // Extra cooldown for Run buttons
        if (text === 'Run' || text.indexOf('Run ') === 0) {
            _runCooldown = now + COOLDOWN['Run'];
        }
        
        _lastClickedPattern = text;
        
        ++_clickId;
    }

    // Check if we're in Run cooldown period
    function isRunCooldown() {
        return Date.now() < _runCooldown;
    }

    // HIGH_CONFIDENCE: patterns that ONLY appear in agent approval contexts — from shared constants
    var HIGH_CONF = ${JSON.stringify(HIGH_CONF)};


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
            // Interactive modal / dialog / quick-input containers
            btn.closest('.quick-input-widget') ||
            btn.closest('.quick-input-container') ||
            btn.closest('.monaco-dialog-box') ||
            btn.closest('.dialog-buttons') ||
            btn.closest('.context-view') ||
            // Approval dialogs and notifications
            btn.closest('[class*=dialog]') ||
            btn.closest('[class*=notification]') ||
            btn.closest('[class*=overlay]') ||
            btn.closest('[class*=popup]') ||
            btn.closest('[class*=modal]') ||
            btn.closest('[class*=toast]') ||
            btn.closest('[class*=tool]') ||
            btn.closest('[class*=step]') ||
            btn.closest('[class*=command]') ||
            btn.closest('[class*=terminal]') ||
            // React app container (Antigravity agent UI root)
            btn.closest('.react-app-container') ||
            // Action bars within agent panel
            btn.closest('[class*=action-bar]') ||
            btn.closest('[class*=toolbar]')
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
        report('CLICK', { p: matched, b: text });

        // Layer 1: Normal DOM click
        try { btn.click(); } catch(_) {}

        // Layer 2: Synthetic Pointer Events (React-friendly)
        try {
            var r = btn.getBoundingClientRect();
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse' };
            btn.dispatchEvent(new PointerEvent('pointerdown', opts));
            btn.dispatchEvent(new MouseEvent('mousedown', opts));
            btn.dispatchEvent(new PointerEvent('pointerup', opts));
            btn.dispatchEvent(new MouseEvent('mouseup', opts));
            btn.dispatchEvent(new MouseEvent('click', opts));
        } catch(_) {}

        // Expand special handling
        if (matched === 'Expand') {
            setTimeout(function() { try { scanAndClick(); } catch(_) {} }, 400);
            setTimeout(function() { try { scanAndClick(); } catch(_) {} }, 800);
        }

        // Layer 3: Native CDP click (Fallback if button still there)
        setTimeout(function() {
            try {
                if (btn.isConnected && btn.offsetWidth > 0 && !btn.disabled) {
                    var stillText = labelOf(btn);
                    if (stillText === text) {
                        report('RETRY', { p: matched, b: text });
                    }
                }
            } catch(_) {}
        }, 200);
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 3: Shadow DOM Piercing & MutationObserver (Layer 1)
    //  Learned from chrome-accept-cookies extension:
    //  Override Element.attachShadow to track all shadow roots,
    //  and immediately attach MutationObservers to them.
    // ══════════════════════════════════════════════════════════
    var _shadowRoots = [];
    var MAX_SHADOW_ROOTS = 200; // Cap to prevent memory leak
    var _origAttachShadow = Element.prototype.attachShadow;
    var _observedShadowRoots = new WeakSet();
    var _scanTimer = null;

    function triggerScan() {
        if (_scanTimer) clearTimeout(_scanTimer);
        _scanTimer = setTimeout(function() {
            try { safeScanner(); } catch(_) {}
        }, 100);
    }

    function onMutation(mutations) {
        var shouldScan = false;
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.addedNodes && m.addedNodes.length > 0) {
                shouldScan = true;
                for (var j = 0; j < m.addedNodes.length; j++) {
                    var node = m.addedNodes[j];
                    if (node.nodeType === 1) { // ELEMENT_NODE
                        collectShadowRoots(node);
                    }
                }
            } else if (m.type === 'attributes') {
                shouldScan = true;
            }
        }
        if (shouldScan) {
            triggerScan();
        }
    }

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
            if (!_observedShadowRoots.has(shadow)) {
                _observedShadowRoots.add(shadow);
                try {
                    var obs = new MutationObserver(onMutation);
                    obs.observe(shadow, { childList: true, subtree: true, attributes: true,
                        attributeFilter: ['class','style','disabled','aria-hidden','aria-label','data-state'] });
                } catch(_) { /* DOM op */ }
            }
            return shadow;
        };
    } catch(_) { /* DOM op */ }

    // Collect existing open shadow roots and attach MutationObservers to them
    function collectShadowRoots(root) {
        if (!root) return;
        try {
            var all = root.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
                var sr = all[i].shadowRoot;
                if (sr) {
                    if (_shadowRoots.indexOf(sr) === -1) {
                        _shadowRoots.push(sr);
                    }
                    if (!_observedShadowRoots.has(sr)) {
                        _observedShadowRoots.add(sr);
                        try {
                            var obs = new MutationObserver(onMutation);
                            obs.observe(sr, { childList: true, subtree: true, attributes: true,
                                attributeFilter: ['class','style','disabled','aria-hidden','aria-label','data-state'] });
                        } catch(_) {}
                        // Trigger immediate scan when new shadow root is detected
                        triggerScan();
                    }
                    collectShadowRoots(sr);
                }
            }
        } catch(_) { /* DOM op */ }
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
                } catch(_) { /* DOM op */ } // cross-origin — skip silently
            }
        } catch(_) { /* DOM op */ }
        return docs;
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 5: Unified button collector
    //  Collects buttons from: main document + shadow DOMs + iframes
    //  NOTE: Antigravity uses <span class="cursor-pointer"> for some buttons!
    //  Also covers: flux-* components, data-testid buttons, clickable divs
    // ══════════════════════════════════════════════════════════
    function collectAllButtons() {
        var SEL = 'button, [role="button"], a.action-label, vscode-button, span.cursor-pointer, [class*="cursor-pointer"], [class*="flux-button"], [class*="flux-action"], [data-testid*="accept"], [data-testid*="approve"], [data-testid*="allow"], [data-testid*="run"], div.clickable, [class*="clickable"], .monaco-button, [class*="monaco-button"]';
        var btns = [];

        // Main document
        try {
            var main = document.querySelectorAll(SEL);
            for (var i = 0; i < main.length; i++) btns.push(main[i]);
        } catch(_) { /* DOM op */ }

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
            } catch(_) { /* DOM op */ }
        }

        return btns;
    }

    // ── Browser Agent Detection (Removed polling) ────────────────────────────
    // Replaced by inline detection in scanAndClick to accurately reject tool calls.

    // ── Core: Scan & Click (enhanced) ───────────────────────
    var _scanCount = 0;
    function scanAndClick() {
        collectShadowRoots(document.body);
        var btns = collectAllButtons();
        _scanCount++;

        // Every 20 scans (~30s), emit a SCAN debug report so Diagnostics shows live data
        if (_scanCount % 20 === 0) {
            var labels = [];
            for (var _i = 0; _i < Math.min(btns.length, 20); _i++) {
                var _t = labelOf(btns[_i]);
                if (_t) labels.push(_t);
            }
            report('DEBUG', { scan: _scanCount, btns: btns.length, labels: labels.slice(0,10), url: location.href.slice(0,80) });
        }

        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];

            // Skip invisible/disabled
            if (b.disabled) continue;
            if (b.offsetWidth === 0 && b.offsetHeight === 0) {
                if (!b.closest || !b.closest('[class*=overlay],[class*=popup],[class*=dialog],[class*=notification]')) continue;
            }

            // Extract text first
            var text = labelOf(b);
            if (!text || text.length > 60) continue;

            var matched = findMatch(text);
            var isSkipBtn = text === 'Skip' || text === 'Skip Action' || text === 'Skip step' || text.indexOf('Skip') === 0;
            var browserContext = false;

            // ── BROWSER AGENT BYPASS LOGIC ──
            if (SKIP_BROWSER_AGENT) {
                // Use only tight, per-step containers — NOT [class*=message] or [class*=container]
                // which wrap multiple tool calls and cause false positives on terminal Run buttons
                var tc = b.closest('[class*=tool], [class*=step], [class*=preview], [class*=action], [class*=block]');
                if (!tc && isSkipBtn) {
                    // For Skip buttons, search wider (parent hierarchy) since browser agent
                    // UI may not have standard class names
                    tc = b.parentElement;
                    for (var _up = 0; _up < 6 && tc; _up++) { tc = tc.parentElement; }
                    if (!tc) tc = b.parentElement && b.parentElement.parentElement;
                }
                if (tc) {
                    var tcTxt = (tc.innerText || '').toLowerCase().slice(0, 500);
                    var tcClass = (tc.className || '').toLowerCase();
                    browserContext = tcTxt.indexOf('browser_subagent') !== -1 || tcTxt.indexOf('computer_use') !== -1 || tcTxt.indexOf('use_browser') !== -1 ||
                        // Antigravity-specific browser subagent labels
                        tcTxt.indexOf('browser agent') !== -1 || tcTxt.indexOf('open browser') !== -1 || tcTxt.indexOf('web browser') !== -1 ||
                        (tcTxt.indexOf('browser') !== -1 && tcTxt.indexOf('agent') !== -1) ||
                        // Class-based detection: container element has 'browser' in its class name
                        tcClass.indexOf('browser') !== -1 ||
                        // Existing compound checks
                        (tcTxt.indexOf('exploring') !== -1 && tcTxt.indexOf('browser') !== -1) ||
                        (tcTxt.indexOf('navigate') !== -1 && tcTxt.indexOf('browser') !== -1);
                }

                if (isSkipBtn) {
                    if (browserContext) matched = 'Skip';
                } else if (matched && browserContext) {
                    continue; // Block Accept/Run for browser tools
                }
            }

            if (!matched) continue;

            var isHighConf = !!HIGH_CONF[matched] || matched === 'Skip';

            if (matched === 'Skip' && !browserContext) continue;

            // Skip editor context (unless it's a high-confidence button like Accept all)
            if (!isHighConf && inEditorContext(b)) continue;

            // Skip already clicked (multi-layer check)
            if (isAlreadyClicked(b, text)) continue;

            // Skip editor-specific accept patterns
            if (isEditorAccept(text)) {
                var isReviewInAgent = (text === 'Review Changes' || text === 'Review all' || text === 'Review All') && inAgentContext(b);
                if (!isReviewInAgent) continue;
            }

            // Secondary check: if visible text differs from resolved label (e.g. aria-label="Run"
            // but innerText="Review Changes"), block on visible text too
            var visibleText = ((b.innerText || b.textContent || '').trim().split('\\n')[0] || '').trim();
            if (visibleText && visibleText !== text && visibleText.length <= 60 && isEditorAccept(visibleText)) {
                var isReviewInAgent = (visibleText === 'Review Changes' || visibleText === 'Review all' || visibleText === 'Review All') && inAgentContext(b);
                if (!isReviewInAgent) continue;
            }

            // Expand: one-shot per element, but allow re-expand after 5s
            // (React may reuse DOM nodes for new steps)
            if (matched === 'Expand') {
                var expandKey = 'expand:' + (b.getBoundingClientRect().top | 0);
                if (_clickedIds[expandKey] && Date.now() - _clickedIds[expandKey] < 5000) continue;
                _clickedIds[expandKey] = Date.now();
            }

            // Safety guard for Run/Execute commands
            if (matched === 'Run' || matched === 'Run Task' || matched === 'Execute') {
                // Global cooldown: don't click Run too fast (terminal needs time)
                if (isRunCooldown()) continue;
                
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
            // Skip button in browser context already validated — bypass sibling check
            // (Skip is in REJECT_WORDS so hasRejectNearby can't find a reject sibling for it,
            //  since it excludes itself and Expand isn't a reject word)
            if (matched === 'Skip' && browserContext) {
                // Already confirmed: isSkipBtn + browserContext + SKIP_BROWSER_AGENT
                // No further validation needed
            } else {
                // Strategy 1: Has a Reject/Cancel sibling nearby (strongest signal)
                var hasReject = hasRejectNearby(b);
                // Strategy 2: Inside an agent-like container
                var isAgent = inAgentContext(b);

                // Every action needs either reject-sibling confirmation or a real agent context.
                // This keeps high-confidence labels like Accept/Run from firing in unrelated UI.
                if (!hasReject && !isAgent) {
                    report('DEBUG', { skip: matched, text: text, hasReject: hasReject, isHighConf: isHighConf, isAgent: isAgent });
                    continue;
                }
            }

            // ── DRY RUN: report but don't click ──
            if (DRY_RUN) {
                report('DRYRUN', { p: matched, b: text, pos: (b.getBoundingClientRect().top | 0) });
                continue;
            }

            // ── CLICK (multi-layer) ──
            markClicked(b, text);
            executeClick(b, matched, text);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 6: Periodic Scanner (Replaces MutationObserver)
    //  React transitions + OOPIF can cause MutationObservers to
    //  detach or drop events. SetInterval scanning ensures buttons
    //  are never missed.
    // ══════════════════════════════════════════════════════════
    // Removed MutationObserver in favor of flat polling.

    // ══════════════════════════════════════════════════════════
    //  SOLUTION 7: Slower polling to prevent "requires input" errors
    //  Previous: 800ms fast + 3000ms slow = too aggressive
    //  New: 1500ms standard + 5000ms safety = gives terminal time
    // ══════════════════════════════════════════════════════════
    var _lastClickTime = Date.now();
    var _origReport = report;
    report = function(type, data) {
        if (type === 'CLICK') _lastClickTime = Date.now();
        _origReport(type, data);
    };

    // Boot report — tell host what patterns + url we have
    setTimeout(function() {
        try {
            report('BOOT', { url: location.href.slice(0,120), title: document.title.slice(0,60), patterns: PATTERNS.length, dryRun: DRY_RUN });
        } catch(_) { /* DOM op */ }
    }, 1000);

    // Time-based cleanup for _clickedIds — runs every 30s regardless of click count.
    // Also enforces a hard size cap of 2000 entries to guard against high-click-rate sessions
    // (e.g. busy dashboards with many tool steps) accumulating unbounded memory between ticks.
    var CLICKED_IDS_MAX = 2000;
    setInterval(function() {
        var cutoff = Date.now() - 30000;
        for (var k in _clickedIds) {
            if (_clickedIds[k] < cutoff) delete _clickedIds[k];
        }
        // Hard size cap: if still over limit, evict oldest entries first
        var keys = Object.keys(_clickedIds);
        if (keys.length > CLICKED_IDS_MAX) {
            keys.sort(function(a, b) { return _clickedIds[a] - _clickedIds[b]; });
            for (var i = 0; i < keys.length - CLICKED_IDS_MAX; i++) {
                delete _clickedIds[keys[i]];
            }
        }
    }, 30000);

    // Guard: prevent concurrent scans — if a scan is still running (e.g. slow shadow root
    // collection across many nested webviews), skip the next tick rather than overlap.
    var _scanning = false;
    function safeScanner() {
        if (_scanning) return;
        _scanning = true;
        try { scanAndClick(); } catch(_) { /* non-critical */ } finally { _scanning = false; }
    }

    // Event-driven MutationObserver initialization on the main document
    try {
        var docObs = new MutationObserver(onMutation);
        docObs.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'disabled', 'aria-hidden', 'aria-label', 'data-state']
        });
    } catch(_) {}

    // Enhanced safety net poll — 4s interval (almost 0% CPU overhead, highly responsive)
    setInterval(safeScanner, 4000);

    // Initial scan with delay (let page settle)
    setTimeout(safeScanner, 1000);

    // ── Auto-Scroll (stick-to-bottom) ───────────────────────
    // Tracks per-element "was at bottom" state. If user scrolls up, we let them read.
    if (SCROLL_ON) {
        var _agWasAtBottom = new WeakMap();
        var _agJustScrolled = new WeakSet();
        var BOTTOM_THRESHOLD = 150;
        var _isAutoScrolling = false;

        window.addEventListener('scroll', function(e) {
            var el = e.target;
            if (!el || el.nodeType !== 1) return;
            
            // Only care about in-chat scrolling
            if (!el.closest || !el.closest('.antigravity-agent-side-panel,[class*=chat],[class*=agent]')) return;

            // Ignores programmatic scroll events
            if (_agJustScrolled.has(el)) {
                _agJustScrolled.delete(el);
                return;
            }
            if (_isAutoScrolling) return;

            var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (gap <= BOTTOM_THRESHOLD) {
                // User scrolled back to the bottom
                _agWasAtBottom.set(el, true);
            } else {
                // User scrolled up to read
                _agWasAtBottom.set(el, false);
            }
        }, true);

        setInterval(function() {
            var candidates = document.querySelectorAll(
                '.antigravity-agent-side-panel, [class*=chat], [class*=agent], [class*=cascade], [class*=cortex]'
            );
            var scrollables = [];
            for (var _s = 0; _s < candidates.length; _s++) {
                var el = candidates[_s];
                var tag = el.tagName;
                if (tag === 'TEXTAREA' || tag === 'CODE' || tag === 'PRE' || tag === 'INPUT') continue;
                var style = window.getComputedStyle(el);
                if (el.scrollHeight > el.clientHeight && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
                    scrollables.push(el);
                }
            }

            if (scrollables.length > 0) {
                _isAutoScrolling = true;
                scrollables.forEach(function (el) {
                    var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                    var wasBottom = _agWasAtBottom.get(el);

                    // First time seeing this target? Check if it's currently at the bottom.
                    if (wasBottom === undefined) {
                        wasBottom = gap <= BOTTOM_THRESHOLD;
                        _agWasAtBottom.set(el, wasBottom);
                    }

                    if (wasBottom) {
                        if (gap > 5) {
                            _agJustScrolled.add(el);
                            try {
                                if (gap < 300) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                                else el.scrollTop = el.scrollHeight;
                            } catch(_) {
                                el.scrollTop = el.scrollHeight;
                            }
                        }
                    }
                });
                setTimeout(function () { _isAutoScrolling = false; }, 200);
            }
        }, 800);
    }

    // ── Self-Healing ────────────────────────────────────────
    var _healTick = 0;
    setInterval(function() {
        _healTick++;
        // Refresh open shadow roots explicitly
        if (_healTick >= 30) {
            _healTick = 0;
            collectShadowRoots(document.body);
        }
    }, 1500);

    // ── Suppress Corrupt Banner + "Requires Input" Notifications ──
    // FIX: Use MutationObserver (event-driven) instead of setInterval (polling)
    // This eliminates the flashing caused by continuous re-scanning.
    (function() {
        // SUPPRESS_KEYWORDS is already defined at top from shared constants
        var _dismissTimer = null;

        function dismissOnce() {
            _dismissTimer = null;
            try {
                var toasts = document.querySelectorAll(
                    '.notifications-toasts .notification-toast, .notification-list-item, .notification-center .notification-toast-container'
                );
                toasts.forEach(function(el) {
                    var t = (el.textContent || '').toLowerCase();
                    var shouldDismiss = SUPPRESS_KEYWORDS.some(function(kw) { return t.indexOf(kw) !== -1; });
                    if (!shouldDismiss) return;

                    // KILL_TERMINAL guard: only fire if a real blocking <input>/<textarea>
                    // is visible in the notification DOM (genuine interactive shell prompt).
                    // Antigravity approval toasts do NOT contain input elements — safe to skip.
                    var hasBlockingInput = (function() {
                        try {
                            var inputs = el.querySelectorAll('input:not([type=hidden]), textarea');
                            for (var i = 0; i < inputs.length; i++) {
                                if (inputs[i].offsetWidth > 0 && inputs[i].offsetHeight > 0) return true;
                            }
                        } catch(_) {}
                        return false;
                    })();
                    if (hasBlockingInput) {
                        console.log('[GRAV:KILL_TERMINAL] Blocking input detected in notification');
                    }

                    // Try close button first (graceful)
                    var closeBtn = el.querySelector('.codicon-notifications-clear, .codicon-close, [class*=close], [aria-label*=close], [aria-label*=Clear]');
                    if (closeBtn && closeBtn.offsetWidth > 0) {
                        try { closeBtn.click(); } catch(_) { /* DOM op */ }
                    } else {
                        // Fallback: hide element (avoids DOM thrashing)
                        el.style.display = 'none';
                    }
                });
            } catch(_) { /* DOM op */ }
        }

        // Run once on load
        setTimeout(dismissOnce, 500);
        setTimeout(dismissOnce, 2000);

        // Use MutationObserver to react to new notifications only
        try {
            var notifArea = document.querySelector('.notifications-toasts, .notification-center, body');
            if (notifArea) {
                var notifObs = new MutationObserver(function(muts) {
                    // Debounce: only dismiss once per 300ms burst of mutations
                    if (_dismissTimer) return;
                    _dismissTimer = setTimeout(dismissOnce, 300);
                });
                notifObs.observe(notifArea, { childList: true, subtree: true });
            }
        } catch(_) { /* DOM op */ }
    })();

    report('BOOT', { v:2, patterns: PATTERNS.length, blacklist: BLACKLIST.length, scroll: SCROLL_ON, shadows: _shadowRoots.length, url: location.href.substring(0, 100) });

    // Debug: log all buttons found on first scan (including shadow DOM + iframes)
    setTimeout(function() {
        var allBtns = collectAllButtons();
        var labels = [];
        var acceptLike = [];
        var acceptRe = /(accept|approve|retry|run|proceed|expand)/i;
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

module.exports = { buildObserverScript };
