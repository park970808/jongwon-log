import {assertPictureGeometry} from './picture-geometry.mjs';
import {chromium} from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
const position={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:1,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:1,cellParaIndex:0}],charOffset:0};
async function exported(p){const bytes=await p.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()));return new DOMParser().parseFromString(strFromU8(unzipSync(new Uint8Array(bytes))['Contents/section0.xml']),'text/xml');}
async function pictures(p){return (await exported(p)).getElementsByTagName('hp:pic').length;}
// Edits reach teammates after the send batch window (up to several seconds), so peer checks poll.
async function eventually(check,label,ms=15000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,250));}throw last||Error(label);}
async function waitPictures(p,n){const end=Date.now()+25000;while(Date.now()<end){if(await pictures(p)===n)return;await p.waitForTimeout(250);}throw Error(`Expected ${n} pictures, UI error: ${await p.locator('#error-text').textContent()}`);}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),a=await ctx.newPage(),b=await ctx.newPage(),errors=[];
 const url=(process.env.TEST_BASE_URL||'http://127.0.0.1:5173/')+'?demo=1&room=image-button-'+Date.now();
 for(const p of[a,b]){p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 await a.bringToFront();await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);await a.keyboard.insertText('앞뒤');await a.waitForTimeout(800);
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore({...pos,charOffset:1},true),position);
 const picture=Buffer.from(await a.evaluate(()=>{const c=document.createElement('canvas');c.width=1600;c.height=800;const x=c.getContext('2d');x.fillStyle='#187652';x.fillRect(0,0,1600,800);return c.toDataURL().split(',')[1];}),'base64');
 // The native snapshot must roll back a partial insert without exporting/reloading a backup HWPX.
 if(await a.evaluate(()=>!!document.querySelector('#studio').contentWindow.__inputHandler)){
  const beforeFailure=(await exported(a)).toString();
  const failure=await a.evaluate(({position,bytes})=>{
   const w=document.querySelector('#studio').contentWindow,wasm=w.__inputHandler.wasm,original=wasm.pasteInternalInCellByPath;
   wasm.pasteInternalInCellByPath=()=>JSON.stringify({ok:false});
   try{w.jongwonStudio.insertImage({...position,charOffset:1},new Uint8Array(bytes),'png',1600,800,'failed.png');return null;}
   catch(e){return e.message;}finally{wasm.pasteInternalInCellByPath=original;}
  },{position,bytes:Array.from(picture)});
  assert.match(failure,/선택한 셀/);assert.equal((await exported(a)).toString(),beforeFailure,'partial insert restores text, paragraphs, picture and cell geometry');
  console.log('PASS failed cell paste restores native snapshot atomically');
 }
 const chooserPromise=a.waitForEvent('filechooser');await a.frameLocator('#studio').locator('button[data-cmd="insert:image"]').click();const chooser=await chooserPromise;
 // The other editor changes the same paragraph while the chooser is open.
 await eventually(async()=>assert.ok((await exported(b)).documentElement.textContent.includes('앞뒤')),'peer has the text before typing next to it');
 await b.bringToFront();await b.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);await b.keyboard.insertText('동료');
 const peerDeadline=Date.now()+15000;while(!(await exported(a)).documentElement.textContent.includes('동료')){if(Date.now()>peerDeadline)throw Error('Peer text did not arrive before image selection');await a.waitForTimeout(250);} 
 await chooser.setFiles({name:'wide-picture.png',mimeType:'image/png',buffer:picture});
 for(const p of[a,b]){
  await waitPictures(p,1);const xml=await exported(p),pic=xml.getElementsByTagName('hp:pic')[0];let cell=pic.parentNode;while(cell&&!cell.nodeName.endsWith(':tc'))cell=cell.parentNode;
  assert.ok(cell,'picture must belong to the target cell, not float in the page');
  const address=cell.getElementsByTagName('hp:cellAddr')[0];assert.equal(address.getAttribute('rowAddr'),'0');assert.equal(address.getAttribute('colAddr'),'1');
  assert.equal(pic.getElementsByTagName('hp:pos')[0].getAttribute('treatAsChar'),'1');
  assert.ok(Number(cell.getElementsByTagName('hp:cellSz')[0].getAttribute('height'))>Number(pic.getElementsByTagName('hp:sz')[0].getAttribute('height')),'cell must grow to fit the full photo');
  assert.ok(pic.getElementsByTagName('hp:sz')[0].getAttribute('width')<=cell.getElementsByTagName('hp:cellSz')[0].getAttribute('width')*1);
  const para=pic.parentNode.parentNode;assert.equal(Array.from(para.getElementsByTagName('hp:t')).map(n=>n.textContent).join(''),'','photo occupies its own paragraph');const order=Array.from(cell.getElementsByTagName('hp:run')).flatMap(r=>Array.from(r.childNodes).filter(n=>n.nodeType===1).map(n=>n.nodeName==='hp:pic'?'[사진]':n.nodeName==='hp:t'?n.textContent:'')).join('');
  assert.equal(order,'동료앞[사진]뒤','separate image paragraph must follow the original relative cursor');assert.equal(await p.locator('#error').isVisible(),false);
 }
 console.log('PASS toolbar file selection: inline image inside original cell, relative cursor preserved during peer edit, width fitted');
 // Inspect actual paint operations as well as saved XML (the duplicate was visual only).
 const renderCounts=await a.evaluate(()=>{
  const h=document.querySelector('#studio').contentWindow.__inputHandler;if(!h)return null;
  let controls=0,paints=0;for(let i=0;i<h.wasm.pageCount;i++){
   controls+=h.wasm.getPageControlLayout(i).controls.filter(c=>c.type==='image').length;
   const walk=n=>{paints+=(n.ops||[]).filter(o=>o.type==='image').length;for(const c of n.children||[])walk(c);if(n.child)walk(n.child);};walk(h.wasm.getPageLayerTreeObject(i).root);
  }return {controls,paints};
 });
 if(renderCounts)assert.deepEqual(renderCounts,{controls:1,paints:1},'one saved picture must be painted once');
 await assertPictureGeometry(a);await assertPictureGeometry(b);


 await a.bringToFront();
 // Find the synthetic green picture in actual rendered pixels, including production builds.
 const findPhoto=async()=>{
  await a.waitForFunction(()=>{const b=window.__collab?.binding;return b&&!b.applying&&!b.refreshing&&!b.remoteTimer;},null,{timeout:15000});await a.waitForTimeout(300);
 // The photo may sit lower than the first screen (a tall first row moves the table down); bring it into view.
 await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler,s=w.document.querySelector('#scroll-container');for(let i=0;i<h.wasm.pageCount;i++){const c=h.wasm.getPageControlLayout(i).controls.find(x=>x.type==='image');if(c){s.scrollTop=Math.max(0,h.virtualScroll.getPageOffset(i)+c.y*h.viewportManager.getZoom()-150);return;}}});await a.waitForTimeout(400);
  const screen=(await a.screenshot()).toString('base64');
  return a.evaluate(async data=>{const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let left=c.width,top=c.height,right=0,bottom=0;for(let y=0;y<c.height;y++)for(let px=0;px<c.width;px++){const i=(y*c.width+px)*4;if(Math.abs(d[i]-24)<4&&Math.abs(d[i+1]-118)<4&&Math.abs(d[i+2]-82)<4){left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,y);bottom=Math.max(bottom,y);}}return{left,right,top,bottom};},screen);
 };
 let box=await findPhoto();
 assert.ok(box.right>box.left,'synthetic picture must be visible');
 await a.mouse.click((box.left+box.right)/2,(box.top+box.bottom)/2);
 const handle=await a.evaluate(()=>{const f=document.querySelector('#studio'),w=f.contentWindow,rect=f.getBoundingClientRect();const points=[...w.document.querySelectorAll('.table-object-layer>div')].filter(e=>e.style.width==='8px'&&e.style.height==='8px').map(e=>e.getBoundingClientRect());const h=points.sort((a,b)=>b.bottom-a.bottom||b.right-a.right)[0];if(!h)throw Error('No visible photo resize handle');return{x:rect.x+h.x+h.width/2,y:rect.y+h.y+h.height/2};});
 const size=async p=>{const pic=(await exported(p)).getElementsByTagName('hp:pic')[0],s=pic.getElementsByTagName('hp:sz')[0];return{width:+s.getAttribute('width'),height:+s.getAttribute('height')};};
 const before=await size(a);await a.mouse.move(handle.x,handle.y);await a.mouse.down();await a.mouse.move(handle.x-80,handle.y-10,{steps:6});await a.mouse.up();await a.waitForTimeout(1200);
 const after=await size(a);assert.ok(after.width<before.width&&after.height<before.height);assert.ok(Math.abs(after.width/after.height-before.width/before.height)<.002,'corner resize preserves aspect ratio');await eventually(async()=>assert.deepEqual(await size(b),after),'resize reached peer');
 console.log('PASS rendered photo selection and real corner drag: proportional resize synchronized to peer');
 box=await findPhoto(); // the layout is redrawn after a resize
 await a.mouse.click(box.left+12,box.top+12);
 const largeHandle=await a.evaluate(()=>{const f=document.querySelector('#studio'),r=f.getBoundingClientRect(),points=[...f.contentWindow.document.querySelectorAll('.table-object-layer>div')].filter(e=>e.style.width==='8px'&&e.style.height==='8px').map(e=>e.getBoundingClientRect());const h=points.sort((a,b)=>b.bottom-a.bottom||b.right-a.right)[0];if(!h)throw Error('No enlargement handle');return{x:r.x+h.x+h.width/2,y:r.y+h.y+h.height/2};});
 await a.keyboard.down('Shift');await a.mouse.move(largeHandle.x,largeHandle.y);await a.mouse.down();await a.mouse.move(largeHandle.x+250,largeHandle.y,{steps:6});await a.mouse.up();await a.keyboard.up('Shift');await a.waitForTimeout(1200);
 const enlarged=await size(a),enlargedXml=await exported(a),enlargedPic=enlargedXml.getElementsByTagName('hp:pic')[0];let enlargedCell=enlargedPic;while(enlargedCell.nodeName!=='hp:tc')enlargedCell=enlargedCell.parentNode;
 const margin=enlargedCell.getElementsByTagName('hp:cellMargin')[0],cellWidth=+enlargedCell.getElementsByTagName('hp:cellSz')[0].getAttribute('width');
 assert.ok(enlarged.width<=cellWidth-(+margin.getAttribute('left'))-(+margin.getAttribute('right'))+1,'oversize drag must stop at cell inner width');
 assert.ok(enlarged.width>after.width,'enlargement drag must actually change size');await eventually(async()=>assert.deepEqual(await size(b),enlarged),'enlargement reached peer');await assertPictureGeometry(a);await assertPictureGeometry(b);
 console.log('PASS oversize drag stops inside cell with no text overlap');

 await a.bringToFront();await a.reload();await a.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});await waitPictures(a,1);console.log('PASS image remains inside cell after reload');
 const pending=a.waitForEvent('download');await a.locator('#header-tab').hover();await a.waitForTimeout(300);await a.locator('#download').click();await a.mouse.move(700,600);await a.waitForTimeout(800);const download=await pending;assert.ok((await fs.promises.stat(await download.path())).size>1000);
 fs.mkdirSync('.test-output',{recursive:true});await a.evaluate(pos=>{const w=document.querySelector('#studio').contentWindow,r=w.jongwonStudio.caretRect(pos);if(r&&r.y>700)w.document.querySelector('#scroll-container').scrollTop+=r.y-350;},position);await a.waitForTimeout(300);await a.screenshot({path:'.test-output/image-button.png',fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS HWPX download and no browser errors');
 const bodyPosition={sectionIndex:0,paragraphIndex:0,charOffset:0};
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),bodyPosition);
 // The toolbar ignores commands while a teammate's change is being redrawn; a person simply clicks again.
 for(let i=0;;i++){const c=a.waitForEvent('filechooser',{timeout:3000}).catch(()=>null);await a.frameLocator('#studio').locator('button[data-cmd="insert:image"]').click();const ch=await c;if(ch){await ch.setFiles({name:'body.png',mimeType:'image/png',buffer:picture});break;}if(i>=4)throw Error('file chooser did not open');}
 await waitPictures(a,2);await waitPictures(b,2);
 const bodyPic=(await exported(a)).getElementsByTagName('hp:pic')[0];let ancestor=bodyPic.parentNode;while(ancestor){assert.notEqual(ancestor.nodeName,'hp:tc');ancestor=ancestor.parentNode;}
 assert.equal(bodyPic.getElementsByTagName('hp:pos')[0].getAttribute('treatAsChar'),'1');
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),bodyPosition);await a.keyboard.press('ControlOrMeta+z');await waitPictures(a,1);await waitPictures(b,1);
 console.log('PASS body cursor insertion and image undo synchronized to peer');

}finally{await browser.close();}
