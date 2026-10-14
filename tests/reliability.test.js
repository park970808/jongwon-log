// 장애·경합 상황 회귀 테스트: 오프라인 중 조각 읽기, 처리 도중 실패한 스냅샷, 손상된 압축본, 압축 실패 반복,
// 이전 버전 탭과의 호환, 오프라인 쓰기 대기, 삭제만 있는 문서의 재업로드.
import test from 'node:test';import assert from 'node:assert/strict';import * as Y from 'yjs';
import {SyncProvider,MemoryOutbox,CorruptRecordError,encodeEnvelope,CURSOR_MARGIN_MS,APPEND_WATCHDOG_MS,DEFAULT_BATCH} from '../src/sync-provider.js';
import {FirestoreBackend} from '../src/firestore-backend.js';
import {chooseCheckpointCutoff} from '../src/checkpoint-policy.js';
import {settle,fakeClock,fakeServer} from './fakes.js';

const typeInto=(doc,text)=>doc.getText('t').insert(doc.getText('t').length,text);
const offline=()=>Object.assign(new Error('Failed to get documents from server.'),{code:'unavailable'});
const ts=ms=>({toMillis:()=>ms});
const bytes=u=>({toUint8Array:()=>u});

/** FirestoreBackend with its Firestore calls replaced, so listen()'s own logic runs unchanged. */
function harness({meta={},payloads={}}={}){
  const b=Object.create(FirestoreBackend.prototype);const subs=[];
  b.metadata=async()=>meta;b.tailQuery=from=>({from});
  b.subscribe=(source,next,fail)=>{const s={source,next,fail,off:false};subs.push(s);return()=>{s.off=true;};};
  b.readPayload=async d=>{const p=payloads[d.id];if(p instanceof Error)throw p;return p??new Uint8Array([1]);};
  return {b,subs};
}
const record=(id,ms)=>({id,data:()=>({createdAt:ts(ms)}),metadata:{hasPendingWrites:false}});
const snapshot=(docs,fromCache=false)=>({docChanges:()=>docs.map(doc=>({type:'added',doc})),metadata:{fromCache}});
function listenWith(b,options={}){
  const seen={received:[],errors:[],synced:[],ready:0};
  const off=b.listen(async e=>{seen.received.push(e.id);return true;},()=>seen.ready++,e=>seen.errors.push(e),{...options,onSynced:(...a)=>seen.synced.push(a)});
  return {seen,off};
}

test('chunks unreachable while offline are an outage, not a corrupt record',async()=>{
  const b=Object.create(FirestoreBackend.prototype);
  const d={ref:{},data:()=>({chunks:2})};
  b.fetchChunks=async()=>{throw offline();};
  await assert.rejects(b.readPayload(d),e=>e.code==='unavailable'&&!(e instanceof CorruptRecordError));
  // Only a server answer that really lacks a chunk is corruption.
  b.fetchChunks=async()=>({docs:[{id:'0',data:()=>({data:bytes(new Uint8Array([1]))})}]});
  await assert.rejects(b.readPayload(d),CorruptRecordError);
});

test('a snapshot that fails half-way stops its listener before anything claims to be synced',async()=>{
  const {b,subs}=harness({payloads:{b:offline()}});
  const {seen}=listenWith(b);await settle();
  assert.equal(subs.length,1);assert.equal(subs[0].source.from,null,'no cursor → full log');
  subs[0].next(snapshot([record('a',1),record('b',2),record('c',3)]));await settle();
  assert.equal(seen.errors.length,1);assert.equal(subs[0].off,true,'listener detached immediately');
  assert.deepEqual(seen.synced,[],'no sync position reported for a partial snapshot');assert.equal(seen.ready,0);
  // Later snapshots on the dead listener are ignored instead of silently skipping a, b and c.
  subs[0].next(snapshot([record('d',4)]));await settle();
  assert.deepEqual(seen.received,[]);assert.equal(seen.errors.length,1);
});

test('the provider resumes from its original position until one complete load has finished',async()=>{
  const clock=fakeClock(),calls=[];let handlers;
  const backend={listen:(receive,ready,error,o)=>{calls.push(o.since);handlers={receive,ready,error,o};return()=>{};},append:async()=>{}};
  const src=new Y.Doc();typeInto(src,'x');const e=encodeEnvelope(Y.encodeStateAsUpdate(src),'x','s');
  const p=new SyncProvider({doc:new Y.Doc(),backend,outbox:new MemoryOutbox(),author:'b',session:'b',clock,onError:()=>{}});
  await p.start();
  // First attempt: one record applied and a cache snapshot reported, then the server snapshot fails.
  await handlers.receive(e);handlers.o.onSynced(9_000_000,1,true);handlers.error(offline());
  await clock.advance(5000);assert.deepEqual(calls,[null,null],'before a complete load, start over (not from a partial position)');
  handlers.o.onSynced(9_000_000,1,false);handlers.ready();await settle();
  handlers.error(offline());await clock.advance(5000);
  assert.equal(calls[2],9_000_000-CURSOR_MARGIN_MS,'after a complete load, resume from it');
  assert.equal(p.online,false,'a failed listener is not online');
  await p.dispose();
});

