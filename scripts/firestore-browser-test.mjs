import {chromium} from '@playwright/test';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,setDoc} from 'firebase/firestore';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const live=process.env.LIVE_TEST_INVITE_FILE?JSON.parse(fs.readFileSync(process.env.LIVE_TEST_INVITE_FILE,'utf8')):null;
const env=live?null:await initializeTestEnvironment({projectId:'demo-jongwon',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.collaboration.rules','utf8')}});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
const contexts=[await browser.newContext({viewport:{width:1440,height:1000}}),await browser.newContext({viewport:{width:1440,height:1000}})];
const pages=[await contexts[0].newPage(),await contexts[1].newPage()];const errors=[];
for(const p of pages)p.on('pageerror',e=>errors.push(e.message));
const id=(live?'validation-':'e2e-')+Date.now();const users=[];
const invite=live?.invite||'emulator-invite-'+Date.now();
if(env)await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'teams','team-3','collaborationInvites',createHash('sha256').update(invite).digest('hex')),{enabled:true}));
async function grant(page){await page.locator('button[type=submit]').click();}
const position={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:1,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:1,cellParaIndex:0}],charOffset:0};
const text=p=>p.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000));
try{
 for(let i=0;i<2;i++){
  const p=pages[i];await p.bringToFront();await p.goto(`${process.env.TEST_BASE_URL||'http://127.0.0.1:5173/'}?${live?'':'emulator=1&'}team=team-3&doc=${id}&name=${i?'Bob':'Alice'}#invite=${invite}`);await grant(p);
  if(i===0){await p.locator('#create').click();}
  await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});users.push(await p.evaluate(()=>window.__collab?.author||null));
 }
 for(const p of pages)await p.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);
 await Promise.all([pages[0].keyboard.insertText('화재예방 '),pages[1].keyboard.insertText('안전교육 ')]);
 for(const p of pages)await p.waitForFunction(()=>{const w=document.querySelector('#studio').contentWindow,t=w.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000);return t.includes('화재예방')&&t.includes('안전교육');},null,{timeout:25000});
 assert.equal(await text(pages[0]),await text(pages[1]));console.log('PASS Firestore: independent browser contexts, same-cell concurrent Korean text');
 await contexts[1].setOffline(true);await pages[1].evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);await pages[1].keyboard.insertText('오프라인수정 ');
 await pages[1].waitForTimeout(800);await contexts[1].setOffline(false);
 await pages[0].waitForFunction(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).includes('오프라인수정'),null,{timeout:30000});
 console.log('PASS Firestore: offline edit delivered after reconnection');
 await pages[0].evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);await pages[0].keyboard.press('ControlOrMeta+z');
 await pages[1].waitForFunction(()=>!document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).includes('화재예방'),null,{timeout:20000});
 assert.ok((await text(pages[1])).includes('안전교육'));console.log('PASS Firestore: undo retained other user edits');
 await pages[0].bringToFront();await pages[0].reload();await pages[0].locator('button[type=submit]').click();await pages[0].waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});assert.ok((await text(pages[0])).includes('오프라인수정'));
 console.log('PASS Firestore: reload recovered persisted updates');
 if(process.env.LARGE_TEST==='1'){
  for(let i=0;i<2;i++){
   const size=await pages[i].evaluate(async seed=>{
    const c=document.createElement('canvas');c.width=c.height=2048;const x=c.getContext('2d'),im=x.createImageData(2048,2048);let n=seed+1;
    for(let j=0;j<im.data.length;j+=4){n=(Math.imul(n,1664525)+1013904223)>>>0;im.data[j]=n&255;im.data[j+1]=(n>>>8)&255;im.data[j+2]=(n>>>16)&255;im.data[j+3]=255;}x.putImageData(im,0,0);
    const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.85)),bytes=new Uint8Array(await blob.arrayBuffer()),h=document.querySelector('#studio').contentWindow.__inputHandler;
    const result=h.wasm.insertPicture(0,0,0,'',bytes,7200,7200,2048,2048,'jpg','large-test-'+seed);if(!result.ok)throw Error('picture insert failed');h.eventBus.emit('document-changed');return bytes.length;
   },i);
   assert.ok(size>2*1024*1024);await pages[i].waitForTimeout(600);
   await pages[i].waitForFunction(()=>document.querySelector('#save-status').textContent==='Firestore에 저장됨',null,{timeout:60000});
   for(const p of pages)await p.waitForFunction(n=>[...window.__collab.doc.getMap('blobs').keys()].filter(k=>k.startsWith('BinData/')).length>=n,i+1,{timeout:60000});
   console.log('PASS large JPEG saved',size);
  }
  await pages[0].reload();await pages[0].locator('button[type=submit]').click();await pages[0].waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:60000});
  await pages[0].waitForFunction(()=>window.__collab?.binding,null,{timeout:60000});assert.equal(await pages[0].evaluate(()=>[...window.__collab.doc.getMap('blobs').keys()].filter(k=>k.startsWith('BinData/')).length),2);
  assert.ok(await pages[0].evaluate(async()=>{const m=await import('/src/sync-provider.js');try{m.encodeEnvelope(window.__collab.Y.encodeStateAsUpdate(window.__collab.doc),'test','test');return false;}catch(e){return e.message.includes('크기를 넘었습니다');}}));
  await pages[0].evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);
  const long='장문공동편집확인 '.repeat(500);await pages[0].keyboard.insertText(long);
  await pages[1].waitForFunction(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).includes('장문공동편집확인 '.repeat(500)),null,{timeout:60000});
  assert.equal(await text(pages[0]),await text(pages[1]));console.log('PASS Firestore: >4 MiB document reload and 5,000-character edit after two large JPEGs');
 }

 fs.mkdirSync('.test-output',{recursive:true});await pages[0].screenshot({path:'.test-output/firestore-desktop.png',fullPage:true});assert.equal(errors.length,0,errors.join('\n'));
}catch(e){console.error(e);for(const p of pages){console.log('ERROR UI',await p.locator('#error-text').textContent({timeout:1000}).catch(()=>''));}process.exitCode=1;}
finally{fs.mkdirSync('.test-output',{recursive:true});if(live)fs.writeFileSync(`.test-output/live-session-${id}.json`,JSON.stringify({id,users}));await browser.close();await env?.cleanup();}
