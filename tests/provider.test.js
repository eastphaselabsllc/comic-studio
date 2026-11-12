import test from 'node:test';
import assert from 'node:assert/strict';
import {Provider, defaults, planInstruction, isCancelled, explainRequestError, explainHttpStatus, imagePromptLimit, localFacePayload, veniceImageBody, readChatStream, IMAGE_NEGATIVE} from '../provider.js';
import {panelPrompt} from '../core.js';

const memory=new Map();
globalThis.localStorage={
  getItem:key=>memory.has(key)?memory.get(key):null,
  setItem:(key,value)=>memory.set(key,String(value)),
  removeItem:key=>memory.delete(key),
  clear:()=>memory.clear()
};

const characters=[{id:'c1',age:32,fictional:true,name:'Mira'}];
const script='Mira waits beside the glass.\n\nRowan smiles at the flowers.\n\nNeither of them is in a hurry.';

test('provider defaults and demo planning do not call the network', async ()=>{
  assert.equal(defaults.panelCount, 45);
  assert.equal(defaults.textModel, 'most_uncensored');
  assert.match(planInstruction({}), /maximum 36 panels/);
  assert.match(planInstruction({targetPanels:45}), /exactly 45/);
  assert.match(planInstruction({}), /dialogue and caption must be an empty string/);
  assert.doesNotMatch(planInstruction({targetPanels:45}), /one line per bubble/);
  assert.match(IMAGE_NEGATIVE, /speech bubble/);
  assert.match(IMAGE_NEGATIVE, /letters/);
  assert.doesNotMatch(IMAGE_NEGATIVE, /unreadable text/);
  let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('network should not be called');};
  const provider=new Provider({...defaults, demo:true}, async()=>{throw Error('demo should not ask');});
  const planned=await provider.text('plan',{script,cast:[{id:'c1'}],targetPanels:45},characters);
  const count=planned.pages.reduce((n,p)=>n+p.panels.length,0);
  assert.equal(count, 45);
  const quick=await provider.text('plan',{script,cast:[{id:'c1'}]},characters);
  const quickCount=quick.pages.reduce((n,p)=>n+p.panels.length,0);
  assert.ok(quickCount>=1&&quickCount<=6);
  assert.equal(calls, 0);
});

test('a normal image still requires approval and a batch can abort before any image returns', async ()=>{
  localStorage.setItem('cs_k','not-a-real-key');
  let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('should not fetch');};
  const declined=new Provider({...defaults, demo:false, localURL:''}, async()=>false, ()=>{});
  await assert.rejects(()=>declined.image('Two fictional adults stand in a garden.',[],[{age:30,fictional:true}]), /Cancelled/);
  assert.equal(calls, 0);
  const controller=new AbortController();
  let fetches=0;
  globalThis.fetch=(url, opts)=>new Promise((_,reject)=>{
    fetches++;
    assert.match(String(url), /^https:\/\/api\.venice\.ai\//);
    const fail=()=>{const error=Error('aborted');error.name='AbortError';reject(error);};
    if(opts.signal.aborted) fail();
    else opts.signal.addEventListener('abort', fail, {once:true});
  });
  const provider=new Provider({...defaults, demo:false, localURL:''}, async()=>{throw Error('batch approval should happen once, outside image()');});
  const pending=provider.image('Two fictional adults stand in a garden.',[],[{age:30,fictional:true}],{approved:true,signal:controller.signal});
  await new Promise(resolve=>setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, error=>isCancelled(error));
  assert.equal(fetches, 1);
});