test('checkpoint: missing, mismatched or damaged copies fall back to the full log',async()=>{
  const src=new Y.Doc();typeInto(src,'압축본');const good=encodeEnvelope(Y.encodeStateAsUpdate(src),'a','checkpoint');
  const meta={checkpointId:good.id,checkpointCutoff:ts(1000)};
  const asSnapshot=(e,covered=1000)=>({id:e.id,exists:()=>true,ref:{},data:()=>({schema:1,hash:e.hash,codec:e.codec,rawSize:e.rawSize,chunks:1,coveredUntil:ts(covered)})});
  const chunkOf=p=>async()=>({docs:[{id:'0',data:()=>({data:bytes(p)})}]});
  const run=async(setup,options={})=>{
    const {b,subs}=harness({meta});setup(b);delete b.readPayload; // real readPayload for the checkpoint
    const {seen}=listenWith(b,options);await settle();return {from:subs[0]?.source.from,seen};
  };
  let r=await run(b=>{b.checkpointSnapshot=async()=>asSnapshot(good);b.fetchChunks=chunkOf(good.payload);});
  assert.equal(r.from,1000,'valid checkpoint → only the tail is queried');assert.deepEqual(r.seen.received,[good.id]);
  r=await run(b=>{b.checkpointSnapshot=async()=>({exists:()=>false});});
  assert.equal(r.from,null,'missing checkpoint → full log');
  r=await run(b=>{b.checkpointSnapshot=async()=>asSnapshot(good,999);b.fetchChunks=chunkOf(good.payload);});
  assert.equal(r.from,null,'coverage differs from the pointer → full log');
  const damaged=good.payload.slice();damaged[damaged.length-1]^=0xff;
  r=await run(b=>{b.checkpointSnapshot=async()=>asSnapshot(good);b.fetchChunks=chunkOf(damaged);});
  assert.equal(r.from,null,'hash mismatch → full log');assert.deepEqual(r.seen.received,[]);
  r=await run(b=>{b.checkpointSnapshot=async()=>{throw offline();};});
  assert.equal(r.from,undefined,'an outage is an error (retried), never a reason to skip history');assert.equal(r.seen.errors.length,1);
  r=await run(()=>{},{ignoreCheckpoint:true});assert.equal(r.from,null,'?fullload=1 ignores the checkpoint');
  // A checkpoint the provider could not apply also falls back.
  const {b,subs}=harness({meta});b.checkpointSnapshot=async()=>asSnapshot(good);b.fetchChunks=chunkOf(good.payload);delete b.readPayload;
  b.listen(async()=>false,()=>{},()=>{},{});await settle();assert.equal(subs[0].source.from,null);
});

test('a local cache missing deletions that the stored snapshot records is not used incrementally',()=>{
  const server=new Y.Doc({gc:false});typeInto(server,'abc');
  const cache=new Y.Doc({gc:false});Y.applyUpdate(cache,Y.encodeStateAsUpdate(server));
  server.getText('t').delete(1,1); // deletions do not change the state vector
  const snapshot=Y.encodeSnapshot(Y.snapshot(server));
  const p=new SyncProvider({doc:cache,backend:fakeServer(),outbox:new MemoryOutbox(),author:'b',session:'b',knownServerSnapshot:snapshot,listenOptions:{since:123}});
  assert.equal(p.since,null,'falls back to the full download');
  const ok=new SyncProvider({doc:server,backend:fakeServer(),outbox:new MemoryOutbox(),author:'b',session:'b2',knownServerSnapshot:snapshot,listenOptions:{since:123}});
  assert.equal(ok.since,123,'a matching cache still opens incrementally');
});

test('deletions already on the server are not uploaded again by crash recovery',async()=>{
  const server=fakeServer(),src=new Y.Doc({gc:false});typeInto(src,'지울 글자 포함');
  server.record(encodeEnvelope(Y.encodeStateAsUpdate(src),'x','s'));
  const before=Y.encodeStateVector(src);src.getText('t').delete(0,3);
  server.record(encodeEnvelope(Y.encodeStateAsUpdate(src,before),'x','s'));
  const doc=new Y.Doc({gc:false}),p=new SyncProvider({doc,backend:server,outbox:new MemoryOutbox(),author:'b',session:'b'});
  await p.start();await settle();assert.equal(doc.getText('t').toString(),src.getText('t').toString());
  const n=server.log.length;await p.recoverLocalState();await settle();
  assert.equal(server.log.length,n,'no duplicate delete-set record on every open');
  doc.getText('t').delete(0,1);p.buffer.length=0;p.scheduler.cancel(); // a deletion lost before reaching the outbox
  await p.recoverLocalState();await settle();assert.equal(server.log.length,n+1,'a genuinely missing deletion is still recovered');
  await p.dispose();
});

