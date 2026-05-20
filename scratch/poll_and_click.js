'use strict';
const http = require('http');
const WebSocket = require('ws');

const CDP_PORTS = [9333, 9222, 9229, 9230, 9234, 9235, 9236];

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function main() {
    let port = 0;
    for (const p of CDP_PORTS) {
        try {
            const res = await httpGet(`http://127.0.0.1:${p}/json/version`);
            if (res && res.includes('webSocketDebuggerUrl')) {
                port = p;
                break;
            }
        } catch (_) {}
    }

    if (!port) {
        console.error('No active CDP port found!');
        process.exit(1);
    }

    try {
        const versionInfo = await httpGet(`http://127.0.0.1:${port}/json/version`);
        const parsed = JSON.parse(versionInfo);
        const wsUrl = parsed.webSocketDebuggerUrl;
        console.log(`Connecting to: ${wsUrl}`);

        const ws = new WebSocket(wsUrl);
        ws.on('open', async () => {
            let msgId = 0;
            const send = (method, params = {}, sessionId = undefined) => {
                return new Promise((resolve, reject) => {
                    const id = ++msgId;
                    const payload = { id, method, params };
                    if (sessionId) payload.sessionId = sessionId;
                    ws.send(JSON.stringify(payload));
                    const listener = (data) => {
                        const msg = JSON.parse(data.toString());
                        if (msg.id === id) {
                            ws.off('message', listener);
                            if (msg.error) reject(new Error(msg.error.message));
                            else resolve(msg.result);
                        }
                    };
                    ws.on('message', listener);
                });
            };

            // Keep track of active sessions to enable console logging
            const activeSessions = new Set();

            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.method === 'Runtime.consoleAPICalled') {
                    const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
                    console.log(`[Browser Console] ${args}`);
                }
            });

            try {
                await send('Target.setDiscoverTargets', { discover: true });
                console.log('Event-driven daemon started using MutationObserver (Layer 1).');

                setInterval(async () => {
                    try {
                        const { targetInfos } = await send('Target.getTargets');
                        
                        for (const target of targetInfos) {
                            if (target.type !== 'page' && target.type !== 'iframe') continue;
                            
                            let sessionId;
                            try {
                                const attachResult = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                                sessionId = attachResult.sessionId;
                            } catch (e) {
                                continue;
                            }

                            if (!activeSessions.has(sessionId)) {
                                activeSessions.add(sessionId);
                                await send('Runtime.enable', {}, sessionId).catch(() => {});
                            }

                            // Inject event-driven MutationObserver
                            const injectObserverScript = `
                                (() => {
                                    if (window.__hasAntigravityObserver) {
                                        return 'ALREADY_INSTALLED';
                                    }
                                    window.__hasAntigravityObserver = true;

                                    const clickedElements = new WeakSet();

                                    function clickElement(el, type) {
                                        if (clickedElements.has(el)) return false;
                                        clickedElements.add(el);
                                        console.log('Clicking: ' + type);
                                        el.focus();
                                        el.click();
                                        
                                        const events = ['mousedown', 'mouseup', 'click'];
                                        for (const evType of events) {
                                            const ev = new MouseEvent(evType, {
                                                bubbles: true,
                                                cancelable: true,
                                                view: window
                                            });
                                            el.dispatchEvent(ev);
                                        }
                                        return true;
                                    }

                                    function checkAndClick(root) {
                                        if (!root) return;
                                        const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
                                        for (const el of elements) {
                                            const text = (el.innerText || el.textContent || '').trim();

                                            // 1. Accept all span button
                                            if (text.includes('Accept all') && (el.tagName === 'SPAN' || el.className?.includes('cursor-pointer'))) {
                                                clickElement(el, 'Accept all');
                                            }

                                            // 2. Radio button
                                            if (el.tagName === 'LABEL' && text.includes('Yes, allow this time')) {
                                                console.log('Selecting: Yes label');
                                                el.click();
                                                const radio = el.querySelector('input[type="radio"]') || document.getElementById(el.getAttribute('for'));
                                                if (radio) {
                                                    radio.checked = true;
                                                    radio.click();
                                                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                                                }
                                            } else if (el.tagName === 'INPUT' && el.type === 'radio' && (el.id?.includes('ask-opt-') || el.value === '1')) {
                                                if (!el.checked) {
                                                    console.log('Selecting: Radio input');
                                                    el.checked = true;
                                                    el.click();
                                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                                }
                                            }

                                            // 3. Submit button
                                            if (el.tagName === 'BUTTON' && (text.includes('Submit') || el.getAttribute('data-tooltip-id') === 'P0-19' || el.className?.includes('bg-accent'))) {
                                                clickElement(el, 'Submit button');
                                            }

                                            if (el.shadowRoot) {
                                                observeRoot(el.shadowRoot);
                                                checkAndClick(el.shadowRoot);
                                            }
                                        }
                                    }

                                    const observedRoots = new WeakSet();
                                    const observer = new MutationObserver((mutations) => {
                                        for (const mutation of mutations) {
                                            for (const node of mutation.addedNodes) {
                                                if (node.nodeType === Node.ELEMENT_NODE) {
                                                    checkAndClick(node);
                                                    if (node.shadowRoot) {
                                                        observeRoot(node.shadowRoot);
                                                        checkAndClick(node.shadowRoot);
                                                    }
                                                }
                                            }
                                        }
                                    });

                                    function observeRoot(root) {
                                        if (observedRoots.has(root)) return;
                                        observedRoots.add(root);
                                        observer.observe(root, { childList: true, subtree: true });
                                        
                                        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
                                        let node;
                                        while (node = walker.nextNode()) {
                                            if (node.shadowRoot) {
                                                observeRoot(node.shadowRoot);
                                                checkAndClick(node.shadowRoot);
                                            }
                                        }
                                    }

                                    observeRoot(document.documentElement);
                                    checkAndClick(document.documentElement);
                                    
                                    console.log('Antigravity MutationObserver installed successfully (Layer 1).');
                                    return 'INSTALLED';
                                })()
                            `;

                            await send('Runtime.evaluate', {
                                expression: injectObserverScript,
                                returnByValue: true,
                                awaitPromise: true
                            }, sessionId).catch(() => {});

                            await send('Target.detachFromTarget', { sessionId }).catch(() => {});
                        }
                    } catch (e) {
                        // Ignore errors
                    }
                }, 2000); // Only check session integrity every 2 seconds (minimal overhead)

            } catch (e) {
                console.error('Error during execution:', e);
                ws.close();
            }
        });
        ws.on('error', (err) => {
            console.error('WS error:', err.message);
        });
    } catch (e) {
        console.error('Main error:', e.message);
    }
}

main();
