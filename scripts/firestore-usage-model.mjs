// Firestore 사용량 모델: 이전 방식과 현재 방식을 같은 "금요일 1시간 집중 작성"에 적용해 비교합니다.
// 실제 코드의 FlushScheduler(전송 묶음)와 shouldSendPresence(커서)를 그대로 실행하고, 문서 1건당 비용은 코드 경로에서 셉니다.
//   node scripts/firestore-usage-model.mjs            표 출력
//   node scripts/firestore-usage-model.mjs --json     숫자만 (테스트용)
import {FlushScheduler,batchForPeers,CURSOR_MARGIN_MS} from '../src/sync-provider.js';
import {shouldSendPresence,PRESENCE} from '../src/presence-policy.js';
import {CHECKPOINT} from '../src/checkpoint-policy.js';

export const SCENARIO=Object.freeze({
  users:6,              // 모두 같은 문서를 1시간 동안 열어 둠 (서로의 변경을 실시간 수신)
  minutes:60,
  typingMinutes:20,     // 그중 실제로 입력하는 시간(사람당)
  editEveryMs:[300,700],// 입력 중 한글 음절 완성마다 변경 1회
  burstSeconds:[5,20],pauseSeconds:[3,40],
  paragraphMoveChance:0.5,// 입력 묶음을 시작할 때 다른 문단·칸으로 옮겨 가는 확률
  priorSessions:2,      // 이번 주에 이미 같은 규모로 두 번 작성됨(열 때 읽어야 하는 기존 기록)
  reloadAtMinute:30,    // 사람마다 한 번 새로고침
  checkpointBytes:3*1024*1024, // 사진이 든 주간 문서의 압축 상태 크기(가정) → 128 KiB 조각 수
  seed:20261014,
  dayHours:8,           // 하루 수업 동안 6명 모두 문서를 화면에 띄워 둠(입력은 위 1시간에만)
  concurrentCheckpoints:2,// 여러 명이 동시에 압축 조건을 만족해 압축본이 중복으로 만들어지는 경우를 반영
});
// 문서 1건(변경 묶음)에 드는 비용. 규칙의 get()/exists()도 읽기로 과금됩니다.
// rulesPerUpdate: 실시간 리스너가 문서 하나를 받을 때마다 읽기 규칙의 exists()가 다시 과금되는지.
//   공식 문서로 확인되지 않아, 테스트는 과금된다고 보는 '최악' 기준으로 한도를 검사합니다.
export const RULES={best:0,worst:1};
export const COST={
  old:{writes:2,authorReads:1+3,readsPerListener:2},   // 기록+조각 쓰기 · 사전 getDoc + 규칙(멤버·문서·조각의 getAfter) · 받는 쪽: 기록+조각
  new:{writes:1,authorReads:2,readsPerListener:1},     // 인라인 기록 1장 · 규칙(멤버·문서) · 받는 쪽: 기록 1장
  presence:{writes:1,authorReads:1},                   // 규칙(멤버) + 접속자 수만큼 수신
  quota:{reads:50000,writes:20000},
};

function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
const between=(r,[a,b])=>a+(b-a)*r();

/** One user's edits (ms) in bursts separated by pauses; `moves` marks bursts that start in another paragraph. */
function activity(r,s){
  const edits=[],moves=new Set(),budget=s.typingMinutes*60000,limit=s.minutes*60000;let t=between(r,[0,60000]),typed=0;
  while(typed<budget&&t<limit){
    const burst=Math.min(between(r,s.burstSeconds)*1000,budget-typed),end=t+burst;
    if(r()<s.paragraphMoveChance)moves.add(Math.round(t));
    for(let x=t;x<end&&x<limit;x+=between(r,s.editEveryMs))edits.push(Math.round(x));
    typed+=burst;t=end+between(r,s.pauseSeconds)*1000;
  }
  return {edits,moves};
}

