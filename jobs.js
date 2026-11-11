// One PC-side comic job. The phone can sleep; polling resumes later and
// each finished image is stored on the panel it was submitted for.
import {panelJob} from './core.js';
import {localFacePayload, localImagePayload} from './provider.js';

export const JOB_POLL_FAST_MS=3000;
export const JOB_POLL_SLOW_MS=9000;
export const JOB_POLL_FAST_WINDOW_MS=30000;

export function useLocalJob(settings){return !!(settings&&settings.demo!==true&&String(settings.localURL||'').trim());}

export function nextPollDelay(elapsedMs){return elapsedMs<JOB_POLL_FAST_WINDOW_MS?JOB_POLL_FAST_MS:JOB_POLL_SLOW_MS;}

export function resolvePanelId(record,item){const echoed=item?.id==null?'':String(item.id);if(echoed&&(record?.panelIds||[]).includes(echoed))return echoed;const byIndex=record?.panelIds?.[item?.index];return byIndex?String(byIndex):(echoed||null);}

export async function buildJobItems(panels,characters,style,faceDataFor,opts={}){const items=[];const panelIds=[];for(const panel of panels||[]){if(panel?.imageId)continue;const scene=String(panel?.prompt||'').trim();if(!scene)throw Error('This panel has no scene prompt.');const job=panelJob({...panel,prompt:scene},characters,style,opts);const face=job.referenceIds[0]?await faceDataFor(job.referenceIds[0]):'';items.push(localFacePayload({...localImagePayload(job.prompt),id:panel.id},face||''));panelIds.push(panel.id);}if(!items.length)throw Error('Every panel already has art.');if(items.length>100)throw Error('A comic job can include at most 100 panels.');return {items,panelIds};}

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
