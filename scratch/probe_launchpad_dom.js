'use strict';
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

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
                
                const launchpadTarget = targetInfos.find(t => t.url && t.url.includes('workbench-jetski-agent.html'));
                if (!launchpadTarget) {
                    console.log('Launchpad target not found.');
                    ws.close();
                    return;
                }

                console.log(`Attaching to Launchpad: ${launchpadTarget.targetId}`);
                const { sessionId } = await send('Target.attachToTarget', { targetId: launchpadTarget.targetId, flatten: true });
                
                const probeScript = `
                    (() => {
                        const results = [];
                        
                        function search(root, path = 'document') {
                            if (!root) return;
                            
                            const elements = root.querySelectorAll('*');
                            elements.forEach(el => {
                                const text = (el.innerText || el.textContent || '').trim().replace(/\\n/g, ' ');
                                const attrs = {};
                                for (let i = 0; i < el.attributes.length; i++) {
                                    const attr = el.attributes[i];
                                    attrs[attr.name] = attr.value;
                                }
                                
                                results.push({
                                    tagName: el.tagName,
                                    text: text.substring(0, 100),
                                    id: el.id,
                                    className: el.className,
                                    path: path,
                                    attributes: attrs
                                });
                                
                                if (el.shadowRoot) {
                                    search(el.shadowRoot, path + ' -> shadowRoot(' + el.tagName + ')');
                                }
                            });
                            
                            const iframes = root.querySelectorAll('iframe');
                            iframes.forEach((iframe, idx) => {
                                try {
                                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                                    search(doc, path + ' -> iframe(' + (iframe.id || idx) + ')');
                                } catch (e) {
                                    results.push({
                                        tagName: 'IFRAME',
                                        text: 'CORS Blocked: ' + e.message,
                                        id: iframe.id,
                                        className: iframe.className,
                                        path: path,
                                        attributes: { src: iframe.src }
                                    });
                                }
                            });
                        }
                        
                        search(document);
                        return results;
                    })()
                `;

                const evalResult = await send('Runtime.evaluate', {
                    expression: probeScript,
                    returnByValue: true,
                    awaitPromise: true
                }, sessionId);

                const dataToWrite = JSON.stringify(evalResult.result.value, null, 2);
                fs.writeFileSync(path.join(__dirname, 'launchpad_elements.json'), dataToWrite, 'utf8');
                console.log(`Successfully saved ${evalResult.result.value?.length || 0} elements to launchpad_elements.json`);

            } catch (e) {
                console.error('Error during execution:', e);
            }
            ws.close();
        });
    } catch (e) {
        console.error('Main error:', e.message);
    }
}

main();
