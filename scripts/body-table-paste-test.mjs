// Like 한글: a log that ends with a table keeps an empty paragraph after it, so a person can click below the
// last table and write there; a table copied from another document (한글, or another log in this editor) pastes
// into the body as a table, the caret goes after it, and typing continues below it — on both screens.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,ms=20000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,300));}throw last;}
// a log ending with its last table (as some team logs do): the template without its final empty paragraph
const files=unzipSync(fs.readFileSync(new URL('../template.hwpx',import.meta.url)));
let sec=strFromU8(files['Contents/section0.xml']);sec=sec.slice(0,sec.lastIndexOf('<hp:p '))+sec.slice(sec.lastIndexOf('</hs:sec>'));
files['Contents/section0.xml']=strToU8(sec);const fixture=Buffer.from(zipSync(files));
const HANCOM=`<HTML><HEAD><META NAME="Generator" CONTENT="Hancom HWP 12.0.0.535"><STYLE type="text/css"><!--
p.HStyle0 {style-name:"바탕글"; margin-top:0.0pt; text-align:justify; line-height:160%; font-size:10.0pt; font-family:함초롬바탕; color:#000000;}
--></STYLE></HEAD><BODY><!--StartFragment-->
<TABLE border="1" cellspacing="0" cellpadding="0" style='border-collapse:collapse;border:none;'>
<TR><TD valign="middle" style='width:113;height:35;border:solid #000000 0.4pt;background:#e5e5e5;padding:1.4pt 5.1pt 1.4pt 5.1pt'><P CLASS=HStyle0 STYLE='text-align:center;'><SPAN STYLE='font-weight:"bold"'>날짜</SPAN></P></TD>
<TD valign="middle" style='width:453;height:35;border:solid #000000 0.4pt;background:#e5e5e5;padding:1.4pt 5.1pt 1.4pt 5.1pt'><P CLASS=HStyle0 STYLE='text-align:center;'><SPAN STYLE='font-weight:"bold"'>주요내용</SPAN></P></TD></TR>
<TR><TD valign="middle" style='width:113;height:60;border:solid #000000 0.4pt'><P CLASS=HStyle0>2026-10-30</P></TD>
<TD valign="middle" style='width:453;height:60;border:solid #000000 0.4pt'><P CLASS=HStyle0>회의 진행</P></TD></TR>
</TABLE><P CLASS=HStyle0></P><!--EndFragment--></BODY></HTML>`;
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']});const a=await ctx.newPage(),b=await ctx.newPage();
 const errors=[];for(const p of[a,b]){p.on('pageerror',e=>errors.push(e.message));await p.route('**/template.hwpx',r=>r.fulfill({body:fixture}));}
 const url='http://127.0.0.1:5173/?demo=1&room=body-table-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 // top-level paragraphs: 'T' = holds a table, otherwise its text
 const body=p=>p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,n=w.getParagraphCount(0),tables=new Set();
  for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='table'&&c.stableIndex.length===3)tables.add(c.stableIndex[1]);
  return Array.from({length:n},(_,i)=>tables.has(i)?'T':w.getTextRange(0,i,0,w.getParagraphLength(0,i)));});
 const caret=p=>p.evaluate(()=>{const c=document.querySelector('#studio').contentWindow.__inputHandler.cursor.getPosition();return {para:c.paragraphIndex,inCell:c.parentParaIndex!==undefined};});
 // 1) the log ending with a table gets an empty paragraph after it
 for(const p of[a,b])await eventually(async()=>assert.deepEqual((await body(p)).slice(-2),['T','']));
 // clicking below the last table puts the caret in that paragraph, not in the table
 await a.bringToFront();
 const pt=await a.evaluate(()=>{const W=document.querySelector('#studio').contentWindow,h=W.__inputHandler,w=h.wasm,content=W.document.querySelector('#scroll-content'),z=h.viewportManager.getZoom(),f=document.querySelector('#studio').getBoundingClientRect();
  const page=w.pageCount-1;let bottom=0;for(const c of w.getPageControlLayout(page).controls)if(c.type==='table'&&c.stableIndex.length===3)bottom=Math.max(bottom,c.y+c.h);
  W.document.getElementById('scroll-container').scrollTop=h.virtualScroll.getPageOffset(page)+bottom*z-300;
  const r=content.getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(page,content.clientWidth);
  return {x:f.x+r.x+left+300*z,y:f.y+r.y+h.virtualScroll.getPageOffset(page)+(bottom+40)*z};});
 await a.mouse.click(pt.x,pt.y);await a.waitForTimeout(300);
 const n=(await body(a)).length;assert.deepEqual(await caret(a),{para:n-1,inCell:false},'caret below the last table');
 console.log('PASS a log ending with a table gets a paragraph after it; clicking below the table writes there (both screens)');
 // 2) paste a table copied in 한글 there: it becomes a table, the caret goes after it, typing continues below
 await a.evaluate(h=>{const W=document.querySelector('#studio').contentWindow,ta=W.__inputHandler.textarea,dt=new W.DataTransfer();dt.setData('text/html',h);dt.setData('text/plain','날짜\t주요내용\n2026-10-30\t회의 진행');ta.focus();ta.dispatchEvent(new W.ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},HANCOM);
 await a.waitForTimeout(500);
 const after=await caret(a);assert.equal(after.inCell,false);
 await a.keyboard.type('표 아래 글');
 await eventually(async()=>{const x=await body(a);const t=x.lastIndexOf('T');assert.equal(x.filter(y=>y==='T').length,4,'pasted table in the body: '+JSON.stringify(x));assert.ok(x.slice(t+1).includes('표 아래 글'),'typing goes below the pasted table: '+JSON.stringify(x));});
 const mine=await body(a);await b.bringToFront();await eventually(async()=>assert.deepEqual(await body(b),mine));
 const cells=await a.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,n=w.getParagraphCount(0);let t=-1;for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='table'&&c.stableIndex.length===3)t=Math.max(t,c.stableIndex[1]);
  return [0,1,2,3].map(k=>{const len=w.doc.getCellParagraphLength?.(0,t,0,k,0);return w.doc.getTextInCell(0,t,0,k,0,0,len??20);});});
 assert.deepEqual(cells,['날짜','주요내용','2026-10-30','회의 진행']);
 console.log('PASS a 한글 table pastes into the body as a table; the caret goes after it and typing continues below (both screens)');
 // 3) a table copied from another log in this editor (Ctrl+C on the selected table), pasted after reopening
 await a.bringToFront();
 await a.evaluate(()=>{const h=document.querySelector('#studio').contentWindow.__inputHandler;h.cursor.enterTableObjectSelectionDirect(0,3,0);h.active=true;h.eventBus.emit('table-object-selection-changed',true);h.textarea.focus();});
 await a.keyboard.press('Control+c');await a.waitForTimeout(300);
 const clip=await a.evaluate(async()=>{const out={};for(const it of await navigator.clipboard.read())for(const t of it.types)if(t.startsWith('text/'))out[t]=await (await it.getType(t)).text();return out;});
 const c=await ctx.newPage();c.on('pageerror',e=>errors.push(e.message));await c.route('**/template.hwpx',r=>r.fulfill({body:fixture}));
 await c.goto('http://127.0.0.1:5173/?demo=1&room=body-table-other-'+Date.now());await c.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});
 await eventually(async()=>assert.deepEqual((await body(c)).slice(-2),['T','']));
 const before=(await body(c)).filter(x=>x==='T').length,last=(await body(c)).length-1;
 await c.evaluate(last=>document.querySelector('#studio').contentWindow.jongwonStudio.restore({sectionIndex:0,paragraphIndex:last,charOffset:0},true),last);
 await c.evaluate(clip=>{const W=document.querySelector('#studio').contentWindow,ta=W.__inputHandler.textarea,dt=new W.DataTransfer();for(const [k,v] of Object.entries(clip))dt.setData(k,v);ta.focus();ta.dispatchEvent(new W.ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},clip);
 await eventually(async()=>{const x=await body(c);assert.equal(x.filter(y=>y==='T').length,before+1);assert.equal(x.at(-1),'','a paragraph after the pasted table');});
 assert.deepEqual(await caret(c),{para:(await body(c)).length-1,inCell:false});
 assert.deepEqual(errors,[]);
 console.log('PASS a table copied from another log pastes into the body; the caret is after it');
}finally{await browser.close();}
