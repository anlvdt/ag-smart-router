(function () {
    if (window._agToolkitLoaded) return;
    window._agToolkitLoaded = true;
    window._agAutoLoaded = true;
    window._agModelSwitchLoaded = true;

    if (window._agToolIntervals) {
        window._agToolIntervals.forEach(clearInterval);
        window.removeEventListener('scroll', window._agScrollListener, true);
    }
    window._agToolIntervals = [];

    // --- Shadow DOM piercing query ---
    function Q(sel, root) {
        var r = [];
        (function w(n) {
            if (!n) return;
            if (n.nodeType === 1) { try { if (n.matches(sel)) r.push(n); } catch(_) {} if (n.shadowRoot) w(n.shadowRoot); }
            for (var i = 0; i < n.childNodes.length; i++) w(n.childNodes[i]);
        })(root || document);
        return r;
    }

    // =================================================================
    // INTERNAL VS CODE COMMAND EXECUTION (Layer 0 runs in workbench renderer)
    // We can access the internal command service via the global require
    // This is the ONLY way to switch models — no external API exists
    // =================================================================
    var _commandService = null;

    function getCommandService() {
        if (_commandService) return _commandService;
        try {
            // VS Code/Antigravity exposes require in workbench renderer
            if (typeof require === 'function') {
                // Try to get the command service from the workbench services
                var services = require('vs/workbench/services/commands/common/commandService');
                if (services && services.CommandService) {
                    // Access via instantiation service
                    var inst = require('vs/platform/instantiation/common/instantiation');
                    // This won't work directly — need the service instance
                }
            }
        } catch (_) {}

        // Alternative: use the global vscode API if available in workbench context
        try {
            if (window._commandService) { _commandService = window._commandService; return _commandService; }
        } catch (_) {}

        return null;
    }

    /** Execute VS Code command from workbench renderer context */
    function executeCommand(commandId, args) {
        try {
            // Method 1: Use the global command handler that VS Code keybindings use
            if (window.document && window.document.querySelector) {
                // Trigger command via keyboard shortcut simulation won't work for non-keybinding commands
            }
        } catch (_) {}
        return false;
    }

    // --- Auto-dismiss "corrupt installation" ---
    (function () {
        function dismiss() {
            document.querySelectorAll('.notifications-toasts .notification-toast, .notification-list-item').forEach(function (b) {
                if ((b.textContent || '').indexOf('corrupt') !== -1 || (b.textContent || '').indexOf('reinstall') !== -1) {
                    var c = b.querySelector('.codicon-notifications-clear, .codicon-close');
                    if (c) c.click(); else b.style.display = 'none';
                }
            });
        }
        dismiss();
        var n = 0, t = setInterval(function () { dismiss(); if (++n > 30) clearInterval(t); }, 1000);
    })();

    // ===== CONFIG =====
    var PAUSE_SCROLL_MS = /*{{PAUSE_SCROLL_MS}}*/7000;
    var CLICK_INTERVAL_MS = /*{{CLICK_INTERVAL_MS}}*/1000;
    var SCROLL_INTERVAL_MS = /*{{SCROLL_INTERVAL_MS}}*/500;
    var CLICK_PATTERNS = /*{{CLICK_PATTERNS}}*/["Allow", "Always Allow", "Run", "Keep Waiting", "Accept all"];
    window._agAcceptChatOnly = false;
    window._agAutoEnabled = /*{{ENABLED}}*/true;
    window._agScrollEnabled = true;
    window._agSmartRouter = /*{{SMART_ROUTER}}*/true;
    window._agQuotaFallback = /*{{QUOTA_FALLBACK}}*/true;

    // ===== HTTP PORT DISCOVERY =====
    var AG_HTTP_PORT_START = 48787, AG_HTTP_PORT_END = 48850, AG_HTTP_PORT = 0;
    var _agPollCount = 0, _agPollErrors = 0, _agPortScanning = false;
    var _agSessionStats = {}, _agSessionTotal = 0;

    function _agDiscoverPort(cb) {
        if (_agPortScanning) return;
        _agPortScanning = true;
        var found = false;
        function tryBatch(from) {
            if (from > AG_HTTP_PORT_END || found) { if (!found) _agPortScanning = false; return; }
            var end = Math.min(from + 7, AG_HTTP_PORT_END), pending = 0;
            for (var p = from; p <= end; p++) {
                (function (port) {
                    pending++;
                    var x = new XMLHttpRequest();
                    x.open('GET', 'http://127.0.0.1:' + port + '/ag-status?t=' + Date.now(), true);
                    x.timeout = 800;
                    x.onload = function () {
                        if (found) return;
                        if (x.status === 200) { try { var c = JSON.parse(x.responseText); if (typeof c.enabled === 'boolean') { found = true; AG_HTTP_PORT = port; _agPortScanning = false; if (cb) cb(port, c); } } catch (_) {} }
                        pending--; if (pending <= 0 && !found) tryBatch(end + 1);
                    };
                    x.onerror = x.ontimeout = function () { pending--; if (pending <= 0 && !found) tryBatch(end + 1); };
                    x.send();
                })(p);
            }
        }
        tryBatch(AG_HTTP_PORT_START);
    }

    function _agApplyConfig(cfg) {
        if (typeof cfg.enabled === 'boolean') window._agAutoEnabled = cfg.enabled;
        if (typeof cfg.scrollEnabled === 'boolean') window._agScrollEnabled = cfg.scrollEnabled;
        if (cfg.clickPatterns && Array.isArray(cfg.clickPatterns)) CLICK_PATTERNS = cfg.clickPatterns.filter(function (p) { return p !== 'Accept'; });
        if (typeof cfg.acceptInChatOnly === 'boolean') window._agAcceptChatOnly = cfg.acceptInChatOnly;
        if (cfg.pauseScrollMs) PAUSE_SCROLL_MS = cfg.pauseScrollMs;
        if (cfg.scrollIntervalMs) SCROLL_INTERVAL_MS = cfg.scrollIntervalMs;
        if (cfg.clickIntervalMs) CLICK_INTERVAL_MS = cfg.clickIntervalMs;
        if (typeof cfg.smartRouter === 'boolean') window._agSmartRouter = cfg.smartRouter;
        if (typeof cfg.quotaFallback === 'boolean') window._agQuotaFallback = cfg.quotaFallback;
        if (cfg.resetStats) { _agSessionStats = {}; _agSessionTotal = 0; }
        // Check if extension wants us to switch model
        if (cfg.switchModel) { _agDoModelSwitch(cfg.switchModel); }
    }

    _agDiscoverPort(function (port, cfg) { _agApplyConfig(cfg); _agPollErrors = 0; });

    var _agConfigReload = setInterval(function () {
        _agPollCount++;
        if (AG_HTTP_PORT === 0) { if (_agPollCount % 5 === 0) _agDiscoverPort(function (p, c) { _agApplyConfig(c); _agPollErrors = 0; }); return; }
        if (_agPollErrors > 3) { AG_HTTP_PORT = 0; _agPollErrors = 0; _agDiscoverPort(function (p, c) { _agApplyConfig(c); }); return; }
        try {
            var x = new XMLHttpRequest();
            var sp = '';
            if (_agSessionTotal > 0) { sp = '&total=' + _agSessionTotal + '&stats=' + encodeURIComponent(JSON.stringify(_agSessionStats)); _agSessionStats = {}; _agSessionTotal = 0; }
            x.open('GET', 'http://127.0.0.1:' + AG_HTTP_PORT + '/ag-status?t=' + Date.now() + sp, true);
            x.timeout = 1500;
            x.onload = function () { if (x.status === 200) { _agPollErrors = 0; _agApplyConfig(JSON.parse(x.responseText)); } };
            x.onerror = x.ontimeout = function () { _agPollErrors++; };
            x.send();
        } catch (_) { _agPollErrors++; }
    }, 2000);
    window._agToolIntervals.push(_agConfigReload);

    // =================================================================
    // QUOTA DETECTION & MODEL SWITCH (Layer 0 — runs in webview DOM)
    // This is the ONLY place that can see the chat panel DOM directly
    // =================================================================
    var QUOTA_PHRASES = [
        'baseline model quota reached', 'exhausted your capacity', 'quota will reset',
        'model quota exceeded', 'rate limit exceeded', 'quota exhausted',
        'capacity exceeded', 'model at capacity', 'too many requests',
        'weekly limit reached', 'credits exhausted', 'usage limit exceeded'
    ];
    var _quotaSwitchInProgress = false;
    var _lastQuotaSwitch = 0;

    function _agDetectQuota() {
        var text = (document.body && document.body.innerText || '').toLowerCase();
        for (var i = 0; i < QUOTA_PHRASES.length; i++) {
            if (text.indexOf(QUOTA_PHRASES[i]) !== -1) return QUOTA_PHRASES[i];
        }
        return null;
    }

    function _agGetCurrentModel() {
        // Look near textarea for model name
        var ta = document.querySelector('textarea');
        if (ta) {
            var p = ta.parentElement;
            for (var up = 0; up < 10 && p; up++) {
                var spans = p.querySelectorAll('span, div, button, a');
                for (var i = 0; i < spans.length; i++) {
                    var t = (spans[i].innerText || spans[i].textContent || '').trim();
                    if (t.length < 3 || t.length > 80) continue;
                    if (t.indexOf('Claude') !== -1 || t.indexOf('Gemini') !== -1 || t.indexOf('GPT') !== -1) return t;
                }
                p = p.parentElement;
            }
        }
        // Brute force
        var all = Q('span, div, button, a', document);
        for (var i = 0; i < all.length; i++) {
            var t = (all[i].innerText || all[i].textContent || '').trim();
            if (t.length < 5 || t.length > 80 || all[i].children.length > 3) continue;
            if (t.indexOf('Claude') !== -1 || t.indexOf('Gemini') !== -1 || t.indexOf('GPT') !== -1) return t;
        }
        return null;
    }

    function _agClickDismiss() {
        var btns = Q('button, vscode-button, [role=button], a.action-label', document);
        for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].innerText || btns[i].textContent || '').trim().toLowerCase();
            if ((t === 'dismiss' || t === 'close' || t === 'ok') && btns[i].offsetParent !== null) {
                btns[i].click();
                console.log('[AG] Clicked Dismiss');
                return true;
            }
        }
        return false;
    }

    function _agClickModelSelector() {
        // Find the element showing current model name near textarea and click it
        var ta = document.querySelector('textarea');
        if (!ta) return false;
        var p = ta.parentElement;
        for (var up = 0; up < 10 && p; up++) {
            var els = p.querySelectorAll('span, div, button, a, [role=button]');
            for (var i = 0; i < els.length; i++) {
                var t = (els[i].innerText || els[i].textContent || '').trim();
                if (t.length < 3 || t.length > 80) continue;
                if ((t.indexOf('Claude') !== -1 || t.indexOf('Gemini') !== -1 || t.indexOf('GPT') !== -1) && els[i].offsetParent !== null) {
                    els[i].click();
                    console.log('[AG] Clicked model selector: ' + t);
                    return true;
                }
            }
            p = p.parentElement;
        }
        return false;
    }

    function _agSelectModelInDropdown(target) {
        var sn = target.split(' ').slice(0, 3).join(' ');
        var fw = target.split(' ').slice(0, 2).join(' ');
        var items = Q('[role=menuitem], [role=option], .monaco-list-row, .monaco-list-item, [class*=list-row], [class*=option], [class*=item], [class*=dropdown] span, [class*=popover] span, [class*=overlay] span, li', document);
        // Pass 1: exact
        for (var i = 0; i < items.length; i++) {
            var t = (items[i].innerText || items[i].textContent || '').trim();
            if (t.indexOf(target) !== -1 && items[i].offsetParent !== null) { items[i].click(); return true; }
        }
        // Pass 2: first 3 words
        for (var i = 0; i < items.length; i++) {
            var t = (items[i].innerText || items[i].textContent || '').trim();
            if (sn && t.indexOf(sn) !== -1 && items[i].offsetParent !== null) { items[i].click(); return true; }
        }
        // Pass 3: first 2 words
        for (var i = 0; i < items.length; i++) {
            var t = (items[i].innerText || items[i].textContent || '').trim();
            if (fw && t.indexOf(fw) !== -1 && t.length < 80 && items[i].offsetParent !== null) { items[i].click(); return true; }
        }
        // Escape dropdown
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        return false;
    }

    function _agDoModelSwitch(targetModel) {
        if (_quotaSwitchInProgress) return;
        _quotaSwitchInProgress = true;
        console.log('[AG] Model switch requested: ' + targetModel);

        // Step 1: Dismiss quota banner
        _agClickDismiss();

        // Step 2: Click model selector (after dismiss settles)
        setTimeout(function () {
            if (!_agClickModelSelector()) {
                console.log('[AG] Failed to click model selector');
                _quotaSwitchInProgress = false;
                return;
            }
            // Step 3: Select target model in dropdown (wait for dropdown to render)
            var attempts = 0;
            var trySelect = setInterval(function () {
                attempts++;
                if (_agSelectModelInDropdown(targetModel)) {
                    clearInterval(trySelect);
                    console.log('[AG] Model switched to: ' + targetModel);
                    // Step 4: Send Continue
                    setTimeout(function () {
                        _agSendContinue();
                        _quotaSwitchInProgress = false;
                    }, 1500);
                } else if (attempts > 15) {
                    clearInterval(trySelect);
                    console.log('[AG] Model selection failed after 15 attempts');
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                    _quotaSwitchInProgress = false;
                }
            }, 300);
        }, 800);
    }

    function _agSendContinue() {
        var ta = document.querySelector('textarea');
        if (!ta) return;
        ta.focus();
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (setter && setter.set) setter.set.call(ta, 'Continue');
        else ta.value = 'Continue';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(function () {
            var o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            ta.dispatchEvent(new KeyboardEvent('keydown', o));
            ta.dispatchEvent(new KeyboardEvent('keyup', o));
        }, 500);
    }

    // Quota polling — runs every 3s
    // Layer 0 runs in workbench.html — it CAN see quota banners (they render as notifications/overlays in main DOM)
    // But model selector is inside webview iframe — DOM click may not work
    // Strategy: dismiss quota → ask extension for target model → try DOM switch → always send Continue
    var _quotaPoll = setInterval(function () {
        if (!window._agAutoEnabled || !window._agQuotaFallback || _quotaSwitchInProgress) return;
        if (Date.now() - _lastQuotaSwitch < 10000) return; // cooldown
        var phrase = _agDetectQuota();
        if (!phrase) return;
        _lastQuotaSwitch = Date.now();
        _quotaSwitchInProgress = true;
        var curModel = _agGetCurrentModel();
        console.log('[AG] Quota detected: "' + phrase + '" | Current: ' + curModel);

        // Step 1: Dismiss quota banner immediately
        _agClickDismiss();
        setTimeout(function () { _agClickDismiss(); }, 500);

        // Step 2: Ask extension host for target model + try API switch
        if (AG_HTTP_PORT > 0) {
            try {
                var x = new XMLHttpRequest();
                x.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/quota-detected', true);
                x.setRequestHeader('Content-Type', 'application/json');
                x.timeout = 5000;
                x.onload = function () {
                    try {
                        var resp = JSON.parse(x.responseText);
                        if (resp.success) {
                            // Extension switched model via API — just send Continue
                            console.log('[AG] Model switched via API: ' + resp.switchTo);
                            setTimeout(function () {
                                _agSendContinue();
                                _quotaSwitchInProgress = false;
                            }, 1500);
                        } else if (resp.switchTo) {
                            // API failed — try DOM switch, then send Continue regardless
                            console.log('[AG] API switch failed, trying DOM for: ' + resp.switchTo);
                            _agDoModelSwitch(resp.switchTo);
                            // Send Continue after delay regardless of DOM switch result
                            setTimeout(function () {
                                _agSendContinue();
                                setTimeout(function () { _quotaSwitchInProgress = false; }, 2000);
                            }, 4000);
                        } else {
                            // No target — just send Continue on current model
                            setTimeout(function () {
                                _agSendContinue();
                                _quotaSwitchInProgress = false;
                            }, 1000);
                        }
                    } catch (_) {
                        setTimeout(function () { _agSendContinue(); _quotaSwitchInProgress = false; }, 1000);
                    }
                };
                x.onerror = x.ontimeout = function () {
                    // Extension unreachable — just dismiss and send Continue
                    console.log('[AG] Extension unreachable, sending Continue');
                    setTimeout(function () { _agSendContinue(); _quotaSwitchInProgress = false; }, 1000);
                };
                x.send(JSON.stringify({ phrase: phrase, currentModel: curModel || 'unknown' }));
            } catch (_) {
                setTimeout(function () { _agSendContinue(); _quotaSwitchInProgress = false; }, 1000);
            }
        } else {
            // No HTTP port — just dismiss and Continue
            setTimeout(function () { _agSendContinue(); _quotaSwitchInProgress = false; }, 1000);
        }
    }, 3000);
    window._agToolIntervals.push(_quotaPoll);

    // =================================================================
    // SMART ROUTER — Enter interceptor stub
    // =================================================================
    var _isRoutingInProgress = false, _routingLockTime = 0;

    document.addEventListener('keydown', function (e) {
        if (!window._agAutoEnabled || !window._agSmartRouter) return;
        if (_isRoutingInProgress && (Date.now() - _routingLockTime > 8000)) _isRoutingInProgress = false;
        if (_isRoutingInProgress) return;
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
        var el = e.target;
        if (!el || el.tagName !== 'TEXTAREA') return;
        if (!el.closest || !el.closest('.antigravity-agent-side-panel, [class*="chat"], [class*="agent"]')) return;
        var prompt = (el.value || '').trim();
        if (!prompt || prompt.length < 3) return;

        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        _isRoutingInProgress = true; _routingLockTime = Date.now();

        if (AG_HTTP_PORT > 0) {
            try {
                var x = new XMLHttpRequest();
                x.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/smart-route', true);
                x.setRequestHeader('Content-Type', 'application/json');
                x.timeout = 6000;
                var _fwd = false;
                var fwd = function () {
                    if (_fwd) return; _fwd = true; _isRoutingInProgress = false;
                    var o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
                    el.dispatchEvent(new KeyboardEvent('keydown', o));
                    el.dispatchEvent(new KeyboardEvent('keyup', o));
                    setTimeout(function () {
                        var bs = Q('button, [role="button"]', document);
                        for (var i = 0; i < bs.length; i++) {
                            var t = (bs[i].innerText || '').trim().toLowerCase();
                            if ((t === 'send' || t === 'submit') && bs[i].offsetParent !== null) { bs[i].click(); break; }
                        }
                    }, 300);
                };
                x.onload = function () { var r = {}; try { r = JSON.parse(x.responseText); } catch (_) {} setTimeout(fwd, r.switched ? 800 : 50); };
                x.onerror = x.ontimeout = function () { fwd(); };
                x.send(JSON.stringify({ prompt: prompt }));
            } catch (_) { _isRoutingInProgress = false; }
        } else { _isRoutingInProgress = false; }
    }, true);

    // =================================================================
    // AUTO CLICK — clean, no debug dumps
    // =================================================================
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];
    var EDITOR_SKIP = ['Accept Changes', 'Accept All', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var _clicked = new WeakSet();

    function btnText(b) {
        var raw = (b.innerText || b.textContent || '').trim();
        var fl = raw.split('\n')[0].trim();
        var aria = (b.getAttribute('aria-label') || '').trim();
        var direct = '';
        for (var i = 0; i < b.childNodes.length; i++) { if (b.childNodes[i].nodeType === 3) direct += b.childNodes[i].nodeValue || ''; }
        return direct.trim() || fl || aria;
    }

    function hasRejectSibling(btn) {
        var p = btn.parentElement;
        for (var lv = 0; lv < 4 && p; lv++) {
            var sibs = p.querySelectorAll('button, [role="button"], vscode-button');
            for (var i = 0; i < sibs.length; i++) {
                if (sibs[i] === btn) continue;
                var t = btnText(sibs[i]);
                for (var j = 0; j < REJECT_WORDS.length; j++) { if (t === REJECT_WORDS[j] || t.indexOf(REJECT_WORDS[j]) === 0) return true; }
            }
            p = p.parentElement;
        }
        return false;
    }

    var autoClick = setInterval(function () {
        if (!window._agAutoEnabled) return;
        var btns = Q('button, vscode-button, a.action-label, [role="button"], span.cursor-pointer', document);
        var target = null, matched = '';

        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (_clicked.has(b)) continue;
            if (b.offsetParent === null && !b.closest('[class*=overlay],[class*=popup],[class*=dialog],[class*=notification],[class*=quick-input],[class*=context-view]')) continue;
            var text = btnText(b);
            if (!text || text.length > 50) continue;

            // Skip editor buttons
            var skip = false;
            for (var s = 0; s < EDITOR_SKIP.length; s++) { if (text.indexOf(EDITOR_SKIP[s]) === 0) { skip = true; break; } }
            if (skip) continue;
            if (b.closest && (b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view') || b.closest('.view-zones') || b.closest('.view-lines'))) continue;

            // Match patterns
            for (var p = 0; p < CLICK_PATTERNS.length; p++) {
                if (text === CLICK_PATTERNS[p] || text.indexOf(CLICK_PATTERNS[p]) === 0) { matched = CLICK_PATTERNS[p]; break; }
            }
            if (!matched) continue;

            // Allow/Run/Always Allow: click directly (critical patterns)
            if (matched === 'Allow' || matched === 'Run' || matched === 'Always Allow' || matched === 'Accept all') { target = b; break; }
            if (hasRejectSibling(b)) { target = b; break; }
        }

        // Accept (chat-only)
        if (!target && window._agAcceptChatOnly) {
            for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                if (b.offsetParent === null || _clicked.has(b)) continue;
                var t = btnText(b);
                if (t.indexOf('Accept') !== 0 || /^Accept\s+(all|changes|incoming|current|both|combination)/i.test(t)) continue;
                if (b.closest && (b.closest('.editor-scrollable') || b.closest('.monaco-diff-editor'))) continue;
                target = b; matched = 'Accept'; break;
            }
        }

        if (target) {
            _clicked.add(target);
            target.click();
            // Log to extension host silently
            if (AG_HTTP_PORT > 0) {
                try { var x = new XMLHttpRequest(); x.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/click-log', true); x.setRequestHeader('Content-Type', 'application/json'); x.timeout = 2000; x.send(JSON.stringify({ button: text, pattern: matched })); } catch (_) {}
            }
            _agSessionTotal++;
            if (!_agSessionStats[matched]) _agSessionStats[matched] = 0;
            _agSessionStats[matched]++;
        }
        matched = '';
    }, CLICK_INTERVAL_MS);
    window._agToolIntervals.push(autoClick);

    // =================================================================
    // AUTO SCROLL (stick-to-bottom)
    // =================================================================
    var _wasBottom = new WeakMap(), _justScrolled = new WeakSet(), _autoScrolling = false;
    var _cachedPanel = null, _panelCheck = 0;

    var autoScroll = setInterval(function () {
        if (!window._agAutoEnabled || !window._agScrollEnabled) return;
        if (!_cachedPanel || !_cachedPanel.isConnected || ++_panelCheck > 20) {
            _cachedPanel = document.querySelector('.antigravity-agent-side-panel');
            _panelCheck = 0;
        }
        if (!_cachedPanel) return;
        var scrollables = Array.from(_cachedPanel.querySelectorAll('*')).filter(function (el) {
            var s = window.getComputedStyle(el);
            return el.scrollHeight > el.clientHeight && (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.tagName !== 'TEXTAREA';
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
    }, SCROLL_INTERVAL_MS);
    window._agToolIntervals.push(autoScroll);

    window._agScrollListener = function (e) {
        var el = e.target;
        if (!el || el.nodeType !== 1 || !el.closest || !el.closest('.antigravity-agent-side-panel')) return;
        if (_justScrolled.has(el)) { _justScrolled.delete(el); return; }
        if (_autoScrolling) return;
        _wasBottom.set(el, (el.scrollHeight - el.scrollTop - el.clientHeight) <= 150);
    };
    window.addEventListener('scroll', window._agScrollListener, true);

    console.log('[AG Autopilot] v6.1 | Layer 0 ready | Patterns:', JSON.stringify(CLICK_PATTERNS));
})();
