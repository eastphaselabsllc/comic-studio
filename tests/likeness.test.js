import test from 'node:test';
import assert from 'node:assert/strict';
import {Provider, defaults, referencePicker, isReferenceCapable, planLikeness, likenessBody, CLEAN_IMAGE, IMAGE_NEGATIVE, referenceBase64} from '../provider.js';
import {panelPrompt} from '../core.js';

const memory=new Map();
globalThis.localStorage={
  getItem:key=>memory.has(key)?memory.get(key):null,
  setItem:(key,value)=>memory.set(key,String(value)),
  removeItem:key=>memory.delete(key),
  clear:()=>memory.clear()
};

const face='data:image/jpeg;base64,'+'A'.repeat(48);
const faceB='data:image/jpeg;base64,'+'B'.repeat(48);
const chars=[{id:'c1',age:32,fictional:true,name:'Mira'}];

test('reference picker keeps edit and style models and leaves chroma on the text-only path', ()=>{
  const models=[
    {id:'chroma',type:'image',model_spec:{uncensored:true}},
    {id:'qwen-edit-uncensored',type:'inpaint',model_spec:{uncensored:true}},
    {id:'krea-v2-large',type:'image',model_spec:{supportsStyleReferences:true,constraints:{maxStyleReferences:3}}},
    {id:'lustify-sdxl',type:'image',model_spec:{uncensored:true}}
  ];
  const ids=referencePicker(models).map(m=>m.id);
  assert.equal(ids[0], 'qwen-edit-uncensored');
  assert.ok(ids.includes('krea-v2-large'));
  assert.equal(ids.includes('chroma'), false);
  assert.equal(ids.includes('lustify-sdxl'), false);
  assert.equal(isReferenceCapable(models[0]), false);
  assert.equal(isReferenceCapable(models[1]), true);
});

test('two portraits use multi-edit and one portrait uses edit', ()=>{
  const qwen=planLikeness({model:'qwen-edit-uncensored',record:null,count:2,prompt:'Mira and Rowan wait by the glass.'});
  assert.equal(qwen.path, '/image/multi-edit');
  assert.equal(qwen.composite, false);
  assert.equal(qwen.max, 3);
  const multi=likenessBody({kind:'multi',model:'qwen-edit-uncensored',prompt:qwen.prompt,images:[face,faceB],aspect:'2:3'});
  assert.equal(multi.modelId, 'qwen-edit-uncensored');
  assert.equal(multi.model, undefined);
  assert.equal(multi.safe_mode, false);
  assert.deepEqual(multi.images, [referenceBase64(face), referenceBase64(faceB)]);
  assert.doesNotMatch(multi.images[0], /^data:/);
  assert.equal(multi.negative_prompt, undefined);
  assert.equal(multi.width, undefined);
  assert.equal(multi.quality, undefined);
  assert.equal(multi.seed, undefined);
  assert.match(multi.prompt, /identical to their reference image/);
  assert.match(multi.prompt, /clean image with no text of any kind/);
  assert.equal(CLEAN_IMAGE, 'A clean image with no text of any kind.');
  assert.doesNotMatch(multi.prompt, /speech bubble|\bcomic\b|lettering/i);
  const one=planLikeness({model:'qwen-edit-uncensored',record:null,count:1,prompt:'Mira waits.'});
  assert.equal(one.path, '/image/edit');
  const single=likenessBody({kind:'edit',model:'qwen-edit-uncensored',prompt:one.prompt,images:[face],aspect:'2:3'});
  assert.equal(single.model, 'qwen-edit-uncensored');
  assert.equal(single.modelId, undefined);
  assert.equal(single.image, referenceBase64(face));
  assert.equal(single.safe_mode, false);
  const limited=planLikeness({model:'flux-2-max-edit',record:{id:'flux-2-max-edit',type:'inpaint',model_spec:{constraints:{maxInputImages:1,combineImages:false}}},count:2,prompt:'Both wait.'});
  assert.equal(limited.composite, true);
  assert.equal(limited.path, '/image/edit');
  assert.match(limited.prompt, /side by side/);
  const style=planLikeness({model:'krea-v2-large',record:{id:'krea-v2-large',type:'image',model_spec:{supportsStyleReferences:true,constraints:{maxStyleReferences:3,supportsStyleReferenceStrength:true}}},count:2,prompt:'Both wait.'});
  assert.equal(style.path, '/image/generate');
  assert.equal(style.composite, false);
  const styled=likenessBody({kind:'style',model:'krea-v2-large',prompt:style.prompt,images:[face,faceB],spec:style.spec,seed:7,negativePrompt:IMAGE_NEGATIVE});
  assert.equal(styled.style_references.length, 2);
  assert.match(styled.negative_prompt, /speech bubble/);
  assert.match(styled.negative_prompt, /signature/);
  assert.match(styled.negative_prompt, /logo/);
  assert.doesNotMatch(styled.prompt, /clean image with no text/);
});

