const WebSocket = require('ws');
const http = require('http');

async function test() {
    const info = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9333/json/version', res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
    
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
            setTimeout(() => {
                if (callbacks.has(id)) {
                    callbacks.delete(id);
                    reject(new Error('timeout'));
                }
            }, 5000);
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
        // Log console messages
        if (msg.method === 'Runtime.consoleAPICalled') {
            const text = msg.params.args && msg.params.args[0] && msg.params.args[0].value;
            if (text && text.includes('[GRAV:')) {
                console.log('GRAV MSG:', text);
            }
        }
    });
    
    await new Promise(r => ws.on('open', r));
    console.log('Connected!');
    
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await send('Target.getTargets');
    
    console.log('\nTargets:', targetInfos.length);
    targetInfos.forEach(t => {
        const url = (t.url || '').toLowerCase();
        const isWorkbench = url.includes('workbench');
        console.log('  -', t.type, '|', isWorkbench ? '✓ WORKBENCH' : '', (t.title || '').slice(0, 30));
    });
    
    // Attach to ALL pages (workbench pages)
    const pages = targetInfos.filter(t => t.type === 'page');
    console.log('\nAttaching to', pages.length, 'pages...');
    
    for (const page of pages) {
        try {
            const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
            await send('Runtime.enable', {}, sessionId);
            
            // Check if Grav observer is already injected
            const checkResult = await send('Runtime.evaluate', {
                expression: 'window.__grav3 || "not-injected"',
                returnByValue: true,
            }, sessionId);
            
            console.log('  Page:', (page.title || '').slice(0, 30), '| Grav:', checkResult.result.value);
            
            // If not injected, try to find buttons
            if (checkResult.result.value === 'not-injected') {
                const scanResult = await send('Runtime.evaluate', {
                    expression: `(function() {
                        var btns = document.querySelectorAll('button, [role="button"], vscode-button');
                        var acceptLike = [];
                        btns.forEach(function(b) {
                            var text = (b.innerText || '').trim().split('\\n')[0].trim();
                            if (/^(accept|run|approve|allow|retry|proceed)/i.test(text)) {
                                acceptLike.push(text);
                            }
                        });
                        return { total: btns.length, acceptLike: acceptLike };
                    })()`,
                    returnByValue: true,
                }, sessionId);
                
                const data = scanResult.result.value;
                if (data.acceptLike.length > 0) {
                    console.log('    → Found accept-like buttons:', data.acceptLike);
                }
            }
        } catch (e) {
            console.log('  Failed:', page.title, e.message);
        }
    }
    
    ws.close();
}

test().catch(console.error);
