// The log form's left margin is wider than its right one, so the page-wide tables sat right of the paper's centre.
// Opened logs get equal left/right margins (same writing width): tables are centred on the page, on both screens
// and in the download.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import {unzipSync,strFromU8} from 'fflate';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
async function eventually(check,ms=20000){const end=Date.now()+ms;let last;while(Date.now()<end){try{return await check();}catch(e){last=e;}await new Promise(r=>setTimeout(r,300));}throw last;}
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const a=await ctx.newPage(),b=await ctx.newPage();
 const errors=[];for(const p of[a,b])p.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:5173/?demo=1&room=center-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});}
 const gaps=p=>p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,d=w.getPageDef(0),out=[];
  for(const c of w.getPageControlLayout(0).controls)if(c.type==='table'&&c.stableIndex.length===3)out.push([c.x,d.width/75-c.x-c.w]);
  return {margins:[d.marginLeft,d.marginRight],body:d.width-d.marginLeft-d.marginRight,gaps:out};});
 for(const p of[a,b])await eventually(async()=>{const g=await gaps(p);assert.equal(g.margins[0],g.margins[1],JSON.stringify(g));assert.ok(g.gaps.length&&g.gaps.every(([l,r])=>Math.abs(l-r)<=3),'tables centred: '+JSON.stringify(g));});
 const g=await gaps(a);assert.equal(g.body,59528-3685-2267,'same writing width as the form');
 const xml=strFromU8(unzipSync(new Uint8Array(await b.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()))))['Contents/section0.xml']);
 const m=xml.match(/<hp:margin [^>]*left="(\d+)" right="(\d+)"/);assert.equal(m[1],m[2],'download: equal margins '+m[0]);
 assert.deepEqual(errors,[]);
 console.log('PASS tables centred on the page (equal side margins, same width), both screens and download',JSON.stringify(g));
}finally{await browser.close();}
