import json, asyncio, websockets
async def dump():
    uri = 'ws://127.0.0.1:9333/devtools/browser/899e8449-5e67-49b0-8cd5-909ac66cb825'
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({'id':1,'method':'Target.getTargets'}))
        res = json.loads(await asyncio.wait_for(ws.recv(), 5))
        targets = res.get('result',{}).get('targetInfos',[])
        
        for t in targets:
            print(t['type'], t.get('title',''), t.get('url',''))

asyncio.run(dump())
