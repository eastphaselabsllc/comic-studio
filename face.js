// The PC gateway forwards face_b64 unchanged to InstantID. That server runs
// InsightFace (detection size 640) and keeps only the largest face. It also
// draws that face's keypoints on a control image the size of the whole
// reference, so a multi-view sheet makes the face a small part of the pose
// map. Sheets from this app and from typical uploads are "front, side, back"
// with the front view on the left (or on top, when the sheet is a tall stack).
// A full-resolution sheet repeated on every panel is large enough that iPhone
// Safari drops the upload before the gateway finishes reading the body.
export const FACE_MAX_EDGE=640;
export const FACE_BYTE_BUDGET=48*1024;
export const JOB_BODY_BUDGET=256*1024;
export const UPLOAD_BODY_LIMIT=1024*1024;
// One swap item (Venice panel + reference) stays near 3 MB so a phone can upload it.
export const SWAP_ITEM_LIMIT=3*1024*1024;
export const SWAP_JPEG_QUALITY=0.9;

export function faceFrame(width,height,maxEdge=FACE_MAX_EDGE){
  const w=Math.max(1,Math.round(Number(width)||1));
  const h=Math.max(1,Math.round(Number(height)||1));
  const edge=Math.max(32,Math.round(Number(maxEdge)||FACE_MAX_EDGE));
  let sx=0,sy=0,sw=w,sh=h;
  const ratio=w/h;
  if(ratio>=2.15){
    const views=Math.max(2,Math.min(4,Math.round(ratio)));
    sw=Math.max(1,Math.round(w/views));
  }else if(h/w>=2.15){
    const views=Math.max(2,Math.min(4,Math.round(h/w)));
    sh=Math.max(1,Math.round(h/views));
  }
  const scale=Math.min(1,edge/Math.max(sw,sh));
  return {sx,sy,sw,sh,dw:Math.max(1,Math.round(sw*scale)),dh:Math.max(1,Math.round(sh*scale))};
}

export function jobBodyBytes(items){
  const json=JSON.stringify({items});
  return typeof TextEncoder==='undefined'?json.length:new TextEncoder().encode(json).length;
}

export function splitJobItems(items,budget=JOB_BODY_BUDGET){
  const chunks=[];
  let current=[];
  for(const item of items||[]){
    const next=current.concat([item]);
    if(current.length&&jobBodyBytes(next)>budget){chunks.push(current);current=[item];}
    else current=next;
  }
  if(current.length)chunks.push(current);
  return chunks;
}

function localRetry(message){const err=Error(message);err.local=true;err.retryable=true;return err;}

function magic(bytes){
  if(!bytes||bytes.length<3)return '';
  if(bytes.length>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47)return 'png';
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'jpeg';
  if(bytes.length>=12&&bytes[0]===0x52&&bytes[1]===0x49&&bytes[2]===0x46&&bytes[3]===0x46&&bytes[8]===0x57&&bytes[9]===0x45&&bytes[10]===0x42&&bytes[11]===0x50)return 'webp';
  return '';
}

function decodePrefix(source){
  if(typeof source!=='string')return new Uint8Array();
  const comma=source.indexOf(',');
  const raw=(source.startsWith('data:')&&comma!==-1?source.slice(comma+1):source).replace(/\s/g,'');
  if(raw.length<8)return new Uint8Array();
  try{
    const bin=atob(raw.slice(0,32));
    const out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
    return out;
  }catch{return new Uint8Array();}
}

async function sniff(source){
  if(typeof Blob!=='undefined'&&source instanceof Blob){
    const buf=new Uint8Array(await source.slice(0,16).arrayBuffer());
    return magic(buf);
  }
  return magic(decodePrefix(source));
}

function browserReady(){return typeof createImageBitmap==='function'&&typeof document!=='undefined'&&typeof document.createElement==='function';}

function bytesToDataUrl(bytes){
  let bin='';
  for(let i=0;i<bytes.length;i+=0x4000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x4000));
  return 'data:image/jpeg;base64,'+btoa(bin);
}

function canvasJpeg(bitmap,frame,quality){
  const canvas=document.createElement('canvas');
  canvas.width=frame.dw;
  canvas.height=frame.dh;
  const ctx=canvas.getContext('2d',{alpha:false})||canvas.getContext('2d');
  if(!ctx)throw localRetry('Could not prepare the reference photo. Try again.');
  ctx.fillStyle='#ffffff';
  ctx.fillRect(0,0,frame.dw,frame.dh);
  ctx.drawImage(bitmap,frame.sx,frame.sy,frame.sw,frame.sh,0,0,frame.dw,frame.dh);
  return new Promise((resolve,reject)=>{
    canvas.toBlob(async blob=>{
      if(!blob){reject(localRetry('Could not prepare the reference photo. Try again.'));return;}
      resolve(new Uint8Array(await blob.arrayBuffer()));
    },'image/jpeg',quality);
  });
}

