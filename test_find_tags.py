import json, asyncio, websockets
async def dump():
    uri = 'ws://127.0.0.1:9333/devtools/browser/899e8449-5e67-49b0-8cd5-909ac66cb825'
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({'id':1,'method':'Target.getTargets'}))
        res = json.loads(await asyncio.wait_for(ws.recv(), 5))
        pages = [t for t in res.get('result',{}).get('targetInfos',[]) if t['type']=='page' and 'ag-smart-router' in t.get('title','')]
        if not pages: print("no page"); return
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
                    # Evaluate in child to get all tag names of elements containing 'Allow' or 'Deny'
                    js = """(function(){
                        var els = document.querySelectorAll('*');
                        var res = [];
                        for(var i=0; i<els.length; i++) {
                            var t = (els[i].innerText||'').trim();
                            if(t === 'Allow' || t.startsWith('Allow') || t === 'Deny') {
                                res.push({tag: els[i].tagName, className: els[i].className, text: t});
                            }
                        }
                        return res;
                    })()"""
                    await ws.send(json.dumps({'id':4,'method':'Runtime.evaluate','sessionId':child_sid,'params':{'expression':js, 'returnByValue':True}}))
                
                if msg.get('id') == 4:
                    val = msg.get('result',{}).get('result',{}).get('value',[])
                    if val:
                        print("Found in iframe:", val)
                        import sys; sys.exit(0)
            except asyncio.TimeoutError:
                break

asyncio.run(dump())
