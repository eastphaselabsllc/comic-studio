// One PC-side comic job. The phone can sleep; polling resumes later and
// each finished image is stored on the panel it was submitted for.
import {panelJob} from './core.js';
import {prepareFaceReference, splitJobItems, JOB_BODY_BUDGET} from './face.js';
import {localFacePayload, localImagePayload} from './provider.js';

export {prepareFaceReference, faceFrame, splitJobItems, jobBodyBytes, JOB_BODY_BUDGET, UPLOAD_BODY_LIMIT, FACE_MAX_EDGE, FACE_BYTE_BUDGET} from './face.js';

export const JOB_POLL_FAST_MS=3000;
export const JOB_POLL_SLOW_MS=9000;
export const JOB_POLL_FAST_WINDOW_MS=30000;

export function useLocalJob(settings){return !!(settings&&settings.demo!==true&&String(settings.localURL||'').trim());}

export function nextPollDelay(elapsedMs){return elapsedMs<JOB_POLL_FAST_WINDOW_MS?JOB_POLL_FAST_MS:JOB_POLL_SLOW_MS;}

export function resolvePanelId(record,item){const echoed=item?.id==null?'':String(item.id);if(echoed&&(record?.panelIds||[]).includes(echoed))return echoed;const byIndex=record?.panelIds?.[item?.index];return byIndex?String(byIndex):(echoed||null);}

export async function buildJobItems(panels,characters,style,faceDataFor,opts={}){const items=[];const panelIds=[];const faces=new Map();for(const panel of panels||[]){if(panel?.imageId)continue;const scene=String(panel?.prompt||'').trim();if(!scene)throw Error('This panel has no scene prompt.');const job=panelJob({...panel,prompt:scene},characters,style,opts);let face='';const refId=job.referenceIds[0];if(refId){if(!faces.has(refId)){const raw=await faceDataFor(refId);faces.set(refId,raw?await prepareFaceReference(raw):'');}face=faces.get(refId)||'';}items.push(localFacePayload({...localImagePayload(job.prompt),id:panel.id},face||''));panelIds.push(panel.id);}if(!items.length)throw Error('Every panel already has art.');if(items.length>100)throw Error('A comic job can include at most 100 panels.');return {items,panelIds};}

export function normalizeImageJob(record){
  if(!record||typeof record!=='object')return null;
  const parts=[];
  if(Array.isArray(record.parts)){
    for(const part of record.parts){
      if(!part||part.jobId==null||part.jobId==='')continue;
      parts.push({jobId:String(part.jobId),panelIds:(part.panelIds||[]).map(String),fetched:(part.fetched||[]).map(String)});
    }
  }else if(record.jobId){
    parts.push({jobId:String(record.jobId),panelIds:(record.panelIds||[]).map(String),fetched:(record.fetched||[]).map(String)});
  }
  const rest=Array.isArray(record.rest)?record.rest.map(String):[];
  if(!parts.length&&!rest.length)return null;
  return {parts,rest,startedAt:record.startedAt||Date.now()};
}

export function hasImageJob(record){const job=normalizeImageJob(record);return !!(job&&(job.parts.length||job.rest.length));}

function mirrorJob(record){
  const part=record.parts[0];
  if(part){record.jobId=part.jobId;record.panelIds=part.panelIds;record.fetched=part.fetched;}
  else{delete record.jobId;record.panelIds=(record.rest||[]).slice();record.fetched=[];}
}

function fetchedIds(record){const ids=[];for(const part of record.parts||[])for(const id of part.fetched||[])ids.push(id);return ids;}

function localRetry(message,status){const err=Error(message);err.local=true;err.retryable=true;if(status)err.status=status;return err;}

