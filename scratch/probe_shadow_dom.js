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
                
                const clickScript = `
                    (() => {
                        const results = [];
                        
                        function search(root) {
                            if (!root) return;
                            
                            // Search all children
                            const elements = root.querySelectorAll('*');
                            elements.forEach(el => {
                                const text = (el.innerText || el.textContent || '').trim().replace(/\\n/g, ' ');
                                if (el.tagName === 'BUTTON' || el.tagName === 'LABEL' || el.tagName === 'INPUT') {
                                    results.push({
                                        tagName: el.tagName,
                                        text: text.substring(0, 50),
                                        id: el.id,
                                        className: el.className,
                                        dataTooltipId: el.getAttribute('data-tooltip-id')
                                    });
                                }
                                
                                // Recursively search shadow DOM
                                if (el.shadowRoot) {
                                    search(el.shadowRoot);
                                }
                            });
                        }
                        
                        search(document);
                        return results;
                    })()
                `;

                const evalResult = await send('Runtime.evaluate', {
                    expression: clickScript,
                    returnByValue: true,
                    awaitPromise: true
                }, sessionId);

                const fs = require('fs');
                const path = require('path');
                fs.writeFileSync(path.join(__dirname, 'shadow_elements.json'), JSON.stringify(evalResult.result.value, null, 2), 'utf8');
                console.log(`Saved ${evalResult.result.value?.length || 0} shadow elements to shadow_elements.json`);

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
