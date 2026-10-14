import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
fs.mkdirSync('.test-output',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const errors=[];const a=await context.newPage(),b=await context.newPage();
for(const p of[a,b]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,300));});}
const url='http://127.0.0.1:5173/?demo=1&room=integration-'+Date.now();
try{
 await a.bringToFront();await a.goto(url+'&name=Alice');await a.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});
 await b.bringToFront();await b.goto(url+'&name=Bob');await b.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});
 const position={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:1,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:1,cellParaIndex:0}],charOffset:0};
 for(const p of[a,b])await p.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);
 await Promise.all([a.keyboard.insertText('앨리스 공동입력 '),b.keyboard.insertText('밥 동시입력 ')]);
 const nativeText=p=>p.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000));
 await a.waitForFunction(()=>{const w=document.querySelector('#studio').contentWindow;const text=w.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000);return text.includes('앨리스 공동입력')&&text.includes('밥 동시입력');},null,{timeout:15000});
 await b.waitForFunction(()=>{const w=document.querySelector('#studio').contentWindow;return w.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).includes('앨리스 공동입력');},null,{timeout:15000});
 assert.equal(await nativeText(a),await nativeText(b));
 console.log('PASS: two native Alhangeul editors merged concurrent Korean insertion in the SAME cell:',await nativeText(a));
 await a.evaluate(()=>window.__collab.binding.history('undo'));
 await b.waitForFunction(()=>!document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).includes('앨리스 공동입력'),null,{timeout:15000});
 assert.ok((await nativeText(b)).includes('밥 동시입력'));console.log('PASS: selective undo preserved peer edit');
 await a.reload();await a.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});
 assert.ok((await nativeText(a)).includes('밥 동시입력'));console.log('PASS: reload restored shared document');

 await a.evaluate(()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;h.wasm.applyCharFormatInCell(0,1,0,1,0,0,2,JSON.stringify({bold:true}));h.eventBus.emit('document-changed');});
 await b.waitForFunction(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getCellCharPropertiesAt(0,1,0,1,0,0).bold===true,null,{timeout:15000});
 console.log('PASS: character formatting synchronized');
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);
 await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,t=w.__inputHandler.textarea;t.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));t.value='ㅎ';t.dispatchEvent(new w.InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'ㅎ',isComposing:true}));});
 await b.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);await b.keyboard.insertText('원격 ');
 await b.waitForTimeout(500);
 await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,t=w.__inputHandler.textarea;w.__inputHandler.active=true;t.value='한글';t.dispatchEvent(new w.InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'한글',isComposing:true}));t.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true,data:'한글'}));});
 await b.waitForFunction(()=>{const t=document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000);return t.includes('한글')&&t.includes('원격');},null,{timeout:15000});
 console.log('PASS: IME composition survived a concurrent remote edit (synthetic composition events)');
 const count=await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTableDimensions(0,1,0).rowCount);
 console.log('Rows before:',count);
 await a.evaluate(()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler,r=h.wasm.getTableDimensions(0,1,0);const result=h.wasm.insertTableRow(0,1,0,r.rowCount-1,true);if(!result.ok)throw new Error('native insertTableRow failed');h.eventBus.emit('document-changed');});
 await b.waitForFunction(old=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTableDimensions(0,1,0).rowCount===old+1,count,{timeout:20000});
 assert.ok((await nativeText(b)).includes('밥 동시입력'));console.log('PASS: table row insertion synchronized without losing cell content');

 await b.evaluate(pos=>{const w=document.querySelector('#studio').contentWindow;w.jongwonStudio.restore(pos,true);const view=w.__canvasView,original=view.loadDocument.bind(view);view.loadDocument=async(...args)=>{const result=await original(...args);w.__renderPaused=true;await new Promise(r=>setTimeout(r,1000));return result;};},position);
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);await a.keyboard.insertText('갱신시작 ');
 await b.waitForFunction(()=>document.querySelector('#studio').contentWindow.__renderPaused,null,{timeout:15000});
 await b.keyboard.insertText('대기입력 ');
 await b.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,t=w.__inputHandler.textarea;t.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));t.value='조합대기';t.dispatchEvent(new w.InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'조합대기',isComposing:true}));t.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true,data:'조합대기'}));});
 for(const page of[a,b])await page.waitForFunction(()=>{const t=document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000);return t.includes('대기입력')&&t.includes('조합대기')&&t.includes('갱신시작');},null,{timeout:20000});
 console.log('PASS: ordinary text and IME events queued during a deliberately delayed remote redraw');
 await a.screenshot({path:'.test-output/editor-desktop.png',fullPage:true});
 const mobile=await context.newPage();await mobile.setViewportSize({width:390,height:844});await mobile.goto('http://127.0.0.1:5173/');await mobile.screenshot({path:'.test-output/welcome-mobile.png',fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));console.log('PASS: no page errors');
}catch(e){console.error('FAIL',e);console.log('VISIBLE',await a.locator('#error-text').textContent(),await b.locator('#error-text').textContent({timeout:1000}).catch(()=>'(not loaded)'));console.log('ERRORS',errors);console.log('TEXTS',await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000)),await b.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000)));await a.screenshot({path:'.test-output/failure.png',fullPage:true});process.exitCode=1;}
finally{await browser.close();}
