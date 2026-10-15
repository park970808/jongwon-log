// A teammate's edit must not move my caret: same spot, Enter before it, Backspace joining its line, formatting,
// photos elsewhere, and both typing at once.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const a=await ctx.newPage(),b=await ctx.newPage();
const url='http://127.0.0.1:5173/?demo=1&room=cursor-'+Date.now();
try{
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 const pos=p=>p.evaluate(()=>{const q=document.querySelector('#studio').contentWindow.__inputHandler.getCursorPosition();return {cellPath:q.cellPath??null,paragraphIndex:q.paragraphIndex,charOffset:q.charOffset};});
 const at=q=>[q.cellPath?.at(-1).cellIndex,q.cellPath?.at(-1).cellParaIndex,q.charOffset];
 const put=(p,q)=>p.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),q);
 const cell=(ci,para,off)=>({sectionIndex:0,paragraphIndex:para,parentParaIndex:1,controlIndex:0,cellIndex:ci,cellParaIndex:para,cellPath:[{controlIndex:0,cellIndex:ci,cellParaIndex:para}],charOffset:off});
 async function scenario(name,start,text,act,expected){
  await a.bringToFront();await put(a,start);if(text)await a.keyboard.insertText(text);await a.waitForTimeout(1500);
  await b.bringToFront();await b.waitForTimeout(2500);await act();await a.bringToFront();await a.waitForTimeout(2500);
  assert.deepEqual(at(await pos(a)),expected,name);console.log('PASS',name);
 }
 await scenario('teammate types at my exact spot: I stay before their text',cell(1,0,0),'XYZ',async()=>{await put(b,cell(1,0,3));await b.keyboard.insertText('ttt');},[1,0,3]);
 await scenario('teammate presses Enter before me: I move to the new line with my words',cell(23,0,0),'abcdef',async()=>{await put(b,cell(23,0,2));await b.keyboard.press('Enter');},[23,1,4]);
 await scenario('teammate joins my line to the previous one: I stay after my words',cell(23,1,4),'',async()=>{await put(b,cell(23,1,0));await b.keyboard.press('Backspace');},[23,0,6]);
 await scenario('teammate bolds my line: I stay',cell(24,0,0),'hello world',async()=>{await put(b,cell(24,0,0));await b.keyboard.press('Shift+End');await b.keyboard.press('Control+b');},[24,0,11]);
 await scenario('teammate inserts a photo elsewhere: I stay',cell(22,0,0),'photo test',async()=>{await b.evaluate(async q=>{const c=document.createElement('canvas');c.width=400;c.height=300;const png=Uint8Array.from(atob(c.toDataURL().split(',')[1]),ch=>ch.charCodeAt(0));await document.querySelector('#studio').contentWindow.jongwonStudio.insertImage(q,png,'png',400,300,'x.png');},cell(1,0,0));},[22,0,10]);
 // A big cell written with Shift+Enter line breaks (one paragraph): I type at its end while a teammate types and
 // adds a line break higher up in the same paragraph. My caret must stay at my text (it used to jump to the top).
 await a.bringToFront();await put(a,cell(26,0,0));
 for(const [i,l] of ['1주차 | 기획','- 팀명 선정','- 현장 비교','산출물: 일지'].entries()){await a.keyboard.insertText(l);if(i<3)await a.keyboard.press('Shift+Enter');}
 await a.waitForTimeout(2000);
 const end=await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getCellParagraphLength(0,1,0,26,0));
 await put(a,cell(26,0,end));
 const mine=(async()=>{for(let i=0;i<20;i++){await a.keyboard.insertText('가');await a.waitForTimeout(150);}})();
 await put(b,cell(26,0,9));for(let i=0;i<5;i++){await b.keyboard.insertText('비');await b.waitForTimeout(300);}await b.keyboard.press('Shift+Enter');await b.keyboard.insertText('새줄');
 await mine;await a.bringToFront();await a.waitForTimeout(3000);
 const big=await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,26,0,0,2000));
 assert.ok(big.endsWith('일지'+'가'.repeat(20)),JSON.stringify(big));assert.deepEqual(at(await pos(a)),[26,0,big.length]);
 console.log('PASS line-break paragraph: my caret stays at my text while a teammate edits above');
 await a.bringToFront();await put(a,cell(21,0,0));
 const typing=(async()=>{for(let i=0;i<30;i++){await a.keyboard.insertText('가');await a.waitForTimeout(120);}})();
 await put(b,cell(25,0,0));for(let i=0;i<10;i++){await b.keyboard.insertText('b');await b.waitForTimeout(300);}
 await typing;await a.waitForTimeout(2500);
 assert.deepEqual(at(await pos(a)),[21,0,30]);
 assert.ok((await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,21,0,0,10000))).startsWith('가'.repeat(30)));
 console.log('PASS both typing at once: my 30 characters stay together and my caret after them');
}finally{await browser.close();}
