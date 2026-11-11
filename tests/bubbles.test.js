import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BUBBLE_PRESETS, createBubble, presetById, renderLettering, seedBubbles, moveBubble, resizeBubble, dragUpdate, flipTail, setFontSize, setBubbleText, pointTailPath, tailPoint, tailMarkup} from '../bubbles.js';

test('built-in presets are one config array of svg files', ()=>{
  assert.equal(BUBBLE_PRESETS.length, 5);
  const ids=BUBBLE_PRESETS.map(p=>p.id);
  assert.deepEqual(ids, ['round-speech','thought-cloud','shout-burst','whisper-dashed','caption-box']);
  for(const preset of BUBBLE_PRESETS){
    assert.equal(typeof preset.name, 'string');
    assert.match(preset.src, /^bubbles\/.+\.svg$/);
    assert.ok(['point','circles','none'].includes(preset.tail));
    assert.equal(fs.existsSync(new URL('../'+preset.src, import.meta.url)), true);
    const svg=fs.readFileSync(new URL('../'+preset.src, import.meta.url), 'utf8');
    assert.match(svg, /<svg/);
  }
  const source=fs.readFileSync(new URL('../bubbles.js', import.meta.url), 'utf8');
  assert.match(source, /export const BUBBLE_PRESETS/);
  assert.match(source, /drop a PNG or SVG into \/bubbles/);
});

test('a new preset is picked up from the config array alone', ()=>{
  const extra={id:'custom-heart',name:'Heart',src:'bubbles/custom-heart.svg',tail:'point'};
  BUBBLE_PRESETS.push(extra);
  try{
    assert.equal(presetById('custom-heart'), extra);
    const bubble=createBubble('custom-heart',{text:'Hi'});
    assert.match(renderLettering([bubble]), /bubbles\/custom-heart\.svg/);
  }finally{
    BUBBLE_PRESETS.pop();
  }
  assert.equal(presetById('custom-heart'), null);
  assert.throws(()=>createBubble('missing'), /BUBBLE_PRESETS/);
});

test('bubbles can be moved, resized, flipped, retyped, and deleted by data', ()=>{
  const bubble=createBubble('round-speech',{text:'Hello',x:0.2,y:0.2,w:0.4,h:0.2,tailX:0.2,tailY:0.8});
  const moved=dragUpdate('move', bubble, {x:0,y:0}, {x:0.1,y:-0.05});
  assert.ok(Math.abs(moved.x-0.3)<1e-9);
  assert.ok(Math.abs(moved.y-0.15)<1e-9);
  assert.equal(moved.id, bubble.id);
  const clamped=moveBubble(bubble, 9, -4);
  assert.equal(clamped.x, 0.92);
  assert.equal(clamped.y, -0.05);
  const sized=resizeBubble(bubble, 0.01, 3);
  assert.equal(sized.w, 0.16);
  assert.equal(sized.h, 0.9);
  const flipped=flipTail(bubble);
  assert.equal(flipped.flip, true);
  assert.ok(Math.abs(flipped.tailX+bubble.tailX)<1e-9);
  assert.equal(flipTail(flipped).flip, false);
  const typed=setBubbleText(bubble, 'x'.repeat(800));
  assert.equal(typed.text.length, 500);
  const font=setFontSize(bubble, 0.2);
  assert.equal(font.fontSize, 0.12);
  const tail=dragUpdate('tail', bubble, {x:0,y:0}, tailPoint({...bubble, tailX:0.4, tailY:-0.2}));
  assert.ok(tail.tailY<bubble.tailY);
  const html=renderLettering([{...bubble, text:'<script>alert(1)</script>'}], {interactive:true, selected:bubble.id});
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-handle="tail"/);
  assert.match(html, /data-handle="resize"/);
  assert.match(html, /data-handle="move"/);
  assert.match(html, /<textarea/);
  assert.match(pointTailPath(bubble), /^M /);
  assert.match(tailMarkup(createBubble('thought-cloud')), /<circle/);
});

test('dialogue seeds editable bubbles without replacing ones already saved', ()=>{
  const seeded=seedBubbles({dialogue:'Mira: Hello there\nRowan: Look out!',caption:'Later that night',bubbles:[]});
  assert.equal(seeded[0].preset, 'round-speech');
  assert.equal(seeded[0].text, 'Hello there');
  assert.equal(seeded[1].preset, 'shout-burst');
  assert.equal(seeded.at(-1).preset, 'caption-box');
  assert.equal(seeded.at(-1).text, 'Later that night');
  const kept=seedBubbles({dialogue:'Mira: Hi',bubbles:[createBubble('whisper-dashed',{text:'psst',id:'bubble-1'})]});
  assert.equal(kept.length, 1);
  assert.equal(kept[0].preset, 'whisper-dashed');
  assert.equal(kept[0].text, 'psst');
  const view=renderLettering(kept);
  assert.match(view, /class="bubble-copy"/);
  assert.doesNotMatch(view, /<textarea/);
});
