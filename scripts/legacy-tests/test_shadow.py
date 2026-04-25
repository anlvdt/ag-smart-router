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

        await ws.send(json.dumps({'id':3,'method':'Target.setAutoAttach','sessionId':sid,
            'params':{'autoAttach':True, 'waitForDebuggerOnStart':False, 'flatten':True}}))
        
        while True:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 2))
                if msg.get('method') == 'Target.attachedToTarget':
                    child_sid = msg['params']['sessionId']
                    # Look for vscode-button and dump innerHTML + shadowRoot HTML
                    js = """(function(){
                        function getShadows(doc) {
                            var btns = doc.querySelectorAll('vscode-button');
                            var res = [];
                            for(var i=0; i<btns.length; i++) {
                                var b = btns[i];
                                var sr = b.shadowRoot ? b.shadowRoot.innerHTML : 'No shadow';
                                res.push({text: b.innerText, shadow: sr});
                            }
                            // Deep search iframes
                            var frs = doc.querySelectorAll('iframe');
                            for(var i=0; i<frs.length; i++){
                                try { res = res.concat(getShadows(frs[i].contentDocument || frs[i].contentWindow.document)); } catch(e){}
                            }
                            return res;
                        }
                        return getShadows(document);
                    })()"""
                    await ws.send(json.dumps({'id':4,'method':'Runtime.evaluate','sessionId':child_sid,'params':{'expression':js, 'returnByValue':True}}))
                
                if msg.get('id') == 4:
                    val = msg.get('result',{}).get('result',{}).get('value',[])
                    if val and len(val) > 0:
                        print("Found vscode-buttons:", json.dumps(val, indent=2))
                        import sys; sys.exit(0)
            except asyncio.TimeoutError:
                break

asyncio.run(dump())
