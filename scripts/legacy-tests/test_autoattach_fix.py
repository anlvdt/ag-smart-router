import json, asyncio, websockets
async def dump():
    uri = 'ws://127.0.0.1:9333/devtools/browser/899e8449-5e67-49b0-8cd5-909ac66cb825'
    async with websockets.connect(uri) as ws:
        # Attach to Target
        await ws.send(json.dumps({'id':111,'method':'Target.getTargets'}))
        while True:
            res = json.loads(await asyncio.wait_for(ws.recv(), 5))
            if res.get('id') == 111: break
        
        pages = [t for t in res.get('result',{}).get('targetInfos',[]) if t['type']=='page' and 'ag-smart-router' in t.get('title','')]
        if not pages: return
        p = pages[0]
        tid = p['targetId']
        await ws.send(json.dumps({'id':222,'method':'Target.attachToTarget','params':{'targetId':tid, 'flatten':True}}))
        while True:
            res = json.loads(await asyncio.wait_for(ws.recv(), 5))
            if res.get('id') == 222:
                sid = res.get('result',{}).get('sessionId')
                break

        print(f"Attached to {p.get('title')}, SID: {sid}")
        
        await ws.send(json.dumps({'id':333,'method':'Target.setAutoAttach','sessionId':sid,
            'params':{'autoAttach':True, 'waitForDebuggerOnStart':False, 'flatten':True}}))
        
        for _ in range(10):
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 2))
                if msg.get('method') == 'Target.attachedToTarget':
                    child_info = msg['params']['targetInfo']
                    child_sid = msg['params']['sessionId']
                    print(f"  -> Child: {child_info['url']} (SID: {child_sid})")
            except asyncio.TimeoutError:
                break

asyncio.run(dump())
