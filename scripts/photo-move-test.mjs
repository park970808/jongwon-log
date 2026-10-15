// 표 칸 안 사진 옮기기·잘라내기·붙이기·복사·지우기, 사진 줄이기, 여러 장 연속 삽입을 실제 편집기에서 검사합니다.
//   개발 서버(npm run dev -- --port 5173) 실행 후: node scripts/photo-move-test.mjs
// 사진마다 "혼자 한 줄", 저장된 사진 수 = 화면에 그려진 수 = 선택 대상 수, 글자와 겹치지 않음,
// 내 화면과 동료 화면(문서를 새로 그린 화면)의 사진 위치가 같음을 매 단계 확인합니다.
import {chromium} from '@playwright/test';
import fs from 'node:fs';import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';import {DOMParser} from '@xmldom/xmldom';

const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
const CELL={controlIndex:0,cellIndex:1};
const at=(cellParaIndex,charOffset=0)=>({sectionIndex:0,paragraphIndex:cellParaIndex,parentParaIndex:1,...CELL,cellParaIndex,cellPath:[{...CELL,cellParaIndex}],charOffset});
const studio=p=>p.frameLocator('#studio');
async function eventually(check,label,ms=20000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,250));}throw last||Error(label);}
async function files(p){const bytes=await p.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()));return unzipSync(new Uint8Array(bytes));}
async function xml(p){return new DOMParser().parseFromString(strFromU8((await files(p))['Contents/section0.xml']),'text/xml');}
/** Lines of the test cell: text, or [사진] for a paragraph holding a photo. */
async function lines(p){
  const cell=Array.from((await xml(p)).getElementsByTagName('hp:tc')).find(tc=>{const a=tc.getElementsByTagName('hp:cellAddr')[0];return a.getAttribute('rowAddr')==='0'&&a.getAttribute('colAddr')==='1';});
  return Array.from(cell.getElementsByTagName('hp:p')).filter(q=>q.parentNode.nodeName==='hp:subList').map(q=>{
    const pics=q.getElementsByTagName('hp:pic').length,text=Array.from(q.getElementsByTagName('hp:t')).map(t=>t.textContent).join('');
    if(pics&&text)throw Error(`photo shares a line with text: "${text}"`);
    return pics?'[사진]'.repeat(pics):text;
  }).filter(x=>x!==''); // blank lines are only spacing
}
async function layout(p){
  return p.evaluate(()=>{
    const h=document.querySelector('#studio').contentWindow.__inputHandler,controls=[],paints=[],texts=[];
    for(let page=0;page<h.wasm.pageCount;page++){
      for(const c of h.wasm.getPageControlLayout(page).controls)if(c.type==='image')controls.push({page,x:c.x,y:c.y,w:c.w,h:c.h});
      const walk=(n,cell)=>{if(n.groupKind?.kind==='tableCell')cell=n.bounds;for(const o of n.ops||[]){if(o.type==='image')paints.push({page,...o.bbox,cell});if(o.type==='textRun'&&o.text?.trim())texts.push({page,...o.bbox});}for(const c of n.children||[])walk(c,cell);if(n.child)walk(n.child,cell);};
      walk(h.wasm.getPageLayerTreeObject(page).root);
    }
    return {controls,paints,texts,height:h.wasm.getCellProperties(0,1,0,1).height};
  });
}
async function check(p,n,label){
  const l=await layout(p),saved=(await lines(p)).join('').split('[사진]').length-1;
  assert.equal(saved,n,`${label}: saved photos`);assert.equal(l.controls.length,n,`${label}: selectable photos`);assert.equal(l.paints.length,n,`${label}: painted photos (a stale or doubled paint shows as two)`);
  for(const q of l.paints){
    assert.ok(q.cell&&q.x>=q.cell.x-.5&&q.x+q.width<=q.cell.x+q.cell.width+.5&&q.y>=q.cell.y-.5&&q.y+q.height<=q.cell.y+q.cell.height+.5,`${label}: photo inside its cell`);
    for(const t of l.texts.filter(t=>t.page===q.page)){const over=Math.min(q.x+q.width,t.x+t.width)-Math.max(q.x,t.x)>.5&&Math.min(q.y+q.height,t.y+t.height)-Math.max(q.y,t.y)>.5;if(over)throw Error(`${label}: photo covers text ${JSON.stringify({photo:[q.page,q.x,q.y,q.width,q.height],cell:q.cell,text:[t.page,t.x,t.y,t.width,t.height]})}`);}
  }
  return l;
}
/** My screen right after the edit must look like a fresh redraw of the same document (the teammate's screen). */
async function consistent(a,b,label){
  await eventually(async()=>assert.deepEqual(await lines(b),await lines(a)),`${label}: peer document`);
  const round=l=>l.controls.map(c=>[c.page,Math.round(c.x),Math.round(c.y),Math.round(c.w),Math.round(c.h)]).sort().join('|');
  await eventually(async()=>assert.equal(round(await layout(b)),round(await layout(a))),`${label}: my layout equals a fresh redraw`);
}
async function clientPoint(p,box){return p.evaluate(({box})=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler,content=w.document.querySelector('#scroll-content'),s=w.document.querySelector('#scroll-container'),z=h.viewportManager.getZoom();s.scrollTop=Math.max(0,h.virtualScroll.getPageOffset(box.page)+box.y*z-200);const r=content.getBoundingClientRect(),f=document.querySelector('#studio').getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(box.page,content.clientWidth);return{x:f.x+r.x+left+(box.x+box.w/2)*z,y:f.y+r.y+h.virtualScroll.getPageOffset(box.page)+(box.y+box.h/2)*z};},{box});}
/** A screen point that hit-tests to pos (lines can overlap where a cell continues on the next page). */
async function caretPoint(p,pos){return p.evaluate(pos=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler,f=document.querySelector('#studio').getBoundingClientRect(),content=w.document.querySelector('#scroll-content'),z=h.viewportManager.getZoom();
  const r=h.wasm.getCursorRectInCell(pos.sectionIndex,pos.parentParaIndex,pos.controlIndex,pos.cellIndex,pos.cellParaIndex,pos.charOffset);
  const s=w.document.querySelector('#scroll-container'),viewY=h.virtualScroll.getPageOffset(r.pageIndex)+r.y*z-s.scrollTop;if(viewY<40||viewY>s.clientHeight-40)s.scrollTop=Math.max(0,h.virtualScroll.getPageOffset(r.pageIndex)+r.y*z-300);
  const b=content.getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(r.pageIndex,content.clientWidth);
  for(const dy of[r.height/2,r.height-2,r.height-4,2]){const x=b.x+left+r.x*z+1,y=b.y+h.virtualScroll.getPageOffset(r.pageIndex)+(r.y+dy)*z,hit=h.hitTestFromClientPoint(x,y);if(hit?.cellParaIndex===pos.cellParaIndex)return{x:f.x+x,y:f.y+y};}
  throw Error('no screen point hits '+JSON.stringify(pos));},pos);}
