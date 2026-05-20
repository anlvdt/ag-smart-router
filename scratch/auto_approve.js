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
                console.log('Auto-approve daemon started. Polling targets every 500ms...');

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

                            const evalScript = `
                                (() => {
                                    let clicked = false;
                                    const logs = [];

                                    function search(root) {
                                        if (!root) return;

                                        const elements = root.querySelectorAll('*');
                                        for (const el of elements) {
                                            // Look for 'Yes, allow this time' radio options
                                            if (el.tagName === 'LABEL' && el.textContent.includes('Yes, allow this time')) {
                                                el.click();
                                                const radio = el.querySelector('input[type="radio"]') || document.getElementById(el.getAttribute('for'));
                                                if (radio && !radio.checked) {
                                                    radio.checked = true;
                                                    radio.click();
                                                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                                                    logs.push('Selected "Yes, allow this time" radio.');
                                                }
                                            }

                                            // Look for 'Submit' button matching data-tooltip-id="P0-19"
                                            if (el.tagName === 'BUTTON' && (el.getAttribute('data-tooltip-id') === 'P0-19' || el.innerText.includes('Submit'))) {
                                                if (el.disabled) {
                                                    el.removeAttribute('disabled');
                                                    el.disabled = false;
                                                }
                                                el.focus();
                                                el.click();

                                                const clickEvent = new MouseEvent('click', {
                                                    bubbles: true,
                                                    cancelable: true,
                                                    view: window
                                                });
                                                el.dispatchEvent(clickEvent);
                                                clicked = true;
                                                logs.push('Clicked Submit button.');
                                            }

                                            if (el.shadowRoot) {
                                                search(el.shadowRoot);
                                            }
                                        }

                                        const iframes = root.querySelectorAll('iframe');
                                        for (const iframe of iframes) {
                                            try {
                                                const doc = iframe.contentDocument || iframe.contentWindow.document;
                                                search(doc);
                                            } catch (e) {}
                                        }
                                    }

                                    search(document);
                                    return { clicked, logs };
                                })()
                            `;

                            try {
                                const evalResult = await send('Runtime.evaluate', {
                                    expression: evalScript,
                                    returnByValue: true,
                                    awaitPromise: true
                                }, sessionId);

                                const res = evalResult.result.value;
                                if (res && res.clicked) {
                                    console.log(`[Auto-Approved] Successfully clicked Submit in target ${target.title || target.targetId}`);
                                    res.logs.forEach(log => console.log('  ' + log));
                                }
                            } catch (e) {
                                // Ignore eval errors during background poll
                            }

                            await send('Target.detachFromTarget', { sessionId }).catch(() => {});
                        }
                    } catch (e) {
                        // Ignore general poll errors
                    }
                }, 500);

            } catch (e) {
                console.error('Error during execution:', e);
                ws.close();
            }
        });
    } catch (e) {
        console.error('Main error:', e.message);
    }
}

main();
