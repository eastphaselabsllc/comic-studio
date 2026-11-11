import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {faceFrame, FACE_MAX_EDGE, JOB_BODY_BUDGET, UPLOAD_BODY_LIMIT} from '../face.js';
import {buildEpisodePages} from '../core.js';
import {IMAGE_NEGATIVE} from '../provider.js';
import {startMockGateway} from './mock-gateway.js';

test('a wide turnaround keeps the front view and a portrait is only scaled down', ()=>{
  const sheet=faceFrame(1800,600);
  assert.equal(sheet.sx,0);
  assert.equal(sheet.sy,0);
  assert.equal(sheet.sw,600);
  assert.equal(sheet.sh,600);
  assert.equal(sheet.dw,600);
  assert.equal(sheet.dh,600);
  const portrait=faceFrame(832,1216);
  assert.equal(portrait.sw,832);
  assert.equal(portrait.sh,1216);
  assert.equal(Math.max(portrait.dw,portrait.dh),FACE_MAX_EDGE);
  const small=faceFrame(320,400);
  assert.deepEqual([small.dw,small.dh],[320,400]);
  const stack=faceFrame(500,1600);
  assert.equal(stack.sx,0);
  assert.equal(stack.sy,0);
  assert.ok(stack.sh<1600);
  assert.equal(stack.sw,500);
});

function crc32(buf){
  let c=~0;
  for(const byte of buf){
    c^=byte;
    for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));
  }
  return ~c>>>0;
}

function pngChunk(type,data){
  const body=Buffer.concat([Buffer.from(type),data]);
  const len=Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc=Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len,body,crc]);
}

function sheetPng(width,height){
  const raw=Buffer.alloc((width*3+1)*height);
  const bases=[[206,148,124],[36,78,176],[48,150,72]];
  for(let y=0;y<height;y++){
    const row=y*(width*3+1);
    raw[row]=0;
    for(let x=0;x<width;x++){
      const band=x<width/3?0:x<2*width/3?1:2;
      const n=((x*13+y*29)%19)-9;
      const i=row+1+x*3;
      raw[i]=Math.max(0,Math.min(255,bases[band][0]+n));
      raw[i+1]=Math.max(0,Math.min(255,bases[band][1]+n));
      raw[i+2]=Math.max(0,Math.min(255,bases[band][2]+n));
    }
  }
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(width,0);
  ihdr.writeUInt32BE(height,4);
  ihdr[8]=8;
  ihdr[9]=2;
  const idat=zlib.deflateSync(raw,{level:0});
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR',ihdr),
    pngChunk('IDAT',idat),
    pngChunk('IEND',Buffer.alloc(0))
  ]);
}

function naiveBodyBytes(ids,prompts,faceB64){
  let total='{"items":['.length;
  ids.forEach((id,index)=>{
    if(index)total+=1;
    total+=Buffer.byteLength(JSON.stringify({
      id,
      prompt:prompts[index],
      width:832,
      height:1216,
      steps:28,
      cfg_scale:7,
      negative_prompt:IMAGE_NEGATIVE,
      face_b64:faceB64
    }));
  });
  return total+']}'.length;
}

function startStatic(png){
  const root=path.resolve('/workspace');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/face-harness.html'){
      res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});
      res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; img-src \'self\' blob: data:; connect-src \'self\' https: http://localhost:* http://127.0.0.1:*"><title>face</title>');
      return;
    }
    if(url.pathname==='/sheet.png'){
      res.writeHead(200,{'content-type':'image/png','cache-control':'no-store'});
      res.end(png);
      return;
    }
    const rel=decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if(!rel||rel.includes('..')){res.writeHead(404);res.end('missing');return;}
    const file=path.resolve(root,rel);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){
      res.writeHead(404);res.end('missing');return;
    }
    const ext=path.extname(file);
    const type=ext==='.js'?'text/javascript':ext==='.svg'?'image/svg+xml':ext==='.html'?'text/html':ext==='.css'?'text/css':'application/octet-stream';
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({
    url:'http://127.0.0.1:'+server.address().port,
    close(){return new Promise(done=>server.close(()=>done()));}
  })));
}

