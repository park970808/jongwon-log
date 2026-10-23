// While nobody types, the editor must not keep re-editing the document (that redrew the page and pulled the
// view back to the caret, making scrolling jump and the editor lag). A cell paragraph ending with Shift+Enter
// used to trigger an endless clean-up loop.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const a=await ctx.newPage(),b=await ctx.newPage();
 const url='http://127.0.0.1:5173/?demo=1&room=idle-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 const cell=ci=>({sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:ci,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:ci,cellParaIndex:0}],charOffset:0});
 await a.bringToFront();await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(22));
 await a.keyboard.insertText('첫 줄');await a.keyboard.press('Shift+Enter');await a.waitForTimeout(2500);
 const count=p=>p.evaluate(()=>{const W=document.querySelector('#studio').contentWindow;window.__changes=0;W.__inputHandler.eventBus.on('document-changed',()=>window.__changes++);});
 for(const p of[a,b])await count(p);
 // A scrolls away from its caret; B (teammate) types elsewhere so A gets teammate updates
 await a.evaluate(()=>{const s=document.querySelector('#studio').contentWindow.document.getElementById('scroll-container');s.scrollTop=1800;});
 await b.bringToFront();await b.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(1));
 for(let i=0;i<5;i++){await b.keyboard.insertText('b');await b.waitForTimeout(400);}
 await b.waitForTimeout(6000);
 const idleB=await b.evaluate(()=>window.__changes);
 await a.bringToFront();await a.waitForTimeout(1000);
 const changesA=await a.evaluate(()=>window.__changes),top=await a.evaluate(()=>document.querySelector('#studio').contentWindow.document.getElementById('scroll-container').scrollTop);
 assert.ok(changesA<=2,'no endless re-editing: '+changesA);assert.ok(idleB<=8,'teammate: only their own edits: '+idleB);
 assert.ok(Math.abs(top-1800)<5,'my view stays where I scrolled: '+top);
 console.log('PASS no endless re-editing; the view stays where I scrolled while a teammate types',JSON.stringify({changesA,idleB,top}));
}finally{await browser.close();}
