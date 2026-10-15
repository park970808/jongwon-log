import * as Y from 'yjs';
import {IndexeddbPersistence} from 'y-indexeddb';
import {initializeApp,getApps} from 'firebase/app';
import {getAuth,signInAnonymously,connectAuthEmulator} from 'firebase/auth';
import {getFirestore,initializeFirestore,persistentLocalCache,persistentMultipleTabManager,connectFirestoreEmulator,doc as firestoreDoc,getDoc,setDoc,serverTimestamp,collection,query,orderBy,limit,getDocs} from 'firebase/firestore';
import {FIREBASE_CONFIGS} from './firebase-config.js';
import {FirestoreBackend,CLIENT_FORMAT} from './firestore-backend.js';
import {DemoBackend} from './demo-backend.js';
import {SyncProvider,IndexedOutbox,encodeEnvelope,batchForPeers} from './sync-provider.js';
import {importParts,readHwpx} from './document-model.js';
import {EditorBinding} from './editor-binding.js';
import {PRESENCE,shouldSendPresence,anchorParagraph,heartbeatFor,presenceStaleMs} from './presence-policy.js';

// 다시 열 때 이미 이 기기에 있는 내용은 Firestore에서 다시 읽지 않도록, 문서별 동기화 위치를 같은 IndexedDB에 둡니다.
// (IndexedDB가 지워지면 이 값도 함께 사라지므로 전체를 다시 읽는 안전한 경로로 돌아갑니다.)
const CURSOR_KEY='syncCursor',CURSOR_SAVE_MS=30000;
async function readCursor(persistence,document){
 try{
   const c=await persistence.get(CURSOR_KEY);
   if(c?.v!==2||!Number.isFinite(c.since)||!(c.snapshot instanceof Uint8Array)||!document.getMap('parts').size)return null;
   return c;
 }catch{return null;}
}
function saveCursor(a){
 // Only once the document finished opening: a half-loaded session must never record a resume point.
 if(!a||a.demo||!a.persistence||!a.binding||a.binding.stopped)return;
 const c=a.provider.syncCursor();if(c)void a.persistence.set(CURSOR_KEY,c).catch(()=>{});
}

