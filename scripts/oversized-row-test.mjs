// A table row fixed taller than a page must be given back a normal height (it otherwise runs off the page and
// never shrinks), and Shift+arrow while several cells are selected must widen the selection, not resize rows.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const a=await ctx.newPage(),b=await ctx.newPage();
 const url='http://127.0.0.1:5173/?demo=1&room=rows-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 const st=p=>p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,d=w.getPageDef(0),bottom=(d.height-d.marginBottom-d.marginFooter)/75;let over=-1e9;
  for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='table'&&c.stableIndex?.length===3)over=Math.max(over,c.y+c.h-bottom);
  return {pages:w.pageCount,over:Math.round(over),h21:w.getCellProperties(0,1,0,21).height,h22:w.getCellProperties(0,1,0,22).height,h24:w.getCellProperties(0,1,0,24).height};});
 const cell=(ci,para,off)=>({sectionIndex:0,paragraphIndex:para,parentParaIndex:1,controlIndex:0,cellIndex:ci,cellParaIndex:para,cellPath:[{controlIndex:0,cellIndex:ci,cellParaIndex:para}],charOffset:off});
 await a.bringToFront();const before=await st(a);
 // what the team document had: rows fixed at about two pages tall
 await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm;for(const i of[21,22])w.setCellProperties(0,1,0,i,{height:219663});});
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(1,0,0));await a.keyboard.insertText('x');
 await a.waitForTimeout(3500);const fixed=await st(a);
 assert.ok(fixed.h21<20000&&fixed.h22<20000,JSON.stringify(fixed));assert.ok(fixed.over<=4,'nothing runs off the page '+JSON.stringify(fixed));
 await b.bringToFront();await b.waitForTimeout(3000);const seen=await st(b);assert.equal(seen.h22,fixed.h22);assert.equal(seen.pages,fixed.pages);
 console.log('PASS a row taller than a page gets a normal height again (both screens)',JSON.stringify({before,fixed}));
 // drag from one cell into the next row (cell selection), then Shift+Down: selection grows, row heights stay
 await a.bringToFront();
 const bb=await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTableCellBboxes(0,1,0));
 const c22=bb.find(x=>x.cellIdx===22),c24=bb.find(x=>x.cellIdx===24);
 const point=box=>a.evaluate(box=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler,content=w.document.querySelector('#scroll-content'),z=h.viewportManager.getZoom();
  w.document.querySelector('#scroll-container').scrollTop=h.virtualScroll.getPageOffset(box.pageIndex)+box.y*z-150;
  const r=content.getBoundingClientRect(),f=document.querySelector('#studio').getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(box.pageIndex,content.clientWidth);
  return{x:f.x+r.x+left+(box.x+box.w/2)*z,y:f.y+r.y+h.virtualScroll.getPageOffset(box.pageIndex)+(box.y+box.h/2)*z};},box);
 const p1=await point(c22);const p2=await a.evaluate(({c24,p1,c22})=>{const z=document.querySelector('#studio').contentWindow.__inputHandler.viewportManager.getZoom();return {x:p1.x,y:p1.y+(c24.y+c24.h/2-(c22.y+c22.h/2))*z};},{c24,p1,c22});
 await a.mouse.move(p1.x,p1.y);await a.mouse.down();await a.mouse.move(p1.x,p1.y+20,{steps:3});await a.mouse.move(p2.x,p2.y,{steps:15});await a.mouse.up();
 const mode=()=>a.evaluate(()=>{const c=document.querySelector('#studio').contentWindow.__inputHandler.cursor;return {cells:c.isInCellSelectionMode(),focus:c.cellFocus?.row};});
 const m0=await mode();assert.ok(m0.cells,'dragging across rows selects cells');
 const h0=await st(a);for(let i=0;i<3;i++)await a.keyboard.press('Shift+ArrowDown');await a.waitForTimeout(1500);
 const h1=await st(a),m1=await mode();
 assert.deepEqual([h1.h21,h1.h22,h1.h24],[h0.h21,h0.h22,h0.h24],'rows keep their height');assert.ok(m1.focus>m0.focus,'selection grows');
 console.log('PASS Shift+Down with cells selected widens the selection and leaves row heights alone');
}finally{await browser.close();}
