const WebSocket = require('ws');
const http = require('http');

async function test() {
    // Get WS URL
    const info = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9333/json/version', res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
    
    console.log('WS URL:', info.webSocketDebuggerUrl);
    
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    let msgId = 0;
    const callbacks = new Map();
    
    function send(method, params = {}, sessionId = null) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            const msg = { id, method, params };
            if (sessionId) msg.sessionId = sessionId;
            callbacks.set(id, { resolve, reject });
            ws.send(JSON.stringify(msg));
        });
    }
    
    ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.id && callbacks.has(msg.id)) {
            const cb = callbacks.get(msg.id);
            callbacks.delete(msg.id);
            if (msg.error) cb.reject(new Error(msg.error.message));
            else cb.resolve(msg.result);
        }
        if (msg.method === 'Target.attachedToTarget') {
            const t = msg.params.targetInfo;
            console.log('AUTO-ATTACHED:', t.type, '|', (t.title || '').slice(0, 40), '|', (t.url || '').slice(0, 60));
        }
    });
    
    await new Promise(r => ws.on('open', r));
    console.log('Connected!');
    
    // Enable auto-attach
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    console.log('Auto-attach enabled');
    
    // Discover targets
    await send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await send('Target.getTargets');
    console.log('\nTargets found:', targetInfos.length);
    
    for (const t of targetInfos) {
        console.log('  -', t.type, '|', (t.title || '').slice(0, 40), '|', (t.url || '').slice(0, 50));
    }
    
    // Attach to pages to discover nested webviews
    console.log('\nAttaching to pages...');
    for (const t of targetInfos) {
        if (t.type === 'page') {
            try {
                const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
                console.log('Attached to:', t.title || t.targetId);
                
                // Enable auto-attach on this session
                await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
            } catch (e) {
                console.log('Failed to attach:', e.message);
            }
        }
    }
    
    // Wait for auto-attach events
    console.log('\nWaiting 3s for auto-attach events...');
    await new Promise(r => setTimeout(r, 3000));
    
    // Get targets again
    const { targetInfos: newTargets } = await send('Target.getTargets');
    console.log('\nTargets after attach:', newTargets.length);
    for (const t of newTargets) {
        console.log('  -', t.type, '|', (t.title || '').slice(0, 40), '|', (t.url || '').slice(0, 50));
    }
    
    ws.close();
}

test().catch(console.error);
