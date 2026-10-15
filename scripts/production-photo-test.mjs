// Checks the built/public site through its toolbar, rendered pixels and exported HWPX (no dev-only hooks).
import {chromium} from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
const at=(cellParaIndex,charOffset=0)=>({sectionIndex:0,parentParaIndex:1,paragraphIndex:cellParaIndex,controlIndex:0,cellIndex:1,cellParaIndex,cellPath:[{controlIndex:0,cellIndex:1,cellParaIndex}],charOffset});
const restore=(p,pos)=>p.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),pos);
async function xml(p){const bytes=await p.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()));return new DOMParser().parseFromString(strFromU8(unzipSync(new Uint8Array(bytes))['Contents/section0.xml']),'text/xml');}
async function waitPhoto(p,n){
 const end=Date.now()+20000;
 while(Date.now()<end){if((await xml(p)).getElementsByTagName('hp:pic').length===n)return;await p.waitForTimeout(200);}
 throw Error('Expected '+n+' photos: '+await p.locator('#error-text').textContent());
}
async function ready(p){await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:60000});}
try{
 const p=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.goto((process.env.TEST_BASE_URL||'http://127.0.0.1:5173/')+'?demo=1&room=production-photo-'+Date.now());await ready(p);
 await restore(p,at(0));await p.keyboard.insertText('앞뒤');await p.waitForTimeout(500);await restore(p,at(0,1));
 const bytes=Buffer.from(await p.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=300;const g=c.getContext('2d');g.fillStyle='#187652';g.fillRect(0,0,c.width,c.height);return c.toDataURL().split(',')[1];}),'base64');
 const chooser=p.waitForEvent('filechooser');await p.frameLocator('#studio').locator('button[data-cmd="insert:image"]').click();await(await chooser).setFiles({name:'production-photo.png',mimeType:'image/png',buffer:bytes});
 await waitPhoto(p,1);await p.waitForTimeout(1500);
 await p.evaluate(pos=>{const w=document.querySelector('#studio').contentWindow,r=w.jongwonStudio.caretRect(pos);if(r)w.document.querySelector('#scroll-container').scrollTop+=r.y-300;},at(1));await p.waitForTimeout(300);
 const box=await p.evaluate(async data=>{const im=new Image();im.src='data:image/png;base64,'+data;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const g=c.getContext('2d');g.drawImage(im,0,0);const d=g.getImageData(0,0,c.width,c.height).data;let l=c.width,r=0,t=c.height,b=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(Math.abs(d[i]-24)<4&&Math.abs(d[i+1]-118)<4&&Math.abs(d[i+2]-82)<4){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}}return{l,r,t,b};},(await p.screenshot()).toString('base64'));
 assert.ok(box.r-box.l>50&&box.b-box.t>20,'inserted photo is visibly rendered');
 await p.mouse.click((box.l+box.r)/2,(box.t+box.b)/2);await p.keyboard.press('Control+x');await waitPhoto(p,0);
 await restore(p,at(1));await p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow;w.document.activeElement.dispatchEvent(new w.ClipboardEvent('paste',{bubbles:true,cancelable:true}));});
 await waitPhoto(p,1);await p.waitForTimeout(1500);
 const doc=await xml(p),photo=doc.getElementsByTagName('hp:pic')[0];let cell=photo;
 while(cell&&cell.nodeName!=='hp:tc')cell=cell.parentNode;
 assert.ok(cell,'pasted photo remains inside its table cell');
 const order=Array.from(cell.getElementsByTagName('hp:run')).flatMap(r=>Array.from(r.childNodes).map(n=>n.nodeName==='hp:pic'?'[사진]':n.nodeName==='hp:t'?n.textContent:'')).join('');
 assert.equal(order,'앞[사진]뒤');assert.equal(await p.locator('#error').isVisible(),false);
 await p.reload();await ready(p);await waitPhoto(p,1);assert.deepEqual(errors,[]);
 fs.mkdirSync('.test-output',{recursive:true});await p.screenshot({path:'.test-output/production-photo.png'});
 console.log('PASS production: actual photo chooser, rendered photo selection, cut, immediate paste, one saved photo inside cell, surrounding text, reload');
}finally{await browser.close();}
