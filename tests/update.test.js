import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {VERSION, APP_CACHE_PREFIX, isAppShellCache, shouldDeferUpdateReload, recentUpdateReload} from '../core.js';

const app=fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const sw=fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const html=fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(source, name){
  const start=source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, name);
  let depth=0;
  for(let i=source.indexOf('{', start); i<source.length; i++){
    if(source[i]==='{')depth++;
    else if(source[i]==='}'){
      depth--;
      if(depth===0)return source.slice(start, i+1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

test('the footer version and the service worker cache move together', ()=>{
  assert.equal(VERSION, '1.14.0');
  assert.equal(APP_CACHE_PREFIX, 'comic-studio-');
  assert.match(sw, new RegExp(`const CACHE='${APP_CACHE_PREFIX}v${VERSION.replaceAll('.', '\\.')}'`));
  assert.match(app, /Comic Studio v\$\{VERSION\}/);
  assert.match(html, /Update ready - tap to reload/);
});

test('only comic-studio- caches are eligible for deletion', ()=>{
  const keys=['comic-studio-v1.14.0','comic-studio-v1.13.2','comic-studio-v1.13.1','comic-studio-v1.10.0','comic-studio','user-photos','',null,'Comic-Studio-v1'];
  assert.deepEqual(keys.filter(isAppShellCache), ['comic-studio-v1.14.0','comic-studio-v1.13.2','comic-studio-v1.13.1','comic-studio-v1.10.0']);
});

test('automatic reload waits for a generation, a batch, or unsaved edits and will not loop', ()=>{
  assert.equal(shouldDeferUpdateReload({}), false);
  assert.equal(shouldDeferUpdateReload({busy:true}), true);
  assert.equal(shouldDeferUpdateReload({batch:true}), true);
  assert.equal(shouldDeferUpdateReload({unsaved:true}), true);
  const now=1_000_000;
  assert.equal(recentUpdateReload('', now), false);
  assert.equal(recentUpdateReload('0', now), false);
  assert.equal(recentUpdateReload(String(now-1000), now), true);
  assert.equal(recentUpdateReload(String(now-15000), now), false);
  assert.equal(recentUpdateReload('nope', now), false);
  assert.match(app, /shouldDeferUpdateReload\(\{busy,batch:!!batchAbort,unsaved:unsavedWork\(\)\}\)/);
  assert.match(app, /unsavedWork\(\)\{if\(bubbleGesture\)return true/);
  assert.match(app, /#settingsForm/);
});

test('the page bypasses the HTTP cache when checking the service worker', ()=>{
  assert.match(app, /navigator\.serviceWorker\.register\('\.\/sw\.js',\{updateViaCache:'none'\}\)/);
  assert.match(app, /addEventListener\('controllerchange',onControllerChange\)/);
  assert.match(app, /reg\.update\(\)/);
  assert.match(app, /visibilityState==='visible'\)swRegistration\?\.update\(\)/);
  assert.match(app, /Check for updates/);
  assert.match(app, /'check-updates':\(\)=>checkForUpdates\(\)/);
  assert.match(app, /Update ready - tap to reload/);
});

test('check for updates clears only app caches and reloads', ()=>{
  const fn=extractFunction(app, 'checkForUpdates');
  assert.match(fn, /\.update\(/);
  assert.match(fn, /caches\.keys/);
  assert.match(fn, /caches\.delete/);
  assert.match(fn, /isAppShellCache/);
  assert.match(fn, /location\.reload/);
  assert.doesNotMatch(fn, /indexedDB|localStorage|deleteDatabase|removeItem|\.clear\(/);
  const reload=extractFunction(app, 'reloadUpdatedApp');
  assert.match(reload, /flush\(/);
  assert.doesNotMatch(reload, /indexedDB|localStorage|caches\.delete|deleteDatabase/);
});
