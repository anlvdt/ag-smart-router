(function () {
    if (window._agModelSwitchLoaded) return;
    window._agModelSwitchLoaded = true;

    // --- CONFIGURATION ---
    const FALLBACK_MODELS = [
        "Claude Opus 4.6 (Thinking)",
        "Gemini 3.1 Pro (High)",
        "Gemini 3 Flash",
        "GPT-OSS 120B (Medium)"
    ];

    // SMART ROUTER HEURISTICS
    const TIER_CHEAP = "Gemini 3 Flash";
    const TIER_EXTREME = "Claude Opus 4.6 (Thinking)";
    const TIER_DEFAULT = "Gemini 3.1 Pro (High)";

    const REGEX_CHEAP = /(explain|giải thích|hỏi|comment|format|typo|spell|rename|lint|clean|tóm tắt|summary|translate)/i;
    const REGEX_EXTREME = /(architecture|kiến trúc|setup|mới|debug|refactor|complex|plan|structure|design|error|lỗi|build)/i;

    let _modelSwitchingAt = 0;
    let _isRoutingInProgress = false;

    // --- HELPERS ---
    function getChatPanel() {
        return document.querySelector('.antigravity-agent-side-panel') || document.body;
    }

    function findDismissButton() {
        const btns = document.querySelectorAll('button, a.action-label, [role="button"], .monaco-button');
        for (let btn of btns) {
            const text = (btn.innerText || '').trim();
            if (text === 'Dismiss') return btn;
        }
        return null;
    }

    function isQuotaErrorVisible() {
        const elements = document.querySelectorAll('span, div, p');
        for (let el of elements) {
            if (el.innerText && (
                el.innerText.includes('exhausted your capacity on this model') ||
                el.innerText.includes('Your quota will reset after') ||
                el.innerText.includes('Baseline model quota reached')
            )) {
                return true;
            }
        }
        return false;
    }

    function findModelSelectorButton(containsText = null) {
        const btns = document.querySelectorAll('.monaco-button, button, [role="button"]');
        for (let btn of btns) {
            const text = (btn.innerText || '').trim();
            if (containsText && text.includes(containsText)) return btn;
            for (let m of FALLBACK_MODELS) {
                if (text.includes(m)) return btn;
            }
        }
        return null;
    }

    function selectModelInDropdown(targetModel, callback) {
        const selectorBtn = findModelSelectorButton();
        if (!selectorBtn) {
            console.log(`[AG Auto Model] Model selector button not found!`);
            if (callback) callback(false);
            return;
        }

        selectorBtn.click();
        
        setTimeout(() => {
            const menuItems = document.querySelectorAll('.action-item, .action-label, [role="menuitem"]');
            let clicked = false;
            for (let item of menuItems) {
                if ((item.innerText || '').includes(targetModel)) {
                    item.click();
                    clicked = true;
                    break;
                }
            }
            
            if (!clicked) document.body.click(); // Recover if failed
            
            if (callback) callback(clicked);
        }, 300);
    }

    // --- FEATURE 1: SMART ROUTER (PRE-SEND) ---
    function evaluateTargetModel(promptText) {
        if (!promptText || promptText.trim() === '') return TIER_DEFAULT;
        
        // Priority 1: Length overrides
        if (promptText.length > 600) return TIER_EXTREME;
        if (promptText.length < 30) return TIER_CHEAP;
        
        // Priority 2: Keyword Regex
        if (REGEX_EXTREME.test(promptText)) return TIER_EXTREME;
        if (REGEX_CHEAP.test(promptText)) return TIER_CHEAP;

        return TIER_DEFAULT;
    }

    function emulateSendEvent(el) {
        console.log('[AG Auto Model] Re-dispatching Enter to send...');
        const evt = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
        el.dispatchEvent(evt);
    }

    document.addEventListener('keydown', (e) => {
        if (/*{{ENABLED}}*/true === false) return;
        if (_isRoutingInProgress) return; // Prevent loop

        // Intercept bare Enter (no Shift/Ctrl) on textarea
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            const el = e.target;
            if (el && el.tagName === 'TEXTAREA' && (el.classList.contains('chat-input') || el.closest('.antigravity-agent-side-panel'))) {
                const prompt = (el.value || '').trim();
                if (!prompt) return;

                const targetModel = evaluateTargetModel(prompt);
                
                const currentBtn = findModelSelectorButton();
                const currentModel = currentBtn ? currentBtn.innerText.trim() : '';

                if (currentModel && !currentModel.includes(targetModel)) {
                    console.log(`[AG Smart Router] Auto-routing prompt to ${targetModel} based on content heuristics...`);
                    
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    e.stopPropagation();

                    _isRoutingInProgress = true;

                    selectModelInDropdown(targetModel, (success) => {
                        if (success) {
                            console.log(`[AG Smart Router] Safely switched to ${targetModel}`);
                            // Allow UI to update before sending
                            setTimeout(() => {
                                _isRoutingInProgress = false;
                                emulateSendEvent(el);
                            }, 300);
                        } else {
                            console.log(`[AG Smart Router] Failed to switch, proceeding with current model.`);
                            _isRoutingInProgress = false;
                            emulateSendEvent(el);
                        }
                    });
                }
            }
        }
    }, true); // useCapture to intercept React's bubbling

    // --- FEATURE 2: QUOTA FALLBACK RECOVERY ---
    function triggerSwitchSequence() {
        if (Date.now() - _modelSwitchingAt < 15000) return; // Debounce 15s
        _modelSwitchingAt = Date.now();
        console.log('[AG Auto Model] Quota error detected! Initiating model switch...');

        const dismissBtn = findDismissButton();
        if (dismissBtn) dismissBtn.click();

        setTimeout(() => {
            const selectorBtn = findModelSelectorButton();
            let currentModel = selectorBtn ? selectorBtn.innerText.trim() : "";
            
            let targetModel = FALLBACK_MODELS[0];
            let foundCurrent = false;
            for (let m of FALLBACK_MODELS) {
                if (foundCurrent) { targetModel = m; break; }
                if (currentModel.includes(m)) foundCurrent = true;
            }
            if (targetModel === currentModel) {
                const idx = FALLBACK_MODELS.indexOf(targetModel);
                targetModel = FALLBACK_MODELS[(idx + 1) % FALLBACK_MODELS.length] || FALLBACK_MODELS[0];
            }

            console.log(`[AG Auto Model] Quota recovery: Switching to "${targetModel}"`);

            selectModelInDropdown(targetModel, (success) => {
                if (success) setTimeout(sendContinueMessage, 1500);
            });
        }, 300);
    }

    function sendContinueMessage() {
        console.log('[AG Auto Model] Sending "Continue" message...');
        let inputArea = document.querySelector('textarea, [contenteditable="true"]');
        const textareas = document.querySelectorAll('textarea');
        for (let ta of textareas) {
            if(ta.closest && (ta.closest('.antigravity-agent-side-panel') || ta.classList.contains('chat-input'))) {
                inputArea = ta; break;
            }
        }

        if (inputArea) {
            inputArea.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            if (nativeSetter) nativeSetter.call(inputArea, 'Continue');
            else inputArea.value = 'Continue';
            
            inputArea.dispatchEvent(new Event('input', { bubbles: true }));
            inputArea.dispatchEvent(new Event('change', { bubbles: true }));

            setTimeout(() => {
                _isRoutingInProgress = true; // Temporary bypass smart router
                inputArea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, keyCode: 13, key: 'Enter' }));
                
                setTimeout(() => { _isRoutingInProgress = false; }, 500);
            }, 500);
        }
    }

    const panel = getChatPanel();
    if (panel) {
        const observer = new MutationObserver((mutations) => {
            if (/*{{ENABLED}}*/true === false) return;
            if (Date.now() - _modelSwitchingAt < 15000) return; 

            for (let m of mutations) {
                if (m.type === 'childList') {
                    if (isQuotaErrorVisible()) {
                        triggerSwitchSequence();
                        break;
                    }
                }
            }
        });

        observer.observe(panel, { childList: true, subtree: true, characterData: true });
        console.log('[AG Auto Model] Smart Router & Quota Observer loaded! (v2.0.0)');
    }
})();
