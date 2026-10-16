// Usage: node scripts/compat/run.mjs <corpus dir> <out.json> [limit]
import {chromium} from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';
const [dir,out,limit,shard='0/1',...prior]=process.argv.slice(2);const [si,sn]=shard.split('/').map(Number);
const files=fs.readdirSync(dir).filter(f=>/\.(hwpx?)$/i.test(f)).sort().slice(0,limit&&limit!=='0'?Number(limit):undefined).filter((_,i)=>i%sn===si);
const done=fs.existsSync(out)?JSON.parse(fs.readFileSync(out,'utf8')):[];const seen=new Set(done.map(r=>r.name));for(const f of prior)if(fs.existsSync(f))for(const r of JSON.parse(fs.readFileSync(f,'utf8')))seen.add(r.name);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
let page=null,count=0;
async function fresh(){if(page)await page.close().catch(()=>{});page=await (await browser.newContext({viewport:{width:1440,height:1000}})).newPage();
  page.on('dialog',d=>d.dismiss().catch(()=>{}));
  await page.goto('http://127.0.0.1:5173/scripts/compat/index.html');await page.waitForFunction(()=>window.compatReady,null,{timeout:60000});}
const withTimeout=(p,ms,label)=>Promise.race([p,new Promise((_,j)=>setTimeout(()=>j(new Error('timeout '+label)),ms))]);
const MARK='호환검사';
for(const f of files){
  if(seen.has(f))continue;
  if(!page||count++%15===0)await fresh();
  const bytes=[...fs.readFileSync(path.join(dir,f))];let r;
  try{
    r=await withTimeout(page.evaluate(([b,n])=>window.compat.run(b,n),[bytes,f]),90000,'run');
    if(r.stage==='ready'){
      const targets=await page.evaluate(()=>window.compat.targets());let typed=0;
      for(const t of targets.slice(0,3)){
        await page.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),t);
        await page.keyboard.insertText(MARK);typed++;await page.waitForTimeout(250);
      }
      const e=await withTimeout(page.evaluate(m=>window.compat.finishEdit(m),MARK),60000,'edit');
      Object.assign(r,{typed,found:e.found,editErrors:e.errors});r.stage='done';
    }
  }catch(e){r={...(r||{name:f}),error:String(e.message).slice(0,300),crashed:true};await fresh();}
  r.bytes=bytes.length;done.push(r);fs.writeFileSync(out,JSON.stringify(done,null,1));
  console.log(done.length,f,r.stage,r.error?('ERR '+r.error.slice(0,80)):'',r.typed!==undefined?`${r.found}/${r.typed}`:'');
}
await browser.close();