async function selectPhoto(p,index=0){const box=(await layout(p)).controls[index];const pt=await clientPoint(p,box);await p.mouse.click(pt.x,pt.y);await p.waitForTimeout(250);assert.ok(await p.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.cursor.isInPictureObjectSelection()),'photo selected');return pt;}
async function chooseImage(p,file){for(let i=0;;i++){const c=p.waitForEvent('filechooser',{timeout:3000}).catch(()=>null);await studio(p).locator('button[data-cmd="insert:image"]').click();const ch=await c;if(ch){await ch.setFiles(file);return;}if(i>=4)throw Error('file chooser did not open');}}
const restore=(p,pos)=>p.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),pos);
const paste=p=>p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,t=w.__inputHandler.textarea;t.focus();t.dispatchEvent(new w.ClipboardEvent('paste',{bubbles:true,cancelable:true}));});
async function noise(p,width,height,type,quality){return Buffer.from(await p.evaluate(({width,height,type,quality})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const g=c.getContext('2d'),img=g.createImageData(width,height);for(let i=0;i<img.data.length;i+=4){img.data[i]=Math.random()*255;img.data[i+1]=Math.random()*255;img.data[i+2]=Math.random()*255;img.data[i+3]=255;}g.putImageData(img,0,0);return c.toDataURL(type,quality).split(',')[1];},{width,height,type,quality}),'base64');}