export async function driveImageJobs({record,itemFor,createJob,poll,fetchItem,saveItem,deleteJob,cancelJob,shouldCancel,shouldReplace,shouldPause,sleep,now=()=>Date.now(),onProgress,onUpdate,onSubmitted,budget=JOB_BODY_BUDGET}={}){
  if(!record||typeof record!=='object')throw localRetry('Missing comic job. Try again.');
  const normalized=normalizeImageJob(record)||{parts:[],rest:[],startedAt:Date.now()};
  record.parts=normalized.parts.map(part=>({...part,fetched:[...part.fetched]}));
  record.rest=normalized.rest.slice();
  if(!record.startedAt)record.startedAt=normalized.startedAt;
  async function persist(){mirrorJob(record);if(onUpdate)await onUpdate(record);}
  async function cancelAll(){
    const fetched=fetchedIds(record);
    for(const part of record.parts){
      try{await cancelJob(part.jobId);}catch(e){if(e?.status!==404&&!stopped(e))throw e;}
      try{await deleteJob(part.jobId);}catch(e){if(e?.status!==404&&!stopped(e))throw e;}
    }
    record.parts=[];record.rest=[];
    await persist();
    return {cancelled:true,fetched};
  }
  if(record.rest.length){
    const pending=[];
    for(const id of record.rest){
      if(shouldReplace?.())return {replaced:true,fetched:fetchedIds(record)};
      if(shouldPause?.())return {paused:true,fetched:fetchedIds(record)};
      if(shouldCancel?.())return cancelAll();
      const item=await itemFor(id);
      if(item)pending.push({id,item});
    }
    record.rest=pending.map(entry=>entry.id);
    const chunks=splitJobItems(pending.map(entry=>entry.item),budget);
    let cursor=0;
    for(const chunk of chunks){
      if(shouldReplace?.())return {replaced:true,fetched:fetchedIds(record)};
      if(shouldPause?.())return {paused:true,fetched:fetchedIds(record)};
      if(shouldCancel?.())return cancelAll();
      const ids=pending.slice(cursor,cursor+chunk.length).map(entry=>entry.id);
      cursor+=chunk.length;
      let created;
      try{created=await createJob(chunk);}
      catch(e){
        await persist();
        if(stopped(e))throw e;
        if(!e.local)e.local=true;
        if(!e.retryable)e.retryable=true;
        throw e;
      }
      if(!created?.job_id){await persist();throw localRetry('The PC did not start a comic job. Try again.');}
      record.parts.push({jobId:String(created.job_id),panelIds:ids,fetched:[]});
      record.rest=pending.slice(cursor).map(entry=>entry.id);
      await persist();
      if(onProgress)await onProgress({phase:'submitted',parts:record.parts.length,remaining:record.rest.length});
    }
  }
  if(onSubmitted)await onSubmitted();
  const errors=[];
  while(record.parts.length){
    if(shouldReplace?.())return {replaced:true,fetched:fetchedIds(record)};
    if(shouldPause?.())return {paused:true,fetched:fetchedIds(record)};
    if(shouldCancel?.())return cancelAll();
    const part=record.parts[0];
    const result=await collectGatewayJob({
      record:part,
      poll:()=>poll(part.jobId),
      fetchItem:index=>fetchItem(part.jobId,index),
      saveItem,
      deleteJob:()=>deleteJob(part.jobId),
      cancelJob:()=>cancelJob(part.jobId),
      shouldCancel,shouldReplace,shouldPause,
      sleep,now,onProgress,
      onUpdate:persist
    });
    if(result.replaced)return {replaced:true,fetched:fetchedIds(record)};
    if(result.paused)return {paused:true,fetched:fetchedIds(record)};
    if(result.cancelled){
      record.parts.shift();
      const fetched=new Set([...(result.fetched||[]),...fetchedIds(record)]);
      const rest=await cancelAll();
      for(const id of rest.fetched||[])fetched.add(id);
      return {cancelled:true,fetched:[...fetched],errors:result.errors||[]};
    }
    if(result.missing){
      const missed=part.panelIds.filter(id=>!(part.fetched||[]).includes(id));
      record.parts.shift();
      record.rest=[...missed,...record.rest];
      await persist();
      throw localRetry('That comic job is no longer on the PC. Try again to send the unfinished panels.',404);
    }
    if(result.finished){
      if(!result.deleted)throw localRetry('A finished panel is still on the PC. Try again to pick it up.');
      for(const item of result.errors||[])if(item?.status==='error')errors.push({...item,panelId:resolvePanelId(part,item)});
      record.parts.shift();
      await persist();
      continue;
    }
    return {...result,fetched:fetchedIds(record)};
  }
  return {finished:true,deleted:true,status:errors.length?'error':'done',errors,fetched:fetchedIds(record)};
}

function stopped(e){return !!(e&&(e.cancelled||e.name==='AbortError'||/^Cancelled\b/.test(String(e.message||''))));}

