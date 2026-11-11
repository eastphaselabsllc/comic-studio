// Speech-bubble presets.
// To add a bubble later: drop a PNG or SVG into /bubbles, then append one object
// to BUBBLE_PRESETS. The app draws the tail, so the file only needs to be the body.
// id: short slug. name: label in the picker. src: path relative to the app.
// tail: "point" (speech/shout/whisper/caption), "circles" (thought), or "none".
export const BUBBLE_PRESETS=[
  {id:'round-speech',name:'Speech',src:'bubbles/round-speech.svg',tail:'point'},
  {id:'thought-cloud',name:'Thought',src:'bubbles/thought-cloud.svg',tail:'circles'},
  {id:'shout-burst',name:'Shout',src:'bubbles/shout-burst.svg',tail:'point'},
  {id:'whisper-dashed',name:'Whisper',src:'bubbles/whisper-dashed.svg',tail:'point'},
  {id:'caption-box',name:'Caption',src:'bubbles/caption-box.svg',tail:'point'}
];

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));
export function presetById(id){return BUBBLE_PRESETS.find(p=>p.id===id)||null;}

export function normalizeBubble(raw){
  if(!raw||typeof raw!=='object') return null;
  const preset=String(raw.preset||'');
  if(!/^[a-zA-Z0-9_-]{1,40}$/.test(preset)) return null;
  const num=(v,d,min,max)=>{const n=Number(v);return Number.isFinite(n)?clamp(n,min,max):d;};
  const id=typeof raw.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(raw.id)?raw.id:crypto.randomUUID();
  return {
    id,preset,
    text:String(raw.text||'').slice(0,500),
    x:num(raw.x,0.12,-0.05,0.92),
    y:num(raw.y,0.08,-0.05,0.92),
    w:num(raw.w,0.5,0.16,0.98),
    h:num(raw.h,0.24,0.1,0.9),
    fontSize:num(raw.fontSize,0.042,0.02,0.12),
    tailX:num(raw.tailX,0.08,-1.6,1.6),
    tailY:num(raw.tailY,0.82,-1.6,1.6),
    flip:raw.flip===true
  };
}
export function createBubble(presetId,partial={}){
  const preset=presetById(presetId);
  if(!preset) throw Error('Unknown bubble preset. Add it to BUBBLE_PRESETS.');
  return normalizeBubble({
    id:partial.id||crypto.randomUUID(),
    preset:preset.id,
    text:partial.text||'',
    x:partial.x??0.12,
    y:partial.y??0.08,
    w:partial.w??(preset.id==='caption-box'?0.76:0.5),
    h:partial.h??(preset.id==='caption-box'?0.16:0.24),
    fontSize:partial.fontSize??0.042,
    tailX:partial.tailX??0.08,
    tailY:partial.tailY??0.82,
    flip:partial.flip===true
  });
}
export const moveBubble=(b,x,y)=>normalizeBubble({...b,x,y});
export const resizeBubble=(b,w,h)=>normalizeBubble({...b,w,h});
export const moveTail=(b,tailX,tailY)=>normalizeBubble({...b,tailX,tailY});
export const setFontSize=(b,fontSize)=>normalizeBubble({...b,fontSize});
export const setBubbleText=(b,text)=>normalizeBubble({...b,text});
export const flipTail=b=>normalizeBubble({...b,flip:!b.flip,tailX:-Number(b.tailX||0)});
export function dragUpdate(mode,orig,start,point){
  const dx=point.x-start.x, dy=point.y-start.y;
  if(mode==='resize') return resizeBubble(orig,orig.w+dx,orig.h+dy);
  if(mode==='tail'){const cx=orig.x+orig.w/2, cy=orig.y+orig.h/2;return moveTail(orig,(point.x-cx)/orig.w,(point.y-cy)/orig.h);}
  return moveBubble(orig,orig.x+dx,orig.y+dy);
}
export function seedBubbles(panel){
  if(Array.isArray(panel?.bubbles)&&panel.bubbles.length) return panel.bubbles.map(normalizeBubble).filter(Boolean);
  const bubbles=[];
  const lines=String(panel?.dialogue||'').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,5);
  lines.forEach((line,i)=>{
    const shout=/!/.test(line)&&!/\?/.test(line);
    const thought=/^\*[^*]+\*$/.test(line)||/^\([^)]+\)$/.test(line);
    const text=line.replace(/^[^:]{1,40}:\s+/,'');
    bubbles.push(createBubble(thought?'thought-cloud':shout?'shout-burst':'round-speech',{text,x:0.08+(i%2)*0.3,y:Math.min(0.7,0.04+i*0.18),tailX:i%2?0.28:-0.22,tailY:0.86}));
  });
  const caption=String(panel?.caption||'').trim();
  if(caption) bubbles.push(createBubble('caption-box',{text:caption,x:0.08,y:0.78,w:0.84,h:0.16,tailX:0.02,tailY:0.7}));
  return bubbles;
}
export function tailPoint(b){return {x:b.x+b.w/2+b.tailX*b.w,y:b.y+b.h/2+b.tailY*b.h};}
export function pointTailPath(b){
  const S=1000,x=b.x*S,y=b.y*S,w=b.w*S,h=b.h*S,tip=tailPoint(b),tx=tip.x*S,ty=tip.y*S,cx=x+w/2,cy=y+h/2;
  let dx=tx-cx,dy=ty-cy;const len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len,ax=cx+ux*(w/2),ay=cy+uy*(h/2),px=-uy,py=ux,spread=Math.max(8,Math.min(w,h)*0.14),f=n=>n.toFixed(2);
  return `M ${f(ax+px*spread)} ${f(ay+py*spread)} L ${f(tx)} ${f(ty)} L ${f(ax-px*spread)} ${f(ay-py*spread)} Z`;
}
export function thoughtCircles(b){
  const S=1000,tip=tailPoint(b),cx=(b.x+b.w/2)*S,cy=(b.y+b.h/2)*S,tx=tip.x*S,ty=tip.y*S;
  return [0.42,0.68,0.9].map((t,i)=>({x:cx+(tx-cx)*t,y:cy+(ty-cy)*t,r:[22,14,8][i]}));
}
export function tailMarkup(b){
  const bubble=normalizeBubble(b);if(!bubble) return '';
  const preset=presetById(bubble.preset);
  if(preset?.tail==='none') return '';
  if((preset?.tail||'point')==='circles') return thoughtCircles(bubble).map(c=>`<circle cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${c.r}"></circle>`).join('');
  return `<path d="${pointTailPath(bubble)}"></path>`;
}
export function renderLettering(bubbles,{interactive=false,selected=null}={}){
  const list=(bubbles||[]).map(normalizeBubble).filter(Boolean);
  const tails=list.map(tailMarkup).join('');
  const nodes=list.map(b=>{
    const preset=presetById(b.preset);
    const art=preset?`<img class="bubble-art" alt="" src="${esc(preset.src)}" style="transform:${b.flip?'scaleX(-1)':'none'}">`:`<div class="bubble-fallback"></div>`;
    const tip=tailPoint(b);
    const hx=((tip.x-b.x)/b.w)*100, hy=((tip.y-b.y)/b.h)*100;
    const body=interactive
      ? `<textarea data-bubble-text="${esc(b.id)}" maxlength="500" aria-label="Bubble text">${esc(b.text)}</textarea><button type="button" class="handle move" data-handle="move" aria-label="Move bubble">✥</button><button type="button" class="handle tail" data-handle="tail" style="left:${hx}%;top:${hy}%" aria-label="Move tail"></button><button type="button" class="handle resize" data-handle="resize" aria-label="Resize bubble"></button>`
      : `<div class="bubble-copy">${esc(b.text)}</div>`;
    return `<div class="placed-bubble${selected===b.id?' selected':''}" data-bubble-id="${esc(b.id)}" style="left:${b.x*100}%;top:${b.y*100}%;width:${b.w*100}%;height:${b.h*100}%;--fs:${b.fontSize}">${art}${body}</div>`;
  }).join('');
  return `<div class="lettering-layer${interactive?' editing':''}"><svg class="tail-layer" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">${tails}</svg>${nodes}</div>`;
}
export function applyBubbleElement(node,bubble){
  const b=normalizeBubble(bubble)||bubble;
  node.style.left=(b.x*100)+'%';
  node.style.top=(b.y*100)+'%';
  node.style.width=(b.w*100)+'%';
  node.style.height=(b.h*100)+'%';
  node.style.setProperty('--fs',String(b.fontSize));
  const img=node.querySelector?.('.bubble-art');
  if(img) img.style.transform=b.flip?'scaleX(-1)':'none';
  const handle=node.querySelector?.('[data-handle="tail"]');
  if(handle){const tip=tailPoint(b);handle.style.left=((tip.x-b.x)/b.w*100)+'%';handle.style.top=((tip.y-b.y)/b.h*100)+'%';}
}
export function coverRect(srcW,srcH,dstW,dstH){const scale=Math.max(dstW/Math.max(1,srcW),dstH/Math.max(1,srcH));const w=srcW*scale,h=srcH*scale;return {x:(dstW-w)/2,y:(dstH-h)/2,w,h};}
function wrapLines(ctx,text,maxWidth){
  const lines=[];
  for(const para of String(text||'').split('\n')){
    const words=para.split(/\s+/).filter(Boolean);
    if(!words.length){lines.push('');continue;}
    let line='';
    for(const word of words){
      const next=line?line+' '+word:word;
      if(line&&ctx.measureText(next).width>maxWidth){lines.push(line);line=word;}
      else line=next;
    }
    if(line) lines.push(line);
  }
  return lines.slice(0,8);
}
export function paintBubbles(ctx,box,bubbles,images){
  for(const raw of bubbles||[]){
    const b=normalizeBubble(raw);if(!b) continue;
    const x=box.x+b.x*box.w,y=box.y+b.y*box.h,w=b.w*box.w,h=b.h*box.h;
    const tipX=box.x+tailPoint(b).x*box.w,tipY=box.y+tailPoint(b).y*box.h;
    const preset=presetById(b.preset);
    ctx.save();
    ctx.fillStyle='#fffaf7';ctx.strokeStyle='#352832';ctx.lineWidth=Math.max(2,box.w*0.006);ctx.lineJoin='round';
    if(preset?.tail==='circles'){
      const cx=x+w/2,cy=y+h/2;
      for(const t of [0.42,0.68,0.9]){const r=Math.max(3,(1-t)*Math.min(w,h)*0.16);ctx.beginPath();ctx.arc(cx+(tipX-cx)*t,cy+(tipY-cy)*t,r,0,Math.PI*2);ctx.fill();ctx.stroke();}
    }else if(preset?.tail!=='none'){
      const cx=x+w/2,cy=y+h/2;let dx=tipX-cx,dy=tipY-cy;const len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;
      const ax=cx+dx*(w/2),ay=cy+dy*(h/2),px=-dy,py=dx,spread=Math.max(4,Math.min(w,h)*0.12);
      ctx.beginPath();ctx.moveTo(ax+px*spread,ay+py*spread);ctx.lineTo(tipX,tipY);ctx.lineTo(ax-px*spread,ay-py*spread);ctx.closePath();ctx.fill();ctx.stroke();
    }
    ctx.save();ctx.translate(x+w/2,y+h/2);if(b.flip) ctx.scale(-1,1);
    const image=images?.get?.(b.preset);
    let drew=false;
    if(image){try{ctx.drawImage(image,-w/2,-h/2,w,h);drew=true;}catch{drew=false;}}
    if(!drew){ctx.fillStyle=preset?.id==='caption-box'?'#ddf4f0':'#fffaf7';roundRect(ctx,-w/2,-h/2,w,h,Math.min(w,h)*0.2);ctx.fill();ctx.stroke();}
    ctx.restore();
    ctx.fillStyle='#352832';ctx.textAlign='center';ctx.textBaseline='middle';
    const size=Math.max(10,b.fontSize*box.w);ctx.font=`600 ${size}px Georgia, serif`;
    const lines=wrapLines(ctx,b.text,w*0.72),lh=size*1.15,top=y+h/2-((lines.length-1)*lh)/2;
    lines.forEach((line,i)=>ctx.fillText(line,x+w/2,top+i*lh,w*0.72));
    ctx.restore();
  }
}
function roundRect(ctx,x,y,w,h,r){const radius=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+radius,y);ctx.arcTo(x+w,y,x+w,y+h,radius);ctx.arcTo(x+w,y+h,x,y+h,radius);ctx.arcTo(x,y+h,x,y,radius);ctx.arcTo(x,y,x+w,y,radius);ctx.closePath();}
