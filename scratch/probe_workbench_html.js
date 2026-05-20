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
                
                const evalResult = await send('Runtime.evaluate', {
                    expression: `
                        (() => {
                            const results = [];
                            
                            function traverse(doc, path = 'top') {
                                if (!doc) return;
                                
                                // Search all elements containing text
                                const elements = doc.querySelectorAll('button, [role="button"], a, input, div, span');
                                elements.forEach(el => {
                                    const text = (el.innerText || el.textContent || el.value || '').trim().replace(/\\n/g, ' ');
                                    if (text.toLowerCase().includes('submit') || text.toLowerCase().includes('approve') || text.toLowerCase().includes('run')) {
                                        if (text.length > 0 && text.length < 150) {
                                            results.push({
                                                path,
                                                tagName: el.tagName,
                                                text: text,
                                                id: el.id,
                                                className: el.className,
                                                isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
                                            });
                                        }
                                    }
                                });

                                // Check inside iframes recursively
                                const iframes = doc.querySelectorAll('iframe');
                                iframes.forEach((iframe, idx) => {
                                    try {
                                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                                        traverse(iframeDoc, path + ' -> iframe[' + idx + ']');
                                    } catch (e) {
                                        results.push({
                                            path: path + ' -> iframe[' + idx + ']',
                                            error: e.message
                                        });
                                    }
                                });
                            }
                            
                            traverse(document);
                            return results;
                        })()
                    `,
                    returnByValue: true,
                    awaitPromise: true
                }, sessionId);

                console.log('--- FOUND ELEMENTS ---');
                console.log(JSON.stringify(evalResult.result.value, null, 2));
                console.log('----------------------');

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
