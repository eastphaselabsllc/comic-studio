// Sequential panel illustration. Finished panels (those with imageId) are skipped
// so a cancelled or failed run can resume without regenerating them.
export function isCancelledError(e){return !!(e&&(e.cancelled||/^Cancelled\b/.test(String(e.message||''))));}

export async function runPanelBatch({panels,shouldCancel,generate,save,onProgress}){
  const list=Array.isArray(panels)?panels:[];
  const total=list.length;
  const completed=()=>list.filter(p=>p.imageId).length;
  const failed=()=>list.filter(p=>!p.imageId).length;
  const report=(extra)=>onProgress?.({completed:completed(),total,...extra});
  await report({state:'start'});
  for(let i=0;i<list.length;i++){
    if(shouldCancel?.()) return {cancelled:true,completed:completed(),total,failed:failed()};
    const panel=list[i];
    if(panel.imageId) continue;
    await report({state:'panel',index:i,panel});
    try{
      const blob=await generate(panel,i);
      const imageId=await save(panel,blob);
      panel.imageId=imageId;
      panel.genError=undefined;
      await report({state:'saved',index:i,panel});
    }catch(e){
      if(isCancelledError(e)) return {cancelled:true,completed:completed(),total,failed:failed()};
      panel.genError=e?.message||'Image failed.';
      await report({state:'failed',index:i,panel,error:panel.genError});
    }
  }
  return {cancelled:false,completed:completed(),total,failed:failed()};
}
