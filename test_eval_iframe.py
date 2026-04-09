import json, asyncio, websockets
async def dump():
    uri = 'ws://127.0.0.1:9333/devtools/browser/899e8449-5e67-49b0-8cd5-909ac66cb825'
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({'id':1,'method':'Target.getTargets'}))
        res = json.loads(await asyncio.wait_for(ws.recv(), 5))
        targets = res.get('result',{}).get('targetInfos',[])
        pages = [t for t in targets if t['type']=='page' and 'ag-smart-router' in t.get('title','').lower()]
        if not pages: return
        tid = pages[0]['targetId']
        await ws.send(json.dumps({'id':2,'method':'Target.attachToTarget','params':{'targetId':tid, 'flatten':True}}))
        att = json.loads(await asyncio.wait_for(ws.recv(), 5))
        sid = att.get('result',{}).get('sessionId')

        # Enable runtime to get execution contexts
        contexts = {}
        await ws.send(json.dumps({'id':3,'method':'Runtime.enable','sessionId':sid}))
        
        # Listen for a second to collect contexts
        try:
            for _ in range(20):
                msg = json.loads(await asyncio.wait_for(ws.recv(), 1))
                if msg.get('method') == 'Runtime.executionContextCreated':
                    ctx = msg['params']['context']
                    contexts[ctx['id']] = ctx
        except asyncio.TimeoutError:
            pass

        print("Contexts found:", len(contexts))
        for cid, ctx in contexts.items():
            name = ctx.get('name', '')
            origin = ctx.get('origin', '')
            print(f"[{cid}] name:{name} origin:{origin}")
            # Try to query the button
            js = "!!document.querySelector('button')"
            await ws.send(json.dumps({'id': 100+cid, 'method': 'Runtime.evaluate', 'sessionId': sid, 'params': {'expression': js, 'contextId': cid}}))
            try:
                ans = json.loads(await asyncio.wait_for(ws.recv(), 1))
                print("  ->", ans)
            except: pass

asyncio.run(dump())
