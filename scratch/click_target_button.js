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
                console.log(`Found ${targetInfos.length} targets.`);

                let clicked = false;

                for (const target of targetInfos) {
                    if (target.type !== 'page' && target.type !== 'iframe') continue;
                    
                    console.log(`Checking target: ${target.targetId} - ${target.title}`);
                    let sessionId;
                    try {
                        const attachResult = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                        sessionId = attachResult.sessionId;
                    } catch (e) {
                        continue;
                    }

                    const clickScript = `
                        (() => {
                            const logs = [];
                            let found = false;

                            function search(root, path = 'document') {
                                if (!root) return;

                                // Check elements in current root
                                const elements = root.querySelectorAll('*');
                                for (const el of elements) {
                                    if (el.tagName === 'BUTTON' && (el.getAttribute('data-tooltip-id') === 'P0-19' || (el.innerText || el.textContent || '').includes('Submit'))) {
                                        logs.push('Found Submit button at: ' + path + ' -> ' + el.tagName + ' [disabled=' + el.disabled + ']');
                                        
                                        // Enable if disabled
                                        if (el.disabled) {
                                            el.removeAttribute('disabled');
                                            el.disabled = false;
                                            logs.push('Removed disabled attribute');
                                        }
                                        
                                        // Focus and click
                                        el.focus();
                                        el.click();

                                        const clickEvent = new MouseEvent('click', {
                                            bubbles: true,
                                            cancelable: true,
                                            view: window
                                        });
                                        el.dispatchEvent(clickEvent);
                                        logs.push('Dispatched click event');
                                        found = true;
                                    }

                                    if (el.shadowRoot) {
                                        search(el.shadowRoot, path + ' -> shadowRoot(' + el.tagName + ')');
                                    }
                                }

                                // Check iframes
                                const iframes = root.querySelectorAll('iframe');
                                for (const iframe of iframes) {
                                    try {
                                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                                        search(doc, path + ' -> iframe(' + iframe.id + ')');
                                    } catch (e) {
                                        logs.push('Iframe security error: ' + e.message);
                                    }
                                }
                            }

                            search(document);
                            return { found, logs };
                        })()
                    `;

                    try {
                        const evalResult = await send('Runtime.evaluate', {
                            expression: clickScript,
                            returnByValue: true,
                            awaitPromise: true
                        }, sessionId);

                        const res = evalResult.result.value;
                        if (res) {
                            res.logs.forEach(log => console.log('  ' + log));
                            if (res.found) {
                                console.log(`>>> Success in target: ${target.targetId} <<<`);
                                clicked = true;
                            }
                        }
                    } catch (e) {
                        console.error('  Eval error:', e.message);
                    }

                    await send('Target.detachFromTarget', { sessionId }).catch(() => {});
                }

                if (!clicked) {
                    console.log('Submit button not found.');
                }

            } catch (e) {
                console.error('Execution error:', e);
            }
            ws.close();
        });
    } catch (e) {
        console.error('Error:', e.message);
    }
}

main();