const fastCheckpoint={everyRecords:5,lagMs:1000,jitterMs:[0,0],minAdvanceMs:0};
async function busySession(server,options={}){
  const clock=fakeClock(),doc=new Y.Doc({gc:false});
  const p=new SyncProvider({doc,backend:server,outbox:new MemoryOutbox(),author:'a',session:'a',clock,checkpoint:fastCheckpoint,random:()=>0,onError:()=>{},...options});
  await p.start();await settle();
  const write=async n=>{for(let i=0;i<n;i++){typeInto(doc,`${i},`);await p.flush();server.advance(5000);await clock.advance(1);}};
  return {p,clock,write};
}

test('a record that is corrupt on the server does not block compaction, and checkpoint readers see what log readers see',async()=>{
  const server=fakeServer();server.log.push({id:'f'.repeat(64),corrupt:true,createdAt:4_000_000});
  const {p,write}=await busySession(server,{onWarning:()=>{}});
  await write(12);assert.equal(p.rejected.length,1);assert.ok(server.meta.checkpointId,'compacted despite the skipped record');
  const viaCheckpoint=new Y.Doc({gc:false}),pc=new SyncProvider({doc:viaCheckpoint,backend:server,outbox:new MemoryOutbox(),author:'c',session:'c',checkpoint:null,onWarning:()=>{}});
  await pc.start();await settle();
  assert.equal(viaCheckpoint.getText('t').toString(),p.doc.getText('t').toString());
  await p.dispose();await pc.dispose();
});

test('repair (?fullload=1) replaces even a recent checkpoint, keeps trying until it can, and says when it is done',async()=>{
  assert.equal(chooseCheckpointCutoff({current:5000,cutoff:4000,repair:true,maxCutoff:9000}),5001,'moves just past the distrusted one');
  assert.equal(chooseCheckpointCutoff({current:9000,cutoff:4000,repair:true,maxCutoff:9000}),null,'nothing newer applied yet');
  assert.equal(chooseCheckpointCutoff({current:5000,cutoff:4000}),null,'normal sessions never move backwards or sideways');
  assert.equal(chooseCheckpointCutoff({current:null,cutoff:4000,minAdvanceMs:999}),4000);
  const server=fakeServer();const clock=fakeClock(),a=new Y.Doc({gc:false});
  const pa=new SyncProvider({doc:a,backend:server,outbox:new MemoryOutbox(),author:'a',session:'a',clock,checkpoint:null});
  await pa.start();await settle();
  for(let i=0;i<5;i++){typeInto(a,`${i},`);await pa.flush();server.advance(5000);}
  // A distrusted checkpoint that covers everything written so far.
  const bad=new Y.Doc();typeInto(bad,'잘못된 압축본');server.meta={};
  assert.equal(await server.createCheckpoint({state:Y.encodeStateAsUpdate(bad),cutoff:server.log.at(-1).createdAt,author:'x'}),'created');
  const warnings=[],r=new Y.Doc({gc:false});
  const pr=new SyncProvider({doc:r,backend:server,outbox:new MemoryOutbox(),author:'r',session:'r',clock,random:()=>0,
    checkpoint:{everyRecords:300,lagMs:1000,jitterMs:[0,0],minAdvanceMs:60_000},listenOptions:{ignoreCheckpoint:true},onWarning:w=>warnings.push(w.message)});
  await pr.start();await settle();await clock.advance(1);
  assert.equal(warnings.length,0,'cannot replace yet: nothing newer than the stored coverage');assert.equal(pr.checkpointDisabled,false,'not given up');
  typeInto(a,'더 씀,');await pa.flush();await settle();await clock.advance(61_000);
  assert.equal(warnings.length,1,'repair reported');assert.ok(/압축본을 새로 만들었습니다/.test(warnings[0]));
  const fresh=new Y.Doc({gc:false}),pf=new SyncProvider({doc:fresh,backend:server,outbox:new MemoryOutbox(),author:'f',session:'f',clock,checkpoint:null});
  await pf.start();await settle();
  assert.equal(fresh.getText('t').toString(),a.getText('t').toString(),'fresh devices now get the repaired copy');
  await pa.dispose();await pr.dispose();await pf.dispose();
});

