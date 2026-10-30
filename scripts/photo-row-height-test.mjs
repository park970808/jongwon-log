// Big photos in a cell stay inside the table, without the cell's own height growing past a page (that became
// dozens of blank pages in 한글). The clean-up that resets oversized rows keeps the photos inside.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1100}});const a=await ctx.newPage(),b=await ctx.newPage();
 const url='http://127.0.0.1:5173/?demo=1&room=photo-rows-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 const ci=+(process.env.CELL||22),fill=+(process.env.FILL||25),before=+(process.env.BEFORE||0);
 const at=(c,para)=>({sectionIndex:0,paragraphIndex:para,parentParaIndex:1,controlIndex:0,cellIndex:c,cellParaIndex:para,cellPath:[{controlIndex:0,cellIndex:c,cellParaIndex:para}],charOffset:0});
 await a.bringToFront();
 if(before){await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),at(22,0));for(let i=0;i<before;i++){await a.keyboard.insertText('앞 칸 '+i);await a.keyboard.press('Enter');}}
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),at(ci,0));
 for(let i=0;i<fill;i++){await a.keyboard.insertText('내용 줄 '+i);await a.keyboard.press('Enter');}
 const photo=para=>a.evaluate(async q=>{const c=document.createElement('canvas');c.width=600;c.height=450;const x=c.getContext('2d');x.fillStyle='#2a6';x.fillRect(0,0,600,450);
  const png=Uint8Array.from(atob(c.toDataURL().split(',')[1]),ch=>ch.charCodeAt(0));await document.querySelector('#studio').contentWindow.jongwonStudio.insertImage(q,png,'png',600,450,'x.png');},at(ci,para));
 await photo(0);await a.waitForTimeout(2000);await photo(Math.floor(fill/2));await a.waitForTimeout(4000);
 // type somewhere else so the clean-up pass runs again
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),at(1,0));await a.keyboard.insertText('x');await a.waitForTimeout(3000);
 const check=p=>p.evaluate(()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler,out=[];
  for(let pg=0;pg<h.wasm.pageCount;pg++){(function walk(n,cell){if(n.groupKind?.kind==='tableCell')cell=n.bounds;for(const op of n.ops||[])if(op.type==='image')out.push({pg,img:op.bbox,cell});for(const c of n.children||[])walk(c,cell);if(n.child)walk(n.child,cell);})(h.wasm.getPageLayerTreeObject(pg).root);}
  return out.map(({pg,img,cell})=>({pg,inside:!!cell&&img.y>=cell.y-.5&&img.y+img.height<=cell.y+cell.height+.5&&img.x>=cell.x-.5&&img.x+img.width<=cell.x+cell.width+.5,img:[img.y,img.height].map(Math.round),cell:cell&&[cell.y,cell.height].map(Math.round)}));});
 const mine=await check(a);assert.equal(mine.length,2,JSON.stringify(mine));assert.ok(mine.every(x=>x.inside),'photos stay inside the table: '+JSON.stringify(mine));
 await b.bringToFront();await b.waitForTimeout(4000);const peer=await check(b);assert.ok(peer.length===2&&peer.every(x=>x.inside),'teammate: '+JSON.stringify(peer));
 const height=await a.evaluate(ci=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,d=w.getPageDef(0);return {h:w.getCellProperties(0,1,0,ci).height,body:d.height-d.marginTop-d.marginBottom-d.marginHeader-d.marginFooter};},ci);
 assert.ok(height.h<=height.body,'the photo cell is not set taller than a page: '+JSON.stringify(height));
 console.log('PASS two big photos stay inside their cell (both screens)',JSON.stringify(height));
 // the row's label cell stretched to ~8 pages (as in the team's document): it is reset, the photo cell is not,
 // and deleting the text afterwards does not blow the table up
 const label=ci-1;
 await a.bringToFront();await a.evaluate(label=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm;w.setCellProperties(0,1,0,label,{height:638994});},label);
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),at(1,0));await a.keyboard.insertText('y');await a.waitForTimeout(3500);
 const fixed=await a.evaluate(([ci,label])=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm;return {label:w.getCellProperties(0,1,0,label).height,photo:w.getCellProperties(0,1,0,ci).height};},[ci,label]);
 assert.ok(fixed.label<20000,'label cell reset: '+JSON.stringify(fixed));assert.ok((await check(a)).every(x=>x.inside),'photos still inside');
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),at(ci,fill));
 for(let i=0;i<120;i++)await a.keyboard.press('Backspace');await a.waitForTimeout(3500);
 const tallest=await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm;let m=0;for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='table'&&c.stableIndex?.length===3)m=Math.max(m,c.h);return Math.round(m);});
 assert.ok(tallest<1100,'no table part taller than a page after deleting: '+tallest);
 const after=await check(a);assert.ok(after.every(x=>x.inside),'photos still inside: '+JSON.stringify(after));
 console.log('PASS an oversized label cell next to photos is reset; deleting text keeps the table sane',JSON.stringify({fixed,tallest}));
}finally{await browser.close();}
