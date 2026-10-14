import {chromium} from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
const results=[];
async function run(name,actions,check){
 if(process.env.CASE&&!name.includes(process.env.CASE))return;
 const ctx=await browser.newContext(),pages=[await ctx.newPage(),await ctx.newPage()];
 try{
  const url=`http://127.0.0.1:5173/?demo=1&room=structure-${name}-${Date.now()}`;
  for(const p of pages){await p.bringToFront();await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
  for(const p of pages)await p.evaluate(()=>{window.__collab.binding.scheduleRemote=()=>{};});
  for(const p of pages)await p.evaluate(async()=>{window.__model=await import('/src/document-model.js');window.__before=window.__model.snapshotParts(window.__collab.binding.mirror);});
  await actions(pages);
  for(const p of pages)await p.evaluate(()=>{window.__nativeAfter=window.__model.readHwpx(window.__collab.studio.exportHwpx());});
  for(const p of pages)await p.evaluate(async()=>{window.__collab.binding.capture();await window.__collab.provider.flush();});
  await pages[0].waitForTimeout(1000);
  for(const p of pages)await p.evaluate(async()=>{await window.__collab.binding.applyRemote();});
  for(const p of pages){const error=await p.locator('#error-text').textContent();assert.equal(error,'',error);}
  await check(pages);
  console.log('PASS',name);results.push({name,pass:true});
 }catch(e){console.log('FAIL',name,e.message);fs.mkdirSync('.test-output',{recursive:true});for(let i=0;i<pages.length;i++){fs.writeFileSync(`.test-output/${name}-${i}.json`,JSON.stringify(await pages[i].evaluate(()=>({before:window.__before,after:window.__nativeAfter,shared:window.__model.snapshotParts(window.__collab.doc)}))));}results.push({name,pass:false,error:e.message});}
 finally{await ctx.close();}
}
const mutate=(p,fn)=>p.evaluate(fn);
const text=p=>p.evaluate(async()=>{const m=await import('/src/document-model.js');return m.nodePlainText(window.__collab.doc,window.__collab.doc.getMap('parts').get('Contents/section0.xml'));});
const insert=p=>mutate(p,()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;h.wasm.insertTextInCell(0,1,0,1,0,0,'동료보존');h.eventBus.emit('document-changed');});
const requireText=async pages=>{for(const p of pages)assert.ok((await text(p)).includes('동료보존'));};
try{
 await run('insert-row-with-peer-text',async([a,b])=>{await mutate(a,()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;assertNative(h.wasm.insertTableRow(0,1,0,2,true));function assertNative(r){if(!r.ok)throw Error('native insert failed');}h.eventBus.emit('document-changed');});await insert(b);},async pages=>{await requireText(pages);for(const p of pages)assert.equal(await p.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTableDimensions(0,1,0).rowCount),11);});
 await run('concurrent-row-insert',async pages=>{for(const p of pages)await mutate(p,()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;h.wasm.insertTableRow(0,1,0,2,true);h.eventBus.emit('document-changed');});},async pages=>{for(const p of pages)assert.equal(await p.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTableDimensions(0,1,0).rowCount),12);});
 await run('delete-row-with-peer-text',async([a,b])=>{await mutate(a,()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;h.wasm.deleteTableRow(0,1,0,2);h.eventBus.emit('document-changed');});await insert(b);},requireText);
 await run('merge-first-row-with-peer-text',async([a,b])=>{await mutate(a,()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler,r=h.wasm.mergeTableCells(0,1,0,0,0,0,10);if(!r.ok)throw Error('merge native failed');h.eventBus.emit('document-changed');});await insert(b);},requireText);
 await run('paragraph-split-with-peer-text',async([a,b])=>{await mutate(a,()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;h.wasm.splitParagraphInCell(0,1,0,1,0,0);h.eventBus.emit('document-changed');});await insert(b);},requireText);
 await run('concurrent-different-pictures',async pages=>{for(let i=0;i<2;i++)await pages[i].evaluate(async color=>{const h=document.querySelector('#studio').contentWindow.__inputHandler,c=document.createElement('canvas');c.width=128;c.height=128;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,128,128);const bytes=new Uint8Array(await(await fetch(c.toDataURL())).arrayBuffer());const r=h.wasm.insertPicture(0,0,0,'',bytes,7200,7200,128,128,'png',color);if(!r.ok)throw Error('picture native failed');h.eventBus.emit('document-changed');},i?'blue':'red');},async pages=>{for(const p of pages)assert.equal(await p.evaluate(()=>[...window.__collab.doc.getMap('blobs').keys()].filter(k=>k.startsWith('BinData/')).length),2);});
}finally{await browser.close();fs.mkdirSync('.test-output',{recursive:true});fs.writeFileSync('.test-output/structural-results.json',JSON.stringify(results,null,2));if(results.some(r=>!r.pass))process.exitCode=1;}
