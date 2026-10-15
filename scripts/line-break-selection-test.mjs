// Selecting across lines separated by Shift+Enter (line breaks inside one paragraph) must highlight every line.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const a=await (await browser.newContext({viewport:{width:1440,height:1000}})).newPage();
 await a.goto('http://127.0.0.1:5173/?demo=1&room=lb-'+Date.now());await a.waitForFunction(()=>!document.querySelector('#download').disabled,null,{timeout:45000});
 const cell=(para,off)=>({sectionIndex:0,paragraphIndex:para,parentParaIndex:1,controlIndex:0,cellIndex:22,cellParaIndex:para,cellPath:[{controlIndex:0,cellIndex:22,cellParaIndex:para}],charOffset:off});
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(0,0));
 const lines=['1주차 | 프로젝트 기획·현장 선정 및 역할 분담','- 팀명·팀장을 선정, 목표와 수행 범위 설정','- 마잔·자푸라 현장의 공사 난이도, 산업 활용, 에너지 전환, AWP 적용 여건을 비교해 프로젝트 대상 선정','- 주간 회의, 자료 공유','산출물: 프로젝트 활동일지'];
 for(const [i,l] of lines.entries()){await a.keyboard.insertText(l);if(i<lines.length-1)await a.keyboard.press('Shift+Enter');}
 await a.waitForTimeout(2000);
 await a.evaluate(q=>document.querySelector('#studio').contentWindow.jongwonStudio.restore(q,true),cell(0,1));
 for(let i=0;i<5;i++)await a.keyboard.press('Shift+ArrowDown');
 await a.waitForTimeout(300);
 const drawn=await a.evaluate(()=>{const d=document.querySelector('#studio').contentWindow.document;return new Set([...d.querySelectorAll('.selection-highlight, [class*=selection] div, [class*=selection-rect]')].map(e=>Math.round(e.getBoundingClientRect().top))).size;});
 // 5 typed lines, the third wraps: at least 6 highlighted rows
 assert.ok(drawn>=6,`highlighted rows: ${drawn}`);
 console.log('PASS selection across line breaks highlights every line:',drawn,'rows');
}finally{await browser.close();}