/** Run the real FlushScheduler on a virtual clock; returns the times records are sent. */
function sendTimes(edits,timing){
  let now=0,timer=null;const sent=[];
  const clock={now:()=>now,set:(fn,ms)=>{timer={at:now+ms,fn};return 1;},clear:()=>{timer=null;}};
  const s=new FlushScheduler({...timing,clock,onFire:()=>sent.push(now)});
  const fireUntil=t=>{while(timer&&timer.at<=t){const {at,fn}=timer;timer=null;now=at;fn();}};
  for(const t of edits){fireUntil(t);now=t;s.touch();}
  fireUntil(Infinity);return sent;
}

function presenceWrites({edits,moves},minutes,decide){
  let i=0,lastSent=0,writes=0,pendingMove=false,pendingEdit=false,lastActivity=0,lastIdle=false;
  for(let now=0;now<minutes*60000;now+=PRESENCE.checkMs){
    while(i<edits.length&&edits[i]<=now){pendingEdit=true;lastActivity=edits[i];if(moves.has(edits[i]))pendingMove=true;i++;}
    const idle=now-lastActivity>=PRESENCE.idleAfterMs;
    if(decide({now,lastSent,paragraphChanged:pendingMove,offsetChanged:pendingEdit,anchorChanged:pendingEdit,hidden:false,lastHidden:false,idle,lastIdle,force:now===0})){
      writes++;lastSent=now;pendingMove=false;pendingEdit=false;lastIdle=idle;
    }
  }
  return writes;
}
const oldPresence=({now,lastSent,anchorChanged,force})=>force||anchorChanged||now-lastSent>=15000; // 1초마다 검사

/**
 * devices: 'cached'  각자 쓰던 기기로 다시 염 (이번 주 이전 기록은 이미 기기에 있음)
 *          'fresh'   매번 새 기기(교육원 공용 PC 등)로 염 → 기존 기록 전체를 받아야 함
 */
export function model(devices='cached',{rulesPerUpdate=RULES.worst}={},s=SCENARIO){
  const r=rng(s.seed),users=Array.from({length:s.users},()=>activity(r,s));
  const result={};
  for(const kind of ['old','new']){
    // old = 300 ms throttle; new = the real adaptive batching for this many other open sessions
    const timing=kind==='old'?{debounceMs:Number.MAX_SAFE_INTEGER,maxWaitMs:300}:batchForPeers(s.users-1);
    const all=users.map(u=>sendTimes(u.edits,timing)).flat().sort((a,b)=>a-b);
    const prior=all.length*s.priorSessions,c=COST[kind];
    let writes=all.length*c.writes,reads=all.length*(c.authorReads+(c.readsPerListener+rulesPerUpdate)*s.users);
    const pres=users.map(u=>presenceWrites(u,s.minutes,kind==='old'?oldPresence:shouldSendPresence)).reduce((a,b)=>a+b,0);
    writes+=pres*COST.presence.writes;reads+=pres*(COST.presence.authorReads+(1+rulesPerUpdate)*s.users);
    const reloadAt=s.reloadAtMinute*60000,beforeReload=all.filter(t=>t<reloadAt).length;
    const recent=all.filter(t=>t>=reloadAt-CURSOR_MARGIN_MS-30000&&t<reloadAt).length; // cursor saved ≤30 s before reload
    const checkpointReads=1+Math.ceil(s.checkpointBytes/(128*1024))+2; // checkpoint + chunks + their rules checks
    let firstOpen,reload,checkpointWrites=0;
    if(kind==='old'){firstOpen=prior*2;reload=(prior+beforeReload)*2;} // full log, record + chunk each
    else if(devices==='cached'){firstOpen=recent;reload=recent;}   // only the safety margin since last visit
    else{
      // A fresh device reads the latest checkpoint plus the records after it (at most CHECKPOINT.every + margin).
      const tail=Math.min(prior,CHECKPOINT.everyRecords)+recent;
      firstOpen=checkpointReads+tail;reload=checkpointReads+Math.min(prior+beforeReload,CHECKPOINT.everyRecords)+recent;
      const made=Math.floor((prior+all.length)/CHECKPOINT.everyRecords)-Math.floor(prior/CHECKPOINT.everyRecords);
      checkpointWrites=made*s.concurrentCheckpoints*(checkpointReads+1);
    }
    if(kind==='old'&&devices==='fresh'){/* same as cached: the old code always downloads everything */}
    writes+=checkpointWrites;
    // membership ×2, document metadata ×2 (+ rules), the rules check of the update and presence queries,
    // and the presence documents of everyone else
    const perOpen=8+s.users;
    reads+=s.users*(firstOpen+reload+2*perOpen);
    result[kind]={records:all.length,presenceWrites:pres,writes,reads,
      writesPct:Math.round(writes/COST.quota.writes*100),readsPct:Math.round(reads/COST.quota.reads*100)};
  }
  return result;
}

