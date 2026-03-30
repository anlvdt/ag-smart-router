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
        "Claude Sonnet 4.5",
        "Gemini 3.1 Pro (High)",
        "Gemini 3.1 Pro",
        "Gemini 3 Flash",
        "GPT-OSS 120B (Medium)",
        "GPT-OSS 120B"
    ];
    // Unique model families for matching (partial match)
    var MODEL_KEYWORDS = ["Claude", "Gemini", "GPT", "Opus", "Sonnet", "Flash"];

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
                    console.log('[AG Autopilot] 🔍 Found model selector (exact): "' + text.substring(0, 50) + '"');
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
                    console.log('[AG Autopilot] 🔍 Found model selector (keyword): "' + text.substring(0, 50) + '"');
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

        console.log('[AG Autopilot] ⚠️ Model selector not found');
        return null;
    }

    function selectModelInDropdown(targetModel, callback) {
        var selectorBtn = findModelSelectorButton();
        if (!selectorBtn) {
            console.log('[AG Autopilot] ❌ Cannot switch model: selector not found');
            if (callback) callback(false);
            return;
        }

        console.log('[AG Autopilot] 🖱️ Clicking model selector...');
        selectorBtn.click();

        // Wait for dropdown to appear, then search for target model
        var attempts = 0;
        var maxAttempts = 10;
        var searchInterval = setInterval(function () {
            attempts++;

            // Search in multiple possible dropdown containers
            var menuItems = document.querySelectorAll(
                '[role="menuitem"], [role="option"], [role="listbox"] > *, ' +
                '.action-item, .action-label, .monaco-list-row, ' +
                '.quick-input-list .monaco-list-row, ' +
                '[class*="dropdown"] li, [class*="dropdown"] [role="option"], ' +
                '[class*="menu"] [role="menuitem"], ' +
                '.context-view [role="menuitem"], .context-view .action-label'
            );

            var clicked = false;
            for (var i = 0; i < menuItems.length; i++) {
                var itemText = (menuItems[i].innerText || menuItems[i].textContent || '').trim();
                if (itemText.indexOf(targetModel) !== -1) {
                    console.log('[AG Autopilot] ✅ Found model in dropdown: "' + itemText.substring(0, 50) + '"');
                    menuItems[i].click();
                    clicked = true;
                    break;
                }
            }

            if (clicked || attempts >= maxAttempts) {
                clearInterval(searchInterval);
                if (!clicked) {
                    // Try partial match as last resort
                    var shortName = targetModel.split(' ')[0] + ' ' + (targetModel.split(' ')[1] || '');
                    for (var i = 0; i < menuItems.length; i++) {
                        var itemText = (menuItems[i].innerText || menuItems[i].textContent || '').trim();
                        if (itemText.indexOf(shortName) !== -1) {
                            menuItems[i].click();
                            clicked = true;
                            console.log('[AG Autopilot] ✅ Found model (partial): "' + itemText.substring(0, 50) + '"');
                            break;
                        }
                    }
                    if (!clicked) {
                        console.log('[AG Autopilot] ❌ Model "' + targetModel + '" not found in dropdown (' + menuItems.length + ' items scanned)');
                        document.body.click(); // Close dropdown
                    }
                }
                if (callback) callback(clicked);
            }
        }, 150);
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
    document.addEventListener('keydown', function (e) {
        if (!window._agAutoEnabled || !window._agSmartRouter) return;
        if (_isRoutingInProgress) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            var el = e.target;
            // Accept any textarea that looks like a chat input
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
            var currentModel = currentBtn ? (currentBtn.innerText || currentBtn.textContent || '').trim() : '';

            if (!currentModel) {
                console.log('[AG Autopilot] 🧠 Smart Router: no current model detected, skipping');
                return;
            }

            if (currentModel.indexOf(targetModel) === -1) {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                _isRoutingInProgress = true;
                console.log('[AG Autopilot] 🧠 Smart Router: "' + currentModel.substring(0, 30) + '" → ' + targetModel);

                selectModelInDropdown(targetModel, function (success) {
                    setTimeout(function () {
                        _isRoutingInProgress = false;
                        emulateSendEvent(el);
                    }, success ? 400 : 100);
                });
            }
        }
    }, true);

    // =================================================================
    // QUOTA FALLBACK (from ag-auto-model-switch)
    // =================================================================
    function findDismissButton() {
        // Strategy 1: Text-based search
        var btns = document.querySelectorAll('button, a.action-label, [role="button"], .monaco-button');
        for (var i = 0; i < btns.length; i++) {
            var text = (btns[i].innerText || btns[i].textContent || '').trim().toLowerCase();
            if (text === 'dismiss' || text === 'ok' || text === 'close' || text === 'got it' || text === 'đóng') {
                if (btns[i].offsetParent !== null) return btns[i];
            }
        }
        // Strategy 2: Close icon buttons ONLY inside notification/dialog areas
        var errorContainers = document.querySelectorAll(
            '.notifications-toasts, .notification-toast, .dialog-box, ' +
            '[class*="notification"], [class*="dialog"], [class*="error-widget"], [class*="message-widget"]'
        );
        for (var c = 0; c < errorContainers.length; c++) {
            var closeBtn = errorContainers[c].querySelector(
                '.codicon-close, .codicon-notifications-clear, ' +
                '[aria-label="Close"], [aria-label="Dismiss"], .action-label'
            );
            if (closeBtn && closeBtn.offsetParent !== null) return closeBtn;
        }
        return null;
    }

    function isQuotaErrorVisible() {
        var elements = document.querySelectorAll('span, div, p, [class*="message"], [class*="error"], [class*="notification"]');
        var quotaPhrases = [
            'exhausted your capacity',
            'quota will reset',
            'quota reached',
            'rate limit',
            'too many requests',
            'capacity on this model',
            'model quota'
        ];
        var quotaRegexes = [
            /exceeded\s.*quota/i,
            /limit\s.*reached/i
        ];
        for (var i = 0; i < elements.length; i++) {
            var t = (elements[i].innerText || '').toLowerCase();
            if (!t || t.length > 500) continue;
            for (var q = 0; q < quotaPhrases.length; q++) {
                if (t.indexOf(quotaPhrases[q]) !== -1) return true;
            }
            for (var r = 0; r < quotaRegexes.length; r++) {
                if (quotaRegexes[r].test(t)) return true;
            }
        }
        return false;
    }

    function getNextFallbackModel(currentModel) {
        // Find current model in fallback list and return next one
        var currentIdx = -1;
        for (var i = 0; i < FALLBACK_MODELS.length; i++) {
            if (currentModel.indexOf(FALLBACK_MODELS[i]) !== -1) {
                currentIdx = i;
                break;
            }
        }
        // Return next model in rotation
        var nextIdx = (currentIdx + 1) % FALLBACK_MODELS.length;
        // Skip if same as current (shouldn't happen but safety check)
        if (FALLBACK_MODELS[nextIdx] === FALLBACK_MODELS[currentIdx]) {
            nextIdx = (nextIdx + 1) % FALLBACK_MODELS.length;
        }
        return FALLBACK_MODELS[nextIdx];
    }

    function triggerSwitchSequence() {
        if (Date.now() - _modelSwitchingAt < 15000) return;
        _modelSwitchingAt = Date.now();
        console.log('[AG Autopilot] 🔄 Quota error detected! Initiating model switch...');

        // Step 1: Dismiss error dialog
        var dismissBtn = findDismissButton();
        if (dismissBtn) {
            console.log('[AG Autopilot] 🔄 Dismissing error dialog...');
            dismissBtn.click();
        }

        // Step 2: Wait for dismiss animation, then switch model
        setTimeout(function () {
            // Try dismiss again in case first attempt missed
            var dismissBtn2 = findDismissButton();
            if (dismissBtn2) dismissBtn2.click();

            setTimeout(function () {
                var selectorBtn = findModelSelectorButton();
                var currentModel = selectorBtn ? (selectorBtn.innerText || selectorBtn.textContent || '').trim() : '';
                var targetModel = getNextFallbackModel(currentModel);

                console.log('[AG Autopilot] 🔄 Quota fallback: "' + currentModel.substring(0, 30) + '" → ' + targetModel);

                selectModelInDropdown(targetModel, function (success) {
                    if (success) {
                        console.log('[AG Autopilot] ✅ Model switched, sending Continue in 2s...');
                        setTimeout(sendContinueMessage, 2000);
                    } else {
                        console.log('[AG Autopilot] ❌ Failed to switch model, trying Continue anyway...');
                        setTimeout(sendContinueMessage, 2000);
                    }
                });
            }, 500);
        }, 800);
    }

    function sendContinueMessage() {
        var inputArea = findChatTextarea();
        if (!inputArea) {
            console.log('[AG Autopilot] ❌ Cannot send Continue: no textarea found');
            return;
        }

        console.log('[AG Autopilot] 📤 Typing "Continue" into chat...');
        inputArea.focus();

        // Use native setter to bypass React controlled input
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(inputArea, 'Continue');
        } else {
            inputArea.value = 'Continue';
        }

        // Trigger React's synthetic events
        inputArea.dispatchEvent(new Event('input', { bubbles: true }));
        inputArea.dispatchEvent(new Event('change', { bubbles: true }));
        // Also trigger React 18+ compatible events
        inputArea.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Continue', inputType: 'insertText' }));

        // Wait for React to process the input, then send
        setTimeout(function () {
            _isRoutingInProgress = true; // Bypass smart router for this send

            // Method 1: Keyboard Enter event
            var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            inputArea.dispatchEvent(new KeyboardEvent('keydown', opts));
            inputArea.dispatchEvent(new KeyboardEvent('keypress', opts));
            inputArea.dispatchEvent(new KeyboardEvent('keyup', opts));

            // Method 2: Click Send button (fallback, 300ms later)
            setTimeout(function () {
                var sendBtn = findSendButton();
                if (sendBtn) {
                    console.log('[AG Autopilot] 📤 Clicking Send button');
                    sendBtn.click();
                }
                setTimeout(function () { _isRoutingInProgress = false; }, 300);
            }, 300);
        }, 600);
    }

    // Quota observer — watch for error messages appearing
    var _quotaObserverTarget = document.querySelector('.antigravity-agent-side-panel') || document.body;
    var quotaObserver = new MutationObserver(function (mutations) {
        if (!window._agAutoEnabled || !window._agQuotaFallback) return;
        if (Date.now() - _modelSwitchingAt < 15000) return;
        // Only check on childList changes (new elements added)
        var hasNewNodes = false;
        for (var i = 0; i < mutations.length; i++) {
            if (mutations[i].addedNodes && mutations[i].addedNodes.length > 0) {
                hasNewNodes = true;
                break;
            }
        }
        if (hasNewNodes && isQuotaErrorVisible()) {
            triggerSwitchSequence();
        }
    });
    quotaObserver.observe(_quotaObserverTarget, { childList: true, subtree: true });

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

    console.log("[AG Autopilot] 🚀 Loaded | Auto Click & Scroll + Smart Router + Quota Fallback | Patterns:", JSON.stringify(CLICK_PATTERNS));
})();
