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
    // SMART ROUTER (from ag-auto-model-switch)
    // =================================================================
    var FALLBACK_MODELS = [
        "Claude Opus 4.6 (Thinking)",
        "Claude Sonnet 4.5",
        "Gemini 3.1 Pro (High)",
        "Gemini 3 Flash",
        "GPT-OSS 120B (Medium)"
    ];
    // Unique model families for matching (partial match)
    var MODEL_KEYWORDS = ["Claude", "Gemini", "GPT"];

    var TIER_CHEAP = "Gemini 3 Flash";
    var TIER_EXTREME = "Claude Opus 4.6 (Thinking)";
    var TIER_DEFAULT = "Gemini 3.1 Pro (High)";
    var REGEX_CHEAP = /(explain|giải thích|hỏi|comment|format|typo|spell|rename|lint|clean|tóm tắt|summary|translate|what is|là gì)/i;
    var REGEX_EXTREME = /(architecture|kiến trúc|setup|mới|debug|refactor|complex|plan|structure|design|error|lỗi|build|migrate|deploy|security|optimize|performance)/i;

    var _modelSwitchingAt = 0;
    var _isRoutingInProgress = false;

    // --- Robust model selector finder ---
    // AG model selector can be: dropdown button, select element, or custom widget
    function findModelSelectorButton() {
        // Strategy 1: Look for button/element inside chat panel that contains a known model name
        var chatPanel = document.querySelector('.antigravity-agent-side-panel');
        var searchRoot = chatPanel || document;

        // Check all interactive elements
        var candidates = searchRoot.querySelectorAll(
            'button, [role="button"], [role="combobox"], [role="listbox"], ' +
            '.monaco-button, .monaco-dropdown, select, ' +
            '[class*="model"], [class*="selector"], [class*="picker"], [class*="dropdown"], ' +
            '[aria-label*="model" i], [aria-label*="Model" i], [title*="model" i]'
        );

        // First pass: exact model name match
        for (var i = 0; i < candidates.length; i++) {
            var text = (candidates[i].innerText || candidates[i].textContent || '').trim();
            if (!text || text.length > 100) continue;
            for (var m = 0; m < FALLBACK_MODELS.length; m++) {
                if (text.indexOf(FALLBACK_MODELS[m]) !== -1) {
                    return candidates[i];
                }
            }
        }

        // Second pass: keyword match (Claude, Gemini, GPT, etc.)
        for (var i = 0; i < candidates.length; i++) {
            var text = (candidates[i].innerText || candidates[i].textContent || '').trim();
            if (!text || text.length > 100) continue;
            for (var k = 0; k < MODEL_KEYWORDS.length; k++) {
                if (text.indexOf(MODEL_KEYWORDS[k]) !== -1) {
                    return candidates[i];
                }
            }
        }

        // Strategy 2: Broader search across entire document
        if (chatPanel) {
            var allBtns = document.querySelectorAll('button, [role="button"], [role="combobox"]');
            for (var i = 0; i < allBtns.length; i++) {
                var text = (allBtns[i].innerText || '').trim();
                if (!text || text.length > 100) continue;
                for (var m = 0; m < FALLBACK_MODELS.length; m++) {
                    if (text.indexOf(FALLBACK_MODELS[m]) !== -1) return allBtns[i];
                }
                for (var k = 0; k < MODEL_KEYWORDS.length; k++) {
                    if (text.indexOf(MODEL_KEYWORDS[k]) !== -1) return allBtns[i];
                }
            }
        }

        console.log('[AG Autopilot] Model selector not found (may be in isolated webview)');
        return null;
    }

    function selectModelInDropdown(targetModel, callback) {
        var selectorBtn = findModelSelectorButton();
        if (!selectorBtn) {
            console.log('[AG Autopilot] Cannot switch model: selector not found');
            if (callback) callback(false);
            return;
        }

        console.log('[AG Autopilot] Clicking model selector to open dropdown...');
        selectorBtn.click();

        var attempts = 0;
        var maxAttempts = 15; // 15 x 200ms = 3s max wait
        var searchInterval = setInterval(function () {
            attempts++;

            // Search for dropdown menu items
            var menuItems = document.querySelectorAll(
                '[role="menuitem"], [role="option"], ' +
                '.monaco-list-row, .action-item .action-label, ' +
                '.context-view .action-label, ' +
                '.quick-input-list .monaco-list-row'
            );

            // Only proceed if we found menu items (dropdown is open)
            if (menuItems.length === 0 && attempts < maxAttempts) return;

            var clicked = false;

            // Pass 1: exact match
            for (var i = 0; i < menuItems.length; i++) {
                var itemText = (menuItems[i].innerText || menuItems[i].textContent || '').trim();
                if (itemText.indexOf(targetModel) !== -1) {
                    console.log('[AG Autopilot] Found model (exact): "' + itemText.substring(0, 50) + '"');
                    menuItems[i].click();
                    clicked = true;
                    break;
                }
            }

            // Pass 2: partial match (first 2 words)
            if (!clicked) {
                var shortName = targetModel.split(' ').slice(0, 2).join(' ');
                for (var i = 0; i < menuItems.length; i++) {
                    var itemText = (menuItems[i].innerText || menuItems[i].textContent || '').trim();
                    if (shortName && itemText.indexOf(shortName) !== -1) {
                        console.log('[AG Autopilot] Found model (partial): "' + itemText.substring(0, 50) + '"');
                        menuItems[i].click();
                        clicked = true;
                        break;
                    }
                }
            }

            if (clicked || attempts >= maxAttempts) {
                clearInterval(searchInterval);
                if (!clicked) {
                    console.log('[AG Autopilot] Model "' + targetModel + '" not found (' + menuItems.length + ' items). Closing dropdown.');
                    // Press Escape to close dropdown cleanly
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                }
                if (callback) callback(clicked);
            }
        }, 200);
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
        // Dispatch full keyboard event sequence (keydown + keypress + keyup)
        // Some frameworks only listen to specific events
        var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));

        // Fallback: find and click the Send button directly
        setTimeout(function () {
            var sendBtn = findSendButton();
            if (sendBtn) {
                console.log('[AG Autopilot] 📤 Clicking Send button as fallback');
                sendBtn.click();
            }
        }, 200);
    }

    // --- Find Send/Submit button in chat panel ---
    function findSendButton() {
        var panel = document.querySelector('.antigravity-agent-side-panel');
        var searchRoot = panel || document;
        var btns = searchRoot.querySelectorAll(
            'button, [role="button"], .monaco-button, [aria-label*="send" i], [aria-label*="submit" i], [title*="send" i]'
        );
        for (var i = 0; i < btns.length; i++) {
            var text = (btns[i].innerText || btns[i].textContent || '').trim().toLowerCase();
            var ariaLabel = (btns[i].getAttribute('aria-label') || '').toLowerCase();
            var title = (btns[i].getAttribute('title') || '').toLowerCase();
            // Match send/submit buttons
            if (text === 'send' || text === 'submit' || text === '↵' || text === '⏎' ||
                ariaLabel.indexOf('send') !== -1 || ariaLabel.indexOf('submit') !== -1 ||
                title.indexOf('send') !== -1 || title.indexOf('submit') !== -1) {
                // Make sure it's visible
                if (btns[i].offsetParent !== null) return btns[i];
            }
            // Also match icon-only send buttons (SVG arrow icon near textarea)
            if (btns[i].querySelector && btns[i].querySelector('svg, .codicon-send, [class*="send"], [class*="arrow"]')) {
                // Check if it's near a textarea (within same parent container)
                var parent = btns[i].parentElement;
                if (parent && parent.querySelector('textarea') && btns[i].offsetParent !== null) {
                    return btns[i];
                }
            }
        }
        return null;
    }

    // --- Find chat input textarea (robust) ---
    function findChatTextarea() {
        // Strategy 1: Inside AG panel
        var panel = document.querySelector('.antigravity-agent-side-panel');
        if (panel) {
            var ta = panel.querySelector('textarea');
            if (ta) return ta;
        }
        // Strategy 2: By class
        var chatInput = document.querySelector('textarea.chat-input');
        if (chatInput) return chatInput;
        // Strategy 3: Any focused textarea
        if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return document.activeElement;
        // Strategy 4: First textarea in document
        return document.querySelector('textarea');
    }

    // Smart Router: intercept Enter on textarea
    // NOTE: This only works if the chat textarea is in the workbench DOM (not in isolated webview).
    // In Antigravity, the agent panel runs in an isolated Chromium process (OOPIF),
    // so this may not be able to find the model selector. It will gracefully skip if not found.
    document.addEventListener('keydown', function (e) {
        if (!window._agAutoEnabled || !window._agSmartRouter) return;
        if (_isRoutingInProgress) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            var el = e.target;
            var isChatInput = el && el.tagName === 'TEXTAREA' && (
                el.classList.contains('chat-input') ||
                (el.closest && el.closest('.antigravity-agent-side-panel')) ||
                (el.closest && el.closest('[class*="chat"]')) ||
                (el.closest && el.closest('[class*="agent"]'))
            );
            if (!isChatInput) return;

            var prompt = (el.value || '').trim();
            if (!prompt) return;

            var targetModel = evaluateTargetModel(prompt);
            var currentBtn = findModelSelectorButton();
            if (!currentBtn) return; // Model selector not accessible from this context

            var currentModel = (currentBtn.innerText || currentBtn.textContent || '').trim();
            if (!currentModel || currentModel.indexOf(targetModel) !== -1) return; // Already on target model

            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            _isRoutingInProgress = true;
            console.log('[AG Autopilot] Smart Router: "' + currentModel.substring(0, 30) + '" -> ' + targetModel);

            selectModelInDropdown(targetModel, function (success) {
                setTimeout(function () {
                    _isRoutingInProgress = false;
                    emulateSendEvent(el);
                }, success ? 400 : 100);
            });
        }
    }, true);

    // =================================================================
    // QUOTA FALLBACK
    // =================================================================
    function findDismissButton() {
        // Only look inside notification/dialog containers — never in chat content
        var containers = document.querySelectorAll(
            '.notifications-toasts .notification-toast, .dialog-box, ' +
            '.notification-list-item'
        );
        for (var c = 0; c < containers.length; c++) {
            // Check if this container actually has quota-related text
            var containerText = (containers[c].innerText || '').toLowerCase();
            var isQuotaRelated = false;
            var strictPhrases = ['exhausted your capacity', 'quota will reset', 'baseline model quota reached'];
            for (var q = 0; q < strictPhrases.length; q++) {
                if (containerText.indexOf(strictPhrases[q]) !== -1) { isQuotaRelated = true; break; }
            }
            if (!isQuotaRelated) continue;

            // Found a quota error container — look for dismiss/close button inside it
            var btns = containers[c].querySelectorAll('button, a.action-label, [role="button"], .codicon-close, .codicon-notifications-clear');
            for (var b = 0; b < btns.length; b++) {
                if (btns[b].offsetParent !== null) return btns[b];
            }
        }
        return null;
    }

    // Strict quota detection — only match EXACT quota error phrases in notification containers
    // NEVER scan general chat content to avoid false positives
    var _quotaDetectedAt = 0;
    function isQuotaErrorVisible() {
        // Only check inside notification toasts and dialog boxes
        var containers = document.querySelectorAll(
            '.notifications-toasts .notification-toast, .notification-list-item, ' +
            '.dialog-box, .dialog-message'
        );
        if (containers.length === 0) return false;

        var strictPhrases = [
            'exhausted your capacity',
            'quota will reset',
            'baseline model quota reached',
            'exhausted your capacity on this model'
        ];

        for (var c = 0; c < containers.length; c++) {
            var t = (containers[c].innerText || '').toLowerCase();
            if (!t || t.length > 300) continue;
            for (var q = 0; q < strictPhrases.length; q++) {
                if (t.indexOf(strictPhrases[q]) !== -1) {
                    console.log('[AG Autopilot] Quota error found in notification: "' + t.substring(0, 80) + '"');
                    return true;
                }
            }
        }
        return false;
    }

    function getNextFallbackModel(currentModel) {
        var currentIdx = -1;
        for (var i = 0; i < FALLBACK_MODELS.length; i++) {
            if (currentModel.indexOf(FALLBACK_MODELS[i]) !== -1) { currentIdx = i; break; }
        }
        var nextIdx = (currentIdx + 1) % FALLBACK_MODELS.length;
        if (FALLBACK_MODELS[nextIdx] === FALLBACK_MODELS[currentIdx]) {
            nextIdx = (nextIdx + 1) % FALLBACK_MODELS.length;
        }
        return FALLBACK_MODELS[nextIdx];
    }

    var _quotaSwitchInProgress = false;

    function triggerSwitchSequence() {
        // Hard guards against repeated triggers
        if (_quotaSwitchInProgress) return;
        if (Date.now() - _modelSwitchingAt < 30000) return; // 30s cooldown (was 15s)
        _quotaSwitchInProgress = true;
        _modelSwitchingAt = Date.now();
        console.log('[AG Autopilot] Quota error detected! Starting switch sequence...');

        // Step 1: Dismiss the quota error notification
        var dismissBtn = findDismissButton();
        if (dismissBtn) {
            console.log('[AG Autopilot] Clicking dismiss button...');
            dismissBtn.click();
        }

        // Step 2: Wait for dismiss, verify error is gone, then switch model
        setTimeout(function () {
            // Try dismiss again
            var dismissBtn2 = findDismissButton();
            if (dismissBtn2) dismissBtn2.click();

            // Verify the error is actually dismissed before proceeding
            setTimeout(function () {
                if (isQuotaErrorVisible()) {
                    console.log('[AG Autopilot] Error still visible after dismiss, trying once more...');
                    var dismissBtn3 = findDismissButton();
                    if (dismissBtn3) dismissBtn3.click();
                }

                // Step 3: Switch model
                setTimeout(function () {
                    var selectorBtn = findModelSelectorButton();
                    if (!selectorBtn) {
                        console.log('[AG Autopilot] Model selector not found, aborting switch');
                        _quotaSwitchInProgress = false;
                        return;
                    }
                    var currentModel = (selectorBtn.innerText || selectorBtn.textContent || '').trim();
                    var targetModel = getNextFallbackModel(currentModel);
                    console.log('[AG Autopilot] Switching: "' + currentModel.substring(0, 30) + '" -> ' + targetModel);

                    selectModelInDropdown(targetModel, function (success) {
                        if (success) {
                            console.log('[AG Autopilot] Model switched OK, sending Continue in 2s...');
                            setTimeout(function () {
                                sendContinueMessage();
                                // Release lock after everything is done
                                setTimeout(function () { _quotaSwitchInProgress = false; }, 3000);
                            }, 2000);
                        } else {
                            console.log('[AG Autopilot] Failed to select model in dropdown');
                            _quotaSwitchInProgress = false;
                        }
                    });
                }, 500);
            }, 500);
        }, 1000);
    }

    function sendContinueMessage() {
        var inputArea = findChatTextarea();
        if (!inputArea) {
            console.log('[AG Autopilot] Cannot send Continue: no textarea found');
            return;
        }

        console.log('[AG Autopilot] Typing "Continue" into chat...');
        inputArea.focus();

        // Use native setter to bypass React controlled input
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(inputArea, 'Continue');
        } else {
            inputArea.value = 'Continue';
        }

        // Trigger React synthetic events
        inputArea.dispatchEvent(new Event('input', { bubbles: true }));
        inputArea.dispatchEvent(new Event('change', { bubbles: true }));
        try { inputArea.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Continue', inputType: 'insertText' })); } catch (e) {}

        // Wait for React to process, then send
        setTimeout(function () {
            _isRoutingInProgress = true;

            // Method 1: Full keyboard Enter sequence
            var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            inputArea.dispatchEvent(new KeyboardEvent('keydown', opts));
            inputArea.dispatchEvent(new KeyboardEvent('keypress', opts));
            inputArea.dispatchEvent(new KeyboardEvent('keyup', opts));

            // Method 2: Click Send button (fallback after 500ms)
            setTimeout(function () {
                var sendBtn = findSendButton();
                if (sendBtn) {
                    console.log('[AG Autopilot] Clicking Send button as fallback');
                    sendBtn.click();
                }
                setTimeout(function () { _isRoutingInProgress = false; }, 500);
            }, 500);
        }, 800);
    }

    // Quota observer — ONLY watch notification containers, not chat content
    (function initQuotaObserver() {
        // Watch the notifications area specifically
        var notifContainer = document.querySelector('.notifications-toasts') || document.querySelector('.notification-center');

        if (notifContainer) {
            var observer = new MutationObserver(function () {
                if (!window._agAutoEnabled || !window._agQuotaFallback) return;
                if (_quotaSwitchInProgress) return;
                if (Date.now() - _modelSwitchingAt < 30000) return;
                if (isQuotaErrorVisible()) {
                    triggerSwitchSequence();
                }
            });
            observer.observe(notifContainer, { childList: true, subtree: true });
            console.log('[AG Autopilot] Quota observer attached to notifications container');
        } else {
            // Fallback: watch body but with strict checks
            console.log('[AG Autopilot] Notifications container not found, using body fallback with strict checks');
            var bodyObserver = new MutationObserver(function (mutations) {
                if (!window._agAutoEnabled || !window._agQuotaFallback) return;
                if (_quotaSwitchInProgress) return;
                if (Date.now() - _modelSwitchingAt < 30000) return;

                // Only check if a notification-like element was added
                var hasNotification = false;
                for (var i = 0; i < mutations.length; i++) {
                    var added = mutations[i].addedNodes;
                    for (var j = 0; j < added.length; j++) {
                        var node = added[j];
                        if (node.nodeType !== 1) continue;
                        var cls = (node.className || '').toString().toLowerCase();
                        if (cls.indexOf('notification') !== -1 || cls.indexOf('dialog') !== -1 || cls.indexOf('toast') !== -1) {
                            hasNotification = true;
                            break;
                        }
                    }
                    if (hasNotification) break;
                }
                if (hasNotification && isQuotaErrorVisible()) {
                    triggerSwitchSequence();
                }
            });
            bodyObserver.observe(document.body, { childList: true, subtree: true });
        }
    })();

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

    var _agCachedPanel = null;
    var _agPanelCheckCount = 0;

    var autoScroll = setInterval(function () {
        if (!window._agAutoEnabled || !window._agScrollEnabled) return;
        // Re-query panel every 20 cycles (~10s) or if cached ref is detached
        if (!_agCachedPanel || !_agCachedPanel.isConnected || ++_agPanelCheckCount > 20) {
            _agCachedPanel = document.querySelector('.antigravity-agent-side-panel');
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

    console.log("[AG Autopilot] 🚀 Loaded | Auto Click & Scroll + Smart Router + Quota Fallback | Patterns:", JSON.stringify(CLICK_PATTERNS));
})();