function sourceBlob(source){
  if(typeof Blob!=='undefined'&&source instanceof Blob)return source;
  if(typeof source!=='string')throw localRetry('Could not read that reference photo. Try again.');
  let mime='application/octet-stream';
  let raw=source.replace(/\s/g,'');
  if(source.startsWith('data:')){
    const comma=source.indexOf(',');
    mime=(source.slice(5,comma).split(';')[0]||mime);
    raw=source.slice(comma+1).replace(/\s/g,'');
  }
  let bin;
  try{bin=atob(raw);}catch{throw localRetry('Could not read that reference photo. Try again.');}
  const bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return new Blob([bytes],{type:mime});
}

export function maxTargetChars(faceB64='',id='panel'){
  const shell={type:'swap',id:String(id||'panel'),target_b64:'',face_b64:String(faceB64||'')};
  return Math.max(0,SWAP_ITEM_LIMIT-jobBodyBytes([shell]));
}

async function rawBytes(source){
  if(typeof Blob!=='undefined'&&source instanceof Blob)return new Uint8Array(await source.arrayBuffer());
  if(typeof source!=='string'||!source)throw localRetry('Could not read the Venice image. Try again.');
  let raw=source.replace(/\s/g,'');
  if(source.startsWith('data:')){
    const comma=source.indexOf(',');
    if(comma===-1)throw localRetry('Could not read the Venice image. Try again.');
    raw=source.slice(comma+1).replace(/\s/g,'');
  }
  let bin;
  try{bin=atob(raw);}catch{throw localRetry('Could not read the Venice image. Try again.');}
  const bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes){
  let bin='';
  for(let i=0;i<bytes.length;i+=0x4000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x4000));
  return btoa(bin);
}

function canvasToJpeg(bitmap,quality,scale){
  const dw=Math.max(1,Math.round(bitmap.width*scale));
  const dh=Math.max(1,Math.round(bitmap.height*scale));
  const canvas=document.createElement('canvas');
  canvas.width=dw;
  canvas.height=dh;
  const ctx=canvas.getContext('2d',{alpha:false})||canvas.getContext('2d');
  if(!ctx)throw localRetry('Could not compress this panel for your PC. Try again.');
  ctx.fillStyle='#ffffff';
  ctx.fillRect(0,0,dw,dh);
  ctx.drawImage(bitmap,0,0,dw,dh);
  return new Promise((resolve,reject)=>{
    canvas.toBlob(async blob=>{
      if(!blob){reject(localRetry('Could not compress this panel for your PC. Try again.'));return;}
      resolve(new Uint8Array(await blob.arrayBuffer()));
    },'image/jpeg',quality);
  });
}

// Send the Venice image as-is when it already fits. Otherwise JPEG at quality
// 0.9, then a lower quality or a smaller edge until the swap item is under the limit.
export async function prepareSwapTarget(source,faceB64='',id='panel'){
  const maxChars=maxTargetChars(faceB64,id);
  if(maxChars<32)throw localRetry('That panel is still too large to send to your PC. Try again.');
  const bytes=await rawBytes(source);
  const kind=magic(bytes);
  if((kind==='jpeg'||kind==='png'||kind==='webp')&&bytesToB64(bytes).length<=maxChars)return bytesToB64(bytes);
  if(!browserReady())throw localRetry('Could not compress this panel for your PC. Try again.');
  let bitmap;
  try{bitmap=await createImageBitmap(new Blob([bytes],{type:kind==='png'?'image/png':kind==='webp'?'image/webp':'image/jpeg'}));}
  catch{throw localRetry('Could not read the Venice image. Try again.');}
  try{
    const qualities=[SWAP_JPEG_QUALITY,0.82,0.74,0.66,0.58,0.5];
    const scales=[1,0.85,0.72,0.6,0.48];
    for(const scale of scales){
      for(const quality of qualities){
        const jpeg=await canvasToJpeg(bitmap,quality,scale);
        const b64=bytesToB64(jpeg);
        if(b64.length<=maxChars)return b64;
      }
    }
    throw localRetry('That panel is still too large to send to your PC. Try again.');
  }finally{try{bitmap.close?.();}catch{/* already closed */}}
}

export async function prepareFaceReference(source){
  if(source==null||source==='')return '';
  const kind=await sniff(source);
  if(!kind)return typeof source==='string'?source:'';
  if(!browserReady())throw localRetry('Could not prepare the reference photo on this device. Try again.');
  let bitmap;
  try{bitmap=await createImageBitmap(sourceBlob(source));}
  catch{throw localRetry('Could not read that reference photo. Try again.');}
  try{
    const edges=[FACE_MAX_EDGE,512,384];
    const qualities=[0.82,0.7,0.58,0.5];
    let best=null;
    for(const edge of edges){
      const frame=faceFrame(bitmap.width,bitmap.height,edge);
      for(const quality of qualities){
        const bytes=await canvasJpeg(bitmap,frame,quality);
        if(!best||bytes.byteLength<best.byteLength)best=bytes;
        if(bytes.byteLength<=FACE_BYTE_BUDGET)return bytesToDataUrl(bytes);
      }
    }
    return bytesToDataUrl(best);
  }finally{try{bitmap.close?.();}catch{/* already closed */}}
}
