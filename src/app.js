import * as Y from 'yjs';
import {IndexeddbPersistence} from 'y-indexeddb';
import {initializeApp,getApps} from 'firebase/app';
import {getAuth,signInAnonymously,connectAuthEmulator} from 'firebase/auth';
import {getFirestore,connectFirestoreEmulator,doc as firestoreDoc,getDoc,setDoc,serverTimestamp} from 'firebase/firestore';
import {FIREBASE_CONFIGS} from './firebase-config.js';
import {FirestoreBackend} from './firestore-backend.js';
import {DemoBackend} from './demo-backend.js';
import {SyncProvider,IndexedOutbox,encodeEnvelope,decodeEnvelope,REMOTE} from './sync-provider.js';
import {importParts,readHwpx,writeHwpx} from './document-model.js';
import {EditorBinding} from './editor-binding.js';

const $=s=>document.querySelector(s),params=new URLSearchParams(location.search);
const invitation=new URLSearchParams(location.hash.slice(1)).get('invite')||'';
if(invitation)$('#invite-code').value=invitation;
const session=crypto.randomUUID();let active=null,connection=null,busy=false;
const statusLabels={connecting:'Firestore 연결 중…',saving:'저장 중…',saved:'Firestore에 저장됨',offline:'연결 끊김 · 이 기기에 보관됨',error:'저장 상태를 확인해 주세요'};
function isoWeek(d){const x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));x.setUTCDate(x.getUTCDate()+4-(x.getUTCDay()||7));const n=Math.ceil((((x-new Date(Date.UTC(x.getUTCFullYear(),0,1)))/86400000)+1)/7);return `${x.getUTCFullYear()}-W${String(n).padStart(2,'0')}`;}
$('#week').value=params.get('week')||isoWeek(new Date());$('#doc-id').value=params.get('doc')||$('#week').value;
$('#team').value=FIREBASE_CONFIGS[params.get('team')]?params.get('team'):'team-3';
$('#name').value=params.get('name')||localStorage.getItem('jongwon-collab-name')||'';
$('#week').onchange=()=>$('#doc-id').value=$('#week').value;
function error(e){
 const message=e?.message||String(e);$('#error').hidden=false;
 $('#error-text').textContent=/permission-denied|Missing or insufficient permissions/i.test(`${e?.code} ${message}`)
 ? `공동 문서 접근 권한이 없습니다. 관리자에게 공동 편집 규칙과 팀 권한 설정을 요청하세요.${connection?.uid?` 사용자 UID: ${connection.uid}`:''}`:message;
 $('#save-status').textContent='확인이 필요합니다';
 if(active?.binding?.stopped)$('#retry').disabled=true;
 console.error(e);
}
function download(bytes,name,type='application/octet-stream'){const url=URL.createObjectURL(new Blob([bytes],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function getStudio(){
 const iframe=$('#studio');
 for(let i=0;i<300;i++){const studio=iframe.contentWindow?.jongwonStudio;if(studio){await studio.ready();return studio;}await new Promise(r=>setTimeout(r,100));}
 throw new Error('편집기를 준비하지 못했습니다. 새로고침 후 다시 시도해 주세요.');
}
function identity(){
 const team=$('#team').value,id=$('#doc-id').value.trim(),name=$('#name').value.trim()||'체험 사용자',week=$('#week').value;
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new Error('문서 ID는 영문, 숫자, -와 _로 입력해 주세요.');
 localStorage.setItem('jongwon-collab-name',name);
 return {team,id,name,week};
}
async function connect(){
 const {team,id}=identity();if(connection?.team===team&&connection.id===id)return connection;
 const emulator=import.meta.env.DEV&&params.get('emulator')==='1';
 const config=emulator?{apiKey:'demo-key',projectId:'demo-jongwon',authDomain:'localhost'}:FIREBASE_CONFIGS[team];
 const appName=emulator?'demo-jongwon':team;
 const app=getApps().find(a=>a.name===appName)||initializeApp(config,appName);
 const auth=getAuth(app),db=getFirestore(app);
 if(emulator&&!app.__emulators){connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectFirestoreEmulator(db,'127.0.0.1',8080);app.__emulators=true;}
 await auth.authStateReady();const user=auth.currentUser||(await signInAnonymously(auth)).user;
 connection={db,uid:user.uid,team,id,backend:new FirestoreBackend(db,team,id)};
 return connection;
}
async function ensureMembership(c){
 const ref=firestoreDoc(c.db,'teams',c.team,'collaborationMembers',c.uid);
 const current=await getDoc(ref);
 if(current.data()?.role==='editor'){$('#join-options').hidden=true;return true;}
 const code=$('#invite-code').value.trim();
 if(!code){$('#join-options').hidden=false;return false;}
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code));
 const inviteHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
 await setDoc(ref,{role:'editor',inviteHash,joinedAt:serverTimestamp()});
 $('#join-options').hidden=true;
 return true;
}
async function openFirestore(){
 const c=await connect();if(!await ensureMembership(c))return;const meta=await c.backend.metadata();
 $('#connection-info').textContent=`Firebase 연결됨 · 사용자 UID: ${c.uid}`;
 if(!meta){$('#create-options').hidden=false;return;}
 const membership=await getDoc(firestoreDoc(c.db,'teams',c.team,'collaborationMembers',c.uid));
 if(membership.data()?.role!=='editor')throw new Error('이 문서는 편집 권한이 있는 팀원만 열 수 있습니다.');
 await launch({backend:c.backend,author:c.uid,meta,demo:false});
}
async function createFirestore(){
 const c=await connect();if(!await ensureMembership(c))return;const who=identity(),studio=await getStudio();
 $('#workspace').hidden=false;$('#loading').hidden=false;$('#loading').textContent='문서 양식을 준비하고 있습니다…';
 const file=$('#import-file').files[0];const bytes=file?new Uint8Array(await file.arrayBuffer()):new Uint8Array(await (await fetch('./template.hwpx')).arrayBuffer());
 readHwpx(bytes);await studio.open(bytes,file?.name||'활동일지.hwpx');
 const document=new Y.Doc({gc:false});importParts(document,readHwpx(studio.exportHwpx()));
 const seed=encodeEnvelope(Y.encodeStateAsUpdate(document),c.uid,session);
 await c.backend.create({title:`${who.week} 활동일지`,week:who.week,seed,author:c.uid,session});
 document.destroy();await launch({backend:c.backend,author:c.uid,meta:{title:`${who.week} 활동일지`},demo:false});
}
async function openDemo(){
 const who=identity();const room=params.get('room')||'activity-log-v1';const backend=new DemoBackend(room);
 $('#workspace').hidden=false;$('#loading').hidden=false;$('#loading').textContent='알한글 편집기를 준비하고 있습니다…';
 const studio=await getStudio();
 await navigator.locks.request(`jongwon-seed:${room}`,async()=>{
   if(backend.stored().length)return;
   const bytes=new Uint8Array(await (await fetch('./template.hwpx')).arrayBuffer());
   await studio.open(bytes,'활동일지.hwpx');
   const document=new Y.Doc({gc:false});importParts(document,readHwpx(studio.exportHwpx()));
   await backend.append(encodeEnvelope(Y.encodeStateAsUpdate(document),'demo',session));document.destroy();
 });
 const url=new URL(location.href);url.searchParams.set('demo','1');url.searchParams.set('room',room);history.replaceState(null,'',url);
 await launch({backend,author:`demo-${session}`,meta:{title:'활동일지 · 기기 내 체험'},demo:true});
}
async function launch({backend,author,meta,demo}){
 const who=identity();if(active)throw new Error('다른 문서를 열려면 새 탭을 사용해 주세요.');
 $('#welcome').hidden=true;$('#workspace').hidden=false;$('#loading').hidden=false;
 $('#document-title').textContent=meta.title;$('#mode').textContent=demo?'기기 내 체험 · 같은 브라우저 탭끼리만 연결':'Firestore 공동 편집';
 const document=new Y.Doc({gc:false}),namespace=`jongwon-collab-v1:${demo?'demo:'+backend.room:who.team+':'+who.id}`;
 const persistence=new IndexeddbPersistence(namespace,document);await persistence.whenSynced;
 const studio=await getStudio();
 let resolveReady,rejectReady;const initial=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const provider=new SyncProvider({doc:document,backend,author,session,outbox:new IndexedOutbox(`${namespace}:outbox:${author}`),onStatus:({state})=>{
   $('#save-status').textContent=demo?(state==='saved'?'이 기기에 저장됨 · 다른 탭과 연결':state==='connecting'?'기기 내 문서 불러오는 중…':statusLabels[state]):statusLabels[state];
   if(state==='saved')resolveReady();
 },onError:e=>{if(provider.fatal&&active?.binding)active.binding.fail(e);else error(e);rejectReady(e);}});
 active={doc:document,provider,persistence,backend,studio,demo,who,author};
 await provider.start();
 await Promise.race([initial,new Promise((_,reject)=>setTimeout(()=>reject(new Error('서버 응답이 없습니다. 연결 상태를 확인한 뒤 새로고침해 주세요.')),30000))]);
 if(!document.getMap('parts').size)throw new Error('문서 데이터가 없습니다.');
 const binding=new EditorBinding({doc:document,studio,onError:error});active.binding=binding;
 await binding.start();
 $('#loading').hidden=true;$('#share').disabled=false;$('#download').disabled=false;$('#error').hidden=true;
 if(!demo){const url=new URL(location.href);url.searchParams.set('team',who.team);url.searchParams.set('doc',who.id);url.searchParams.set('week',who.week);history.replaceState(null,'',url);}
 $('#legacy-link').href=`./legacy/index.html?team=${encodeURIComponent(who.team)}`;
 // Recover local Yjs changes that survived a crash before the transport queued them.
 await provider.recoverLocalState();
 if(!demo)startPresence(active);
 if(import.meta.env.DEV)window.__collab={...active,Y};
}
function startPresence(a){
 let peers=[],last='',lastSent=0,inflight=false;
 const send=async()=>{
   if(inflight||a.binding.applying||a.binding.stopped)return;
   const anchor=a.binding.anchor(),value=JSON.stringify(anchor),now=Date.now();
   if(value===last&&now-lastSent<15000)return;
   inflight=true;try{await a.backend.presence(session,{uid:a.author,name:a.who.name.slice(0,30),anchor:JSON.stringify(anchor),active:!document.hidden});last=value;lastSent=now;}catch(e){error(e);}finally{inflight=false;}
 };
 a.presenceInterval=setInterval(send,1000);void send();
 a.presenceOff=a.backend.watchPresence(list=>{peers=list;render();},error);
 function render(){
   const current=peers.filter(p=>p.id!==session&&p.active&&p.updatedAt?.toMillis()>Date.now()-45000);
   $('#peers').replaceChildren();$('#remote-cursors').replaceChildren();
   current.forEach((p,i)=>{
     const color=['#4274a5','#a45d40','#588667','#825e9d'][i%4];
     const badge=document.createElement('span');badge.className='peer';badge.textContent=p.name?.slice(0,2)||'팀원';badge.title=p.name;$('#peers').append(badge);
     try{const position=a.binding.resolveAnchor(JSON.parse(p.anchor||'null'),a.binding.mirror),rect=a.studio.caretRect(position);if(!rect)return;
       const caret=document.createElement('div');caret.className='peer-caret';caret.style.cssText=`--peer:${color};left:${rect.x}px;top:${rect.y}px;height:${rect.height}px`;
       const label=document.createElement('span');label.textContent=p.name;caret.append(label);$('#remote-cursors').append(caret);
     }catch{ /* expired anchor during deletion: omit until next presence */ }
   });
 }
 a.cursorInterval=setInterval(render,500);
}
async function action(fn){if(busy)return;busy=true;$('#error').hidden=true;const controls=Array.from($('#open-form').querySelectorAll('button'));controls.forEach(b=>b.disabled=true);try{await fn();}catch(e){error(e);if(!active){$('#workspace').hidden=true;$('#welcome').hidden=false;}}finally{busy=false;controls.forEach(b=>b.disabled=false);}}
$('#open-form').onsubmit=e=>{e.preventDefault();void action(openFirestore);};
$('#create').onclick=()=>void action(createFirestore);$('#join-team').onclick=()=>void action(openFirestore);$('#demo').onclick=()=>void action(openDemo);
$('#download').onclick=()=>{try{active.binding.capture();download(active.studio.exportHwpx(),`${active.who.week}-활동일지.hwpx`);}catch(e){error(e);}};
$('#share').onclick=async()=>{try{const url=new URL(location.href);const invite=$('#invite-code').value.trim();if(invite)url.hash=new URLSearchParams({invite}).toString();url.searchParams.delete('name');await navigator.clipboard.writeText(url.href);$('#share').textContent='복사됨';setTimeout(()=>$('#share').textContent='링크 복사',2000);}catch(e){error(e);}};
$('#retry').onclick=()=>void active?.provider.flush();
$('#recovery').onclick=()=>{if(!active)return;download(Y.encodeStateAsUpdate(active.doc),`${active.who.id}-공동문서-복구.yjs`);try{download(active.studio.exportHwpx(),`${active.who.id}-화면복구.hwpx`);}catch{}};
document.addEventListener('visibilitychange',()=>{if(document.hidden){active?.binding?.capture();void active?.provider?.flush();}});
window.addEventListener('online',()=>void active?.provider.flush());
window.addEventListener('offline',()=>active?.provider.status('offline'));
window.addEventListener('beforeunload',e=>{active?.binding?.capture();if(active&&(active.binding?.stopped||active.provider.state!=='saved')){e.preventDefault();e.returnValue='';}});
if(params.get('demo')==='1')void action(openDemo);
