import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {POLICY, assertSafe} from '../core.js';

const source=fs.readFileSync(new URL('../core.js', import.meta.url), 'utf8');

test('content policy still blocks minors and age ambiguity', ()=>{
  assert.match(POLICY, /Never depict minors or anyone under 18/);
  assert.match(POLICY, /age ambiguity or childlike framing/);
  assert.match(POLICY, /Explicit adult content and nudity between consenting fictional adults \(18\+\) is allowed/);
  assert.match(source, /minor\|underage\|under\[- \]\?18\|preteen\|teen\(\?:ager\|aged\)\?s\?/);
  assert.match(source, /schoolgirl\|schoolboy/);
  assert.match(source, /young\[- \]looking\|baby\[- \]\?faced\?/);
  assert.match(source, /bestiality\|zoophilia/);
  assert.match(source, /rape\|raping\|nonconsensual/);
  for(const phrase of ['a child in the scene','teenagers at a dance','schoolgirl','16 years old','age: 15','barely legal','young-looking','loli','high school','bestiality','rape']){
    assert.throws(()=>assertSafe(phrase), /not allowed|18 or older|Adults only/);
  }
  assert.throws(()=>assertSafe('fine',[{age:17,fictional:true}]), /18/);
  assert.throws(()=>assertSafe('fine',[{age:30,fictional:false}]), /fictional/);
  assert.doesNotThrow(()=>assertSafe('Explicit nudity between consenting fictional adults, age 32 and 35.',[{age:32,fictional:true},{age:35,fictional:true}]));
});
