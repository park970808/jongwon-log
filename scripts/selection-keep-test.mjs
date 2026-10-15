import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const a=await context.newPage(),b=await context.newPage();
const url='http://127.0.0.1:5173/?demo=1&room=selection-'+Date.now();
const cell=i=>({sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:i,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:i,cellParaIndex:0}],charOffset:0});
const W='document.querySelector("#studio").contentWindow';
try{
 for(const [p,n] of[[a,'Alice'],[b,'Bob']]){await p.bringToFront();await p.goto(url+'&name='+n);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),cell(1));
 await a.keyboard.insertText('가나다라마바사');
 await b.waitForFunction(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).includes('가나다라마바사'),null,{timeout:15000});
 // Alice selects the last 3 characters (마바사).
 for(let i=0;i<3;i++)await a.keyboard.press('Shift+ArrowLeft');
 const sel=p=>p.evaluate(()=>{const c=document.querySelector('#studio').contentWindow.__inputHandler.cursor,s=c.getSelectionOrdered();return s&&[s.start.charOffset,s.end.charOffset,s.start.cellIndex,s.end.cellIndex];});
 assert.deepEqual(await sel(a),[4,7,1,1]);
 // Bob types in front of Alice's selection, in the same cell (shifts it by 2) — then in another cell.
 await b.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),cell(1));
 await b.keyboard.insertText('AB');
 await a.waitForFunction(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).startsWith('AB'),null,{timeout:15000});
 await a.waitForTimeout(400);
 assert.deepEqual(await sel(a),[6,9,1,1]);console.log('PASS: selection kept and shifted with teammate typing before it');
 await b.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),cell(3));
 await b.keyboard.insertText('다른칸');
 await a.waitForFunction(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,3,0,0,10000).includes('다른칸'),null,{timeout:15000});
 await a.waitForTimeout(400);
 assert.deepEqual(await sel(a),[6,9,1,1]);console.log('PASS: selection kept while teammate types in another cell');
 // A selection over several lines of a cell (Shift+Down) is kept too.
 await a.bringToFront();
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),{...cell(23),charOffset:0});
 await a.keyboard.insertText('first line');await a.keyboard.press('Enter');await a.keyboard.insertText('second line');await a.keyboard.press('Enter');await a.keyboard.insertText('third line');
 await a.waitForTimeout(1500);
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),{...cell(23),charOffset:2});
 await a.keyboard.press('Shift+ArrowDown');await a.keyboard.press('Shift+ArrowDown');
 const lines=()=>a.evaluate(()=>{const s=document.querySelector('#studio').contentWindow.__inputHandler.cursor.getSelectionOrdered();return s&&[s.start.cellPath[0].cellParaIndex,s.start.charOffset,s.end.cellPath[0].cellParaIndex];});
 const multi=await lines();assert.deepEqual([multi[0],multi[1],multi[2]],[0,2,2]);
 await b.bringToFront();await b.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),cell(3));await b.keyboard.insertText('또');
 await a.bringToFront();await a.waitForFunction(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,3,0,0,10000).includes('또'),null,{timeout:15000});await a.waitForTimeout(800);
 assert.deepEqual(await lines(),multi);console.log('PASS selection over three lines kept while a teammate types');
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),{...cell(1),charOffset:6});
 for(let i=0;i<3;i++)await a.keyboard.press('Shift+ArrowRight');
 // Formatting the kept selection still applies to exactly 마바사.
 await a.keyboard.press('Control+b');await a.waitForTimeout(300);
 const bold=await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm;return [5,6,7,8].map(o=>w.getCellCharPropertiesAt(0,1,0,1,0,o).bold);});
 assert.deepEqual(bold,[false,true,true,true]);console.log('PASS: Ctrl+B after the remote change bolded the kept selection');
}finally{await browser.close();}
