// A "treat as character" table whose cell grows past the page must continue on the next page (not be cut off).
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const a=await ctx.newPage(),b=await ctx.newPage();
 const url='http://127.0.0.1:5173/?demo=1&room=tall-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 const st=p=>p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,bb=w.getTableBBox(0,1,0);return {pages:w.pageCount,tac:w.getTableProperties(0,1,0).treatAsChar,x:Math.round(bb.x)};});
 const cell=(para,off)=>({sectionIndex:0,paragraphIndex:para,parentParaIndex:1,controlIndex:0,cellIndex:22,cellParaIndex:para,cellPath:[{controlIndex:0,cellIndex:22,cellParaIndex:para}],charOffset:off});
 await a.bringToFront();const before=await st(a);assert.equal(before.tac,true);
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(0,0));
 for(let i=0;i<70;i++){await a.keyboard.insertText('내용 줄 '+i);await a.keyboard.press('Enter');}
 await a.waitForTimeout(3000);
 const grown=await st(a);assert.ok(grown.pages>before.pages,'rows continue on the next pages');assert.equal(grown.tac,false);assert.equal(grown.x,before.x,'table stays in place');
 await b.bringToFront();await b.waitForTimeout(3000);assert.deepEqual(await st(b),grown,'teammate sees the same');
 console.log('PASS long cell continues on the next page (both screens)',JSON.stringify(grown));
 await a.bringToFront();await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(0,0));
 for(let i=0;i<70;i++)await a.keyboard.press('Shift+ArrowDown');await a.keyboard.press('Shift+End');await a.keyboard.press('Delete');await a.waitForTimeout(3000);
 assert.equal((await st(a)).pages,before.pages);console.log('PASS deleting the text shrinks the table back');
}finally{await browser.close();}