try{
  const ctx=await browser.newContext({viewport:{width:1440,height:1100}}),a=await ctx.newPage(),b=await ctx.newPage(),errors=[];
  const url=(process.env.TEST_BASE_URL||'http://127.0.0.1:5173/')+'?demo=1&room=photo-move-'+Date.now();
  for(const p of[a,b]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(/jongwon|\[InputHandler\]/.test(m.text()))console.log('[page]',m.text().slice(0,300));});await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:60000});}
  await a.bringToFront();
  await restore(a,at(0));await a.keyboard.insertText('첫째 줄');await a.keyboard.press('Enter');await a.keyboard.insertText('둘째 줄');await a.keyboard.press('Enter');await a.keyboard.insertText('셋째 줄');
  await eventually(async()=>assert.deepEqual(await lines(b),['첫째 줄','둘째 줄','셋째 줄']),'peer has the text');
  const base=(await layout(a)).height;
  const green=Buffer.from(await a.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=600;const x=c.getContext('2d');x.fillStyle='#187652';x.fillRect(0,0,1200,600);return c.toDataURL().split(',')[1];}),'base64');
  await restore(a,at(1,0));await chooseImage(a,{name:'green.png',mimeType:'image/png',buffer:green});
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째 줄','[사진]','둘째 줄','셋째 줄']),'inserted');
  const inserted=(await check(a,1,'insert')).height;await consistent(a,b,'insert');
  console.log('PASS insert: own line, cell grown',base,'→',inserted);

  // 1) Drag the photo below the last line.
  let pt=await selectPhoto(a);const end=await caretPoint(a,at(3,4));
  await a.mouse.move(pt.x,pt.y);await a.mouse.down();await a.mouse.move(pt.x+10,pt.y+10,{steps:3});await a.mouse.move(end.x,end.y,{steps:12});await a.mouse.up();
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째 줄','둘째 줄','셋째 줄','[사진]']),'dragged to the end');
  let l=await check(a,1,'drag down');assert.ok(Math.abs(l.height-inserted)<=2500,`cell height kept (${inserted} → ${l.height})`);await consistent(a,b,'drag down');
  console.log('PASS drag photo below the last line (one undoable move, same on both screens)');

  // 2) Drag it back between the first and second lines.
  pt=await selectPhoto(a);const mid=await caretPoint(a,at(1,0));
  await a.mouse.move(pt.x,pt.y);await a.mouse.down();await a.mouse.move(pt.x,pt.y-10,{steps:3});await a.mouse.move(mid.x,mid.y,{steps:12});await a.mouse.up();
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째 줄','[사진]','둘째 줄','셋째 줄']),'dragged up');
  l=await check(a,1,'drag up');assert.equal(l.height,(await layout(b)).height);assert.ok(Math.abs(l.height-inserted)<=2500,`moves inside a cell keep its height (${inserted} → ${l.height})`);await consistent(a,b,'drag up');
  await a.evaluate(()=>window.__collab.binding.history('undo'));
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째 줄','둘째 줄','셋째 줄','[사진]']),'undo restores the previous place');
  await check(a,1,'undo');await consistent(a,b,'undo');
  console.log('PASS drag photo up between lines, and undo of a move');

  // 3) Cut: the photo, its line and the height it added go away; paste puts it on its own line.
  await selectPhoto(a);await a.keyboard.press('Control+x');
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째 줄','둘째 줄','셋째 줄']),'cut');
  l=await check(a,0,'cut');assert.ok(l.height<=inserted-25000&&l.height>=base,`cut gives back the height the photo added, never below the original (${base} → ${inserted} → ${l.height})`);await consistent(a,b,'cut');
  await restore(a,at(0,2));await paste(a); // in the middle of "첫째 줄"
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째','[사진]',' 줄','둘째 줄','셋째 줄']),'pasted in the middle of a line');
  l=await check(a,1,'paste');assert.ok(l.height>=inserted-2500,'cell grows again for the pasted photo');await consistent(a,b,'paste');
  console.log('PASS cut removes line and height; paste in the middle of text splits around the photo');

  // 4) Copy and paste duplicates; Delete removes one with its height.
  await selectPhoto(a);await a.keyboard.press('Control+c');{const q=await caretPoint(a,at(4,4));await a.mouse.click(q.x,q.y);}await paste(a); // click where it goes, as a person would
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째','[사진]',' 줄','둘째 줄','셋째 줄','[사진]']),'copied');
  const two=(await check(a,2,'copy')).height;await consistent(a,b,'copy');
  await selectPhoto(a,1);await a.keyboard.press('Delete');
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째','[사진]',' 줄','둘째 줄','셋째 줄']),'deleted');
  l=await check(a,1,'delete');assert.ok(l.height<two-15000,`delete shrinks the cell (${two} → ${l.height})`);await consistent(a,b,'delete');
  console.log('PASS copy/paste duplicates a photo; Delete removes it with the height it added');

  // Paste immediately after cutting, while capture/redraw timers are still pending.
  await selectPhoto(a);await a.keyboard.press('Control+x');
  await restore(a,at(1,0));await paste(a);
  await eventually(async()=>assert.deepEqual(await lines(a),['첫째','[사진]',' 줄','둘째 줄','셋째 줄']),'immediate cut/paste');
  await consistent(a,b,'immediate cut/paste');await check(a,1,'immediate cut/paste');
  console.log('PASS immediate cut/paste before redraw: one photo, correct line, same on both screens');

  // 5) Several photos in quick succession all arrive, each on its own line. (Record-size splitting for large
  //    photos is covered by tests/photo-sync.test.js; the in-browser demo stores records in localStorage.)
  //    The editor's preview cannot lay out a photo cell that continues on the next page (photos and text overlap
  //    there even for files made in Hangul), so these checks keep the cell within one page.
  for(let i=0;i<3;i++){await restore(a,at(0,0));await chooseImage(a,{name:`burst${i}.jpg`,mimeType:'image/jpeg',buffer:await noise(a,1200,160,'image/jpeg',0.9)});} // wide strips: the cell stays within one page
  await eventually(async()=>assert.equal((await lines(b)).filter(x=>x==='[사진]').length,4),'burst reached the peer',45000);
  assert.equal(await a.locator('#error').isVisible(),false,'no save error');
  await check(a,4,'burst');await consistent(a,b,'burst');
  console.log('PASS three photos in a row: saved, own lines, same on both screens');

  // 6) A phone-sized photo is shrunk before it enters the document.
  const phone=await noise(a,4000,3000,'image/jpeg',0.92);assert.ok(phone.length>4_000_000,`synthetic phone photo ${phone.length} bytes`);
  await restore(a,at(4,4));await chooseImage(a,{name:'phone.jpg',mimeType:'image/jpeg',buffer:phone});
  await eventually(async()=>assert.equal((await lines(a)).filter(x=>x==='[사진]').length,5),'phone photo inserted',30000);
  const bins=Object.entries(await files(a)).filter(([n])=>n.startsWith('BinData/'));
  const big=bins.map(([n,d])=>({n,size:d.length})).sort((x,y)=>y.size-x.size)[0];
  assert.ok(big.n.endsWith('.jpg')&&big.size<=1_600_000,`stored ${big.n} ${big.size} bytes`);
  const dims=await a.evaluate(async bytes=>{const b=await createImageBitmap(new Blob([new Uint8Array(bytes)]));return[b.width,b.height];},Array.from((await files(a))[big.n]));
  assert.deepEqual(dims,[2000,1500]);
  console.log('PASS phone photo stored as',dims.join('×'),big.size,'bytes instead of',phone.length);

  assert.deepEqual(errors,[]);
}finally{await browser.close();}
