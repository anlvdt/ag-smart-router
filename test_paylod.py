import json, asyncio, websockets
async def dump():
    uri = 'ws://127.0.0.1:9333/devtools/browser/899e8449-5e67-49b0-8cd5-909ac66cb825'
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({'id':1,'method':'Target.getTargets'}))
        res = json.loads(await asyncio.wait_for(ws.recv(), 5))
        pages = [t for t in res.get('result',{}).get('targetInfos',[]) if t['type']=='page' and 'ag-smart-router' in t.get('title','')]
        if not pages: return
        p = pages[0]
        tid = p['targetId']
        await ws.send(json.dumps({'id':2,'method':'Target.attachToTarget','params':{'targetId':tid, 'flatten':True}}))
        att = json.loads(await asyncio.wait_for(ws.recv(), 5))
        sid = att.get('result',{}).get('sessionId')

        # Auto attach to everything
        await ws.send(json.dumps({'id':3,'method':'Target.setAutoAttach','sessionId':sid,
            'params':{'autoAttach':True, 'waitForDebuggerOnStart':False, 'flatten':True}}))
        
        child_sids = [sid]
        for _ in range(5):
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 1))
                if msg.get('method') == 'Target.attachedToTarget':
                    child_sids.append(msg['params']['sessionId'])
            except asyncio.TimeoutError:
                break
        
        js = """(function(){
            try {
                var pats = ['Allow', 'Run', 'Accept'];
                var rejects = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];
                function searchWindow(w) {
                    try {
                        var clickables = w.document.querySelectorAll('button, [role="button"], [class*="button"], vscode-button');
                        var hasReject = false;
                        var log = [];
                        for (var i=0; i<clickables.length; i++) {
                            if (clickables[i].offsetParent === null) continue;
                            var t = (clickables[i].innerText || clickables[i].textContent || '').trim();
                            log.push('Btn text: ' + t);
                            for(var r=0; r<rejects.length; r++) {
                                if (t === rejects[r] || t.indexOf(rejects[r])===0) { hasReject = true; break; }
                            }
                        }

                        for(var i=0; i<clickables.length; i++) {
                            var b = clickables[i];
                            if (b.offsetParent === null) continue;
                            var text = (b.innerText || b.textContent || '').trim();
                            if (!text || text.length > 50) continue;
                            
                            var matchedPattern = null;
                            for(var p=0; p<pats.length; p++) {
                                if (text === pats[p] || text.indexOf(pats[p]) === 0) { 
                                    matchedPattern = pats[p]; break; 
                                }
                            }
                            if (!matchedPattern) continue;

                            if (matchedPattern.indexOf('Accept') !== -1 || matchedPattern.indexOf('Allow') !== -1 || matchedPattern.indexOf('Run') !== -1 || hasReject) {
                                return "WOULD_CLICK: " + matchedPattern + " (hasReject=" + hasReject + ")";
                            }
                        }
                        return log.join(' | ');
                    } catch(e) { return 'ERR: '+e; }
                    
                    try {
                        for(var k=0; k<w.frames.length; k++) {
                            var res = searchWindow(w.frames[k]);
                            if (res) return res;
                        }
                    } catch(e) {}
                    return null;
                }
                return searchWindow(window);
            } catch(e) { return 'ERR: '+e; }
        })()"""
        
        for csid in child_sids:
            await ws.send(json.dumps({'id':100, 'method':'Runtime.evaluate', 'sessionId':csid, 'params':{'expression':js, 'returnByValue':True}}))
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
                if msg.get('id') == 100:
                    val = msg.get('result',{}).get('result',{}).get('value')
                    import sys
                    print(f"[{csid}]: {val}")
                    break

asyncio.run(dump())