async function withChrome(origin,run){
  const profile='/tmp/cs-face-chrome';
  fs.rmSync(profile,{recursive:true,force:true});
  const chrome=spawn('google-chrome',[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--remote-debugging-port=9341',`--user-data-dir=${profile}`,'about:blank'
  ],{stdio:'ignore'});
  let ws;
  try{
    let version;
    for(let i=0;i<50;i++){
      try{version=await (await fetch('http://127.0.0.1:9341/json/version')).json();break;}
      catch{await delay(100);}
    }
    if(!version)throw Error('Chrome did not open a debugging port');
    ws=new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve);ws.addEventListener('error',reject);});
    const pending=new Map();
    let seq=0;
    let sessionId;
    ws.addEventListener('message',event=>{
      const msg=JSON.parse(event.data);
      if(msg.id&&pending.has(msg.id)){
        const {resolve,reject}=pending.get(msg.id);
        pending.delete(msg.id);
        if(msg.error)reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    function send(method,params={},sid=sessionId){
      const id=++seq;
      const payload={id,method,params};
      if(sid)payload.sessionId=sid;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
    }
    const {targetId}=await send('Target.createTarget',{url:`${origin}/face-harness.html`},null);
    sessionId=(await send('Target.attachToTarget',{targetId,flatten:true},null)).sessionId;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate',{url:`${origin}/face-harness.html`});
    await delay(200);
    return await run(async expression=>{
      const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
      return result.result.value;
    });
  }finally{
    try{ws&&ws.close();}catch{}
    chrome.kill('SIGKILL');
  }
}

test('a 25-panel comic with a multi-megabyte turnaround stays under the upload limit', {timeout:120000}, async ()=>{
  const width=1800;
  const height=600;
  const png=sheetPng(width,height);
  assert.ok(png.length>=3*1024*1024&&png.length<=4*1024*1024,`reference png was ${png.length} bytes`);
  const mira={id:'c1',name:'Mira',age:32,fictional:true,description:'amber eyes',hair:'dark curls',body:'athletic adult build',outfit:'copper jacket',tattoos:'a constellation',personality:'warm',backstory:'a cartographer',refId:'ref-mira'};
  const script=Array.from({length:25},(_,i)=>`Mira walks through the orbital garden, beat ${i+1}.`).join('\n\n');
  const panels=buildEpisodePages({script,cast:['c1'],count:25,characters:[mira]}).flatMap(page=>page.panels);
  assert.equal(panels.length,25);
  const before=naiveBodyBytes(panels.map(panel=>panel.id),panels.map(panel=>panel.prompt),png.toString('base64'));
  assert.ok(before>UPLOAD_BODY_LIMIT);
  const gw=await startMockGateway('sheet-token',{maxBody:UPLOAD_BODY_LIMIT});
  const site=await startStatic(png);
  const jpegPath='/tmp/cs-face-check.jpg';
  try{
    const raw=await fetch(gw.url+'/jobs',{
      method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+gw.token},
      body:JSON.stringify({items:[{id:'too-big',prompt:'Mira waits.',width:832,height:1216,steps:28,cfg_scale:7,face_b64:png.toString('base64')}]})
    });
    assert.equal(raw.status,413);
    const report=await withChrome(site.url,async evalPage=>{
      const payload=JSON.stringify({
        url:gw.url,
        token:gw.token,
        budget:JOB_BODY_BUDGET,
        limit:UPLOAD_BODY_LIMIT,
        width,
        height,
        script,
        negative:IMAGE_NEGATIVE
      });
      return evalPage(`(async ()=>{
        const cfg=${payload};
        const core=await import('/core.js');
        const jobs=await import('/jobs.js');
        const blob=await (await fetch('/sheet.png')).blob();
        const prepared=await jobs.prepareFaceReference(blob);
        const header=prepared.slice(prepared.indexOf(',')+1);
        const bytes=Uint8Array.from(atob(header),ch=>ch.charCodeAt(0));
        const mira={id:'c1',name:'Mira',age:32,fictional:true,description:'amber eyes',hair:'dark curls',body:'athletic adult build',outfit:'copper jacket',tattoos:'a constellation',personality:'warm',backstory:'a cartographer',refId:'ref-mira'};
        const panels=core.buildEpisodePages({script:cfg.script,cast:['c1'],count:25,characters:[mira]}).flatMap(page=>page.panels);
        const built=await jobs.buildJobItems(panels,[mira],'Ink',async ()=>prepared);
        const chunks=jobs.splitJobItems(built.items,cfg.budget);
        const sizes=[];
        for(const items of chunks){
          const body=JSON.stringify({items});
          const size=new TextEncoder().encode(body).length;
          sizes.push(size);
          if(size>cfg.limit)throw Error('chunk is still too large: '+size);
          const res=await fetch(cfg.url+'/jobs',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+cfg.token},body});
          if(!res.ok)throw Error('gateway rejected a prepared chunk: '+res.status+' '+await res.text());
        }
        const frame=jobs.faceFrame(cfg.width,cfg.height);
        return {sizes,ids:chunks.map(chunk=>chunk.map(item=>item.id)),prepared,bytes:bytes.length,frame,panelIds:built.panelIds,faces:built.items.map(item=>item.face_b64.length)};
      })()`);
    });
    const sizes=report.sizes;
    const after=sizes.reduce((sum,size)=>sum+size,0);
    console.log(JSON.stringify({
      referencePngBytes:png.length,
      beforeBodyBytes:before,
      afterChunkBytes:sizes,
      afterTotalBytes:after,
      chunks:sizes.length,
      jpegBytes:report.bytes,
      frame:report.frame
    },null,2));
    assert.ok(sizes.length>1,`expected several jobs, got ${sizes.length}`);
    assert.ok(sizes.every(size=>size<=UPLOAD_BODY_LIMIT));
    assert.ok(sizes.every(size=>size<=JOB_BODY_BUDGET));
    assert.ok(after<before/10);
    assert.deepEqual(report.ids.flat(),report.panelIds);
    assert.equal(report.panelIds.length,25);
    assert.equal(new Set(report.faces).size,1);
    assert.ok(report.faces[0]<80*1024);
    const posts=gw.calls.filter(call=>call.method==='POST'&&call.path==='/jobs'&&call.bytes&&call.bytes<=UPLOAD_BODY_LIMIT);
    assert.equal(posts.length,sizes.length);
    assert.deepEqual(posts.map(call=>call.body.items.map(item=>item.id)),report.ids);
    fs.writeFileSync(jpegPath,Buffer.from(report.prepared.slice(report.prepared.indexOf(',')+1),'base64'));
    const probe=await new Promise(resolve=>{
      const child=spawn('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',jpegPath],{stdio:['ignore','pipe','pipe']});
      let out='';
      child.stdout.on('data',chunk=>{out+=chunk;});
      child.on('close',code=>resolve({code,out:out.trim()}));
    });
    assert.equal(probe.code,0,probe.out);
    assert.equal(probe.out,`${report.frame.dw},${report.frame.dh}`);
    assert.ok(report.frame.dh>400);
    const rawVideo=await new Promise((resolve,reject)=>{
      const child=spawn('ffmpeg',['-v','error','-i',jpegPath,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{stdio:['ignore','pipe','pipe']});
      const chunks=[];
      let err='';
      child.stdout.on('data',chunk=>chunks.push(chunk));
      child.stderr.on('data',chunk=>{err+=chunk;});
      child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(err||'ffmpeg failed')));
    });
    let r=0,g=0,b=0,n=0;
    for(let i=0;i<rawVideo.length;i+=3){r+=rawVideo[i];g+=rawVideo[i+1];b+=rawVideo[i+2];n++;}
    r/=n;g/=n;b/=n;
    assert.ok(r>170&&g>110&&b<170&&r>b,`front crop average was ${r.toFixed(1)},${g.toFixed(1)},${b.toFixed(1)}`);
    assert.equal(gw.jobs.size,sizes.length);
    for(const [jobId,job] of gw.jobs){
      job.items.forEach((item,index)=>gw.complete(jobId,index,'PANEL-'+item.id));
    }
    const order=[];
    for(const job of gw.jobs.values()){
      for(const item of job.items){
        const res=await fetch(`${gw.url}/jobs/${job.job_id}/items/${item.index}`,{headers:{authorization:'Bearer '+gw.token}});
        const body=await res.json();
        order.push(body.images[0]);
      }
    }
    assert.deepEqual(order,report.panelIds.map(id=>'PANEL-'+id));
  }finally{
    fs.rmSync(jpegPath,{force:true});
    await gw.close();
    await site.close();
  }
});
