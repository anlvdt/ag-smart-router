'use strict';
const http = require('http');
const WebSocket = require('ws');

const CDP_PORTS = [9333, 9222, 9229, 9230, 9234, 9235, 9236];

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 1000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function main() {
    for (const p of CDP_PORTS) {
        console.log(`\n================ Probing Port ${p} ================`);
        let wsUrl = '';
        try {
            const res = await httpGet(`http://127.0.0.1:${p}/json/version`);
            const parsed = JSON.parse(res);
            wsUrl = parsed.webSocketDebuggerUrl;
            console.log(`Port ${p} is active! WS: ${wsUrl}`);
        } catch (e) {
            console.log(`Port ${p} is not active: ${e.message}`);
            continue;
        }

        if (wsUrl) {
            await new Promise((resolve) => {
                const ws = new WebSocket(wsUrl);
                ws.on('open', async () => {
                    let msgId = 0;
                    const send = (method, params = {}) => {
                        return new Promise((resolve, reject) => {
                            const id = ++msgId;
                            ws.send(JSON.stringify({ id, method, params }));
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
                        const { targetInfos } = await send('Target.getTargets');
                        console.log(`Targets on port ${p}:`);
                        targetInfos.forEach(t => {
                            console.log(`- ID: ${t.targetId} | Type: ${t.type} | Title: "${t.title}" | URL: ${t.url}`);
                        });
                    } catch (err) {
                        console.error('Error fetching targets:', err.message);
                    }
                    ws.close();
                    resolve();
                });
                ws.on('error', (err) => {
                    console.error('WS Error:', err.message);
                    resolve();
                });
            });
        }
    }
}

main();
