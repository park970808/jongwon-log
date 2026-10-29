// Photos dragged from a folder and dropped on a table cell go into that cell (two at once), through the same
// path as the photo button, and reach the teammate. Dropping a non-image file does nothing.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,ms=20000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,300));}throw last;}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1100}});const a=await ctx.newPage(),b=await ctx.newPage();
 const errors=[];for(const p of[a,b])p.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:5173/?demo=1&room=drop-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 const photos=p=>p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,r=[];for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='image')r.push(c.cellPath?.[0]?.cellIndex??c.cellPath?.[0]?.cellIdx??'body');return r;});
 await a.bringToFront();
 // drop two PNG files on the middle of cell 24 (팀 주요 회의내용)
 const dropOn=(ci,names)=>a.evaluate(async([ci,names])=>{
  const W=document.querySelector('#studio').contentWindow,h=W.__inputHandler,content=W.document.querySelector('#scroll-content'),z=h.viewportManager.getZoom();
  const box=h.wasm.getTableCellBboxes(0,1,0).find(x=>x.cellIdx===ci);W.document.getElementById('scroll-container').scrollTop=h.virtualScroll.getPageOffset(box.pageIndex)+box.y*z-200;
  await new Promise(r=>setTimeout(r,300));
  const r=content.getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(box.pageIndex,content.clientWidth);
  const x=r.x+left+(box.x+box.w/2)*z,y=r.y+h.virtualScroll.getPageOffset(box.pageIndex)+(box.y+box.h/2)*z;
  const dt=new W.DataTransfer();
  for(const [i,name] of names.entries()){
   if(name.endsWith('.png')){const c=W.document.createElement('canvas');c.width=640;c.height=480;const g=c.getContext('2d');g.fillStyle=i?'#c33':'#2a6';g.fillRect(0,0,640,480);
    const blob=await new Promise(res=>c.toBlob(res,'image/png'));dt.items.add(new W.File([blob],name,{type:'image/png'}));}
   else dt.items.add(new W.File(['hello'],name,{type:'text/plain'}));}
  const target=W.document.elementFromPoint(x,y)||W.document.body;
  target.dispatchEvent(new W.DragEvent('dragover',{dataTransfer:dt,clientX:x,clientY:y,bubbles:true,cancelable:true}));
  target.dispatchEvent(new W.DragEvent('drop',{dataTransfer:dt,clientX:x,clientY:y,bubbles:true,cancelable:true}));
 },[ci,names]);
 await dropOn(24,['memo.txt']);await a.waitForTimeout(1500);
 assert.deepEqual(await photos(a),[],'a text file is ignored');
 await dropOn(24,['first.png','second.png']);
 await eventually(async()=>assert.deepEqual(await photos(a),[24,24]));
 await b.bringToFront();await eventually(async()=>assert.deepEqual(await photos(b),[24,24]));
 assert.deepEqual(errors,[]);
 console.log('PASS two photos dropped on a cell go into that cell (both screens); a text file is ignored');
}finally{await browser.close();}
