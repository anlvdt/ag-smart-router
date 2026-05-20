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
                
                const findIframeScript = `
                    (() => {
                        const results = [];
                        
                        function search(root, path = 'top') {
                            if (!root) return;
                            const iframes = root.querySelectorAll('iframe');
                            iframes.forEach((iframe, idx) => {
                                results.push({
                                    path: path + ' -> iframe[' + idx + ']',
                                    id: iframe.id,
                                    name: iframe.name,
                                    src: iframe.src,
                                    title: iframe.title,
                                    className: iframe.className
                                });
                                try {
                                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                                    search(doc, path + ' -> iframe[' + idx + ']');
                                } catch (e) {
                                    results.push({
                                        path: path + ' -> iframe[' + idx + '] (nested)',
                                        error: e.message
                                    });
                                }
                            });

                            // Search shadow roots
                            const elements = root.querySelectorAll('*');
                            elements.forEach(el => {
                                if (el.shadowRoot) {
                                    search(el.shadowRoot, path + ' -> shadowRoot');
                                }
                            });
                        }
                        
                        search(document);
                        return results;
                    })()
                `;

                const evalResult = await send('Runtime.evaluate', {
                    expression: findIframeScript,
                    returnByValue: true,
                    awaitPromise: true
                }, sessionId);

                console.log('Iframes:', JSON.stringify(evalResult.result.value, null, 2));

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