test('checkpoint failures: rules not deployed → stop trying; outages → back off instead of retrying every snapshot',async()=>{
  let server=fakeServer(),attempts=0;
  server.createCheckpoint=async()=>{attempts++;throw Object.assign(new Error('denied'),{code:'permission-denied'});};
  let s=await busySession(server);await s.write(20);
  assert.equal(attempts,1,'permission denied once → disabled for the session');await s.p.dispose();
  server=fakeServer();attempts=0;
  server.createCheckpoint=async()=>{attempts++;throw offline();};
  s=await busySession(server);await s.write(20);
  assert.equal(attempts,1,'no retry storm while the backoff runs');
  await s.clock.advance(61_000);await s.write(1);assert.equal(attempts,2,'retried after the backoff');
  await s.p.dispose();
});

test('inline records only when every open tab can read them; fallback keeps inline until chunks succeed',async()=>{
  const small=encodeEnvelope(new TextEncoder().encode('작은 변경'),'a','s');
  const b=Object.create(FirestoreBackend.prototype);b.inline=true;b.legacyPeers=true;const writes=[];
  b.writeRecord=async(e,inline)=>{writes.push(inline);};b.exists=async()=>false;
  await b.append(small);b.legacyPeers=false;await b.append(small);
  assert.deepEqual(writes,[false,true],'chunked while a previous-version tab is open, inline afterwards');
  const c=Object.create(FirestoreBackend.prototype);c.inline=true;c.legacyPeers=false;
  c.writeRecord=async(e,inline)=>{throw inline?Object.assign(new Error('denied'),{code:'permission-denied'}):offline();};c.exists=async()=>false;
  await assert.rejects(c.append(small),e=>e.code==='unavailable');
  assert.equal(c.inline,true,'a failed fallback does not prove the rules lack inline support');
});

test('a write the SDK keeps queued (offline) shows "offline" instead of "saving" forever, without a duplicate send',async()=>{
  const clock=fakeClock(),server=fakeServer();let release,sends=0;
  const append=server.append;
  const p=new SyncProvider({doc:new Y.Doc(),backend:server,outbox:new MemoryOutbox(),author:'a',session:'s',clock});
  await p.start();await settle();
  server.append=e=>{sends++;return new Promise(r=>{release=()=>r(append(e));});};
  typeInto(p.doc,'대기 중');await clock.advance(DEFAULT_BATCH.maxWaitMs);
  assert.equal(p.state,'saving');await clock.advance(APPEND_WATCHDOG_MS);assert.equal(p.state,'offline');
  release();await settle();assert.equal(p.state,'saved');assert.equal(sends,1);assert.equal(server.log.length,1);
  await p.dispose();
});

test('edits made while a slow send is in flight are sent without waiting for another keystroke',async()=>{
  const clock=fakeClock(),server=fakeServer();const append=server.append;let release=null;
  const p=new SyncProvider({doc:new Y.Doc(),backend:server,outbox:new MemoryOutbox(),author:'a',session:'s',clock});
  await p.start();await settle();
  server.append=e=>new Promise(r=>{release=()=>{release=null;r(append(e));};});
  typeInto(p.doc,'첫 묶음');await clock.advance(DEFAULT_BATCH.maxWaitMs);assert.ok(release,'first send in flight');
  typeInto(p.doc,' 두 번째');await clock.advance(DEFAULT_BATCH.maxWaitMs); // the timer fires while the first send waits
  server.append=append;release();await settle();
  await clock.advance(DEFAULT_BATCH.maxWaitMs);
  assert.equal(p.state,'saved');assert.equal(p.buffer.length,0);assert.equal(server.log.length,2);
  await p.dispose();
});

test('delete-set checks do not mutate their inputs and see adjacent deletions (yjs snapshotContainsUpdate pitfall)',async()=>{
  const {snapshotHoldsUpdate,deleteSetCovers}=await import('../src/sync-provider.js');
  const server=new Y.Doc({gc:false});typeInto(server,'abcdef');server.getText('t').delete(0,3);
  const local=new Y.Doc({gc:false});Y.applyUpdate(local,Y.encodeStateAsUpdate(server));local.getText('t').delete(0,1); // adjacent to the server's range
  const snap=Y.snapshot(server),before=JSON.stringify([...snap.ds.clients.values()]);
  const delta=Y.encodeStateAsUpdate(local,Y.encodeStateVector(server));
  assert.equal(snapshotHoldsUpdate(snap,delta),false,'the new adjacent deletion is not on the server');
  assert.equal(JSON.stringify([...snap.ds.clients.values()]),before,'snapshot untouched');
  assert.equal(snapshotHoldsUpdate(snap,Y.encodeStateAsUpdate(server,Y.encodeStateVector(server))),true);
  assert.equal(deleteSetCovers(Y.snapshot(local).ds,snap.ds),true);assert.equal(deleteSetCovers(snap.ds,Y.snapshot(local).ds),false);
});
