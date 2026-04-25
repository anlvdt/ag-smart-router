import json, asyncio, websockets
async def dump():
    uri = 'ws://127.0.0.1:9333/devtools/browser/899e8449-5e67-49b0-8cd5-909ac66cb825'
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({'id':1,'method':'Target.getTargets'}))
        res = json.loads(await asyncio.wait_for(ws.recv(), 5))
        targets = res.get('result',{}).get('targetInfos',[])
        
        for t in targets:
            if t['type'] != 'page': continue
            tid = t['targetId']
            await ws.send(json.dumps({'id':2,'method':'Target.attachToTarget','params':{'targetId':tid, 'flatten':True}}))
            att = json.loads(await asyncio.wait_for(ws.recv(), 5))
            sid = att.get('result',{}).get('sessionId')
            if not sid: continue
            
            # evaluate iframe traversal
            js = """(function(){
                let res = [];
                let frames = document.querySelectorAll('iframe');
                for(let i=0; i<frames.length; i++) {
                    try {
                        let d = frames[i].contentDocument || frames[i].contentWindow.document;
                        if(d && d.body) {
                            if(d.body.innerText.includes('Deny')) res.push('Found Deny in iframe ' + i);
                            if(d.body.innerText.includes('Allow')) res.push('Found Allow in iframe ' + i);
                        }
                    } catch(e) {}
                }
                return res.join(', ');
            })()"""
            await ws.send(json.dumps({'id':3,'method':'Runtime.evaluate','sessionId':sid,'params':{'expression':js, 'returnByValue':True}}))
            ev = json.loads(await asyncio.wait_for(ws.recv(), 5))
            val = ev.get('result',{}).get('result',{}).get('value','')
            print(f"{t.get('title')}: {val}")

asyncio.run(dump())
