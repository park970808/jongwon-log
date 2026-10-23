// Enlarging a photo inside a table cell must grow the cell with it (photo stays inside the table), on both screens
// and after reload.
import {assertPictureGeometry} from './picture-geometry.mjs';
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,label,ms=15000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,250));}throw last||Error(label);}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1100}});const a=await ctx.newPage(),b=await ctx.newPage();
 const url='http://127.0.0.1:5173/?demo=1&room=enlarge-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 const ci=+(process.env.CELL||22);
 const pos={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:ci,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:ci,cellParaIndex:0}],charOffset:0};
 await a.bringToFront();
 const lines=+(process.env.LINES??55);
 if(lines){await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),pos);for(let i=0;i<lines;i++){await a.keyboard.insertText('내용 줄 '+i);await a.keyboard.press('Enter');}await a.waitForTimeout(2500);pos.cellParaIndex=pos.cellPath[0].cellParaIndex=pos.paragraphIndex=+(process.env.AT||48);}
 await a.evaluate(async pos=>{const c=document.createElement('canvas');c.width=400;c.height=300;const x=c.getContext('2d');x.fillStyle='#2a6';x.fillRect(0,0,400,300);
  const png=Uint8Array.from(atob(c.toDataURL().split(',')[1]),ch=>ch.charCodeAt(0));await document.querySelector('#studio').contentWindow.jongwonStudio.insertImage(pos,png,'png',400,300,'x.png');},pos);
 await a.waitForTimeout(1500);await assertPictureGeometry(a);
 const box=()=>a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler,s=w.document.querySelector('#scroll-container'),content=w.document.querySelector('#scroll-content');let c,page;for(let i=0;i<h.wasm.pageCount;i++){c=h.wasm.getPageControlLayout(i).controls.find(x=>x.type==='image');if(c){page=i;break;}}s.scrollTop=h.virtualScroll.getPageOffset(page)+c.y*h.viewportManager.getZoom()-150;const r=content.getBoundingClientRect(),z=h.viewportManager.getZoom(),left=h.virtualScroll.getPageLeftResolved(page,content.clientWidth),f=document.querySelector('#studio').getBoundingClientRect();return{x:f.x+r.x+left+(c.x+c.w/2)*z,y:f.y+r.y+h.virtualScroll.getPageOffset(page)+(c.y+c.h/2)*z,w:c.w,h:c.h};});
 const before=await box();await a.mouse.click(before.x,before.y);await a.waitForTimeout(200);
 const handle=await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler,k=h.pictureObjectRenderer.handles.find(x=>x.dir==='se');const r=k.el.getBoundingClientRect(),f=document.querySelector('#studio').getBoundingClientRect();return{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};});
 await a.mouse.move(handle.x,handle.y);await a.mouse.down();await a.mouse.move(handle.x+(+(process.env.DX||200)),handle.y+(+(process.env.DY||300)),{steps:8});await a.mouse.up();await a.waitForTimeout(1500);
 await a.waitForTimeout(2500);
 const after=await box();assert.ok(after.h>before.h+40,'photo grew '+JSON.stringify([before,after]));
 await assertPictureGeometry(a);
 await b.bringToFront();await eventually(()=>assertPictureGeometry(b),'peer');
 await a.reload();await a.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});await a.waitForTimeout(1500);await assertPictureGeometry(a);
 console.log('PASS enlarged photo grows its cell (both screens, after reload)',JSON.stringify({before:[before.w,before.h],after:[after.w,after.h]}));
}finally{await browser.close();}
