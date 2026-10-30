// A long 한글 table (a project log: 날짜/주요내용/특이사항, header shading, merged cells) copied from another
// 한글 document and pasted into the body becomes the same table: inside the page width, merged cells kept, every
// row's text, borders — and the shared document accepts it (no "겹치거나 비어 있는 영역" stop), on both screens.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,ms=25000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,300));}throw last;}
const td=(w,h,text,extra='')=>`<TD valign="middle" ${extra} style='width:${w};height:${h};border-left:solid #000000 0.4pt;border-right:solid #000000 0.4pt;border-top:solid #000000 0.4pt;border-bottom:solid #000000 0.4pt;padding:1.4pt 5.1pt 1.4pt 5.1pt'><P CLASS=HStyle0 STYLE='text-align:center;'><SPAN STYLE='font-family:"HY중고딕"'>${text}</SPAN></P></TD>`;
let rows=`<TR>${td(113,30,'날짜','bgcolor="#e5e5e5"')}${td(300,30,'주요내용','bgcolor="#e5e5e5"')}${td(260,30,'특이사항','bgcolor="#e5e5e5"')}</TR>`;
const texts=[];
const N=40;for(let i=0;i<N;i++){const d=`2026-10-${String(i+1).padStart(2,'0')}`,t=`IWP 검색세트 구성 ${i}`;texts.push(d,t);
 if(i%6===0){rows+=`<TR>${td(113,40,d)}${td(300,40,t)}${td(260,80,'토요일 Discord 미팅','rowspan="2"')}</TR>`;texts.push('토요일 Discord 미팅');}
 else if(i%6===1)rows+=`<TR>${td(113,40,d)}${td(300,40,t)}</TR>`;
 else rows+=`<TR>${td(113,40,d)}${td(300,40,t)}${td(260,40,'')}</TR>`;}
const HTML=`<HTML><HEAD><META NAME="Generator" CONTENT="Hancom HWP 12.0.0.535"><STYLE type="text/css"><!--
p.HStyle0 {style-name:"바탕글"; margin-top:0.0pt; line-height:160%; font-size:10.0pt; font-family:함초롬바탕;}
--></STYLE></HEAD><BODY><!--StartFragment--><TABLE border="1" cellspacing="0" cellpadding="0" style='border-collapse:collapse;border:none;'>${rows}</TABLE><P CLASS=HStyle0></P><!--EndFragment--></BODY></HTML>`;
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1100}});const a=await ctx.newPage(),b=await ctx.newPage();
 const errors=[];for(const p of[a,b])p.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:5173/?demo=1&room=body-html-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 const n=await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getParagraphCount(0));
 await a.bringToFront();
 await a.evaluate(last=>document.querySelector('#studio').contentWindow.jongwonStudio.restore({sectionIndex:0,paragraphIndex:last,charOffset:0},true),n-1);
 await a.evaluate(h=>{const W=document.querySelector('#studio').contentWindow,ta=W.__inputHandler.textarea,dt=new W.DataTransfer();dt.setData('text/html',h);dt.setData('text/plain','날짜\t주요내용\t특이사항');ta.focus();ta.dispatchEvent(new W.ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},HTML);
 const table=p=>p.evaluate(para=>{const W=document.querySelector('#studio').contentWindow,w=W.__inputHandler.wasm,d=w.doc;
  const parts=[];for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='table'&&c.stableIndex.length===3&&c.stableIndex[1]===para)parts.push({page:i,x:c.x,w:c.w,y:c.y,h:c.h});
  if(!parts.length)return null;const def=w.getPageDef(0);
  const dims=JSON.parse(d.getTableDimensions?d.getTableDimensions(0,para,0):'{}');
  const texts=[];for(let k=0;k<(dims.cellCount||0);k++){const len=d.getCellParagraphLength(0,para,0,k,0);texts.push(d.getTextInCell(0,para,0,k,0,0,len));}
  return {parts,left:def.marginLeft/75,right:(def.width-def.marginRight)/75,top:def.marginTop/75,dims,texts,stopped:window.__collab.binding.stopped,warn:document.body.innerText.includes('겹치거나')};},n-1);
 const got=await eventually(async()=>{const t=await table(a);assert.ok(t,'a table at the caret');return t;});
 await a.waitForTimeout(2500);
 const t=await table(a);
 assert.equal(t.stopped,false,'the shared document accepts the table');assert.equal(t.warn,false);
 assert.equal(t.dims.rowCount,N+1);assert.equal(t.dims.colCount,3);
 for(const q of t.parts)assert.ok(q.x>=t.left-1&&q.x+q.w<=t.right+1,`inside the page width ${JSON.stringify(q)} ${t.left}-${t.right}`);
 assert.ok(t.parts.length>=2,'continues on the next page');
 for(const x of texts)assert.ok(t.texts.includes(x),'kept: '+x);
 assert.equal(t.texts.filter(x=>x==='토요일 Discord 미팅').length,Math.ceil(N/6),'merged cells kept (one text per merge)');
 assert.ok(t.dims.cellCount<(N+1)*3,'merged cells: '+t.dims.cellCount);
 const caret=await a.evaluate(()=>{const c=document.querySelector('#studio').contentWindow.__inputHandler.cursor.getPosition();return [c.paragraphIndex,c.parentParaIndex];});
 assert.deepEqual(caret,[n,undefined],'caret on the line after the table');
 await b.bringToFront();await eventually(async()=>{const x=await table(b);assert.deepEqual(x?.texts,t.texts);});
 await a.bringToFront();await a.keyboard.press('Control+z');
 await eventually(async()=>assert.equal(await table(a),null,'undo removes the pasted table'));
 await b.bringToFront();await eventually(async()=>assert.equal(await table(b),null));
 assert.deepEqual(errors,[]);
 console.log('PASS a long 한글 table with merged cells pastes into the body: in the page, merged cells and text kept, accepted, both screens; undo removes it',JSON.stringify({rows:t.dims.rowCount,cells:t.dims.cellCount,pages:t.parts.length}));
}finally{await browser.close();}
