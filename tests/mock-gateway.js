import http from 'node:http';

function readBody(req,maxBody){
  return new Promise((resolve,reject)=>{
    const chunks=[];
    let size=0;
    let failed=false;
    req.on('data',chunk=>{
      if(failed)return;
      size+=chunk.length;
      if(maxBody&&size>maxBody){
        failed=true;
        const err=Error('Body larger than limit');
        err.status=413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',()=>{if(!failed)resolve(Buffer.concat(chunks));});
    req.on('error',err=>{if(!failed)reject(err);});
  });
}

function refresh(job){
  const items=job.items;
  job.completed=items.filter(item=>item.status==='done').length;
  job.failed=items.filter(item=>item.status==='error').length;
  job.cancelled=items.filter(item=>item.status==='cancelled').length;
  job.total=items.length;
  const pending=items.some(item=>item.status==='queued'||item.status==='running');
  if(items.some(item=>item.status==='cancelled')&&!pending)job.status='cancelled';
  else if(!pending&&job.failed)job.status='error';
  else if(!pending)job.status='done';
  else if(items.some(item=>item.status==='running'||item.status==='done'))job.status='running';
  else job.status='queued';
  job.updated_at=new Date().toISOString();
}

function publicJob(job){
  return {
    job_id:job.job_id,
    status:job.status,
    total:job.total,
    completed:job.completed,
    failed:job.failed,
    cancelled:job.cancelled,
    created_at:job.created_at,
    updated_at:job.updated_at,
    items:job.items.map(item=>({index:item.index,id:item.id,status:item.status,message:item.message}))
  };
}

export function startMockGateway(token='test-local-token',options={}){
  const jobs=new Map();
  const calls=[];
  let seq=0;
  const control={maxBody:options.maxBody||0,rejectAfter:options.rejectAfter??null,faceswap:options.faceswap!==false,swapFail:options.swapFail||null,swapped:options.swapped};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const send=(code,obj)=>{
      const body=obj==null?'':JSON.stringify(obj);
      res.writeHead(code,{
        'content-type':obj==null?'text/plain':'application/json',
        'access-control-allow-origin':req.headers.origin||'*',
        'access-control-allow-methods':'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers':'Authorization, Content-Type, Accept',
        'cache-control':'no-store'
      });
      res.end(body);
    };
    if(req.method==='OPTIONS'){send(204,null);return;}
    const entry={method:req.method,path:url.pathname,auth:req.headers.authorization||'',bytes:0};
    const declared=Number(req.headers['content-length']||0);
    if(control.maxBody&&declared>control.maxBody){
      calls.push(entry);
      send(413,{detail:'Body larger than limit'});
      req.resume();
      return;
    }
    if(req.method==='POST'||req.method==='DELETE'){
      let raw;
      try{raw=await readBody(req,control.maxBody);}
      catch(err){
        entry.bytes=declared||0;
        calls.push(entry);
        if(err?.status===413){send(413,{detail:'Body larger than limit'});return;}
        send(400,{detail:'Body is not a JSON object'});
        return;
      }
      entry.bytes=raw.length;
      try{entry.body=JSON.parse(raw.toString('utf8')||'null');}
      catch{entry.body=null;}
    }
    calls.push(entry);
    if(req.method==='GET'&&url.pathname==='/health'){const body={ok:true};if(control.faceswap)body.faceswap=true;send(200,body);return;}
    if((req.headers.authorization||'')!=='Bearer '+token){send(401,{detail:'Unauthorized'});return;}
    if(req.method==='POST'&&url.pathname==='/faceswap'){
      const data=entry.body;
      if(!data||typeof data!=='object'||Array.isArray(data)||!data.target_b64||!data.face_b64||control.swapFail==='noface'){send(422,{detail:'No face found'});return;}
      const swapped=Number.isFinite(control.swapped)?control.swapped:1;
      const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      send(200,{image_b64:control.swapImage||png,swapped});
      return;
    }
    if(req.method==='POST'&&url.pathname==='/jobs'){
      if(Number.isInteger(control.rejectAfter)&&seq>=control.rejectAfter){send(500,{detail:'Gateway broke'});return;}
      const data=entry.body;
      if(!data||typeof data!=='object'||Array.isArray(data)){send(400,{detail:'Body is not a JSON object'});return;}
      if(!Array.isArray(data.items)||!data.items.length||data.items.length>100||data.items.some(item=>!item||typeof item!=='object')){send(422,{detail:'items'});return;}
      const job_id='job-'+(++seq);
      const now=new Date().toISOString();
      const job={job_id,status:'queued',created_at:now,updated_at:now,items:data.items.map((item,index)=>({index,id:item.id??null,status:'queued',message:null,_image:null,_swap:item.type==='swap',_target:item.target_b64||null,_face:item.face_b64||null}))};
      refresh(job);
      jobs.set(job_id,job);
      send(201,publicJob(job));
      return;
    }
    const itemMatch=url.pathname.match(/^\/jobs\/([^/]+)\/items\/(\d+)$/);
    if(req.method==='GET'&&itemMatch){
      const job=jobs.get(decodeURIComponent(itemMatch[1]));
      if(!job){send(404,{detail:'Unknown job'});return;}
      const index=Number(itemMatch[2]);
      const item=job.items[index];
      if(!item){send(404,{detail:'Unknown item'});return;}
      if(item._reject){send(item._reject.status||422,{detail:item._reject.detail||'No face found'});return;}
      if(item.status!=='done'){send(409,{detail:'Item is '+item.status,status:item.status,index,id:item.id});return;}
      if(item._swap){const swapped=item._swapped??1;send(200,{images:[item._image],image_b64:item._image,swapped});return;}
      send(200,{images:[item._image]});
      return;
    }
    const cancelMatch=url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
    if(req.method==='POST'&&cancelMatch){
      const job=jobs.get(decodeURIComponent(cancelMatch[1]));
      if(!job){send(404,{detail:'Unknown job'});return;}
      for(const item of job.items)if(item.status==='queued'||item.status==='running'){item.status='cancelled';item.message=item.message||'Cancelled.';}
      refresh(job);
      send(200,publicJob(job));
      return;
    }
    const jobMatch=url.pathname.match(/^\/jobs\/([^/]+)$/);
    if(jobMatch){
      const job=jobs.get(decodeURIComponent(jobMatch[1]));
      if(!job){send(404,{detail:'Unknown job'});return;}
      if(req.method==='GET'){send(200,publicJob(job));return;}
      if(req.method==='DELETE'){
        jobs.delete(job.job_id);
        res.writeHead(204,{'access-control-allow-origin':req.headers.origin||'*'});
        res.end();
        return;
      }
    }
    send(404,{detail:'Not found'});
  });
  return new Promise(resolve=>{
    server.listen(0,'127.0.0.1',()=>{
      const port=server.address().port;
      resolve({
        url:'http://127.0.0.1:'+port,
        token,
        calls,
        jobs,
        control,
        complete(jobId,index,image,extra){
          const job=jobs.get(jobId);
          const item=job.items[index];
          item.status='done';
          item.message=null;
          item._image=image;
          if(extra&&extra.swapped!=null)item._swapped=extra.swapped;
          refresh(job);
          return publicJob(job);
        },
        fail(jobId,index,message){
          const job=jobs.get(jobId);
          const item=job.items[index];
          item.status='error';
          item.message=message;
          refresh(job);
          return publicJob(job);
        },
        rejectItem(jobId,index,detail='No face found',status=422){
          const job=jobs.get(jobId);
          const item=job.items[index];
          item.status='done';
          item._reject={status,detail};
          refresh(job);
          return publicJob(job);
        },
        close(){return new Promise(done=>server.close(()=>done()));}
      });
    });
  });
}
