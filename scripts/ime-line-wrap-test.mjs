// Korean (IME) typing in a table cell must wrap onto new lines like ordinary typing; it used to cram the
// second line (letters squeezed sideways) and leave an empty last line. Documents saved in that state are
// re-laid out when opened.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
const TEXT='1. 4.2MW가 공고에 나와있어도 이거 이상의 전력을 최대한 많이 깔아라 -> 예산 내에 최대한 깔도록 하면 될거같다 -> 우리의 목표는 어떻게든 수주를 하겠다!!! 어떻게 하면 비용을 줄이고 최대한 많이 생산할 수 있을까 그리고 계속 입력합니다';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const a=await ctx.newPage(),b=await ctx.newPage();
 const url='http://127.0.0.1:5173/?demo=1&room=ime-wrap-'+Date.now();
 for(const p of[a,b]){await p.goto(url);await p.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});}
 const cell=(ci,off)=>({sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:ci,cellParaIndex:0,cellPath:[{controlIndex:0,cellIndex:ci,cellParaIndex:0}],charOffset:off});
 const starts=(p,ci)=>p.evaluate(ci=>{const w=document.querySelector('#studio').contentWindow.__inputHandler.wasm,len=w.getCellParagraphLength(0,1,0,ci,0),s=new Set();
  for(let o=0;o<=len;o++)s.add(w.getLineInfoInCell(0,1,0,ci,0,o).charStart);return [...s];},ci);
 const cdp=await ctx.newCDPSession(a);
 // the same sentence typed two ways in two empty cells of the same width (팀 명 and 프로젝트 주제)
 await a.bringToFront();await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(3,0));
 for(const ch of TEXT){if(ch===' '){await a.keyboard.insertText(' ');continue;}await cdp.send('Input.imeSetComposition',{text:ch,selectionStart:1,selectionEnd:1});await cdp.send('Input.insertText',{text:ch});}
 const typed=await starts(a,3); // right away, before any clean-up pass could run
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(1,0));
 await a.keyboard.insertText(TEXT);await a.waitForTimeout(2500);
 const ime=await starts(a,3),plain=await starts(a,1);
 // (the two cells' styles differ slightly, so compare the shape: same number of lines, no crammed line)
 const crammed=s=>s.length<3||s.at(-1)>=TEXT.length||s.slice(1).some((x,i)=>x-s[i]>s[1]+6);
 assert.ok(!crammed(typed),'Korean input wraps while typing: '+typed+' vs ordinary '+plain);assert.equal(typed.length,plain.length);assert.deepEqual(ime,typed);
 await b.bringToFront();await b.waitForTimeout(3000);assert.deepEqual(await starts(b,3),ime,'teammate sees the same lines');
 console.log('PASS Korean input wraps onto new lines in a cell (both screens)',JSON.stringify(ime));
 // a document saved with the squeezed layout is fixed when opened
 const src=unzipSync(new Uint8Array(fs.readFileSync(new URL('../template.hwpx',import.meta.url))));
 let xml=strFromU8(src['Contents/section0.xml']);const at=xml.indexOf('<hp:p ',xml.indexOf('</hp:tc>',xml.indexOf('프로젝트 주제')));const end=xml.indexOf('</hp:p>',at)+7;
 const seg=pos=>`<hp:lineseg textpos="${pos}" vertpos="0" vertsize="900" textheight="900" baseline="765" spacing="540" horzpos="0" horzsize="42828" flags="393216"/>`;
 const esc=TEXT.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
 xml=xml.slice(0,at)+xml.slice(at,end).replace(/<hp:run charPrIDRef="(\d+)"\/>/,`<hp:run charPrIDRef="$1"><hp:t>${esc}</hp:t></hp:run>`).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/,`<hp:linesegarray>${seg(0)}${seg(plain[1])}${seg(TEXT.length)}</hp:linesegarray>`)+xml.slice(end);
 src['Contents/section0.xml']=strToU8(xml);
 await a.bringToFront();await a.evaluate(async bytes=>{await document.querySelector('#studio').contentWindow.jongwonStudio.open(new Uint8Array(bytes),'squeezed.hwpx');},Array.from(zipSync(src)));
 await a.waitForTimeout(2500);
 const fixed=await starts(a,3);assert.ok(fixed.length>=3&&fixed.at(-1)<TEXT.length,'squeezed paragraph re-laid out: '+fixed);
 console.log('PASS a paragraph saved squeezed is re-laid out when opened',JSON.stringify(fixed));
}finally{await browser.close();}
