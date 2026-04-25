import json, asyncio, websockets
async def dump():
    uri = 'ws://127.0.0.1:9333/devtools/browser/899e8449-5e67-49b0-8cd5-909ac66cb825'
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({'id':1,'method':'Target.getTargets'}))
        res = json.loads(await asyncio.wait_for(ws.recv(), 5))
        targets = res.get('result',{}).get('targetInfos',[])
        pages = [t for t in targets if t['type']=='page' and 'antigravity' in t.get('title','').lower() or 'agent' in t.get('title','').lower()]
        for p in pages:
            tid = p['targetId']
            await ws.send(json.dumps({'id':2,'method':'Target.attachToTarget','params':{'targetId':tid, 'flatten':True}}))
            att = json.loads(await asyncio.wait_for(ws.recv(), 5))
            sid = att.get('result',{}).get('sessionId')
            if not sid: continue
            
            # evaluate
            js = "document.body.innerHTML"
            await ws.send(json.dumps({'id':3,'method':'Runtime.evaluate','sessionId':sid,'params':{'expression':js, 'returnByValue':True}}))
            ev = json.loads(await asyncio.wait_for(ws.recv(), 5))
            html = ev.get('result',{}).get('result',{}).get('value','')
            if 'Deny' in html or 'Allow' in html or 'Run command' in html:
                import sys
                with open('dom_dump.html', 'w') as f: f.write(html)
                print(f"Dumped DOM for {p.get('title')}")
                break

asyncio.run(dump())
