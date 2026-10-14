// Spark(무료) 한도 대응 변경의 회귀 테스트: 묶음 전송, 증분 재열기, 손상 기록 격리, 리스너 재연결, 인라인 기록.
import test from 'node:test';import assert from 'node:assert/strict';import * as Y from 'yjs';
import {SyncProvider,MemoryOutbox,FlushScheduler,CorruptRecordError,encodeEnvelope,decodeEnvelope,CURSOR_MARGIN_MS,DEFAULT_BATCH} from '../src/sync-provider.js';
import {FirestoreBackend,INLINE_MAX} from '../src/firestore-backend.js';
import {shouldSendPresence,PRESENCE,anchorParagraph,presenceStaleMs,heartbeatFor} from '../src/presence-policy.js';

import {settle,fakeClock,fakeServer} from './fakes.js';

const typeInto=(doc,text)=>doc.getText('t').insert(doc.getText('t').length,text);

test('scheduler waits for a pause, but never longer than maxWait during continuous input',async()=>{
  const clock=fakeClock();let fired=0;const s=new FlushScheduler({debounceMs:800,maxWaitMs:2500,clock,onFire:()=>fired++});
  s.touch();await clock.advance(799);assert.equal(fired,0);await clock.advance(1);assert.equal(fired,1,'fires 800ms after the last change');
  const times=[];const s2=new FlushScheduler({debounceMs:800,maxWaitMs:2500,clock,onFire:()=>times.push(clock.now())});
  const start=clock.now();
  for(let t=0;t<10_000;t+=200){s2.touch();await clock.advance(200);} // typing without any pause for 10 s
  const gaps=[times[0]-start,...times.slice(1).map((t,i)=>t-times[i])];
  assert.ok(times.length>=3,`sends during continuous typing (${times.length} sends in 10 s)`);
  assert.ok(Math.max(...gaps)<=2500+200,`no change waits longer than maxWait (max gap ${Math.max(...gaps)} ms)`);
  assert.equal(fired,1,'the first scheduler was untouched');
});

test('a burst of edits becomes one Firestore record instead of one every 300 ms',async()=>{
  const clock=fakeClock(),server=fakeServer(),doc=new Y.Doc();
  const p=new SyncProvider({doc,backend:server,outbox:new MemoryOutbox(),author:'a',session:'s',clock});
  await p.start();await settle();
  for(let i=0;i<20;i++){typeInto(doc,'가');await clock.advance(150);} // 3 s of fast typing
  await clock.advance(DEFAULT_BATCH.debounceMs);
  assert.ok(server.log.length<=2,`20 keystrokes over 3 s → ${server.log.length} records (old policy: ~10)`);
  const replica=new Y.Doc();for(const r of server.log)Y.applyUpdate(replica,decodeEnvelope(r));
  assert.equal(replica.getText('t').toString(),'가'.repeat(20));
  assert.equal(p.state,'saved');await p.dispose();
});

