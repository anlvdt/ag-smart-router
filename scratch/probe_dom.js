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
                    if (sessionId) {
                        payload.sessionId = sessionId;
                    }
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
                    console.error('Main Grav target not found! All targets:', JSON.stringify(targetInfos, null, 2));
                    ws.close();
                    return;
                }

                console.log(`Attaching to main target: ${mainTarget.targetId}`);
                const { sessionId } = await send('Target.attachToTarget', { targetId: mainTarget.targetId, flatten: true });
                console.log(`Attached! Session ID: ${sessionId}`);

                // Evaluate script to search for buttons in the main document and all iframes
                const scriptToEvaluate = `
                    (() => {
                        const results = [];
                        
                        function traverse(doc, path = 'top') {
                            if (!doc) return;
                            
                            // Find all buttons or elements that look like buttons/interactive elements
                            const elements = doc.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
                            elements.forEach(el => {
                                const text = el.innerText || el.value || el.ariaLabel || el.getAttribute('aria-label') || '';
                                results.push({
                                    path,
                                    tagName: el.tagName,
                                    text: text.trim().substring(0, 100),
                                    id: el.id,
                                    className: el.className,
                                    isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
                                });
                            });

                            // Traverse iframes
                            const iframes = doc.querySelectorAll('iframe');
                            iframes.forEach((iframe, idx) => {
                                try {
                                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                                    traverse(iframeDoc, path + ' -> iframe[' + idx + ']');
                                } catch (e) {
                                    results.push({
                                        path: path + ' -> iframe[' + idx + ']',
                                        error: 'Cross-origin or inaccessible: ' + e.message
                                    });
                                }
                            });
                        }
                        
                        traverse(document);
                        return results;
                    })()
                `;

                // We send the evaluation via the target session
                const evalResult = await send('Runtime.evaluate', {
                    expression: scriptToEvaluate,
                    returnByValue: true,
                    awaitPromise: true
                }, sessionId);

                const fs = require('fs');
                const path = require('path');
                const results = evalResult.result.value;
                const outPath = path.join(__dirname, 'interactive_elements.json');
                fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
                console.log(`Saved ${results.length} interactive elements to ${outPath}`);

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