test('likeness requests ask before spending and chroma stays text-only', async ()=>{
  localStorage.setItem('cs_k','not-a-real-key');
  let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('should not fetch');};
  const declined=new Provider({...defaults,demo:false,likenessMode:true,likenessModel:'qwen-edit-uncensored'}, async()=>false);
  await assert.rejects(()=>declined.image('Mira waits by the glass.',[],chars,{preparedImages:[face]}), /Cancelled/);
  assert.equal(calls, 0);
  const seen=[];
  globalThis.fetch=async(url,opts)=>{seen.push({url:String(url),body:JSON.parse(opts.body)});throw new TypeError('Failed to fetch');};
  const live=new Provider({...defaults,demo:false,likenessMode:true,likenessModel:'qwen-edit-uncensored'}, async()=>true);
  const prompt=panelPrompt({style:'Ink',camera:'Wide establishing shot',scene:'Mira waits by the glass.',characters:[{name:'Mira',age:32,description:'amber eyes',hair:'dark curls'}],likeness:true});
  await assert.rejects(()=>live.image(prompt,[],chars,{approved:true,preparedImages:[face,faceB]}), /connection dropped/);
  assert.match(seen[0].url, /\/image\/multi-edit$/);
  assert.equal(seen[0].body.modelId, 'qwen-edit-uncensored');
  assert.equal(seen[0].body.images.length, 2);
  assert.equal(seen[0].body.safe_mode, false);
  assert.match(seen[0].body.prompt, /identical to their reference image/);
  assert.match(seen[0].body.prompt, /clean image with no text of any kind/);
  seen.length=0;
  live.compose=async urls=>'data:image/jpeg;base64,'+'C'.repeat(40);
  live.settings.likenessModel='flux-2-max-edit';
  live.models=[{id:'flux-2-max-edit',type:'inpaint',model_spec:{constraints:{maxInputImages:1,combineImages:false}}}];
  await assert.rejects(()=>live.image(prompt,[],chars,{approved:true,preparedImages:[face,faceB]}), /connection dropped/);
  assert.match(seen[0].url, /\/image\/edit$/);
  assert.equal(typeof seen[0].body.image, 'string');
  assert.equal(seen[0].body.images, undefined);
  assert.match(seen[0].body.prompt, /side by side/);
  seen.length=0;
  const chroma=new Provider({...defaults,demo:false,likenessMode:false,imageModel:'chroma'}, async()=>true);
  await assert.rejects(()=>chroma.image(prompt,[],chars,{approved:true,seed:9,preparedImages:[face]}), /connection dropped/);
  assert.match(seen[0].url, /\/image\/generate$/);
  assert.equal(seen[0].body.model, 'chroma');
  assert.equal(seen[0].body.safe_mode, false);
  assert.equal(seen[0].body.style_references, undefined);
  assert.equal(seen[0].body.image, undefined);
  assert.match(seen[0].body.negative_prompt, /speech bubble/);
  assert.doesNotMatch(seen[0].body.prompt, /speech bubble|\bcomic\b/);
});

test('loading models reads image and inpaint lists without a paid call', async ()=>{
  localStorage.setItem('cs_k','not-a-real-key');
  const urls=[];
  globalThis.fetch=async url=>{
    urls.push(String(url));
    if(String(url).includes('type=inpaint'))return new Response(JSON.stringify({data:[{id:'qwen-edit-uncensored',type:'image',model_spec:{uncensored:true}},{id:'retired-edit',type:'image',model_spec:{deprecation:{date:'2020'}}}]}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({data:[{id:'chroma',type:'image',model_spec:{uncensored:true}},{id:'krea-v2-large',type:'image',model_spec:{supportsStyleReferences:true,constraints:{maxStyleReferences:3}}},{id:'most_uncensored',type:'text',model_spec:{uncensored:true}}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  const provider=new Provider({...defaults,demo:false}, async()=>{throw Error('model list is not a paid generation');});
  const models=await provider.loadModels();
  assert.ok(urls.some(url=>url.endsWith('/models?type=all')));
  assert.ok(urls.some(url=>url.endsWith('/models?type=inpaint')));
  assert.equal(models.find(m=>m.id==='qwen-edit-uncensored').type, 'inpaint');
  assert.equal(models.some(m=>m.id==='retired-edit'), false);
  assert.ok(referencePicker(models).some(m=>m.id==='krea-v2-large'));
  assert.equal(referencePicker(models).some(m=>m.id==='chroma'), false);
});