test('incremental reopen reads only recent records, converges, and never re-uploads the cache',async()=>{
  const clock=fakeClock(),server=fakeServer();
  const H=()=>new Y.Doc({gc:false}); // the app keeps history (gc:false); required to rebuild the server snapshot
  const a=H(),pa=new SyncProvider({doc:a,backend:server,outbox:new MemoryOutbox(),author:'a',session:'a1',clock});
  await pa.start();await settle();
  for(let i=0;i<30;i++){typeInto(a,`${i},`);await pa.flush();}          // older history
  server.advance(2*CURSOR_MARGIN_MS);typeInto(a,'x,');await pa.flush();   // latest record before B leaves
  // Device B opens fully once; the app then stores B's cursor next to its IndexedDB copy.
  const b=H(),pb=new SyncProvider({doc:b,backend:server,outbox:new MemoryOutbox(),author:'b',session:'b1',clock});
  await pb.start();await settle();assert.equal(b.getText('t').toString(),a.getText('t').toString());
  const cursor=pb.syncCursor();assert.ok(cursor,'cursor available after the full load');
  const cache=Y.encodeStateAsUpdate(b);await pb.dispose();
  server.advance(2*CURSOR_MARGIN_MS);
  for(let i=0;i<5;i++){typeInto(a,`new${i},`);await pa.flush();}         // written while B was away
  // B reopens from its local cache.
  const b2=H();Y.applyUpdate(b2,cache);let downloaded=0;
  const viaCount={...server,listen:(r,ready,err,o)=>server.listen(e=>{downloaded++;return r(e);},ready,err,o)};
  const pb2=new SyncProvider({doc:b2,backend:viaCount,outbox:new MemoryOutbox(),author:'b',session:'b2',clock,knownServerSnapshot:cursor.snapshot,listenOptions:{since:cursor.since}});
  await pb2.start();await settle();
  assert.equal(b2.getText('t').toString(),a.getText('t').toString(),'converged');
  assert.equal(downloaded,6,`downloaded ${downloaded} of ${server.log.length} records (x + 5 new)`);
  // Recovery must not re-upload the cached document: serverDoc only holds the tail, the stored vector covers the rest.
  const before=server.log.length;await pb2.recoverLocalState();await settle();
  assert.equal(server.log.length,before,'nothing re-sent when the cache holds no unsent edits');
  const saved=pb2.syncCursor();await pb2.dispose();
  // A genuinely unsent edit (browser crashed before the outbox) is still recovered on the next open, and only that edit.
  const b3=H();Y.applyUpdate(b3,Y.encodeStateAsUpdate(b2));typeInto(b3,'오프라인');
  const pb3=new SyncProvider({doc:b3,backend:server,outbox:new MemoryOutbox(),author:'b',session:'b3',clock,knownServerSnapshot:saved.snapshot,listenOptions:{since:saved.since}});
  await pb3.start();await settle();await pb3.recoverLocalState();await settle();
  assert.equal(server.log.length,before+1);assert.ok(decodeEnvelope(server.log.at(-1)).length<300,'only the missing edit is uploaded');
  const fresh=new Y.Doc();for(const r of server.log)Y.applyUpdate(fresh,decodeEnvelope(r));
  assert.equal(fresh.getText('t').toString(),b3.getText('t').toString(),'a brand-new device sees everything');
  await pa.dispose();await pb3.dispose();
});

test('one corrupt record is skipped with a warning instead of stopping every editor',async()=>{
  const server=fakeServer(),src=new Y.Doc();typeInto(src,'정상 기록');
  server.record(encodeEnvelope(Y.encodeStateAsUpdate(src),'x','s'));
  server.log.push({id:'f'.repeat(64),corrupt:true,createdAt:9_999_999_999});
  const bad=encodeEnvelope(Y.encodeStateAsUpdate(src),'x','s');server.log.push({...bad,id:'e'.repeat(64),hash:'e'.repeat(64),createdAt:9_999_999_999});
  const doc=new Y.Doc(),warnings=[],errors=[];
  const p=new SyncProvider({doc,backend:server,outbox:new MemoryOutbox(),author:'b',session:'b',onWarning:w=>warnings.push(w),onError:e=>errors.push(e)});
  await p.start();await settle();
  assert.equal(doc.getText('t').toString(),'정상 기록');assert.equal(warnings.length,2);assert.equal(errors.length,0);
  typeInto(doc,' + 계속 편집');await p.flush();assert.equal(p.state,'saved','editing continues normally');
  await p.dispose();
});

test('a failed listener (e.g. read quota exhausted) re-subscribes from its sync position',async()=>{
  const clock=fakeClock(),server=fakeServer(),src=new Y.Doc();typeInto(src,'처음');server.record(encodeEnvelope(Y.encodeStateAsUpdate(src),'x','s'));
  const doc=new Y.Doc(),errors=[];
  const p=new SyncProvider({doc,backend:server,outbox:new MemoryOutbox(),author:'b',session:'b',clock,onError:e=>errors.push(e)});
  await p.start();await settle();assert.equal(server.listens,1);
  server.failListen=Object.assign(new Error('quota'),{code:'resource-exhausted'});
  // Simulate the SDK terminating the live listener.
  p.listenFailed(Object.assign(new Error('Quota exceeded.'),{code:'resource-exhausted'}));
  assert.equal(p.state,'error');assert.equal(errors.length,1);
  await clock.advance(5000);assert.equal(server.listens,2,'retried after backoff');
  await clock.advance(60_000);assert.ok(server.listens>=3,'keeps retrying');
  const before=Y.encodeStateVector(src);typeInto(src,' 이후');await server.append(encodeEnvelope(Y.encodeStateAsUpdate(src,before),'x','s'));
  await clock.advance(60_000);await settle();
  assert.equal(doc.getText('t').toString(),'처음 이후','receives edits after the outage');
  await p.dispose();
});

