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

            // Keep track of attached sessions
            const sessions = new Map();

            ws.on('message', async (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.method === 'Target.attachedToTarget') {
                        const info = msg.params.targetInfo;
                        const sid = msg.params.sessionId;
                        console.log(`[ATTACHED] ID: ${info.targetId} | Type: ${info.type} | Title: "${info.title}" | URL: ${info.url} | Session: ${sid}`);
                        
                        // Recursively auto-attach
                        await send('Target.setAutoAttach', {
                            autoAttach: true,
                            waitForDebuggerOnStart: false,
                            flatten: true,
                            filter: [
                                { type: 'page', exclude: false },
                                { type: 'iframe', exclude: false },
                                { type: 'webview', exclude: false },
                                { type: 'other', exclude: false }
                            ]
                        }, sid).catch(() => {});
                    }
                } catch (e) {
                    console.error('Event handling error:', e.message);
                }
            });

            try {
                // Enable auto-attach at browser level
                console.log('Enabling browser-level auto-attach...');
                await send('Target.setAutoAttach', {
                    autoAttach: true,
                    waitForDebuggerOnStart: false,
                    flatten: true,
                    filter: [
                        { type: 'page', exclude: false },
                        { type: 'iframe', exclude: false },
                        { type: 'webview', exclude: false },
                        { type: 'other', exclude: false }
                    ]
                });

                await send('Target.setDiscoverTargets', { discover: true });
                const { targetInfos } = await send('Target.getTargets');
                console.log(`\nFound ${targetInfos.length} top-level targets:`);
                for (const t of targetInfos) {
                    console.log(`- ID: ${t.targetId} | Type: ${t.type} | Title: "${t.title}" | URL: ${t.url}`);
                    
                    // Force attach to all page targets
                    if (t.type === 'page') {
                        console.log(`Force attaching to page ${t.targetId}...`);
                        await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(err => {
                            console.error(`Failed to attach: ${err.message}`);
                        });
                    }
                }

                // Wait 3 seconds to collect nested targets
                console.log('\nWaiting 3 seconds for nested targets...');
                await new Promise(r => setTimeout(r, 3000));

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
