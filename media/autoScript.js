(function () {
    // --- Guard: prevent double execution ---
    if (window._agToolkitLoaded) return;
    window._agToolkitLoaded = true;
    // Also block old extensions from loading
    window._agAutoLoaded = true;
    window._agModelSwitchLoaded = true;

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

    // ===== HTTP PORT DISCOVERY (from ag-auto-click-scroll) =====
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
        if (typeof cfg.enabled === 'boolean') window._agAutoEnabled = cfg.enabled;
        if (typeof cfg.scrollEnabled === 'boolean') window._agScrollEnabled = cfg.scrollEnabled;
        if (cfg.clickPatterns && Array.isArray(cfg.clickPatterns)) CLICK_PATTERNS = cfg.clickPatterns.filter(function (p) { return p !== 'Accept'; });
        if (typeof cfg.acceptInChatOnly === 'boolean') window._agAcceptChatOnly = cfg.acceptInChatOnly;
        if (cfg.pauseScrollMs) PAUSE_SCROLL_MS = cfg.pauseScrollMs;
        if (cfg.scrollIntervalMs) SCROLL_INTERVAL_MS = cfg.scrollIntervalMs;
        if (cfg.clickIntervalMs) CLICK_INTERVAL_MS = cfg.clickIntervalMs;
        if (typeof cfg.smartRouter === 'boolean') window._agSmartRouter = cfg.smartRouter;
        if (typeof cfg.quotaFallback === 'boolean') window._agQuotaFallback = cfg.quotaFallback;
        if (cfg.resetStats) { window._agClickStats = {}; window._agTotalClicks = 0; _agSessionStats = {}; _agSessionTotal = 0; }
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
    // SMART ROUTER (from ag-auto-model-switch)
    // =================================================================
    var FALLBACK_MODELS = [
        "Claude Opus 4.6 (Thinking)",
        "Gemini 3.1 Pro (High)",
        "Gemini 3 Flash",
        "GPT-OSS 120B (Medium)"
    ];
    var TIER_CHEAP = "Gemini 3 Flash";
    var TIER_EXTREME = "Claude Opus 4.6 (Thinking)";
    var TIER_DEFAULT = "Gemini 3.1 Pro (High)";
    var REGEX_CHEAP = /(explain|giải thích|hỏi|comment|format|typo|spell|rename|lint|clean|tóm tắt|summary|translate)/i;
    var REGEX_EXTREME = /(architecture|kiến trúc|setup|mới|debug|refactor|complex|plan|structure|design|error|lỗi|build)/i;

    var _modelSwitchingAt = 0;
    var _isRoutingInProgress = false;

    function findModelSelectorButton(containsText) {
        var btns = document.querySelectorAll('.monaco-button, button, [role="button"]');
        for (var i = 0; i < btns.length; i++) {
            var text = (btns[i].innerText || '').trim();
            if (containsText && text.indexOf(containsText) !== -1) return btns[i];
            for (var m = 0; m < FALLBACK_MODELS.length; m++) {
                if (text.indexOf(FALLBACK_MODELS[m]) !== -1) return btns[i];
            }
        }
        return null;
    }

    function selectModelInDropdown(targetModel, callback) {
        var selectorBtn = findModelSelectorButton();
        if (!selectorBtn) { if (callback) callback(false); return; }
        selectorBtn.click();
        setTimeout(function () {
            var menuItems = document.querySelectorAll('.action-item, .action-label, [role="menuitem"]');
            var clicked = false;
            for (var i = 0; i < menuItems.length; i++) {
                if ((menuItems[i].innerText || '').indexOf(targetModel) !== -1) { menuItems[i].click(); clicked = true; break; }
            }
            if (!clicked) document.body.click();
            if (callback) callback(clicked);
        }, 300);
    }

    function evaluateTargetModel(promptText) {
        if (!promptText || promptText.trim() === '') return TIER_DEFAULT;
        if (promptText.length > 600) return TIER_EXTREME;
        if (promptText.length < 30) return TIER_CHEAP;
        if (REGEX_EXTREME.test(promptText)) return TIER_EXTREME;
        if (REGEX_CHEAP.test(promptText)) return TIER_CHEAP;
        return TIER_DEFAULT;
    }

    function emulateSendEvent(el) {
        var evt = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
        el.dispatchEvent(evt);
    }

    // Smart Router: intercept Enter on textarea
    document.addEventListener('keydown', function (e) {
        if (!window._agAutoEnabled || !window._agSmartRouter) return;
        if (_isRoutingInProgress) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            var el = e.target;
            if (el && el.tagName === 'TEXTAREA' && (el.classList.contains('chat-input') || (el.closest && el.closest('.antigravity-agent-side-panel')))) {
                var prompt = (el.value || '').trim();
                if (!prompt) return;
                var targetModel = evaluateTargetModel(prompt);
                var currentBtn = findModelSelectorButton();
                var currentModel = currentBtn ? currentBtn.innerText.trim() : '';
                if (currentModel && currentModel.indexOf(targetModel) === -1) {
                    e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
                    _isRoutingInProgress = true;
                    console.log('[AG Autopilot] 🧠 Smart Router → ' + targetModel);
                    selectModelInDropdown(targetModel, function (success) {
                        setTimeout(function () { _isRoutingInProgress = false; emulateSendEvent(el); }, 300);
                    });
                }
            }
        }
    }, true);

    // =================================================================
    // QUOTA FALLBACK (from ag-auto-model-switch)
    // =================================================================
    function findDismissButton() {
        var btns = document.querySelectorAll('button, a.action-label, [role="button"], .monaco-button');
        for (var i = 0; i < btns.length; i++) {
            if ((btns[i].innerText || '').trim() === 'Dismiss') return btns[i];
        }
        return null;
    }

    function isQuotaErrorVisible() {
        var elements = document.querySelectorAll('span, div, p');
        for (var i = 0; i < elements.length; i++) {
            var t = elements[i].innerText;
            if (t && (t.indexOf('exhausted your capacity on this model') !== -1 ||
                      t.indexOf('Your quota will reset after') !== -1 ||
                      t.indexOf('Baseline model quota reached') !== -1)) return true;
        }
        return false;
    }

    function triggerSwitchSequence() {
        if (Date.now() - _modelSwitchingAt < 15000) return;
        _modelSwitchingAt = Date.now();
        console.log('[AG Autopilot] 🔄 Quota error! Switching model...');
        var dismissBtn = findDismissButton();
        if (dismissBtn) dismissBtn.click();
        setTimeout(function () {
            var selectorBtn = findModelSelectorButton();
            var currentModel = selectorBtn ? selectorBtn.innerText.trim() : '';
            var targetModel = FALLBACK_MODELS[0];
            var foundCurrent = false;
            for (var i = 0; i < FALLBACK_MODELS.length; i++) {
                if (foundCurrent) { targetModel = FALLBACK_MODELS[i]; break; }
                if (currentModel.indexOf(FALLBACK_MODELS[i]) !== -1) foundCurrent = true;
            }
            if (targetModel === currentModel) {
                var idx = FALLBACK_MODELS.indexOf(targetModel);
                targetModel = FALLBACK_MODELS[(idx + 1) % FALLBACK_MODELS.length] || FALLBACK_MODELS[0];
            }
            console.log('[AG Autopilot] 🔄 Switching to: ' + targetModel);
            selectModelInDropdown(targetModel, function (success) {
                if (success) setTimeout(sendContinueMessage, 1500);
            });
        }, 300);
    }

    function sendContinueMessage() {
        var inputArea = null;
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) {
            if (textareas[i].closest && (textareas[i].closest('.antigravity-agent-side-panel') || textareas[i].classList.contains('chat-input'))) {
                inputArea = textareas[i]; break;
            }
        }
        if (!inputArea) inputArea = document.querySelector('textarea, [contenteditable="true"]');
        if (inputArea) {
            inputArea.focus();
            var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            if (nativeSetter) nativeSetter.call(inputArea, 'Continue');
            else inputArea.value = 'Continue';
            inputArea.dispatchEvent(new Event('input', { bubbles: true }));
            inputArea.dispatchEvent(new Event('change', { bubbles: true }));
            setTimeout(function () {
                _isRoutingInProgress = true;
                inputArea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, keyCode: 13, key: 'Enter' }));
                setTimeout(function () { _isRoutingInProgress = false; }, 500);
            }, 500);
        }
    }

    // Quota observer
    var chatPanel = document.querySelector('.antigravity-agent-side-panel') || document.body;
    if (chatPanel) {
        var quotaObserver = new MutationObserver(function (mutations) {
            if (!window._agAutoEnabled || !window._agQuotaFallback) return;
            if (Date.now() - _modelSwitchingAt < 15000) return;
            for (var i = 0; i < mutations.length; i++) {
                if (mutations[i].type === 'childList' && isQuotaErrorVisible()) { triggerSwitchSequence(); break; }
            }
        });
        quotaObserver.observe(chatPanel, { childList: true, subtree: true, characterData: true });
    }

    // =================================================================
    // AUTO CLICK (from ag-auto-click-scroll)
    // =================================================================
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];
    var EDITOR_SKIP_WORDS = ['Accept Changes', 'Accept All', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var _clicked = new WeakSet();
    if (!window._agClickStats) window._agClickStats = {};
    if (!window._agTotalClicks) window._agTotalClicks = 0;

    function isApprovalButton(btn) {
        var parent = btn.parentElement;
        if (!parent) return false;
        for (var level = 0; level < 3; level++) {
            if (!parent) break;
            var siblingBtns = parent.querySelectorAll('button, a.action-label, [role="button"], .monaco-button, span.bg-ide-button-background');
            for (var i = 0; i < siblingBtns.length; i++) {
                var sib = siblingBtns[i];
                if (sib === btn) continue;
                var sibText = (sib.innerText || '').trim();
                for (var j = 0; j < REJECT_WORDS.length; j++) {
                    if (sibText === REJECT_WORDS[j] || sibText.indexOf(REJECT_WORDS[j]) === 0) return true;
                }
            }
            parent = parent.parentElement;
        }
        return false;
    }

    var autoClick = setInterval(function () {
        if (!window._agAutoEnabled) return;
        var clickables = Array.from(document.querySelectorAll('button, a.action-label, [role="button"], .monaco-button'));
        document.querySelectorAll('span.cursor-pointer').forEach(function (s) { clickables.push(s); });
        var targetBtn = null;
        var matchedPattern = '';

        for (var i = 0; i < clickables.length; i++) {
            var b = clickables[i];
            if (b.offsetParent === null || _clicked.has(b)) continue;
            var text = (b.innerText || b.textContent || '').trim();
            if (!text || text.length > 40) continue;

            var skipEditor = false;
            for (var se = 0; se < EDITOR_SKIP_WORDS.length; se++) {
                if (text.indexOf(EDITOR_SKIP_WORDS[se]) === 0) { skipEditor = true; break; }
            }
            if (skipEditor) continue;

            if (b.closest && (b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view') ||
                b.closest('.inline-merge-region') || b.closest('.merged-editor') ||
                b.closest('.view-zones') || b.closest('.view-lines') ||
                b.closest('[id*="workbench.parts.editor"]'))) continue;

            if (b.classList && (b.classList.contains('diff-hunk-button') || b.classList.contains('accept') || b.classList.contains('revert'))) {
                if (b.closest && b.closest('[class*="editor"], [id*="editor"]')) continue;
            }

            var matchesPattern = false;
            for (var p = 0; p < CLICK_PATTERNS.length; p++) {
                if (text === CLICK_PATTERNS[p] || text.indexOf(CLICK_PATTERNS[p]) === 0) { matchesPattern = true; matchedPattern = CLICK_PATTERNS[p]; break; }
            }
            if (!matchesPattern) continue;

            if (b.tagName === 'SPAN' && b.classList.contains('cursor-pointer')) { targetBtn = b; break; }
            if (isApprovalButton(b)) { targetBtn = b; break; }
        }

        // Separate Accept handling (chat-only)
        if (!targetBtn && window._agAcceptChatOnly) {
            for (var ai = 0; ai < clickables.length; ai++) {
                var ab = clickables[ai];
                if (ab.offsetParent === null || _clicked.has(ab)) continue;
                var aText = (ab.innerText || ab.textContent || '').trim();
                if (aText.indexOf('Accept') !== 0) continue;
                if (/^Accept\s+(all|changes|incoming|current|both|combination)/i.test(aText)) continue;
                if (ab.closest && (ab.closest('.editor-scrollable') || ab.closest('.monaco-diff-editor') || ab.closest('.view-zones') || ab.closest('.merge-editor-view'))) continue;
                if (ab.classList && (ab.classList.contains('diff-hunk-button') || ab.classList.contains('revert'))) continue;
                targetBtn = ab; matchedPattern = 'Accept'; break;
            }
        }

        if (targetBtn) {
            try {
                var _lx = new XMLHttpRequest();
                _lx.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/click-log', true);
                _lx.setRequestHeader('Content-Type', 'application/json');
                _lx.timeout = 3000;
                _lx.send(JSON.stringify({ button: targetBtn.innerText.trim().substring(0, 100), pattern: matchedPattern }));
            } catch (_e) {}
            _clicked.add(targetBtn);
            targetBtn.click();
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

    var autoScroll = setInterval(function () {
        if (!window._agAutoEnabled || !window._agScrollEnabled) return;
        var panel = document.querySelector('.antigravity-agent-side-panel');
        if (!panel) return;
        var scrollables = Array.from(panel.querySelectorAll('*')).filter(function (el) {
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

    console.log("[AG Autopilot] 🚀 v3.0.0 | Auto Click & Scroll + Smart Router + Quota Fallback | Patterns:", JSON.stringify(CLICK_PATTERNS));
})();
