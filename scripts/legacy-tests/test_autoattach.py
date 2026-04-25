import json, asyncio, websockets
async def dump():
    uri = 'ws://127.0.0.1:9333/devtools/browser/899e8449-5e67-49b0-8cd5-909ac66cb825'
    async with websockets.connect(uri) as ws:
        # Attach to Target
        await ws.send(json.dumps({'id':1,'method':'Target.getTargets'}))
        res = json.loads(await asyncio.wait_for(ws.recv(), 5))
        pages = [t for t in res.get('result',{}).get('targetInfos',[]) if t['type']=='page']
        
        for p in pages:
            tid = p['targetId']
            # Attach to page
            await ws.send(json.dumps({'id':2,'method':'Target.attachToTarget','params':{'targetId':tid, 'flatten':True}}))
            att = json.loads(await asyncio.wait_for(ws.recv(), 5))
            sid = att.get('result',{}).get('sessionId')

            print(f"Attached to {p.get('title')}, SID: {sid}")
            
            # Enable auto-attach to iframes
            await ws.send(json.dumps({'id':3,'method':'Target.setAutoAttach','sessionId':sid,
                'params':{'autoAttach':True, 'waitForDebuggerOnStart':False, 'flatten':True}}))
            
            # Listen to messages
            for _ in range(5):
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 1))
                    if msg.get('method') == 'Target.attachedToTarget':
                        child_info = msg['params']['targetInfo']
                        child_sid = msg['params']['sessionId']
                        print(f"  -> Attached to child: {child_info['url']} (SID: {child_sid})")
                        
                        # Evaluate in child
                        js = "document.body.innerText.length"
                        await ws.send(json.dumps({'id':4,'method':'Runtime.evaluate','sessionId':child_sid,'params':{'expression':js}}))
                except asyncio.TimeoutError:
                    pass

asyncio.run(dump())