const $=s=>document.querySelector(s),params=new URLSearchParams(location.search);
const invitation=new URLSearchParams(location.hash.slice(1)).get('invite')||'';
if(invitation)$('#invite-code').value=invitation;
// ?fullload=1: 이 기기의 동기화 위치와 서버 압축본을 쓰지 않고 전체 기록을 읽은 뒤 압축본을 새로 만듭니다(복구용).
const fullLoad=params.get('fullload')==='1';
const session=crypto.randomUUID();let active=null,connection=null,busy=false;
const statusLabels={connecting:'Firestore 연결 중…',saving:'저장 중…',saved:'Firestore에 저장됨',offline:'연결 끊김 · 이 기기에 보관됨',error:'저장 상태를 확인해 주세요'};
function isoWeek(d){const x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));x.setUTCDate(x.getUTCDate()+4-(x.getUTCDay()||7));const n=Math.ceil((((x-new Date(Date.UTC(x.getUTCFullYear(),0,1)))/86400000)+1)/7);return `${x.getUTCFullYear()}-W${String(n).padStart(2,'0')}`;}
$('#week').value=params.get('week')||isoWeek(new Date());$('#doc-id').value=params.get('doc')||$('#week').value;
$('#team').value=FIREBASE_CONFIGS[params.get('team')]?params.get('team'):'team-3';
$('#name').value=params.get('name')||localStorage.getItem('jongwon-collab-name')||'';
// 문서 선택: 팀의 기존 문서를 목록에서 고르거나, "새 문서"로 활동 주차를 정해 만듭니다(문서 ID = 주차).
const NEW_DOC='__new';
function chooseDocument(){
 const sel=$('#doc-list'),opt=sel.selectedOptions[0];
 if(!opt||!opt.value)return;
 if(opt.value===NEW_DOC){$('#doc-id').value=$('#week').value;return;}
 $('#doc-id').value=opt.value;if(opt.dataset.week)$('#week').value=opt.dataset.week;
}
$('#doc-list').onchange=chooseDocument;
$('#week').onchange=()=>{
 // A week that already has a document opens it; another week starts a new one.
 const sel=$('#doc-list'),match=Array.from(sel.options).find(o=>o.dataset.week===$('#week').value&&o.value!==NEW_DOC);
 if(match)sel.value=match.value;else if(Array.from(sel.options).some(o=>o.value===NEW_DOC))sel.value=NEW_DOC;
 $('#doc-id').value=match?match.value:$('#week').value;
};
let listRequest=0;
async function refreshDocList(){
 const sel=$('#doc-list'),request=++listRequest,team=$('#team').value;
 const show=(options,selected)=>{if(request!==listRequest)return;sel.replaceChildren(...options);if(selected!==undefined)sel.value=selected;chooseDocument();};
 const option=(value,text,week)=>{const o=document.createElement('option');o.value=value;o.textContent=text;if(week)o.dataset.week=week;return o;};
 const fresh=()=>option(NEW_DOC,'+ 새 문서 (위 활동 주차로 만들기)');
 show([option('','팀 문서 목록을 불러오는 중…')]);
 try{
   const c=await connect();
   const member=await getDoc(firestoreDoc(c.db,'teams',team,'collaborationMembers',c.uid));
   if(member.data()?.role!=='editor'){show([option('','초대 코드로 팀에 참여하면 문서 목록이 보입니다'),fresh()],'');return;}
   const snap=await getDocs(query(collection(c.db,'teams',team,'documents'),orderBy('createdAt','desc'),limit(100)));
   const docs=snap.docs.map(d=>option(d.id,`${d.data().title||d.id}${d.data().week&&!String(d.data().title||'').includes(d.data().week)?` · ${d.data().week}`:''}`,d.data().week||''));
   const wanted=params.get('doc')||$('#doc-id').value,thisWeek=docs.find(o=>o.dataset.week===$('#week').value);
   const selected=docs.some(o=>o.value===wanted)?wanted:thisWeek?thisWeek.value:docs.length?docs[0].value:NEW_DOC;
   show([...docs,fresh()],selected);
 }catch(e){console.warn('문서 목록을 불러오지 못했습니다.',e);show([option('','문서 목록을 불러오지 못했습니다 · 새 문서로 만들 수 있습니다'),fresh()],NEW_DOC);}
}
$('#team').addEventListener('change',()=>void refreshDocList());
if(params.get('demo')!=='1')void refreshDocList();
function warn(e){
 $('#warning-text').textContent=e?.message||String(e);$('#warning').hidden=false;console.warn(e);
}
const isAccessError=e=>/permission-denied|unauthenticated/.test(e?.code||'');
function error(e){
 const message=e?.message||String(e);$('#error').hidden=false;
 $('#error-text').textContent=/permission-denied|Missing or insufficient permissions/i.test(`${e?.code} ${message}`)
 ? `공동 문서 접근 권한이 없습니다. 관리자에게 공동 편집 규칙과 팀 권한 설정을 요청하세요.${connection?.uid?` 사용자 UID: ${connection.uid}`:''}`
 : /resource-exhausted|quota/i.test(`${e?.code} ${message}`)
 ? '오늘 Firebase 무료 사용량을 모두 사용했습니다. 입력한 내용은 이 기기에 보관되어 있으며, 한도가 초기화되는 오후 4~5시(미국 태평양 자정) 이후 자동으로 저장됩니다. 창을 닫아도 이 기기에서 문서를 다시 열면 이어서 저장됩니다.'
 : message;
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
 // Without an offline cache, Firestore bills every reconnect (sleep, Wi-Fi change) as a brand-new query over all
 // results. The persistent cache lets a reconnect within 30 minutes pay only for changed documents.
 let db;
 try{db=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})});}
 catch{db=getFirestore(app);} // already initialized for this app, or IndexedDB unavailable
 const auth=getAuth(app);
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
 if(!$('#doc-list').value&&!params.get('doc'))$('#doc-list').value=NEW_DOC,chooseDocument();
 const c=await connect();const wasMember=(await getDoc(firestoreDoc(c.db,'teams',c.team,'collaborationMembers',c.uid))).data()?.role==='editor';if(!await ensureMembership(c))return;if(!wasMember)void refreshDocList();const meta=await c.backend.metadata();
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
 // 이 기기에 남아 있는 문서 + 동기화 위치가 있으면 그 이후의 서버 기록만 읽습니다.
 const cursor=demo||fullLoad?null:await readCursor(persistence,document);
 const studio=await getStudio();
 let resolveReady,rejectReady;const initial=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const provider=new SyncProvider({doc:document,backend,author,session,outbox:new IndexedOutbox(`${namespace}:outbox:${author}`),
   knownServerSnapshot:cursor?.snapshot??null,listenOptions:{since:cursor?.since??null,ignoreCheckpoint:fullLoad},onWarning:warn,
   onStatus:({state})=>{
   $('#save-status').textContent=demo?(state==='saved'?'이 기기에 저장됨 · 다른 탭과 연결':state==='connecting'?'기기 내 문서 불러오는 중…':statusLabels[state]):statusLabels[state];
   if(state==='saved'){resolveReady();if(active?.binding&&!active.binding.stopped)$('#error').hidden=true;} // recovered after an outage
 },onError:e=>{error(e);if(isAccessError(e))rejectReady(e);}}); // other errors are retried; the open timeout still applies
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
 if(!demo){startPresence(active);active.cursorSaveInterval=setInterval(()=>saveCursor(active),CURSOR_SAVE_MS);}
 if(import.meta.env.DEV)window.__collab={...active,Y};
}
function startPresence(a){
 let peers=[],last='',lastParagraph='',lastSent=0,lastHidden=false,lastIdle=false,inflight=false;
 let observed='',lastActivity=Date.now(),sentLocalAt=0,ownUpdatedAt=0,clockOffset=0;
 const parse=p=>{try{return JSON.parse(p.anchor||'null');}catch{return null;}};
 // Presence times are server timestamps; a shared PC's clock may be minutes off. Estimate the offset from our
 // own presence document (written moments ago) instead of trusting Date.now().
 const serverNow=()=>Date.now()+clockOffset;
 const send=async(force=false)=>{
   if(inflight||a.binding.applying||a.binding.stopped)return;
   const hidden=document.hidden,now=Date.now(),anchor=hidden?null:a.binding.anchor(),key=JSON.stringify(anchor);
   if(key!==observed){observed=key;lastActivity=now;}
   const idle=!hidden&&now-lastActivity>=PRESENCE.idleAfterMs,paragraph=anchorParagraph(anchor);
   if(!shouldSendPresence({now,lastSent,paragraphChanged:paragraph!==lastParagraph,offsetChanged:key!==last,hidden,lastHidden,idle,lastIdle,force}))return;
   // v: client format, so teammates know whether every open tab can read inline records (old tabs ignore it).
   // hb: when our next presence will come at the latest, so teammates know how long to keep showing us.
   const value=JSON.stringify({...anchor,v:CLIENT_FORMAT,hb:heartbeatFor(idle)});
   inflight=true;sentLocalAt=now;
   try{await a.backend.presence(session,{uid:a.author,name:a.who.name.slice(0,30),anchor:value,active:!hidden});last=key;lastParagraph=paragraph;lastSent=now;lastHidden=hidden;lastIdle=idle;}
   catch(e){error(e);}finally{inflight=false;}
 };
 a.presenceSend=send;
 a.presenceInterval=setInterval(send,PRESENCE.checkMs);void send(true);
 a.presenceOff=a.backend.watchPresence(list=>{peers=list;calibrate();adapt();render();},error);
 function calibrate(){
   const own=peers.find(p=>p.id===session)?.updatedAt?.toMillis();
   if(own&&own!==ownUpdatedAt){ownUpdatedAt=own;if(sentLocalAt)clockOffset=own-sentLocalAt;}
 }
 const visible=p=>p.updatedAt?.toMillis()>serverNow()-presenceStaleMs(parse(p)?.hb);
 function adapt(){
   const others=peers.filter(p=>p.id!==session);
   // Every open session reads every record, hidden tabs included (they stop sending presence but keep listening
   // until they close and delete their entry): batch harder when more of them are open.
   a.provider.setBatch(batchForPeers(others.filter(p=>!p.active||visible(p)).length));
   // Keep the chunked format while any recently seen tab still runs the previous version.
   a.backend.legacyPeers=others.some(p=>p.updatedAt?.toMillis()>serverNow()-30*60*1000&&!(parse(p)?.v>=CLIENT_FORMAT));
 }
 function render(){
   const current=peers.filter(p=>p.id!==session&&p.active&&visible(p));
   $('#peers').replaceChildren();$('#remote-cursors').replaceChildren();
   current.forEach((p,i)=>{
     const color=['#4274a5','#a45d40','#588667','#825e9d'][i%4];
     const badge=document.createElement('span');badge.className='peer';badge.textContent=p.name?.slice(0,2)||'팀원';badge.title=p.name;$('#peers').append(badge);
     try{const {v:_format,hb:_heartbeat,...anchor}=parse(p)||{};if(!anchor.key&&!anchor.fallback)return;
       const position=a.binding.resolveAnchor(anchor,a.binding.mirror),rect=a.studio.caretRect(position);if(!rect)return;
       const caret=document.createElement('div');caret.className='peer-caret';caret.style.cssText=`--peer:${color};left:${rect.x}px;top:${rect.y}px;height:${rect.height}px`;
       const label=document.createElement('span');label.textContent=p.name;caret.append(label);$('#remote-cursors').append(caret);
     }catch{ /* expired anchor during deletion: omit until next presence */ }
   });
 }
 a.renderInterval=setInterval(render,500);
}
async function action(fn){if(busy)return;busy=true;$('#error').hidden=true;const controls=Array.from($('#open-form').querySelectorAll('button'));controls.forEach(b=>b.disabled=true);try{await fn();}catch(e){error(e);if(!active){$('#workspace').hidden=true;$('#welcome').hidden=false;}}finally{busy=false;controls.forEach(b=>b.disabled=false);}}
$('#open-form').onsubmit=e=>{e.preventDefault();void action(openFirestore);};
$('#create').onclick=()=>void action(createFirestore);$('#join-team').onclick=()=>void action(openFirestore);$('#demo').onclick=()=>void action(openDemo);
$('#download').onclick=()=>{try{active.binding.capture();download(active.studio.exportHwpx(),`${active.who.week}-활동일지.hwpx`);}catch(e){error(e);}};
$('#share').onclick=async()=>{try{const url=new URL(location.href);const invite=$('#invite-code').value.trim();if(invite)url.hash=new URLSearchParams({invite}).toString();url.searchParams.delete('name');await navigator.clipboard.writeText(url.href);$('#share').textContent='복사됨';setTimeout(()=>$('#share').textContent='링크 복사',2000);}catch(e){error(e);}};
$('#retry').onclick=()=>void active?.provider.flush();
$('#recovery').onclick=()=>{if(!active)return;download(Y.encodeStateAsUpdate(active.doc),`${active.who.id}-공동문서-복구.yjs`);try{download(active.studio.exportHwpx(),`${active.who.id}-화면복구.hwpx`);}catch{}};
$('#warning-close').onclick=()=>$('#warning').hidden=true;
document.addEventListener('visibilitychange',()=>{
 if(document.hidden){active?.binding?.capture();void active?.provider?.flush();saveCursor(active);}
 void active?.presenceSend?.(); // policy sends "away" once when hidden and resumes immediately when visible
});
window.addEventListener('pageshow',e=>{ // restored from the back/forward cache after pagehide stopped presence
 if(e.persisted&&active?.presenceSend){clearInterval(active.presenceInterval);active.presenceInterval=setInterval(active.presenceSend,PRESENCE.checkMs);void active.presenceSend(true);}
});
window.addEventListener('pagehide',()=>{
 saveCursor(active);
 if(active&&!active.demo){clearInterval(active.presenceInterval);void active.backend.leave(session).catch(()=>{});}
});
window.addEventListener('online',()=>void active?.provider.flush());
window.addEventListener('offline',()=>active?.provider.status('offline'));
window.addEventListener('beforeunload',e=>{active?.binding?.capture();if(active&&(active.binding?.stopped||active.provider.state!=='saved')){e.preventDefault();e.returnValue='';}});
if(params.get('demo')==='1')void action(openDemo);
