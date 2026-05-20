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
        return;
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

            try {
                await send('Target.setDiscoverTargets', { discover: true });
                const { targetInfos } = await send('Target.getTargets');
                
                const mainTarget = targetInfos.find(t => t.url && t.url.includes('workbench.html'));
                if (!mainTarget) {
                    console.log('Main workbench target not found.');
                    ws.close();
                    return;
                }

                console.log(`Attaching to main workbench: ${mainTarget.targetId}`);
                const { sessionId } = await send('Target.attachToTarget', { targetId: mainTarget.targetId, flatten: true });
                
                const deepClickScript = `
                    (() => {
                        const logs = [];
                        let radioClicked = false;
                        let submitClicked = false;

                        function searchAndInteract(root) {
                            if (!root) return;

                            // Search all elements in the current root
                            const elements = root.querySelectorAll('*');
                            for (const el of elements) {
                                // 1. Check for the "Yes, allow this time" radio button or label
                                if (!radioClicked) {
                                    const text = (el.innerText || el.textContent || '').trim();
                                    if (el.tagName === 'LABEL' && text.includes('Yes, allow this time')) {
                                        logs.push('Found "Yes, allow this time" label. Clicking label...');
                                        el.click();
                                        const radio = el.querySelector('input[type="radio"]') || document.getElementById(el.getAttribute('for'));
                                        if (radio) {
                                            radio.checked = true;
                                            radio.click();
                                            radio.dispatchEvent(new Event('change', { bubbles: true }));
                                            logs.push('Checked and clicked inner radio button.');
                                        }
                                        radioClicked = true;
                                    } else if (el.tagName === 'INPUT' && el.type === 'radio' && (el.id?.includes('ask-opt-') || el.value === '1')) {
                                        logs.push('Found radio input directly: ' + el.id + '. Clicking...');
                                        el.checked = true;
                                        el.click();
                                        el.dispatchEvent(new Event('change', { bubbles: true }));
                                        radioClicked = true;
                                    }
                                }

                                // 2. Check for the Submit button
                                if (!submitClicked) {
                                    const text = (el.innerText || el.textContent || '').trim();
                                    if (el.tagName === 'BUTTON' && (text.includes('Submit') || el.getAttribute('data-tooltip-id') === 'P0-19' || el.className?.includes('bg-accent'))) {
                                        logs.push('Found Submit button! text="' + text + '", tooltip="' + el.getAttribute('data-tooltip-id') + '". Clicking...');
                                        el.focus();
                                        el.click();
                                        
                                        // Dispatch custom MouseEvent click
                                        const clickEvent = new MouseEvent('click', {
                                            bubbles: true,
                                            cancelable: true,
                                            view: window
                                        });
                                        el.dispatchEvent(clickEvent);
                                        
                                        submitClicked = true;
                                    }
                                }

                                // Recursively search shadow DOM of this element if present
                                if (el.shadowRoot) {
                                    searchAndInteract(el.shadowRoot);
                                }
                            }

                            // Recursively search nested iframes in this document context
                            const iframes = root.querySelectorAll('iframe');
                            for (const iframe of iframes) {
                                try {
                                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                                    searchAndInteract(iframeDoc);
                                } catch (e) {
                                    logs.push('Failed to access iframe: ' + e.message);
                                }
                            }
                        }

                        searchAndInteract(document);

                        return {
                            radioClicked,
                            submitClicked,
                            logs
                        };
                    })()
                `;

                const evalResult = await send('Runtime.evaluate', {
                    expression: deepClickScript,
                    returnByValue: true,
                    awaitPromise: true
                }, sessionId);

                console.log('Result:', JSON.stringify(evalResult.result.value, null, 2));

            } catch (e) {
                console.error('Error during execution:', e);
            }
            ws.close();
        });
        ws.on('error', (err) => {
            console.error('WS error:', err.message);
        });
    } catch (e) {
        console.error('Main error:', e.message);
    }
}

main();
