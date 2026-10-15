import {chromium} from '@playwright/test';import fs from 'node:fs';import assert from 'node:assert/strict';
// Run against a local dev server. Synthetic photos and a fresh local demo room; no team documents are changed.
// TEST_BASE_URL=http://127.0.0.1:5185/ PERF_SEED_PHOTOS=8 node scripts/photo-performance.mjs
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
try{
 const p=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const fixture=process.env.PERF_FIXTURE;if(fixture)await p.route('**/template.hwpx',r=>r.fulfill({body:fs.readFileSync(fixture)}));
 await p.goto((process.env.TEST_BASE_URL||'http://127.0.0.1:5173/')+'?demo=1&room=photo-perf-'+Date.now());await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:120000});
 // Seed different cells with distinct wide JPEGs before measuring, to exercise a photo-heavy log.
 await p.evaluate(async count=>{
  const s=document.querySelector('#studio').contentWindow.jongwonStudio;
  for(let n=0;n<count;n++){
   const c=document.createElement('canvas');c.width=1000;c.height=200;
   const g=c.getContext('2d'),img=g.createImageData(c.width,c.height);let r=n+7;
   for(let i=0;i<img.data.length;i+=4){r=(r*1664525+1013904223)>>>0;img.data[i]=r&255;img.data[i+1]=(r>>>8)&255;img.data[i+2]=(r>>>16)&255;img.data[i+3]=255;}
   g.putImageData(img,0,0);const bytes=Uint8Array.from(atob(c.toDataURL('image/jpeg',.8).split(',')[1]),x=>x.charCodeAt(0)),cellIndex=3+n*2;
   s.insertImage({sectionIndex:0,parentParaIndex:1,paragraphIndex:0,controlIndex:0,cellIndex,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex,cellParaIndex:0}],charOffset:0},bytes,'jpg',1000,200,'seed-'+n+'.jpg');
  }
 },Number(process.env.PERF_SEED_PHOTOS||0));
 await p.waitForFunction(()=>{const b=window.__collab.binding;return !b.dirty&&!b.applying&&!b.refreshing&&!b.refreshTimer&&!b.remoteTimer;},null,{timeout:120000});
 if(process.env.PERF_SAVE_SEED)fs.writeFileSync(process.env.PERF_SAVE_SEED,Buffer.from(await p.evaluate(()=>Array.from(document.querySelector('#studio').contentWindow.jongwonStudio.exportHwpx()))));
 const cdp=await p.context().newCDPSession(p);if(process.env.PERF_PROFILE){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
 await p.evaluate(()=>{window.__perf=[];window.__phase='';const s=document.querySelector('#studio').contentWindow.jongwonStudio,w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,b=window.__collab.binding;
 function wrap(o,key,label){const original=o[key];if(!original)return;o[key]=function(...args){const start=performance.now(),phase=window.__phase;const done=()=>window.__perf.push({phase,label,ms:performance.now()-start});try{const r=original.apply(this,args);if(r?.then)return r.finally(done);done();return r;}catch(e){done();throw e;}};}
 for(const k of ['capture','adoptNativeBaseline','applyRemote','refreshLayout','anchor','resolveAnchor'])wrap(b,k,'binding.'+k);
 for(const k of ['insertImage','replace','fitCellPhotos'])wrap(s,k,'studio.'+k);
 for(const k of ['exportHwpx','getPageControlLayout','getPageLayerTreeObject','ensureCellPictureHeight','fitCellPictureHeights','loadDocument','saveSnapshot','pasteInternalInCellByPath','deleteCellPictureControlByPath','insertPicture','setCellProperties'])wrap(w,k,'wasm.'+k);
 });
 const pos={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:1,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:1,cellParaIndex:0}],charOffset:0};
 const file=Buffer.from(await p.evaluate(()=>{const c=document.createElement('canvas');c.width=1600;c.height=1200;const g=c.getContext('2d'),img=g.createImageData(c.width,c.height);let r=142;for(let i=0;i<img.data.length;i+=4){r=(r*1664525+1013904223)>>>0;img.data[i]=r&255;img.data[i+1]=(r>>>8)&255;img.data[i+2]=(r>>>16)&255;img.data[i+3]=255;}g.putImageData(img,0,0);return c.toDataURL('image/jpeg',.8).split(',')[1];}),'base64');
 async function idle(){await p.waitForTimeout(100);await p.waitForFunction(()=>{const b=window.__collab.binding;return !b.dirty&&!b.applying&&!b.refreshing&&!b.refreshTimer&&!b.remoteTimer;},null,{timeout:120000});await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
 async function phase(name,fn){await p.evaluate(name=>window.__phase=name,name);const start=Date.now();await fn();if(name==='insert')await p.waitForFunction(()=>window.__perf.some(r=>r.phase==='insert'&&r.label==='studio.insertImage')||document.querySelector('#error').style.display==='block',null,{timeout:120000});await idle();console.log(name,'settledMs',Date.now()-start);}
 await p.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),pos);
 await phase('insert',async()=>{const f=p.waitForEvent('filechooser');await p.frameLocator('#studio').locator('button[data-cmd="insert:image"]').click();await(await f).setFiles({name:'perf.jpg',mimeType:'image/jpeg',buffer:file});});
 const pt=await p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,h=w.__inputHandler,s=w.document.querySelector('#scroll-container'),content=w.document.querySelector('#scroll-content');let c,page;for(let i=0;i<h.wasm.pageCount;i++){c=h.wasm.getPageControlLayout(i).controls.find(x=>x.type==='image'&&x.cellIdx===1);if(c){page=i;break;}}if(!c)throw Error('missing inserted photo');const z=h.viewportManager.getZoom();s.scrollTop=h.virtualScroll.getPageOffset(page)+c.y*z-180;const r=content.getBoundingClientRect(),f=document.querySelector('#studio').getBoundingClientRect(),left=h.virtualScroll.getPageLeftResolved(page,content.clientWidth);return{x:f.x+r.x+left+(c.x+c.w/2)*z,y:f.y+r.y+h.virtualScroll.getPageOffset(page)+(c.y+c.h/2)*z};});await p.mouse.click(pt.x,pt.y);
 await phase('cut',()=>p.keyboard.press('Control+x'));
 await p.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),pos);
 await phase('paste',()=>p.evaluate(()=>{const w=document.querySelector('#studio').contentWindow,t=w.__inputHandler.textarea;t.focus();t.dispatchEvent(new w.ClipboardEvent('paste',{bubbles:true,cancelable:true}));}));
 if(process.env.PERF_PROFILE){const profile=await cdp.send('Profiler.stop');fs.writeFileSync(process.env.PERF_PROFILE,JSON.stringify(profile.profile));}
 assert.equal(await p.locator('#error').isVisible(),false,await p.locator('#error-text').textContent());assert.deepEqual(errors,[]);
 console.log(JSON.stringify(await p.evaluate(()=>{const stats={};for(const row of window.__perf){if(!row.phase)continue;const key=row.phase+' '+row.label;const s=stats[key]??={count:0,ms:0,max:0};s.count++;s.ms+=row.ms;s.max=Math.max(s.max,row.ms);}for(const s of Object.values(stats)){s.ms=Math.round(s.ms);s.max=Math.round(s.max);}return{stats,error:document.querySelector('#error-text').textContent};}),null,2));
}finally{await browser.close();}
