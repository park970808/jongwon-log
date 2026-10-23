// Like 한글: tables go inside tables at any depth, and a pasted 한글/Excel/web table keeps its column widths,
// letter formatting, borders and cell colours.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,ms=15000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,250));}throw last;}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const a=await ctx.newPage(),b=await ctx.newPage();
 const errors=[];for(const p of[a,b])p.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:5173/?demo=1&room=cell-table-depth-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 const tables=p=>p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,r=[];for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='table')r.push({si:c.stableIndex,x:c.x,w:c.w,page:i});return r;});
 const pickGrid=async(row,col)=>{await a.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.dispatcher.dispatch('table:create'));
  const pt=await a.evaluate(([row,col])=>{const W=document.querySelector('#studio').contentWindow,f=document.querySelector('#studio').getBoundingClientRect();
   const cells=[...W.document.querySelectorAll('div')].filter(d=>d.style.position==='absolute'&&d.parentElement?.style.position==='relative'&&d.style.width===d.style.height);
   const tops=[...new Set(cells.map(c=>parseFloat(c.style.top)))].sort((x,y)=>x-y),lefts=[...new Set(cells.map(c=>parseFloat(c.style.left)))].sort((x,y)=>x-y);
   const el=cells.find(c=>parseFloat(c.style.top)===tops[row]&&parseFloat(c.style.left)===lefts[col]);const r=el.getBoundingClientRect();return {x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};},[row,col]);
  await a.mouse.move(pt.x,pt.y,{steps:3});await a.mouse.click(pt.x,pt.y);await a.waitForTimeout(1500);};
 await a.bringToFront();
 // 1) inside the PBL table that already sits inside a cell (2nd level) → a 3rd-level table
 const pbl=[{controlIndex:0,cellIndex:20,cellParaIndex:1},{controlIndex:0,cellIndex:10,cellParaIndex:0}];
 await a.evaluate(path=>document.querySelector('#studio').contentWindow.jongwonStudio.restore({sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:20,cellParaIndex:1,cellPath:path,charOffset:0},true),pbl);
 await pickGrid(1,1);
 const level3=(await tables(a)).filter(t=>t.si.length===12);assert.equal(level3.length,1,'a table two levels down: '+JSON.stringify(await tables(a)));
 const host=await a.evaluate(path=>{const d=document.querySelector('#studio').contentWindow.__inputHandler.wasm.doc;return JSON.parse(d.getTableCellBboxesByPath(0,1,JSON.stringify(path))).find(b=>b.cellIdx===10);},pbl);
 assert.ok(level3[0].x>=host.x-.5&&level3[0].x+level3[0].w<=host.x+host.w+.5,'fits the small cell');
 // 2) and one more level inside that new table
 const inner=[...pbl.slice(0,1),{...pbl[1],cellParaIndex:level3[0].si[8]},{controlIndex:level3[0].si[9],cellIndex:0,cellParaIndex:0}];
 await a.evaluate(path=>document.querySelector('#studio').contentWindow.jongwonStudio.restore({sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:20,cellParaIndex:1,cellPath:path,charOffset:0},true),inner);
 await pickGrid(0,1);
 assert.equal((await tables(a)).filter(t=>t.si.length===15).length,1,'a table three levels down');
 await b.bringToFront();await eventually(async()=>assert.equal((await tables(b)).filter(t=>t.si.length>=12).length,2));
 console.log('PASS tables inside tables inside tables (both screens)');
 // 3) a 한글-style HTML table: widths 1:3, bold centred text, red left border, yellow cell
 await a.bringToFront();
 const cell=ci=>({sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:ci,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:ci,cellParaIndex:0}],charOffset:0});
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(22));
 await a.evaluate(()=>{const W=document.querySelector('#studio').contentWindow,ta=W.__inputHandler.textarea,dt=new W.DataTransfer();
  dt.setData('text/html',`<TABLE border=1 cellspacing=0 cellpadding=0 style='border-collapse:collapse;border:none;'><TR>
   <TD width=60 height=40 style='border-left:solid #ff0000 1.1pt;border-right:solid #000000 0.4pt;border-top:solid #000000 0.4pt;border-bottom:solid #000000 0.4pt;background:#ffff00'><P STYLE='text-align:center'><SPAN STYLE='font-weight:bold;font-size:12.0pt'>굵게</SPAN></P></TD>
   <TD width=180 height=40 style='border:solid #000000 0.4pt'><P><SPAN STYLE='font-size:10.0pt'>보통 글자</SPAN></P></TD></TR></TABLE>`);
  dt.setData('text/plain','굵게\t보통 글자');ta.focus();ta.dispatchEvent(new W.ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));});
 await a.waitForTimeout(1500);
 const got=await a.evaluate(()=>{const W=document.querySelector('#studio').contentWindow,w=W.__inputHandler.wasm,d=w.doc;
  let t;for(let i=0;i<w.pageCount;i++)for(const c of w.getPageControlLayout(i).controls)if(c.type==='table'&&c.stableIndex.length===9&&c.stableIndex[3]===22)t={c,page:i};
  const path=k=>JSON.stringify([{controlIndex:0,cellIndex:22,cellParaIndex:t.c.stableIndex[4]},{controlIndex:t.c.stableIndex[5],cellIndex:k,cellParaIndex:0}]);
  const boxes=JSON.parse(d.getTableCellBboxesByPath(0,1,path(0)));const cp=JSON.parse(d.getCellCharPropertiesAtByPath(0,1,path(0),1));
  // colour of the yellow cell and of its left edge, from the page as drawn
  const cv=W.document.createElement('canvas');w.renderPageToCanvas(t.page,cv,2);const g=cv.getContext('2d');const b0=boxes[0];
  const px=(x,y)=>Array.from(g.getImageData(Math.round(x*2),Math.round(y*2),1,1).data).slice(0,3);
  return {widths:boxes.map(b=>Math.round(b.w)),bold:cp.bold,size:cp.fontSize,text:d.getTextInCellByPath(0,1,path(1),0,20),fill:px(b0.x+4,b0.y+b0.h-4),edge:px(b0.x+0.5,b0.y+b0.h/2)};});
 assert.ok(Math.abs(got.widths[1]/got.widths[0]-3)<0.2,'column widths 1:3 '+got.widths);
 assert.equal(got.bold,true);assert.equal(got.size,1200);assert.equal(got.text,'보통 글자');
 assert.ok(got.fill[0]>200&&got.fill[1]>200&&got.fill[2]<80,'yellow cell '+got.fill);assert.ok(got.edge[0]>150&&got.edge[1]<100,'red left border '+got.edge);
 assert.deepEqual(errors,[]);
 console.log('PASS 한글-style table keeps widths, bold 12pt text, red border and yellow cell',JSON.stringify(got));
}finally{await browser.close();}