export function waitUntilVisible(delay,doc,signal){return new Promise((resolve,reject)=>{let timer=null;let settled=false;const cleanup=()=>{settled=true;if(timer)clearTimeout(timer);doc?.removeEventListener?.('visibilitychange',onVis);signal?.removeEventListener?.('abort',onAbort);};const finish=()=>{if(settled)return;cleanup();resolve();};const onAbort=()=>{if(settled)return;cleanup();const e=Error('Cancelled.');e.cancelled=true;reject(e);};const arm=()=>{if(settled)return;if(signal?.aborted)return onAbort();if(doc?.visibilityState==='hidden'){if(timer){clearTimeout(timer);timer=null;}return;}if(timer)return;timer=setTimeout(finish,delay);};const onVis=()=>{if(settled)return;if(doc?.visibilityState==='visible'){if(timer){clearTimeout(timer);timer=null;}finish();}else if(timer){clearTimeout(timer);timer=null;}};doc?.addEventListener?.('visibilitychange',onVis);signal?.addEventListener?.('abort',onAbort);arm();});}

function briefWait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

export async function collectGatewayJob({record,poll,fetchItem,saveItem,deleteJob,cancelJob,shouldCancel,shouldReplace,shouldPause,sleep,now=()=>Date.now(),onProgress,onUpdate}){if(!record?.jobId)throw Error('Missing comic job.');const sessionStart=now();const fetched=new Set((record.fetched||[]).map(String));record.fetched=[...fetched];
  async function pull(status){const items=Array.isArray(status?.items)?status.items:[];for(const item of items){if(item?.status!=='done')continue;const panelId=resolvePanelId(record,item);if(!panelId||fetched.has(panelId))continue;let payload;try{payload=await fetchItem(item.index);}catch(e){if(e?.status===409)continue;throw e;}const image=payload?.images?.[0];if(!image){const err=Error('The PC finished a panel but sent no image. Try again.');err.local=true;err.retryable=true;throw err;}await saveItem(panelId,image,item);fetched.add(panelId);record.fetched=[...fetched];if(onUpdate)await onUpdate(record);}}
  function problems(status){return (status?.items||[]).filter(item=>item&&(item.status==='error'||item.status==='cancelled'));}
  async function removeJob(){try{await deleteJob();}catch(e){if(e?.status!==404)throw e;}}
  async function finish(status){const doneIds=(status?.items||[]).filter(item=>item?.status==='done').map(item=>resolvePanelId(record,item)).filter(Boolean);if(!doneIds.every(id=>fetched.has(id)))return false;await removeJob();return true;}
  async function settle(){let status=null;try{status=await cancelJob();}catch(e){if(e?.status===404)return {missing:true,fetched:[...fetched]};throw e;}for(let i=0;i<4;i++){if(status)await pull(status);const items=status?.items||[];if(!items.some(item=>item?.status==='running'))break;await briefWait(1000);try{status=await poll();}catch{break;}}if(status)await pull(status);await removeJob();return {cancelled:true,fetched:[...fetched],errors:problems(status)};}
  while(true){if(shouldReplace?.())return {replaced:true,fetched:[...fetched]};if(shouldPause?.())return {paused:true,fetched:[...fetched]};if(shouldCancel?.())return settle();
    let status;try{status=await poll();}catch(e){if(shouldReplace?.())return {replaced:true,fetched:[...fetched]};if(shouldPause?.())return {paused:true,fetched:[...fetched]};if(shouldCancel?.())return settle();if(e?.status===404)return {missing:true,fetched:[...fetched]};throw e;}
    await pull(status);if(onProgress)await onProgress(status,fetched);
    if(['done','error','cancelled'].includes(status?.status)){const deleted=await finish(status);return {finished:true,status:status.status,deleted,errors:problems(status),fetched:[...fetched]};}
    let step;try{step=await sleep(nextPollDelay(now()-sessionStart));}catch(e){if(shouldReplace?.())return {replaced:true,fetched:[...fetched]};if(shouldPause?.())return {paused:true,fetched:[...fetched]};if(shouldCancel?.())return settle();if(stopped(e))return {paused:true,fetched:[...fetched]};throw e;}
    if(step==='stop')return {paused:true,fetched:[...fetched]};if(shouldReplace?.())return {replaced:true,fetched:[...fetched]};if(shouldPause?.())return {paused:true,fetched:[...fetched]};}
}
