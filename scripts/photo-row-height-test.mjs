// A cell holding big photos may need to be taller than a page. The clean-up that resets accidentally oversized
// rows must leave such rows alone, or the photos stick out of the table.
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
 assert.ok(height.h>height.body,'the photo row keeps the height its photos need: '+JSON.stringify(height));
 console.log('PASS two big photos stay inside their cell (both screens)',JSON.stringify(height));
}finally{await browser.close();}
