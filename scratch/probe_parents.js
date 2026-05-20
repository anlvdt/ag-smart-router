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
                    console.error('Main Grav target not found!');
                    ws.close();
                    return;
                }

                const { sessionId } = await send('Target.attachToTarget', { targetId: mainTarget.targetId, flatten: true });

                const scriptToEvaluate = `
                    (() => {
                        const results = [];
                        const btns = document.querySelectorAll('button, [role="button"], a');
                        btns.forEach(btn => {
                            const text = (btn.innerText || btn.textContent || '').trim().replace(/\\n/g, ' ');
                            if (text.includes('Cancel') || text.includes('Review') || text.includes('Submit') || text.includes('Approve')) {
                                const parentChain = [];
                                let curr = btn.parentElement;
                                while (curr) {
                                    parentChain.push({
                                        tagName: curr.tagName,
                                        id: curr.id,
                                        className: curr.className
                                    });
                                    curr = curr.parentElement;
                                }
                                results.push({
                                    text: text.substring(0, 100),
                                    tagName: btn.tagName,
                                    className: btn.className,
                                    parentChain: parentChain.slice(0, 25) // Get up to 25 levels
                                });
                            }
                        });
                        return results;
                    })()
                `;

                const evalResult = await send('Runtime.evaluate', {
                    expression: scriptToEvaluate,
                    returnByValue: true,
                    awaitPromise: true
                }, sessionId);

                console.log(JSON.stringify(evalResult.result.value, null, 2));

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