test('network failures explain themselves and streaming does not wait in silence', async ()=>{
  assert.match(explainRequestError(new TypeError('Load failed')), /connection dropped/i);
  assert.doesNotMatch(explainRequestError(new TypeError('Load failed')), /Load failed/);
  assert.equal(explainRequestError(Error('Write your episode first.')), 'Write your episode first.');
  assert.match(explainHttpStatus(401, 'Authentication failed'), /API key/);
  assert.equal(imagePromptLimit('lustify-sdxl', []), 1500);
  assert.equal(imagePromptLimit('chroma', []), 7500);
  assert.equal(imagePromptLimit('custom', [{id:'custom',model_spec:{constraints:{promptCharacterLimit:3200}}}]), 3200);
  const face='A'.repeat(32);
  const local=localFacePayload({prompt:'Exact character identity',width:832}, `data:image/jpeg;base64,${face}`);
  assert.equal(local.face_b64, face);
  assert.equal(local.seed, undefined);
  assert.doesNotMatch(JSON.stringify(local), /data:image/);
  assert.equal(localFacePayload({prompt:'x'}, 'data:image/jpeg;base64,short').face_b64, undefined);
  const chroma=veniceImageBody({prompt:'keep me'}, [`data:image/jpeg;base64,${face}`], {supportsStyleReferences:false}, 42, 'chroma');
  assert.equal(chroma.seed, 42);
  assert.equal(chroma.safe_mode, false);
  assert.equal(chroma.style_references, undefined);
  const krea=veniceImageBody({prompt:'p'}, ['one','two','three','four'], {supportsStyleReferences:true,constraints:{maxStyleReferences:1,supportsStyleReferenceStrength:true}}, 7, 'krea-v2-large');
  assert.equal(krea.style_references.length, 1);
  assert.equal(krea.style_references[0].image, 'one');
  assert.equal(krea.style_references[0].strength, .7);
  const luma=veniceImageBody({prompt:'p'}, ['one'], {supportsStyleReferences:true,constraints:{maxStyleReferences:3,supportsStyleReferenceStrength:false}}, 3, 'luma-uni-1');
  assert.equal(luma.style_references[0].strength, undefined);

  localStorage.setItem('cs_k','not-a-real-key');
  const provider=new Provider({...defaults, demo:false, textModel:'most_uncensored'}, async()=>true, ()=>{});
  let body;
  const encoder=new TextEncoder();
  const packets=[
    'data: {"choices":[{"delta":{"reasoning_content":"secret think","content":""}}]}\n\ndata: {"choices":[{"delta":{"content":"Hel',
    'lo sky"}}]}\n\ndata: [DONE]\n\n'
  ];
  globalThis.fetch=async(_url, opts)=>{
    body=JSON.parse(opts.body);
    return new Response(new ReadableStream({start(controller){for(const packet of packets)controller.enqueue(encoder.encode(packet));controller.close();}}), {status:200, headers:{'content-type':'text/event-stream'}});
  };
  const polished=await provider.text('polish', {script:'Hello there friend'}, characters);
  assert.equal(polished, 'Hello sky');
  assert.equal(body.stream, true);
  assert.equal(body.model, 'most_uncensored');
  assert.equal(body.max_tokens, undefined);
  assert.ok(body.max_completion_tokens<=8192);
  assert.equal(body.venice_parameters.disable_thinking, true);
  assert.equal(body.venice_parameters.strip_thinking_response, true);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.venice_parameters.include_venice_system_prompt, true);

  globalThis.fetch=async()=>{throw new TypeError('Load failed');};
  await assert.rejects(()=>provider.text('polish', {script:'Hello there friend'}, characters), error=>{
    assert.equal(error.retryable, true);
    assert.match(error.message, /connection dropped/i);
    assert.doesNotMatch(error.message, /Load failed/);
    return true;
  });

  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Authentication failed'}), {status:401, headers:{'content-type':'application/json'}});
  await assert.rejects(()=>provider.text('polish', {script:'Hello there friend'}, characters), error=>{
    assert.equal(error.status, 401);
    assert.match(error.message, /API key/);
    assert.equal(error.retryable, true);
    return true;
  });

  globalThis.fetch=async()=>new Response('data: {"error":{"code":"model_overloaded","message":"The model is currently overloaded"}}\n\ndata: [DONE]\n\n', {status:200, headers:{'content-type':'text/event-stream'}});
  await assert.rejects(()=>provider.text('polish', {script:'Hello there friend'}, characters), /busy/);

  provider.models=[{id:'qwen-3-8-27b',type:'text',model_spec:{traits:['default_vision'],maxCompletionTokens:65536,capabilities:{supportsReasoning:true}}}];
  provider.settings.textModel='default_vision';
  const planJSON=JSON.stringify({pages:[{layout:'single',panels:[{camera:'Wide shot',prompt:'Mira waits.',cast:['c1'],dialogue:'',caption:''}]}]});
  globalThis.fetch=async(_url, opts)=>{
    body=JSON.parse(opts.body);
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:planJSON}}]})}\n\ndata: [DONE]\n\n`, {status:200, headers:{'content-type':'text/event-stream'}});
  };
  const planned=await provider.text('plan', {script:'Mira waits beside the glass.', cast:[{id:'c1'}]}, characters);
  assert.equal(planned.pages[0].panels[0].prompt, 'Mira waits.');
  assert.equal(body.model, 'qwen-3-8-27b');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.venice_parameters.disable_thinking, true);
  assert.ok(body.max_completion_tokens<=8000);

  const seen=[];
  globalThis.fetch=async(_url, opts)=>{seen.push(JSON.parse(opts.body));throw new TypeError('Failed to fetch');};
  const prompt=panelPrompt({style:'Ink',camera:'Close-up',scene:'She smiles.',characters:[{name:'Mira',age:32,description:'amber eyes',hair:'dark curls'}],limit:7500});
  await assert.rejects(()=>provider.image(prompt, [], [{age:32,fictional:true,name:'Mira'}], {approved:true, seed:4242}), /connection dropped/);
  assert.equal(seen[0].seed, 4242);
  assert.equal(seen[0].safe_mode, false);
  assert.equal(seen[0].model, 'chroma');
  assert.equal(seen[0].style_references, undefined);
  assert.match(seen[0].prompt, /Exact character identity/);
  assert.match(seen[0].prompt, /dark curls/);
  assert.equal(await readChatStream(new Response('data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}})), 'AB');
});

test('a configured local server does not fall back to Venice when the picture fails', async ()=>{
  localStorage.setItem('cs_k','venice-key-should-not-be-sent');
  localStorage.setItem('cs_local_k','local-token');
  const urls=[];
  globalThis.fetch=async url=>{urls.push(String(url));throw new TypeError('Load failed');};
  const provider=new Provider({...defaults,demo:false,localURL:'https://pc.example',allowCloudFallback:true},async()=>{throw Error('should not ask to switch to Venice');});
  await assert.rejects(()=>provider.image('Two fictional adults stand in a garden.',[],[{age:32,fictional:true,name:'Mira'}],{approved:true}),error=>{
    assert.equal(error.local,true);
    assert.equal(error.retryable,true);
    assert.match(error.message,/try again/i);
    assert.doesNotMatch(error.message,/Venice/);
    return true;
  });
  assert.ok(urls.some(url=>url.startsWith('https://pc.example/image/generate')));
  assert.equal(urls.some(url=>/venice\.ai/i.test(url)),false);
  assert.equal(JSON.stringify(urls).includes('venice-key-should-not-be-sent'),false);
});
