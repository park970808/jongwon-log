import {chromium} from '@playwright/test';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,setDoc} from 'firebase/firestore';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const env=await initializeTestEnvironment({projectId:'demo-jongwon',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.collaboration.rules','utf8')}});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
const contexts=[await browser.newContext({viewport:{width:1440,height:1000}}),await browser.newContext({viewport:{width:1440,height:1000}})];
const pages=[await contexts[0].newPage(),await contexts[1].newPage()];const errors=[];
for(const p of pages)p.on('pageerror',e=>errors.push(e.message));
const id='e2e-'+Date.now();
async function grant(page){
 await page.locator('button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#error-text').textContent.includes('UID:'),null,{timeout:15000});
 const message=await page.locator('#error-text').textContent(),uid=message.match(/UID: ([A-Za-z0-9_-]+)/)[1];
 await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'teams','team-3','collaborationMembers',uid),{role:'editor'}));
 await page.locator('button[type=submit]').click();
}
const position={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:1,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:1,cellParaIndex:0}],charOffset:0};
const text=p=>p.evaluate(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000));
try{
 for(let i=0;i<2;i++){
  const p=pages[i];await p.bringToFront();await p.goto(`http://127.0.0.1:5173/?emulator=1&team=team-3&doc=${id}&name=${i?'Bob':'Alice'}`);await grant(p);
  if(i===0){await p.locator('#create').click();}
  await p.waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});
 }
 for(const p of pages)await p.evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);
 await Promise.all([pages[0].keyboard.insertText('화재예방 '),pages[1].keyboard.insertText('안전교육 ')]);
 for(const p of pages)await p.waitForFunction(()=>{const w=document.querySelector('#studio').contentWindow,t=w.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000);return t.includes('화재예방')&&t.includes('안전교육');},null,{timeout:25000});
 assert.equal(await text(pages[0]),await text(pages[1]));console.log('PASS Firestore: independent browser contexts, same-cell concurrent Korean text');
 await contexts[1].setOffline(true);await pages[1].evaluate(pos=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(pos,true),position);await pages[1].keyboard.insertText('오프라인수정 ');
 await pages[1].waitForTimeout(800);await contexts[1].setOffline(false);
 await pages[0].waitForFunction(()=>document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).includes('오프라인수정'),null,{timeout:30000});
 console.log('PASS Firestore: offline edit delivered after reconnection');
 await pages[0].evaluate(()=>window.__collab.binding.history('undo'));
 await pages[1].waitForFunction(()=>!document.querySelector('#studio').contentWindow.__inputHandler.wasm.getTextInCell(0,1,0,1,0,0,10000).includes('화재예방'),null,{timeout:20000});
 assert.ok((await text(pages[1])).includes('안전교육'));console.log('PASS Firestore: undo retained other user edits');
 await pages[0].bringToFront();await pages[0].reload();await pages[0].locator('button[type=submit]').click();await pages[0].waitForFunction(()=>window.__collab?.binding,null,{timeout:45000});assert.ok((await text(pages[0])).includes('오프라인수정'));
 console.log('PASS Firestore: reload recovered persisted updates');
 fs.mkdirSync('.test-output',{recursive:true});await pages[0].screenshot({path:'.test-output/firestore-desktop.png',fullPage:true});assert.equal(errors.length,0,errors.join('\n'));
}catch(e){console.error(e);for(const p of pages){console.log('ERROR UI',await p.locator('#error-text').textContent({timeout:1000}).catch(()=>''));}process.exitCode=1;}
finally{await browser.close();await env.cleanup();}
