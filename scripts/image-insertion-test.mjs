import {chromium} from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
const position={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:1,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:1,cellParaIndex:0}],charOffset:0};
async function exported(p){const bytes=await p.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()));return new DOMParser().parseFromString(strFromU8(unzipSync(new Uint8Array(bytes))['Contents/section0.xml']),'text/xml');}
async function pictures(p){return (await exported(p)).getElementsByTagName('hp:pic').length;}
async function waitPictures(p,n){const end=Date.now()+25000;while(Date.now()<end){if(await pictures(p)===n)return;await p.waitForTimeout(250);}throw Error(`Expected ${n} pictures, UI error: ${await p.locator('#error-text').textContent()}`);}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),a=await ctx.newPage(),b=await ctx.newPage(),errors=[];
 const url=(process.env.TEST_BASE_URL||'http://127.0.0.1:5173/')+'?demo=1&room=image-button-'+Date.now();
 for(const p of[a,b]){p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 await a.bringToFront();await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);await a.keyboard.insertText('앞뒤');await a.waitForTimeout(800);
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore({...pos,charOffset:1},true),position);
 const picture=Buffer.from(await a.evaluate(()=>{const c=document.createElement('canvas');c.width=1600;c.height=800;const x=c.getContext('2d');x.fillStyle='#187652';x.fillRect(0,0,1600,800);return c.toDataURL().split(',')[1];}),'base64');
 const chooserPromise=a.waitForEvent('filechooser');await a.frameLocator('#studio').locator('button[data-cmd="insert:image"]').click();const chooser=await chooserPromise;
 // The other editor changes the same paragraph while the chooser is open.
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
  const para=pic.parentNode.parentNode,order=Array.from(para.getElementsByTagName('hp:run')).flatMap(r=>Array.from(r.childNodes).filter(n=>n.nodeType===1).map(n=>n.nodeName==='hp:pic'?'[사진]':n.nodeName==='hp:t'?n.textContent:'')).join('');
  assert.equal(order,'동료앞[사진]뒤','image must follow the original relative cursor');assert.equal(await p.locator('#error').isVisible(),false);
 }
 console.log('PASS toolbar file selection: inline image inside original cell, relative cursor preserved during peer edit, width fitted');
 await a.bringToFront();await a.reload();await a.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});await waitPictures(a,1);console.log('PASS image remains inside cell after reload');
 const pending=a.waitForEvent('download');await a.locator('#download').click();const download=await pending;assert.ok((await fs.promises.stat(await download.path())).size>1000);
 fs.mkdirSync('.test-output',{recursive:true});await a.evaluate(pos=>{const w=document.querySelector('#studio').contentWindow,r=w.jongwonStudio.caretRect(pos);if(r&&r.y>700)w.document.querySelector('#scroll-container').scrollTop+=r.y-350;},position);await a.waitForTimeout(300);await a.screenshot({path:'.test-output/image-button.png',fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS HWPX download and no browser errors');
 const bodyPosition={sectionIndex:0,paragraphIndex:0,charOffset:0};
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),bodyPosition);
 const bodyChooser=a.waitForEvent('filechooser');await a.frameLocator('#studio').locator('button[data-cmd="insert:image"]').click();await(await bodyChooser).setFiles({name:'body.png',mimeType:'image/png',buffer:picture});
 await waitPictures(a,2);await waitPictures(b,2);
 const bodyPic=(await exported(a)).getElementsByTagName('hp:pic')[0];let ancestor=bodyPic.parentNode;while(ancestor){assert.notEqual(ancestor.nodeName,'hp:tc');ancestor=ancestor.parentNode;}
 assert.equal(bodyPic.getElementsByTagName('hp:pos')[0].getAttribute('treatAsChar'),'1');
 await a.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),bodyPosition);await a.keyboard.press('ControlOrMeta+z');await waitPictures(a,1);await waitPictures(b,1);
 console.log('PASS body cursor insertion and image undo synchronized to peer');

}finally{await browser.close();}
