(function () {
    // --- Guard: prevent double execution ---
    if (window._agToolkitLoaded) return;
    window._agToolkitLoaded = true;
    // Also block old extensions from loading
    window._agAutoLoaded = true;
    window._agModelSwitchLoaded = true;

    // --- Shadow DOM piercing query helper ---
    function pierceQuery(selector, root) {
        var results = [];
        var walk = function(node) {
            if (!node) return;
            if (node.nodeType === 1) {
                try { if (node.matches(selector)) results.push(node); } catch(_) {}
                if (node.shadowRoot) walk(node.shadowRoot);
            }
            var children = node.childNodes || (node.children ? Array.from(node.children) : []);
            for (var i = 0; i < children.length; i++) walk(children[i]);
        };
        walk(root || document);
        return results;
    }

    // --- Cleanup old instances ---
    if (window._agToolIntervals) {
        window._agToolIntervals.forEach(clearInterval);
        window.removeEventListener('scroll', window._agScrollListener, true);
    }
    window._agToolIntervals = [];

    // --- Auto-dismiss "corrupt installation" notification ---
    (function suppressCorruptBanner() {
        function dismissCorrupt() {
            var banners = document.querySelectorAll('.notifications-toasts .notification-toast, .notification-list-item');
            banners.forEach(function (b) {
                var text = b.textContent || '';
                if (text.indexOf('corrupt') !== -1 || text.indexOf('reinstall') !== -1) {
                    var closeBtn = b.querySelector('.codicon-notifications-clear, .codicon-close, .action-label[aria-label*="Close"], .action-label[aria-label*="clear"], .clear-notification-action');
                    if (closeBtn) closeBtn.click();
                    else b.style.display = 'none';
                }
            });
        }
        dismissCorrupt();
        var attempts = 0;
        var timer = setInterval(function () { dismissCorrupt(); if (++attempts > 30) clearInterval(timer); }, 1000);
        try {
            var observer = new MutationObserver(function () { dismissCorrupt(); });
            observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
            setTimeout(function () { observer.disconnect(); }, 30000);
        } catch (e) {}
    })();

    // ===== CONFIGURATION (replaced by extension at inject time) =====
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
    var AG_HTTP_PORT_START = 48787;
    var AG_HTTP_PORT_END = 48850;
    var AG_HTTP_PORT = 0;
    var _agPollCount = 0;
    var _agPollErrors = 0;
    var _agPortScanning = false;
    var _agSessionStats = {};
    var _agSessionTotal = 0;

    function _agDiscoverPort(callback) {
        if (_agPortScanning) return;
        _agPortScanning = true;
        var found = false;
        function tryBatch(from) {
            if (from > AG_HTTP_PORT_END || found) { if (!found) _agPortScanning = false; return; }
            var batchEnd = Math.min(from + 7, AG_HTTP_PORT_END);
            var pending = 0;
            for (var p = from; p <= batchEnd; p++) {
                (function (port) {
                    pending++;
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', 'http://127.0.0.1:' + port + '/ag-status?t=' + Date.now(), true);
                    xhr.timeout = 800;
                    xhr.onload = function () {
                        if (found) return;
                        if (xhr.status === 200) {
                            try {
                                var cfg = JSON.parse(xhr.responseText);
                                if (typeof cfg.enabled === 'boolean') {
                                    found = true; AG_HTTP_PORT = port; _agPortScanning = false;
                                    console.log('[AG Autopilot] ✅ Server on port ' + port);
                                    if (callback) callback(port, cfg);
                                }
                            } catch (_e) {}
                        }
                        pending--; if (pending <= 0 && !found) tryBatch(batchEnd + 1);
                    };
                    xhr.onerror = function () { pending--; if (pending <= 0 && !found) tryBatch(batchEnd + 1); };
                    xhr.ontimeout = function () { pending--; if (pending <= 0 && !found) tryBatch(batchEnd + 1); };
                    xhr.send();
                })(p);
            }
        }
        tryBatch(AG_HTTP_PORT_START);
    }

    function _agApplyConfig(cfg) {
        if (typeof cfg.enabled === 'boolean') {
            if (window._agAutoEnabled !== cfg.enabled) {
                console.log('[AG Autopilot] ' + (cfg.enabled ? '✅ ON' : '❌ OFF') + ' (live toggle via HTTP)');
            }
            window._agAutoEnabled = cfg.enabled;
        }
        if (typeof cfg.scrollEnabled === 'boolean') window._agScrollEnabled = cfg.scrollEnabled;
        if (cfg.clickPatterns && Array.isArray(cfg.clickPatterns)) CLICK_PATTERNS = cfg.clickPatterns.filter(function (p) { return p !== 'Accept'; });
        if (typeof cfg.acceptInChatOnly === 'boolean') window._agAcceptChatOnly = cfg.acceptInChatOnly;
        if (cfg.pauseScrollMs) PAUSE_SCROLL_MS = cfg.pauseScrollMs;
        if (cfg.scrollIntervalMs) SCROLL_INTERVAL_MS = cfg.scrollIntervalMs;
        if (cfg.clickIntervalMs) CLICK_INTERVAL_MS = cfg.clickIntervalMs;
        if (typeof cfg.smartRouter === 'boolean') window._agSmartRouter = cfg.smartRouter;
        if (typeof cfg.quotaFallback === 'boolean') window._agQuotaFallback = cfg.quotaFallback;
        if (cfg.clickStats) window._agClickStats = cfg.clickStats;
        if (typeof cfg.totalClicks === 'number') window._agTotalClicks = cfg.totalClicks;
        if (cfg.resetStats) { window._agClickStats = {}; window._agTotalClicks = 0; _agSessionStats = {}; _agSessionTotal = 0; console.log('[AG Autopilot] 🔄 Stats reset by user'); }
    }

    _agDiscoverPort(function (port, cfg) { _agApplyConfig(cfg); _agPollErrors = 0; });

    var _agConfigReload = setInterval(function () {
        _agPollCount++;
        if (AG_HTTP_PORT === 0) { if (_agPollCount % 5 === 0) _agDiscoverPort(function (port, cfg) { _agApplyConfig(cfg); _agPollErrors = 0; }); return; }
        if (_agPollErrors > 3) { AG_HTTP_PORT = 0; _agPollErrors = 0; _agDiscoverPort(function (port, cfg) { _agApplyConfig(cfg); }); return; }
        try {
            var xhr = new XMLHttpRequest();
            var statsParam = '';
            if (_agSessionTotal > 0) {
                statsParam = '&total=' + _agSessionTotal + '&stats=' + encodeURIComponent(JSON.stringify(_agSessionStats));
                _agSessionStats = {}; _agSessionTotal = 0;
            }
            xhr.open('GET', 'http://127.0.0.1:' + AG_HTTP_PORT + '/ag-status?t=' + Date.now() + statsParam, true);
            xhr.timeout = 1500;
            xhr.onload = function () { if (xhr.status === 200) { _agPollErrors = 0; _agApplyConfig(JSON.parse(xhr.responseText)); } };
            xhr.onerror = function () { _agPollErrors++; };
            xhr.ontimeout = function () { _agPollErrors++; };
            xhr.send();
        } catch (e) { _agPollErrors++; }
    }, 2000);
    window._agToolIntervals.push(_agConfigReload);

    // =================================================================
    // SMART ROUTER — Thin Enter interceptor stub (v6.0.0)
    // All routing logic runs in Extension Host via /api/smart-route
    // This stub only intercepts Enter, reads prompt, delegates to extension
    // Safety: auto-unlock after 8s to prevent stuck state
    // =================================================================
    var _isRoutingInProgress = false;
    var _routingLockTime = 0;

    document.addEventListener('keydown', function (e) {
        if (!window._agAutoEnabled || !window._agSmartRouter) return;
        // Safety: auto-unlock if stuck for more than 8 seconds
        if (_isRoutingInProgress && (Date.now() - _routingLockTime > 8000)) {
            console.log('[AG Autopilot] ⚠️ Routing lock expired, auto-unlocking');
            _isRoutingInProgress = false;
        }
        if (_isRoutingInProgress) return;
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;

        var el = e.target;
        if (!el) return;
        // Support both textarea and contenteditable elements
        var isInput = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';
        if (!isInput) return;
        if (!el.closest || !el.closest('.antigravity-agent-side-panel, [class*="chat"], [class*="agent"], [class*="inline-chat"], [class*="command-approval"], [class*="jetski"]')) return;

        var prompt = (el.value || el.textContent || '').trim();
        if (!prompt || prompt.length < 3) return;

        // Intercept Enter — delegate routing to Extension Host
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        _isRoutingInProgress = true;
        _routingLockTime = Date.now();

        if (AG_HTTP_PORT > 0) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/smart-route', true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.timeout = 6000;
                var _enterForwarded = false;
                var forwardEnter = function () {
                    if (_enterForwarded) return; // prevent double-fire
                    _enterForwarded = true;
                    _isRoutingInProgress = false;
                    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
                    el.dispatchEvent(new KeyboardEvent('keydown', opts));
                    el.dispatchEvent(new KeyboardEvent('keypress', opts));
                    el.dispatchEvent(new KeyboardEvent('keyup', opts));
                    // Fallback: click Send button
                    setTimeout(function () {
                        var btns = pierceQuery('button, vscode-button, [role="button"]', document);
                        for (var i = 0; i < btns.length; i++) {
                            var t = (btns[i].innerText || '').trim().toLowerCase();
                            var a = (btns[i].getAttribute('aria-label') || '').toLowerCase();
                            if ((t === 'send' || t === 'submit' || a.indexOf('send') !== -1) && (btns[i].offsetParent !== null || btns[i].shadowRoot)) {
                                btns[i].click(); break;
                            }
                        }
                    }, 300);
                };
                xhr.onload = function () {
                    var result = {};
                    try { result = JSON.parse(xhr.responseText); } catch (_) {}
                    // Wait a bit after model switch for UI to settle
                    setTimeout(forwardEnter, result.switched ? 800 : 50);
                };
                xhr.onerror = function () { forwardEnter(); };
                xhr.ontimeout = function () { forwardEnter(); };
                xhr.send(JSON.stringify({ prompt: prompt }));
            } catch (_e) {
                _isRoutingInProgress = false;
                // Let original Enter through
            }
        } else {
            // No HTTP port — just let Enter through
            _isRoutingInProgress = false;
        }
    }, true);

    // =================================================================
    // AUTO CLICK
    // =================================================================
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];
    var EDITOR_SKIP_WORDS = ['Accept Changes', 'Accept All', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var _clicked = new WeakSet();
    if (!window._agClickStats) window._agClickStats = {};
    if (!window._agTotalClicks) window._agTotalClicks = 0;

    function isApprovalButton(btn) {
        var parent = btn.parentElement || (btn.getRootNode && btn.getRootNode().host);
        if (!parent) return false;
        for (var level = 0; level < 5; level++) {
            if (!parent) break;
            // Pierce shadow DOM when searching for sibling reject buttons
            var siblingBtns = pierceQuery('button, vscode-button, a.action-label, [role="button"], .monaco-button, span.bg-ide-button-background', parent);
            for (var i = 0; i < siblingBtns.length; i++) {
                var sib = siblingBtns[i];
                if (sib === btn) continue;
                var sibText = (sib.innerText || '').trim();
                for (var j = 0; j < REJECT_WORDS.length; j++) {
                    if (sibText === REJECT_WORDS[j] || sibText.indexOf(REJECT_WORDS[j]) === 0) return true;
                }
            }
            parent = parent.parentElement || (parent.getRootNode && parent.getRootNode().host);
        }
        return false;
    }

    var autoClick = setInterval(function () {
        if (!window._agAutoEnabled) return;
        
        // --- QUOTA EXHAUSTION DETECTION ---
        if (window._agQuotaFallback && !_isRoutingInProgress) {
            var quotaTextMatch = false;
            var bodyText = document.body.innerText || '';
            if (bodyText.indexOf('Your Claude Code usage is unusually high') !== -1 || bodyText.indexOf('free limit reached') !== -1) {
                quotaTextMatch = true;
            } else {
                // Check inner nodes deeply just in case it's in shadow DOM
                var twq = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
                while (twq.nextNode()) {
                    var vq = (twq.currentNode.nodeValue || '').trim().toLowerCase();
                    if (vq.indexOf('usage is unusually high') !== -1 || vq.indexOf('free limit reached') !== -1) {
                        quotaTextMatch = true; break;
                    }
                }
            }
            if (quotaTextMatch) {
                // Stop to switch
                _isRoutingInProgress = true;
                _routingLockTime = Date.now();
                var switchTarget = 'Gemini 3.1 Pro (High)';
                console.log('[AG] Quota exhausted! Switching to: ' + switchTarget);
                
                // Directly click the model dropdown
                var M_pats = ["Select a model", "Claude", "Gemini", "GPT"];
                var tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
                var dropdownClicked = false;
                while (tw.nextNode()) {
                    var v = (tw.currentNode.nodeValue || '').trim();
                    if (!v || v.length < 3 || v.length > 120) continue;
                    var found = false;
                    for (var m = 0; m < M_pats.length; m++) { if (v.indexOf(M_pats[m]) !== -1) { found = true; break; } }
                    if (found) {
                        var anc = tw.currentNode.parentElement;
                        for (var l = 0; l < 8 && anc; l++) {
                            if (anc.tagName === 'BUTTON' || anc.tagName === 'VSCODE-BUTTON' || anc.getAttribute('role') === 'button' || (anc.style && anc.style.cursor === 'pointer')) {
                                anc.click();
                                dropdownClicked = true;
                                break;
                            }
                            anc = anc.parentElement || (anc.getRootNode && anc.getRootNode().host);
                        }
                    }
                    if (dropdownClicked) break;
                }
                
                if (dropdownClicked) {
                    setTimeout(function() {
                        var tgt = switchTarget; var sn = tgt.split(' ').slice(0, 3).join(' ');
                        var items = pierceQuery('vscode-option, [role=menuitem], [role=option], .monaco-list-row, .action-label, [class*=list-row], [class*=option], [class*=item]', document);
                        var modelClicked = false;
                        for (var i = 0; i < items.length; i++) {
                            var t = (items[i].innerText || items[i].textContent || '').trim();
                            if ((t.indexOf(tgt) !== -1 || (sn && t.indexOf(sn) !== -1)) && (items[i].offsetParent !== null || items[i].closest('[class*=overlay],[class*=popover],[class*=popup],[class*=shadow]'))) {
                                items[i].click(); modelClicked = true; break;
                            }
                        }
                        if (!modelClicked) {
                            var firstWord = tgt.split(' ')[0];
                            for (var i = 0; i < items.length; i++) {
                                var t = (items[i].innerText || items[i].textContent || '').trim();
                                if (t.indexOf(firstWord) !== -1 && t.length < 80) { items[i].click(); modelClicked = true; break; }
                            }
                        }
                        // Press escape
                        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', keyCode: 27, bubbles: true}));
                        setTimeout(function() { _isRoutingInProgress = false; }, 300);
                    }, 800);
                } else {
                    _isRoutingInProgress = false;
                }
            }
        }

        // Pierce Shadow DOM to find buttons inside Antigravity's new popup architecture
        var clickables = pierceQuery('button, vscode-button, a.action-label, [role="button"], [class*="button"], span.cursor-pointer, span.bg-ide-button-background', document);
        var targetBtn = null;
        var matchedPattern = '';

        for (var i = 0; i < clickables.length; i++) {
            var b = clickables[i];
            if (_clicked.has(b)) continue;
            // Extract button's own text — NOT nested children's full text
            // For long command popups, innerText includes the command description
            var rawText = (b.innerText || b.textContent || '').trim();
            var ariaLabel = (b.getAttribute('aria-label') || '').trim();
            var titleAttr = (b.getAttribute('title') || '').trim();
            var firstLine = rawText.split('\n')[0].trim();
            var directText = '';
            for (var cn = 0; cn < b.childNodes.length; cn++) {
                if (b.childNodes[cn].nodeType === 3) directText += b.childNodes[cn].nodeValue || '';
            }
            directText = directText.trim();
            
            var text = directText || titleAttr || firstLine || ariaLabel;
            
            // DEBUG: if it contains Allow, log it to HTTP API
            var lcRaw = rawText.toLowerCase(), lcAria = ariaLabel.toLowerCase(), lcTitle = titleAttr.toLowerCase();
            if (lcRaw.indexOf('allow') !== -1 || lcAria.indexOf('allow') !== -1 || lcTitle.indexOf('allow') !== -1) {
                try {
                    fetch('http://127.0.0.1:48787/api/click-log', {
                        method: 'POST',
                        body: JSON.stringify({
                            pattern: 'DEBUG',
                            button: JSON.stringify({
                                raw: rawText.substring(0,50),
                                first: firstLine,
                                direct: directText,
                                aria: ariaLabel,
                                title: titleAttr,
                                tag: b.tagName,
                                offsetParent: !!b.offsetParent,
                                classes: b.className,
                                closestQuickInput: !!(b.closest && b.closest('[class*=quick-input]')),
                                shadow: !!b.shadowRoot
                            })
                        })
                    }).catch(function(){});
                } catch(e){}
            }

            if (!text) continue;

            // EXTREME DEEP AUDIT: Dump to 48888 if it's remotely related to Allow or Run
            var lcAll = (b.outerHTML || '').toLowerCase();
            if (lcAll.indexOf('allow') !== -1 || lcAll.indexOf('run command') !== -1 || lcAll.indexOf('curl') !== -1) {
                try {
                    fetch('http://127.0.0.1:48888/', {
                        method: 'POST',
                        body: JSON.stringify({
                            ts: Date.now(),
                            isTarget: matchedPattern,
                            tag: b.tagName,
                            className: b.className,
                            offsetParent: !!b.offsetParent,
                            shadowRoot: !!b.shadowRoot,
                            rect: b.getBoundingClientRect ? b.getBoundingClientRect().width : 0,
                            innerText: (b.innerText || '').substring(0, 50),
                            outerHTML: (b.outerHTML || '').substring(0, 300)
                        })
                    }).catch(function(){});
                } catch(e){}
            }

            // Relaxed visibility: allow buttons in overlays/popups that lack offsetParent
            if (b.offsetParent === null && !b.shadowRoot && !(b.closest && b.closest('[class*=overlay],[class*=popover],[class*=popup],[class*=dialog],[class*=notification],[class*=quick-input],[class*=context-view],[class*=action-widget],[class*=chat]'))) {
                // If it's the specific curl command block, bypass visibility check!
                if (lcAll.indexOf('curl') !== -1 || lcAll.indexOf('allow') !== -1) {
                   // Force allow
                } else {
                    continue;
                }
            }

            var skipEditor = false;
            for (var se = 0; se < EDITOR_SKIP_WORDS.length; se++) {
                if (text.indexOf(EDITOR_SKIP_WORDS[se]) === 0 || firstLine.indexOf(EDITOR_SKIP_WORDS[se]) === 0) { skipEditor = true; break; }
            }
            if (skipEditor) continue;

            if (b.closest && (b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view') ||
                b.closest('.inline-merge-region') || b.closest('.merged-editor') ||
                b.closest('.view-zones') || b.closest('.view-lines') ||
                b.closest('[id*="workbench.parts.editor"]'))) continue;

            if (b.classList && (b.classList.contains('diff-hunk-button') || b.classList.contains('accept') || b.classList.contains('revert'))) {
                if (b.closest && b.closest('[class*="editor"], [id*="editor"]')) continue;
            }

            // Match against all text variants: direct text, first line, aria-label
            var matchesPattern = false;
            var candidates = [text, firstLine, ariaLabel, rawText.split('\n')[0]];
            for (var ci = 0; ci < candidates.length; ci++) {
                var cand = (candidates[ci] || '').trim();
                if (!cand) continue;
                for (var p = 0; p < CLICK_PATTERNS.length; p++) {
                    if (cand === CLICK_PATTERNS[p] || cand.indexOf(CLICK_PATTERNS[p]) === 0) { matchesPattern = true; matchedPattern = CLICK_PATTERNS[p]; break; }
                }
                if (matchesPattern) break;
            }
            if (!matchesPattern) continue;

            // FIX: Don't require a 'Deny' sibling if the button explicitly matches our critical patterns!
            if (matchedPattern === 'Allow' || matchedPattern === 'Run' || matchedPattern === 'Always Allow' || matchedPattern === 'Accept all') {
                targetBtn = b; break;
            }

            if (b.tagName === 'SPAN' && b.classList.contains('cursor-pointer')) { targetBtn = b; break; }
            if (isApprovalButton(b)) { targetBtn = b; break; }
        }

        // Separate Accept handling (chat-only)
        if (!targetBtn && window._agAcceptChatOnly) {
            for (var ai = 0; ai < clickables.length; ai++) {
                var ab = clickables[ai];
                if ((ab.offsetParent === null && !ab.shadowRoot) || _clicked.has(ab)) continue;
                var aText = (ab.innerText || ab.textContent || '').trim();
                if (aText.indexOf('Accept') !== 0) continue;
                if (/^Accept\s+(all|changes|incoming|current|both|combination)/i.test(aText)) continue;
                if (ab.closest && (ab.closest('.editor-scrollable') || ab.closest('.monaco-diff-editor') || ab.closest('.view-zones') || ab.closest('.merge-editor-view'))) continue;
                if (ab.classList && (ab.classList.contains('diff-hunk-button') || ab.classList.contains('revert'))) continue;
                targetBtn = ab; matchedPattern = 'Accept'; break;
            }
        }

        if (targetBtn) {
            if (AG_HTTP_PORT > 0) {
                try {
                    var _lx = new XMLHttpRequest();
                    _lx.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/click-log', true);
                    _lx.setRequestHeader('Content-Type', 'application/json');
                    _lx.timeout = 3000;
                    _lx.send(JSON.stringify({ button: targetBtn.innerText.trim().substring(0, 100), pattern: matchedPattern }));
                } catch (_e) {}
            }
            console.log('[AG Autopilot] 🎯 Click: [' + (targetBtn.innerText || '').trim().substring(0, 40) + '] pattern=' + matchedPattern);
            _clicked.add(targetBtn);
            
            if (matchedPattern === 'Allow' || matchedPattern === 'Run') {
                try {
                    fetch('http://127.0.0.1:' + AG_HTTP_PORT + '/api/debug-element', {
                        method: 'POST',
                        body: JSON.stringify({ pattern: matchedPattern, html: targetBtn.outerHTML || '' })
                    }).catch(function(){});
                } catch(e){}
            }

            var evtOptions = { bubbles: true, cancelable: true, view: window, detail: 1, clientX: 1, clientY: 1 };
            try { targetBtn.dispatchEvent(new PointerEvent('pointerdown', evtOptions)); targetBtn.dispatchEvent(new PointerEvent('pointerup', evtOptions)); } catch(e){}
            targetBtn.dispatchEvent(new MouseEvent('mousedown', evtOptions));
            targetBtn.dispatchEvent(new MouseEvent('mouseup', evtOptions));
            targetBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
            targetBtn.click();

            // If it's a span/icon inside a button, also trigger the parent
            // But if it's already an anchor (A), do not click the parent, as that triggers split-button dropdowns!
            if (targetBtn.tagName !== 'BUTTON' && targetBtn.tagName !== 'VSCODE-BUTTON' && targetBtn.tagName !== 'A' && targetBtn.parentElement) {
                var p = targetBtn.parentElement;
                if (p.tagName === 'BUTTON' || p.tagName === 'VSCODE-BUTTON' || p.tagName === 'A' || p.classList.contains('monaco-button')) {
                    try { p.dispatchEvent(new PointerEvent('pointerdown', evtOptions)); p.dispatchEvent(new PointerEvent('pointerup', evtOptions)); } catch(e){}
                    p.dispatchEvent(new MouseEvent('mousedown', evtOptions));
                    p.dispatchEvent(new MouseEvent('mouseup', evtOptions));
                    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
                    p.click();
                    _clicked.add(p);
                } else if (p.parentElement) {
                    var gp = p.parentElement;
                    if (gp.tagName === 'BUTTON' || gp.tagName === 'VSCODE-BUTTON' || gp.tagName === 'A' || gp.classList.contains('monaco-button')) {
                        try { gp.dispatchEvent(new PointerEvent('pointerdown', evtOptions)); gp.dispatchEvent(new PointerEvent('pointerup', evtOptions)); } catch(e){}
                        gp.dispatchEvent(new MouseEvent('mousedown', evtOptions));
                        gp.dispatchEvent(new MouseEvent('mouseup', evtOptions));
                        gp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
                        gp.click();
                        _clicked.add(gp);
                    }
                }
            }

            _agSessionTotal++;
            if (!_agSessionStats[matchedPattern]) _agSessionStats[matchedPattern] = 0;
            _agSessionStats[matchedPattern]++;
            window._agTotalClicks++;
            if (!window._agClickStats[matchedPattern]) window._agClickStats[matchedPattern] = 0;
            window._agClickStats[matchedPattern]++;
        }
    }, CLICK_INTERVAL_MS);
    window._agToolIntervals.push(autoClick);

    // =================================================================
    // SMART AUTO SCROLL (stick-to-bottom)
    // =================================================================
    var _agWasAtBottom = new WeakMap();
    var _agJustScrolled = new WeakSet();
    var BOTTOM_THRESHOLD = 150;
    var isAutoScrolling = false;

    var _agCachedPanel = null;
    var _agPanelCheckCount = 0;

    var autoScroll = setInterval(function () {
        if (!window._agAutoEnabled || !window._agScrollEnabled) return;
        // Re-query panel every 20 cycles (~10s) or if cached ref is detached
        if (!_agCachedPanel || !_agCachedPanel.isConnected || ++_agPanelCheckCount > 20) {
            _agCachedPanel = document.querySelector('.antigravity-agent-side-panel') || pierceQuery('.antigravity-agent-side-panel, [class*="agent-panel"], [class*="jetski"]', document)[0] || null;
            _agPanelCheckCount = 0;
        }
        if (!_agCachedPanel) return;
        var scrollables = Array.from(_agCachedPanel.querySelectorAll('*')).filter(function (el) {
            var style = window.getComputedStyle(el);
            return el.scrollHeight > el.clientHeight &&
                (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                el.tagName !== 'TEXTAREA';
        });
        if (scrollables.length > 0) {
            isAutoScrolling = true;
            scrollables.forEach(function (el) {
                var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                var wasBottom = _agWasAtBottom.get(el);
                if (wasBottom === undefined) { wasBottom = gap <= BOTTOM_THRESHOLD; _agWasAtBottom.set(el, wasBottom); }
                if (wasBottom && gap > 5) { _agJustScrolled.add(el); el.scrollTop = el.scrollHeight; }
            });
            setTimeout(function () { isAutoScrolling = false; }, 200);
        }
    }, SCROLL_INTERVAL_MS);
    window._agToolIntervals.push(autoScroll);

    window._agScrollListener = function (e) {
        var el = e.target;
        if (!el || el.nodeType !== 1) return;
        if (!el.closest || !el.closest('.antigravity-agent-side-panel')) return;
        if (_agJustScrolled.has(el)) { _agJustScrolled.delete(el); return; }
        if (isAutoScrolling) return;
        var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        _agWasAtBottom.set(el, gap <= BOTTOM_THRESHOLD);
    };
    window.addEventListener('scroll', window._agScrollListener, true);

    console.log("[AG Autopilot] 🚀 v6.0.0 | Auto Click & Scroll (Layer 0) | Smart Router & Quota Fallback (Extension Host) | Patterns:", JSON.stringify(CLICK_PATTERNS));
})();