test('permission errors on the listener are not retried in a loop',async()=>{
  const clock=fakeClock(),server=fakeServer(),p=new SyncProvider({doc:new Y.Doc(),backend:server,outbox:new MemoryOutbox(),author:'b',session:'b',clock,onError:()=>{}});
  await p.start();await settle();p.listenFailed(Object.assign(new Error('denied'),{code:'permission-denied'}));
  await clock.advance(120_000);assert.equal(server.listens,1);await p.dispose();
});

test('an outbox entry the server already holds is cleared without sending it again',async()=>{
  const server=fakeServer(),src=new Y.Doc();typeInto(src,'애매한 전송');
  const e=encodeEnvelope(Y.encodeStateAsUpdate(src),'b','old');server.record(e); // committed, but the ack was lost
  const outbox=new MemoryOutbox();await outbox.put(e);
  let appends=0;const append=server.append;server.append=async x=>{appends++;return append(x);};
  const p=new SyncProvider({doc:new Y.Doc(),backend:server,outbox,author:'b',session:'new'});
  await p.start();await settle();await p.flush();
  assert.equal(appends,0);assert.equal((await outbox.list()).length,0);await p.dispose();
});

test('quota exhaustion on write keeps edits in the outbox and retries until saved',async()=>{
  const clock=fakeClock(),server=fakeServer(),doc=new Y.Doc(),outbox=new MemoryOutbox();
  const p=new SyncProvider({doc,backend:server,outbox,author:'a',session:'s',clock,onError:()=>{}});
  await p.start();await settle();
  const append=server.append;server.append=async()=>{throw Object.assign(new Error('Quota exceeded.'),{code:'resource-exhausted'});};
  typeInto(doc,'한도 초과 중');await clock.advance(DEFAULT_BATCH.maxWaitMs);
  assert.equal(p.state,'offline');assert.equal((await outbox.list()).length,1);
  server.append=append;await clock.advance(30_000);
  assert.equal(p.state,'saved');assert.equal(server.log.length,1);assert.equal((await outbox.list()).length,0);
  await p.dispose();
});

test('Firestore backend writes small updates inline and falls back to chunks under old rules',async()=>{
  const backend=Object.create(FirestoreBackend.prototype);backend.inline=true;
  const writes=[];let rulesAllowInline=false;const stored=new Set();
  backend.writeRecord=async(e,inline)=>{writes.push(inline);if(inline&&!rulesAllowInline)throw Object.assign(new Error('denied'),{code:'permission-denied'});stored.add(e.id);};
  backend.exists=async id=>stored.has(id);
  const small=encodeEnvelope(new TextEncoder().encode('작은 변경'),'a','s');
  await backend.append(small);
  assert.deepEqual(writes,[true,false],'inline denied by old rules → chunked retry');assert.equal(backend.inline,false,'no further inline attempts');
  const backend2=Object.create(FirestoreBackend.prototype);backend2.inline=true;const w2=[];
  backend2.writeRecord=async(e,inline)=>{w2.push(inline);};backend2.exists=async()=>false;
  await backend2.append(small);
  const big={...small,payload:new Uint8Array(INLINE_MAX+1)};await backend2.append(big);
  assert.deepEqual(w2,[true,false],'small → inline (1 write); large → chunks');
  // Retry of an id that already committed resolves without error (rules reject the duplicate as an update).
  const backend3=Object.create(FirestoreBackend.prototype);backend3.inline=true;
  backend3.writeRecord=async()=>{throw Object.assign(new Error('denied'),{code:'permission-denied'});};backend3.exists=async()=>true;
  await backend3.append(small);
});

