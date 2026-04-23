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
    });
    
    await new Promise(r => ws.on('open', r));
    console.log('Connected!');
    
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await send('Target.getTargets');
    
    console.log('\nTargets:', targetInfos.length);
    
    // Find main workbench page
    const workbench = targetInfos.find(t => t.type === 'page' && t.url && t.url.includes('workbench'));
    
    if (!workbench) {
        console.log('No workbench found, trying first page...');
    }
    
    const target = workbench || targetInfos.find(t => t.type === 'page');
    if (!target) {
        console.log('No page target found!');
        ws.close();
        return;
    }
    
    console.log('\nAttaching to:', target.title);
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    
    // Scan for buttons in main document + iframes
    const scanScript = `(function() {
        var results = { mainDoc: [], iframes: [], shadows: [] };
        
        // Scan main document
        var btns = document.querySelectorAll('button, [role="button"], vscode-button, a.action-label');
        btns.forEach(function(b) {
            var text = (b.innerText || b.textContent || '').trim().split('\\n')[0].trim();
            if (text && text.length < 50) results.mainDoc.push(text);
        });
        
        // Scan iframes
        var iframes = document.querySelectorAll('iframe, webview');
        results.iframeCount = iframes.length;
        iframes.forEach(function(iframe, i) {
            try {
                var doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
                if (doc) {
                    var ibtns = doc.querySelectorAll('button, [role="button"], vscode-button');
                    ibtns.forEach(function(b) {
                        var text = (b.innerText || b.textContent || '').trim().split('\\n')[0].trim();
                        if (text && text.length < 50) results.iframes.push('iframe' + i + ':' + text);
                    });
                }
            } catch(e) {
                results.iframes.push('iframe' + i + ':CROSS-ORIGIN');
            }
        });
        
        // Scan shadow DOMs
        function scanShadow(root, prefix) {
            var all = root.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
                var sr = all[i].shadowRoot;
                if (sr) {
                    var sbtns = sr.querySelectorAll('button, [role="button"], vscode-button');
                    sbtns.forEach(function(b) {
                        var text = (b.innerText || b.textContent || '').trim().split('\\n')[0].trim();
                        if (text && text.length < 50) results.shadows.push(prefix + text);
                    });
                    scanShadow(sr, prefix + 'shadow>');
                }
            }
        }
        scanShadow(document, '');
        
        return results;
    })()`;
    
    const result = await send('Runtime.evaluate', {
        expression: scanScript,
        returnByValue: true,
    }, sessionId);
    
    const data = result.result.value;
    console.log('\n=== SCAN RESULTS ===');
    console.log('Main doc buttons:', data.mainDoc.length);
    data.mainDoc.slice(0, 20).forEach(b => console.log('  -', b));
    
    console.log('\nIframes found:', data.iframeCount);
    console.log('Iframe buttons:', data.iframes.length);
    data.iframes.slice(0, 20).forEach(b => console.log('  -', b));
    
    console.log('\nShadow DOM buttons:', data.shadows.length);
    data.shadows.slice(0, 20).forEach(b => console.log('  -', b));
    
    // Look for Accept/Run buttons
    const allButtons = [...data.mainDoc, ...data.iframes, ...data.shadows];
    const acceptLike = allButtons.filter(b => /accept|run|approve|allow|retry/i.test(b));
    console.log('\n=== ACCEPT-LIKE BUTTONS ===');
    acceptLike.forEach(b => console.log('  ✓', b));
    
    ws.close();
}

test().catch(console.error);
