// Crop a cell photo through the right-click menu, check the crop reaches the teammate and the saved HWPX.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
const CELL={controlIndex:0,cellIndex:1},pos={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,...CELL,cellParaIndex:0,cellPath:[{...CELL,cellParaIndex:0}],charOffset:0};
async function xml(p){const bytes=await p.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()));return new DOMParser().parseFromString(strFromU8(unzipSync(new Uint8Array(bytes))['Contents/section0.xml']),'text/xml');}
async function pic(p){const x=(await xml(p)).getElementsByTagName('hp:pic');if(x.length!==1)return x.length?{count:x.length}:null;const sz=x[0].getElementsByTagName('hp:sz')[0],dim=x[0].getElementsByTagName('hp:imgDim')[0];return{w:Number(sz.getAttribute('width')),h:Number(sz.getAttribute('height')),dim:[Number(dim.getAttribute('dimwidth')),Number(dim.getAttribute('dimheight'))]};}
async function colors(p){return p.evaluate(async()=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler;let found=null;for(let para=0;para<6&&!found;para++){try{h.wasm.getCellPicturePropertiesByPath(0,1,[{controlIndex:0,cellIndex:1,cellParaIndex:para}],0);found=para;}catch{}}const data=h.wasm.getControlImageData(0,1,0,JSON.stringify([{controlIndex:0,cellIndex:1,cellParaIndex:found}]));const bmp=await createImageBitmap(new Blob([data]));const c=new OffscreenCanvas(bmp.width,bmp.height),x=c.getContext('2d');x.drawImage(bmp,0,0);const px=(a,b)=>Array.from(x.getImageData(a,b,1,1).data.slice(0,3));return{size:[bmp.width,bmp.height],left:px(5,bmp.height/2),right:px(bmp.width-5,bmp.height/2)};});}
async function eventually(check,ms=20000){const end=Date.now()+ms;let last=Error("timeout");while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,250));}throw last;}
async function photoPoint(p){return p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler,page=[...Array(h.wasm.pageCount).keys()].find(i=>h.wasm.getPageControlLayout(i).controls.some(c=>c.type==='image')),box=h.wasm.getPageControlLayout(page).controls.find(c=>c.type==='image'),content=w.document.querySelector('#scroll-content'),s=w.document.querySelector('#scroll-container'),z=h.viewportManager.getZoom();s.scrollTop=Math.max(0,h.virtualScroll.getPageOffset(page)+box.y*z-200);const r=content.getBoundingClientRect(),f=document.querySelector('#studio').getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(page,content.clientWidth);return{x:f.x+r.x+left+(box.x+box.w/2)*z,y:f.y+r.y+h.virtualScroll.getPageOffset(page)+(box.y+box.h/2)*z};});}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),a=await ctx.newPage(),b=await ctx.newPage(),errors=[];
 const url='http://127.0.0.1:5173/?demo=1&room=crop-'+Date.now();
 for(const p of[a,b]){p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 await a.bringToFront();
 await a.screenshot({path:'.test-output/editing-layout.png'});
 const png=await a.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=800;const x=c.getContext('2d');x.fillStyle='#c33';x.fillRect(0,0,600,800);x.fillStyle='#36c';x.fillRect(600,0,600,800);return Array.from(Uint8Array.from(atob(c.toDataURL().split(',')[1]),ch=>ch.charCodeAt(0)));});
 await a.evaluate(({pos,png})=>document.querySelector('#studio').contentWindow.jongwonStudio.insertImage(pos,new Uint8Array(png),'png',1200,800,'two.png'),{pos,png});
 await b.bringToFront();
 const before=await eventually(async()=>{const v=await pic(b);assert.ok(v);return v;});
 await a.bringToFront();
 await eventually(async()=>assert.ok(await a.evaluate(()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;for(let i=0;i<h.wasm.pageCount;i++)if(h.wasm.getPageControlLayout(i).controls.some(c=>c.type==='image'))return true;return false;})));
 await a.waitForTimeout(1500);
 const pt=await photoPoint(a);await a.mouse.click(pt.x,pt.y,{button:'right'});
 await a.frameLocator('#studio').getByText('그림 자르기(C)...').click();
 const dialog=a.frameLocator('#studio').locator('.jw-crop');await dialog.waitFor();
 // Drag the right edge to the middle: keep only the red left half.
 const box=await dialog.locator('.jw-crop-box').boundingBox(),f=await a.locator('#studio').boundingBox();
 const e=await dialog.locator('[data-h="e"]').boundingBox();
 await a.mouse.move(e.x+e.width/2,e.y+e.height/2);await a.mouse.down();await a.mouse.move(box.x+box.width/2,e.y+e.height/2,{steps:8});await a.mouse.up();
 await a.screenshot({path:'.test-output/crop-dialog.png'});
 await dialog.getByRole('button',{name:'자르기'}).click();
 await dialog.waitFor({state:'detached'});
 for(const p of[a,b]){
  await p.bringToFront();
  const after=await eventually(async()=>{const v=await pic(p);assert.ok(v&&v.w&&Math.abs(v.w-before.w/2)<before.w*0.06,'box width halves: '+JSON.stringify(v));return v;});
  assert.equal(after.h,before.h,'height kept');
  const c=await colors(p);assert.ok(Math.abs(c.size[0]-600)<40&&c.size[1]===800,'image itself cropped: '+JSON.stringify(c));assert.ok(c.right[0]>150&&c.right[2]<100,'only the red half is left: '+JSON.stringify(c));
 }
 console.log('PASS crop via right-click menu: the photo itself is cut, size kept to scale, teammate gets it');
 await a.waitForTimeout(1500);await a.screenshot({path:'.test-output/after-crop.png'});
 await a.bringToFront();await a.keyboard.press('Control+z');
 await eventually(async()=>{const v=await pic(b);assert.equal(v.w,before.w);assert.equal((await colors(b)).size[0],1200);});
 console.log('PASS undo restored the uncropped photo for the teammate');
 assert.deepEqual(errors,[]);
}catch(e){console.log("FAIL",e);process.exitCode=1;}finally{await browser.close();}