test('Firestore backend reads inline records and reports damaged ones as corrupt, not as outages',async()=>{
  const backend=Object.create(FirestoreBackend.prototype);
  const bytes=new Uint8Array([1,2,3]);
  assert.deepEqual(await backend.readPayload({data:()=>({chunks:0,data:{toUint8Array:()=>bytes}})}),bytes);
  await assert.rejects(backend.readPayload({data:()=>({chunks:0})}),CorruptRecordError);
  await assert.rejects(backend.readPayload({data:()=>({chunks:99})}),CorruptRecordError);
});

test('presence: another paragraph within moveMs, in-place typing and heartbeat sparsely, silent while hidden',()=>{
  const at=(o)=>shouldSendPresence({lastSent:1,hidden:false,lastHidden:false,...o});
  assert.equal(at({now:2_000,paragraphChanged:true}),false);
  assert.equal(at({now:PRESENCE.moveMs+1,paragraphChanged:true}),true,'moved to another cell');
  assert.equal(at({now:10_000,offsetChanged:true}),false,'typing within one paragraph is not re-sent every second');
  assert.equal(at({now:PRESENCE.refineMs+1,offsetChanged:true}),true);
  assert.equal(at({now:PRESENCE.heartbeatMs-1}),false);assert.equal(at({now:PRESENCE.heartbeatMs+1}),true,'heartbeat');
  assert.equal(at({now:2,offsetChanged:true,hidden:true}),true,'announce away once');
  assert.equal(at({now:999_999,hidden:true,lastHidden:true}),false,'then silent');
  assert.equal(at({now:2,lastHidden:true}),true,'back immediately');
  assert.ok(presenceStaleMs(PRESENCE.heartbeatMs)>PRESENCE.heartbeatMs*2,'peers are not dropped between heartbeats');
  assert.ok(presenceStaleMs(PRESENCE.idleHeartbeatMs)>PRESENCE.idleHeartbeatMs*2,'nor between idle heartbeats');
  assert.equal(presenceStaleMs(undefined),presenceStaleMs(PRESENCE.heartbeatMs),'previous-version peers use the normal interval');
  assert.equal(presenceStaleMs(1e12),presenceStaleMs(PRESENCE.idleHeartbeatMs),'an absurd announced interval is capped');
  // Idle: one announcement when going idle, then sparse heartbeats until activity resumes.
  assert.equal(at({now:2,idle:true,lastIdle:false}),true,'announce the longer interval once');
  assert.equal(at({now:PRESENCE.heartbeatMs+1,idle:true,lastIdle:true}),false);
  assert.equal(at({now:heartbeatFor(true)+1,idle:true,lastIdle:true}),true,'idle heartbeat');
  assert.ok(PRESENCE.moveMs<=5000,'switching cells is shown within seconds');
  assert.equal(anchorParagraph({key:'p1',relative:[1,2]}),anchorParagraph({key:'p1',relative:[3]}),'offset changes keep the paragraph');
});

test('a stored snapshot that does not match the local cache falls back to a full, correct download',async()=>{
  const server=fakeServer(),src=new Y.Doc({gc:false});typeInto(src,'서버 내용');server.record(encodeEnvelope(Y.encodeStateAsUpdate(src),'x','s'));
  const ahead=new Y.Doc({gc:false});Y.applyUpdate(ahead,Y.encodeStateAsUpdate(src));typeInto(ahead,' 더');
  const snapshot=Y.encodeSnapshot(Y.snapshot(ahead)); // claims more than the (e.g. evicted) local cache holds
  const doc=new Y.Doc({gc:false});
  const p=new SyncProvider({doc,backend:server,outbox:new MemoryOutbox(),author:'b',session:'b',knownServerSnapshot:snapshot,listenOptions:{since:Number.MAX_SAFE_INTEGER}});
  assert.equal(p.since,null,'incremental mode refused');
  await p.start();await settle();assert.equal(doc.getText('t').toString(),'서버 내용');
  const n=server.log.length;await p.recoverLocalState();await settle();assert.equal(server.log.length,n,'nothing re-uploaded');
  await p.dispose();
});

const fastCheckpoint={everyRecords:40,lagMs:60_000,jitterMs:[0,0],minAdvanceMs:0};
async function writeMany(provider,doc,server,n,label){for(let i=0;i<n;i++){typeInto(doc,`${label}${i},`);await provider.flush();server.advance(5000);}}

