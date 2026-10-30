// A photo cut where its cell runs to the page end must not make the cell grow again and again (a team log's photo
// cell reached 2,014,464 HWPUNIT — about 27 pages of blank space in 한글 that could not be deleted). Such a cell is
// given a normal height again, its photos stay inside the table, and teammates and the download get the fix.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import {unzipSync,strFromU8} from 'fflate';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,ms=25000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,300));}throw last;}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1100}});const a=await ctx.newPage(),b=await ctx.newPage();
 const errors=[];for(const p of[a,b])p.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:5173/?demo=1&room=photo-cell-height-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 const ci=24,at=(c,para)=>({sectionIndex:0,paragraphIndex:para,parentParaIndex:1,controlIndex:0,cellIndex:c,cellParaIndex:para,cellPath:[{controlIndex:0,cellIndex:c,cellParaIndex:para}],charOffset:0});
 const state=p=>p.evaluate(ci=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,d=w.getPageDef(0),out=[];
  for(let pg=0;pg<w.pageCount;pg++){(function walk(n,cell){if(n.groupKind?.kind==='tableCell')cell=n.bounds;for(const op of n.ops||[])if(op.type==='image')out.push(!!cell&&op.bbox.x>=cell.x-.5&&op.bbox.x+op.bbox.width<=cell.x+cell.width+.5);for(const c of n.children||[])walk(c,cell);if(n.child)walk(n.child,cell);})(w.getPageLayerTreeObject(pg).root);}
  return {h:w.getCellProperties(0,1,0,ci).height,body:d.height-d.marginTop-d.marginBottom-d.marginHeader-d.marginFooter,pages:w.pageCount,photos:out.length,inside:out.every(Boolean)};},ci);
 await a.bringToFront();
 // lines of text, then photos — one of them falls across a page end
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),at(ci,0));
 for(let i=0;i<30;i++){await a.keyboard.insertText('회의 내용 '+i);await a.keyboard.press('Enter');}
 for(const para of [10,20,30]){
  await a.evaluate(async q=>{const c=document.createElement('canvas');c.width=800;c.height=600;const x=c.getContext('2d');x.fillStyle='#36c';x.fillRect(0,0,800,600);
   const png=Uint8Array.from(atob(c.toDataURL().split(',')[1]),ch=>ch.charCodeAt(0));await document.querySelector('#studio').contentWindow.jongwonStudio.insertImage(q,png,'png',800,600,'p.png');},at(ci,para));
  await a.waitForTimeout(2500);
 }
 // the photo fitting runs again and again (every photo edit does): the cell never grows past a page
 for(let i=0;i<6;i++){await a.evaluate(()=>document.querySelector('#studio').contentWindow.jongwonStudio.fitCellPhotos());await a.waitForTimeout(300);}
 let s=await state(a);assert.equal(s.photos,3);assert.ok(s.h<=s.body,'photo cell not grown past a page: '+JSON.stringify(s));
 console.log('PASS repeated photo fitting does not grow the cell past a page',JSON.stringify(s));
 // a cell already grown that far (as saved by the earlier version) gets a normal height again
 const pages=s.pages;
 await a.evaluate(ci=>{const W=document.querySelector('#studio').contentWindow;W.__inputHandler.wasm.setCellProperties(0,1,0,ci,{height:2014464});W.__inputHandler.eventBus.emit('document-changed');},ci);
 await a.waitForTimeout(500);
 await eventually(async()=>{s=await state(a);assert.ok(s.h<=s.body,'reset: '+JSON.stringify(s));});
 assert.equal(s.photos,3);assert.ok(s.inside,'photos inside the table');
 await b.bringToFront();await eventually(async()=>{const t=await state(b);assert.ok(t.h<=t.body&&t.photos===3&&t.inside,JSON.stringify(t));});
 // the download (opened in 한글) has no cell taller than a page
 const xml=strFromU8(unzipSync(new Uint8Array(await b.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()))))['Contents/section0.xml']);
 const tallest=Math.max(...[...xml.matchAll(/<hp:cellSz [^>]*height="(\d+)"/g)].map(m=>+m[1]));
 assert.ok(tallest<=s.body,'tallest cell in the download: '+tallest);
 assert.deepEqual(errors,[]);
 console.log('PASS a photo cell grown to 2,014,464 gets a normal height (both screens, download); photos stay inside',JSON.stringify({...s,pagesBefore:pages,tallest}));
}finally{await browser.close();}
