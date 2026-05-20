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
                
                // Let's find the radio option, click it, then click submit
                const clickScript = `
                    (() => {
                        const results = [];
                        
                        // Let's find all labels to see if any contains "Yes, allow this time"
                        const labels = document.querySelectorAll('label');
                        let foundRadio = false;
                        for (const label of labels) {
                            const text = (label.innerText || label.textContent || '').trim();
                            if (text.includes('Yes, allow this time')) {
                                console.log('Found "Yes, allow this time" option. Clicking it...');
                                results.push('Found "Yes, allow this time" label');
                                
                                // Click label and input
                                label.click();
                                const input = label.querySelector('input[type="radio"]') || document.getElementById(label.getAttribute('for'));
                                if (input) {
                                    input.checked = true;
                                    input.click();
                                    input.dispatchEvent(new Event('change', { bubbles: true }));
                                    results.push('Clicked radio input');
                                }
                                foundRadio = true;
                            }
                        }

                        // Try finding any radio input directly by ask-opt pattern
                        if (!foundRadio) {
                            const radios = document.querySelectorAll('input[type="radio"]');
                            for (const r of radios) {
                                if (r.id?.includes('ask-opt-') && r.value === '1') {
                                    r.checked = true;
                                    r.click();
                                    r.dispatchEvent(new Event('change', { bubbles: true }));
                                    results.push('Clicked radio by ID ask-opt');
                                }
                            }
                        }

                        // Now find the Submit button
                        const buttons = document.querySelectorAll('button');
                        let foundSubmit = false;
                        for (const btn of buttons) {
                            const text = (btn.innerText || btn.textContent || '').trim();
                            if (text.includes('Submit') || btn.getAttribute('data-tooltip-id')?.includes('P0-19')) {
                                console.log('Found Submit button! Clicking...');
                                btn.focus();
                                btn.click();
                                
                                // Dispatch custom click event
                                const clickEvent = new MouseEvent('click', {
                                    bubbles: true,
                                    cancelable: true,
                                    view: window
                                });
                                btn.dispatchEvent(clickEvent);
                                
                                results.push('Clicked Submit button');
                                foundSubmit = true;
                                break;
                            }
                        }

                        return {
                            success: foundSubmit,
                            steps: results
                        };
                    })()
                `;

                const evalResult = await send('Runtime.evaluate', {
                    expression: clickScript,
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
