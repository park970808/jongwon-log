// A table can be made inside a table cell (표 만들기) and a table copied from 한글/Excel/the web (HTML) pasted
// into a cell stays a table, fits the cell, and reaches the teammate; undo removes it.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,ms=15000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,250));}throw last;}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});const a=await ctx.newPage(),b=await ctx.newPage();
 const errors=[];for(const p of[a,b])p.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:5173/?demo=1&room=cell-table-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 const cell=ci=>({sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:ci,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:ci,cellParaIndex:0}],charOffset:0});
 // nested tables inside cell ci of the first table: size, position and text of their cells
 const nested=(p,ci)=>p.evaluate(ci=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,out=[];
  const outer=w.getTableCellBboxes(0,1,0).filter(b=>b.cellIdx===ci);
  for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='table'&&c.stableIndex.length>3&&c.stableIndex[3]===ci){
   const path=[{controlIndex:0,cellIndex:ci,cellParaIndex:c.stableIndex[4]},{controlIndex:c.stableIndex[5],cellIndex:0,cellParaIndex:0}];
   const dims=JSON.parse(w.doc.getTableDimensionsByPath(0,1,JSON.stringify(path)));const texts=[];
   for(let k=0;k<dims.cellCount;k++){const q=JSON.stringify([path[0],{...path[1],cellIndex:k}]);texts.push(w.doc.getTextInCellByPath(0,1,q,0,w.doc.getCellParagraphLengthByPath(0,1,q)));}
   const box=outer.find(o=>o.pageIndex===i)||outer[0];
   out.push({rows:dims.rowCount,cols:dims.colCount,texts,inside:c.x>=box.x-.5&&c.x+c.w<=box.x+box.w+.5});}
  return out;},ci);
 await a.bringToFront();
 // 1) 표 만들기 with the caret in a cell
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(24));
 await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.dispatcher.dispatch('table:create'));
 // the grid picker: point at row 2, column 3 and click (a 2×3 table)
 const pick=await a.evaluate(()=>{const W=document.querySelector('#studio').contentWindow,f=document.querySelector('#studio').getBoundingClientRect();
  const cells=[...W.document.querySelectorAll('div')].filter(d=>d.style.position==='absolute'&&d.parentElement?.style.position==='relative'&&d.style.width===d.style.height);
  const tops=[...new Set(cells.map(c=>parseFloat(c.style.top)))].sort((x,y)=>x-y),lefts=[...new Set(cells.map(c=>parseFloat(c.style.left)))].sort((x,y)=>x-y);
  const el=cells.find(c=>parseFloat(c.style.top)===tops[1]&&parseFloat(c.style.left)===lefts[2]);const r=el.getBoundingClientRect();return {x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};});
 await a.mouse.move(pick.x,pick.y,{steps:3});await a.mouse.click(pick.x,pick.y);await a.waitForTimeout(1500);
 const made=await nested(a,24);assert.equal(made.length,1,'one table in the cell: '+JSON.stringify(made));assert.deepEqual([made[0].rows,made[0].cols],[2,3]);assert.ok(made[0].inside,'fits the cell');
 await b.bringToFront();await eventually(async()=>assert.equal((await nested(b,24)).length,1));
 console.log('PASS 표 만들기 inside a cell (both screens)',JSON.stringify(made[0]));
 // 2) paste an HTML table (as 한글/Excel/web copies) into another cell, with a merged header
 await a.bringToFront();await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(22));
 await a.evaluate(()=>{const W=document.querySelector('#studio').contentWindow,ta=W.__inputHandler.textarea,dt=new W.DataTransfer();
  dt.setData('text/html','<table><tr><td colspan="2">구분</td><td>비고</td></tr><tr><td>가</td><td>나</td><td>다</td></tr><tr><td>라</td><td>마</td><td>바</td></tr></table>');dt.setData('text/plain','구분\t\t비고\n가\t나\t다\n라\t마\t바');
  ta.focus();ta.dispatchEvent(new W.ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));});
 await a.waitForTimeout(1500);
 const pasted=await nested(a,22);assert.equal(pasted.length,1,JSON.stringify(pasted));
 assert.equal(pasted[0].rows,3);assert.equal(pasted[0].cols,3);assert.ok(pasted[0].inside);
 assert.deepEqual(pasted[0].texts.filter(Boolean),['구분','비고','가','나','다','라','마','바']);
 await b.bringToFront();await eventually(async()=>assert.deepEqual((await nested(b,22))[0]?.texts,pasted[0].texts));
 console.log('PASS pasted HTML table stays a table in the cell, merged header kept (both screens)',JSON.stringify(pasted[0]));
 // 3) undo removes it, and the outer body paragraph is unchanged (the temporary table is gone)
 await a.bringToFront();await a.keyboard.press('Control+z');await a.waitForTimeout(1500);
 assert.equal((await nested(a,22)).length,0,'undo removes the pasted table');
 assert.equal(await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getParagraphLength(0,1)),await b.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getParagraphLength(0,1)));
 assert.deepEqual(errors,[]);
 console.log('PASS undo removes it; no leftover temporary table');
 // 4) a table copied in this editor (Ctrl+C on the selected table) pasted into a cell: rebuilt to fit the cell
 await a.evaluate(()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;h.cursor.enterTableObjectSelectionDirect(0,3,0);h.active=true;h.eventBus.emit('table-object-selection-changed',true);h.textarea.focus();});
 await a.keyboard.press('Control+c');await a.waitForTimeout(300);
 const clip=await a.evaluate(async()=>{const out={html:'',text:''};for(const it of await navigator.clipboard.read()){if(it.types.includes('text/html'))out.html=await (await it.getType('text/html')).text();if(it.types.includes('text/plain'))out.text=await (await it.getType('text/plain')).text();}return out;});
 assert.ok(/<table/i.test(clip.html),'the copy carries the table');
 await a.evaluate(()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;h.cursor.exitTableObjectSelection();h.eventBus.emit('table-object-selection-changed',false);});
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(26));
 await a.evaluate(c=>{const W=document.querySelector('#studio').contentWindow,ta=W.__inputHandler.textarea,dt=new W.DataTransfer();dt.setData('text/html',c.html);dt.setData('text/plain',c.text);ta.focus();ta.dispatchEvent(new W.ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},clip);
 await a.waitForTimeout(1500);
 const copied=await nested(a,26);assert.ok(copied.length>=1&&copied.every(t=>t.inside),'copied table fits the cell: '+JSON.stringify(copied));assert.equal(copied[0].cols,2);
 assert.ok(copied[0].texts.some(t=>t.includes('이름')),'contents kept');
 console.log('PASS a table copied in the editor pastes into a cell and fits it',JSON.stringify({rows:copied[0].rows,cols:copied[0].cols}));
}finally{await browser.close();}
