// Deleted photos must not stay in the shared log: the editor keeps every picture it ever held, which made the
// log grow with each photo action until it hit the 32 MB limit and no more photos could be added.
// Three photos dropped, two deleted → only one picture is stored (both screens); undo brings a deleted one back.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import {unzipSync} from 'fflate';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,ms=20000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,300));}throw last;}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1100}});const a=await ctx.newPage(),b=await ctx.newPage();
 const errors=[];for(const p of[a,b])p.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:5173/?demo=1&room=cleanup-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 // pictures drawn, pictures in the shared document, and pictures the editor would save
 const count=p=>p.evaluate(()=>{const W=document.querySelector('#studio').contentWindow,w=W.__inputHandler.wasm;let drawn=0;for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='image')drawn++;
  return {drawn,shared:[...window.__collab.binding.doc.getMap('blobs').keys()].filter(k=>k.startsWith('BinData/')).length};});
 const saved=async p=>Object.keys(unzipSync(new Uint8Array(await p.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()))))).filter(k=>k.startsWith('BinData/')).length;
 const point=(p,box)=>p.evaluate(box=>{const W=document.querySelector('#studio').contentWindow,h=W.__inputHandler,content=W.document.querySelector('#scroll-content'),z=h.viewportManager.getZoom(),f=document.querySelector('#studio').getBoundingClientRect();
  W.document.getElementById('scroll-container').scrollTop=h.virtualScroll.getPageOffset(box.page)+box.y*z-200;
  const r=content.getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(box.page,content.clientWidth);
  return {x:f.x+r.x+left+(box.x+box.w/2)*z,y:f.y+r.y+h.virtualScroll.getPageOffset(box.page)+(box.y+box.h/2)*z};},box);
 await a.bringToFront();
 await a.evaluate(async()=>{
  const W=document.querySelector('#studio').contentWindow,h=W.__inputHandler,content=W.document.querySelector('#scroll-content'),z=h.viewportManager.getZoom();
  const box=h.wasm.getTableCellBboxes(0,1,0).find(x=>x.cellIdx===24);W.document.getElementById('scroll-container').scrollTop=h.virtualScroll.getPageOffset(box.pageIndex)+box.y*z-200;
  await new Promise(r=>setTimeout(r,300));
  const r=content.getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(box.pageIndex,content.clientWidth);
  const x=r.x+left+(box.x+box.w/2)*z,y=r.y+h.virtualScroll.getPageOffset(box.pageIndex)+(box.y+box.h/2)*z,dt=new W.DataTransfer();
  for(const [i,color] of ['#2a6','#c33','#36c'].entries()){const c=W.document.createElement('canvas');c.width=640;c.height=480;const g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,640,480);
   dt.items.add(new W.File([await new Promise(res=>c.toBlob(res,'image/png'))],`p${i}.png`,{type:'image/png'}));}
  const target=W.document.elementFromPoint(x,y)||W.document.body;
  target.dispatchEvent(new W.DragEvent('dragover',{dataTransfer:dt,clientX:x,clientY:y,bubbles:true,cancelable:true}));
  target.dispatchEvent(new W.DragEvent('drop',{dataTransfer:dt,clientX:x,clientY:y,bubbles:true,cancelable:true}));});
 await eventually(async()=>assert.deepEqual(await count(a),{drawn:3,shared:3}));
 for(let k=0;k<2;k++){
  await a.waitForTimeout(1200);
  const box=await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm;for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='image')return {page:i,x:c.x,y:c.y,w:c.w,h:c.h};});
  const pt=await point(a,box);await a.mouse.click(pt.x,pt.y);await a.waitForTimeout(250);
  assert.ok(await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.cursor.isInPictureObjectSelection()),'photo selected');
  await a.keyboard.press('Delete');
  await eventually(async()=>assert.equal((await count(a)).drawn,2-k));
 }
 await eventually(async()=>assert.deepEqual(await count(a),{drawn:1,shared:1}),30000);
 await b.bringToFront();await eventually(async()=>assert.deepEqual(await count(b),{drawn:1,shared:1}),30000);
 await eventually(async()=>assert.equal(await saved(b),1));
 console.log('PASS deleted photos leave the shared log (both screens): 3 dropped, 2 deleted → 1 stored');
 await a.bringToFront();await a.waitForTimeout(800);await a.keyboard.press('Control+z');
 await eventually(async()=>assert.deepEqual(await count(a),{drawn:2,shared:2}));
 await b.bringToFront();await eventually(async()=>assert.deepEqual(await count(b),{drawn:2,shared:2}));
 assert.deepEqual(errors,[]);
 console.log('PASS undo brings the deleted photo back (both screens)');
}finally{await browser.close();}
