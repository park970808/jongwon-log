import {chromium} from '@playwright/test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root=path.resolve('dist');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/jongwon-log/')){res.writeHead(404);res.end();return;}
  const file=path.resolve(root,decodeURIComponent(url.pathname.slice('/jongwon-log/'.length))||'index.html');if(!file.startsWith(root+path.sep))throw new Error('Invalid path');
  const body=await fsp.readFile(file);res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(body);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/jongwon-log/`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
 await page.goto(url+'?demo=1&room=production-'+Date.now());await page.locator('#download').waitFor({state:'visible',timeout:45000});await page.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});
 await page.evaluate(()=>document.querySelector('#studio').contentWindow.jongwonStudio.restore({sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:1,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:1,cellParaIndex:0}],charOffset:0},true));
 await page.keyboard.insertText('배포 빌드 확인');
 await page.waitForTimeout(1000);const pending=page.waitForEvent('download');await page.locator('#header-tab').hover();await page.waitForTimeout(300);await page.locator('#download').click();const download=await pending;assert.ok(download.suggestedFilename().endsWith('.hwpx'));assert.ok((await fsp.stat(await download.path())).size>1000);
 fs.mkdirSync('.test-output',{recursive:true});await page.screenshot({path:'.test-output/production-desktop.png',fullPage:true});
 const mobile=await browser.newPage({viewport:{width:390,height:844}});await mobile.goto(url);await mobile.screenshot({path:'.test-output/welcome-mobile.png',fullPage:true});
 assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'welcome must not overflow on mobile');assert.deepEqual(errors,[]);
 console.log('PASS: production build under /jongwon-log/, WASM/fonts, native typing, HWPX download, mobile welcome width');
}finally{await browser.close();await new Promise(r=>server.close(r));}
