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
                
                // Find webview targets
                const webviewTargets = targetInfos.filter(t => t.url && t.url.includes('vscode-webview://'));
                if (webviewTargets.length === 0) {
                    console.log('No webview targets found. All targets:', JSON.stringify(targetInfos, null, 2));
                    ws.close();
                    return;
                }

                for (const target of webviewTargets) {
                    console.log(`Attaching to webview target: ${target.targetId} (URL: ${target.url})`);
                    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                    console.log(`Attached to webview session: ${sessionId}`);

                    const scriptToEvaluate = `
                        (() => {
                            const results = [];
                            
                            function traverse(doc, path = 'top') {
                                if (!doc) return;
                                
                                const elements = doc.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], div, span');
                                elements.forEach(el => {
                                    const text = (el.innerText || el.textContent || el.value || el.ariaLabel || el.getAttribute('aria-label') || '').trim().replace(/\\n/g, ' ');
                                    if (text.length > 0 && text.length < 150) {
                                        results.push({
                                            tagName: el.tagName,
                                            text: text,
                                            id: el.id,
                                            className: el.className,
                                            isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
                                        });
                                    }
                                });

                                // Check inside iframes recursively if any
                                const iframes = doc.querySelectorAll('iframe');
                                iframes.forEach((iframe, idx) => {
                                    try {
                                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                                        traverse(iframeDoc, path + ' -> iframe[' + idx + ']');
                                    } catch (e) {}
                                });
                            }
                            
                            traverse(document);
                            return results;
                        })()
                    `;

                    const evalResult = await send('Runtime.evaluate', {
                        expression: scriptToEvaluate,
                        returnByValue: true,
                        awaitPromise: true
                    }, sessionId);

                    const elements = evalResult.result.value || [];
                    console.log(`Found ${elements.length} elements in webview.`);
                    const filtered = elements.filter(el => {
                        const txt = el.text.toLowerCase();
                        return el.isVisible && (txt.includes('submit') || txt.includes('approve') || txt.includes('confirm') || txt.includes('cancel'));
                    });
                    console.log('Filtered interesting elements:', JSON.stringify(filtered, null, 2));
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