test('compaction: a fresh device reads one checkpoint plus a short tail and sees everything',async()=>{
  const clock=fakeClock(),server=fakeServer(),a=new Y.Doc({gc:false});
  const pa=new SyncProvider({doc:a,backend:server,outbox:new MemoryOutbox(),author:'a',session:'a',clock,checkpoint:fastCheckpoint,random:()=>0});
  await pa.start();await settle();
  await writeMany(pa,a,server,60,'w');await clock.advance(10);
  assert.ok(server.meta.checkpointId,'checkpoint created after enough records');
  await writeMany(pa,a,server,5,'after');
  const fresh=new Y.Doc({gc:false}),pf=new SyncProvider({doc:fresh,backend:server,outbox:new MemoryOutbox(),author:'f',session:'f',clock,checkpoint:null});
  await pf.start();await settle();
  assert.equal(fresh.getText('t').toString(),a.getText('t').toString(),'fresh device converges');
  const read=server.lastSub.delivered;
  assert.ok(read<30,`fresh open read ${read} documents instead of ${server.log.length}`);
  // Nothing is lost if the newest records sit exactly at the boundary: the tail query is inclusive.
  const cut=server.meta.checkpointCutoff;assert.ok(server.log.some(r=>r.createdAt>=cut),'tail exists after the cutoff');
  await pa.dispose();await pf.dispose();
});

test('compaction is never done by a session that was rebuilt from its local cache, and never includes unsent edits',async()=>{
  const clock=fakeClock(),server=fakeServer(),a=new Y.Doc({gc:false});
  const pa=new SyncProvider({doc:a,backend:server,outbox:new MemoryOutbox(),author:'a',session:'a',clock,checkpoint:null});
  await pa.start();await settle();await writeMany(pa,a,server,10,'w');
  const cursor=pa.syncCursor(),cache=Y.encodeStateAsUpdate(a);
  await writeMany(pa,a,server,60,'x');
  const b=new Y.Doc({gc:false});Y.applyUpdate(b,cache);
  const pb=new SyncProvider({doc:b,backend:server,outbox:new MemoryOutbox(),author:'b',session:'b',clock,knownServerSnapshot:cursor.snapshot,listenOptions:{since:cursor.since},checkpoint:fastCheckpoint,random:()=>0});
  await pb.start();await settle();await clock.advance(10);
  assert.equal(pb.since!==null,true);assert.equal(server.meta.checkpointId,undefined,'incremental session does not compact');
  await pb.dispose();
  // A full-history session compacts, but its unsent edit (server offline for writes) stays out of the checkpoint.
  const c=new Y.Doc({gc:false});
  const pc=new SyncProvider({doc:c,backend:server,outbox:new MemoryOutbox(),author:'c',session:'c',clock,checkpoint:fastCheckpoint,random:()=>0,onError:()=>{}});
  server.fail=true;await pc.start();await settle();typeInto(c,'아직 안 보낸 글');await pc.flush();await clock.advance(10);
  assert.ok(server.meta.checkpointId,'full session compacts');
  const cp=new Y.Doc();Y.applyUpdate(cp,decodeEnvelope(server.checkpoints.get(server.meta.checkpointId)));
  assert.ok(!cp.getText('t').toString().includes('아직 안 보낸 글'),'checkpoint holds only server-confirmed content');
  server.fail=false;await clock.advance(40_000);
  const fresh=new Y.Doc({gc:false}),pf=new SyncProvider({doc:fresh,backend:server,outbox:new MemoryOutbox(),author:'f',session:'f',clock,checkpoint:null});
  await pf.start();await settle();
  assert.ok(fresh.getText('t').toString().includes('아직 안 보낸 글'),'the edit arrives through the tail once sent');
  await pa.dispose();await pc.dispose();await pf.dispose();
});

test('checkpoint pointer only moves forward',async()=>{
  const server=fakeServer(),d=new Y.Doc();typeInto(d,'a');
  assert.equal(await server.createCheckpoint({state:Y.encodeStateAsUpdate(d),cutoff:2_000,author:'a'}),'created');
  typeInto(d,'b');
  assert.equal(await server.createCheckpoint({state:Y.encodeStateAsUpdate(d),cutoff:1_000,author:'b'}),'exists');
  assert.equal(server.meta.checkpointCutoff,2_000);
});
