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
                // Enable target discovery
                await send('Target.setDiscoverTargets', { discover: true });
                const { targetInfos } = await send('Target.getTargets');
                console.log(`Found ${targetInfos.length} targets.`);

                let clicked = false;

                // Process all page and iframe targets
                for (const target of targetInfos) {
                    if (target.type !== 'page' && target.type !== 'iframe') continue;
                    
                    console.log(`Examining target: ${target.targetId} | Title: "${target.title}" | URL: ${target.url}`);
                    
                    let sessionId;
                    try {
                        const attachResult = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                        sessionId = attachResult.sessionId;
                    } catch (e) {
                        console.error(`  Failed to attach: ${e.message}`);
                        continue;
                    }

                    // Look for the Submit button and 'Yes, allow this time' option inside this target (and nested iframes)
                    const evalScript = `
                        (() => {
                            function findAndClick(doc) {
                                if (!doc) return false;

                                // Look for the 'Yes, allow this time' radio option
                                const labels = doc.querySelectorAll('label');
                                let foundRadio = false;
                                for (const label of labels) {
                                    const text = (label.innerText || label.textContent || '').trim();
                                    if (text.includes('Yes, allow this time')) {
                                        console.log('Found "Yes, allow this time" option. Attempting to click...');
                                        const input = label.querySelector('input[type="radio"]') || doc.getElementById(label.getAttribute('for'));
                                        if (input) {
                                            input.checked = true;
                                            input.click();
                                            input.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                        label.click();
                                        foundRadio = true;
                                    }
                                }

                                // Also try to find inputs directly by ID/value if label query wasn't enough
                                const radios = doc.querySelectorAll('input[type="radio"]');
                                for (const radio of radios) {
                                    if (radio.value === '1' || radio.id?.includes('ask-opt-')) {
                                        console.log('Found radio input by ID/value. Selecting...');
                                        radio.checked = true;
                                        radio.click();
                                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                                        foundRadio = true;
                                    }
                                }

                                // Look for the Submit button
                                const buttons = doc.querySelectorAll('button');
                                for (const btn of buttons) {
                                    const text = (btn.innerText || btn.textContent || '').trim();
                                    if (text.includes('Submit') || btn.getAttribute('data-tooltip-id')?.includes('P0-19')) {
                                        console.log('Found Submit button! Attempting to click...');
                                        
                                        // Focus first
                                        btn.focus();
                                        
                                        // Click using standard click
                                        btn.click();
                                        
                                        // Dispatch click events for React/custom handlers
                                        const clickEvent = new MouseEvent('click', {
                                            bubbles: true,
                                            cancelable: true,
                                            view: window
                                        });
                                        btn.dispatchEvent(clickEvent);
                                        
                                        return true;
                                    }
                                }

                                // Check nested iframes
                                const iframes = doc.querySelectorAll('iframe');
                                for (const iframe of iframes) {
                                    try {
                                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                                        if (findAndClick(iframeDoc)) {
                                            return true;
                                        }
                                    } catch (e) {}
                                }

                                return false;
                            }

                            return findAndClick(document);
                        })()
                    `;

                    try {
                        const evalResult = await send('Runtime.evaluate', {
                            expression: evalScript,
                            returnByValue: true,
                            awaitPromise: true
                        }, sessionId);

                        if (evalResult.result.value) {
                            console.log(`  >>> CLICKED SUBMIT BUTTON IN TARGET: ${target.targetId}! <<<`);
                            clicked = true;
                        }
                    } catch (e) {
                        console.error(`  Failed to evaluate in target ${target.targetId}: ${e.message}`);
                    }

                    // Detach from target to keep connection clean
                    await send('Target.detachFromTarget', { sessionId }).catch(() => {});
                }

                if (!clicked) {
                    console.log('Submit button not found in any of the current targets.');
                }

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