/**
 * A whole class day: the busy hour above, plus the rest of the day with everyone's document left open on screen
 * (idle presence heartbeats only) and one more open per person.
 */
export function day(devices='cached',{rulesPerUpdate=RULES.worst}={},s=SCENARIO){
  const busy=model(devices,{rulesPerUpdate},s).new;
  const idleMinutes=(s.dayHours-1)*60,quiet=presenceWrites({edits:[],moves:new Set()},idleMinutes,shouldSendPresence);
  const presence=s.users*quiet;
  const writes=busy.writes+presence;
  const reads=busy.reads+presence*(COST.presence.authorReads+(1+rulesPerUpdate)*s.users)+s.users*(8+s.users+200); // reopen: ≤ cursor margin tail
  return {writes,reads,writesPct:Math.round(writes/COST.quota.writes*100),readsPct:Math.round(reads/COST.quota.reads*100),idlePresenceWritesPerUser:quiet};
}

if(import.meta.url===`file://${process.argv[1]}`){
  if(process.argv.includes('--json')){console.log(JSON.stringify(Object.fromEntries(['cached','fresh'].flatMap(d=>Object.entries(RULES).map(([r,v])=>[`${d}-${r}`,model(d,{rulesPerUpdate:v})])))));process.exit(0);}
  const s=SCENARIO;
  console.log(`가정: ${s.users}명이 ${s.minutes}분 동안 같은 문서를 열고 각자 ${s.typingMinutes}분 입력, 이번 주 기존 기록 ${s.priorSessions}회분, 1인 1회 새로고침`);
  console.log('규칙 읽기: 실시간으로 받는 문서마다 규칙의 exists()가 과금된다고 보는 최악 기준 (괄호 안: 과금되지 않을 때)');
  for(const devices of ['cached','fresh']){
    const m=model(devices),b=model(devices,{rulesPerUpdate:RULES.best}),row=(k,label)=>`  ${label.padEnd(6)}${String(m[k].records).padStart(8)}${String(m[k].presenceWrites).padStart(10)}${String(m[k].writes).padStart(10)} (${String(m[k].writesPct).padStart(4)}%)${String(m[k].reads).padStart(11)} (${String(m[k].readsPct).padStart(5)}%, ${b[k].readsPct}%)`;
    console.log(`\n[${devices==='cached'?'각자 쓰던 기기':'매번 새 기기(공용 PC)'}]   변경기록  커서쓰기   쓰기(하루 한도 대비)   읽기(하루 한도 대비)`);
    console.log(row('old','이전'));console.log(row('new','현재'));
    console.log(`  → 쓰기 ${(m.old.writes/m.new.writes).toFixed(1)}배, 읽기 ${(m.old.reads/m.new.reads).toFixed(1)}배 감소`);
    const d=day(devices),db=day(devices,{rulesPerUpdate:RULES.best});
    console.log(`  하루 전체(${s.dayHours}시간 내내 화면에 띄워 둠, 위 1시간 포함): 쓰기 ${d.writes} (${d.writesPct}%), 읽기 ${d.reads} (${d.readsPct}%, ${db.readsPct}%)`);
  }
}
