// 사진 여러 장을 연달아 넣어도 기록 한 건의 한도(압축 후 4 MiB)를 넘지 않게 나눠 저장하는지 검사합니다.
import test from 'node:test';import assert from 'node:assert/strict';import * as Y from 'yjs';import {randomBytes} from 'node:crypto';
import {SyncProvider,MemoryOutbox,decodeEnvelope} from '../src/sync-provider.js';
import {packUpdates,splitUpdate,RECORD_TARGET} from '../src/update-split.js';
import {settle,fakeClock,fakeServer} from './fakes.js';

const photo=(n=1_600_000)=>new Uint8Array(randomBytes(n)); // JPEG-like: does not compress
const replay=server=>{const d=new Y.Doc({gc:false});for(const r of server.log)Y.applyUpdate(d,decodeEnvelope(r));return d;};
const same=(a,b)=>assert.deepEqual(Y.encodeStateVector(a),Y.encodeStateVector(b));

test('photos inserted a second apart are saved as separate records, promptly',async()=>{
  const clock=fakeClock(),server=fakeServer(),doc=new Y.Doc({gc:false}),errors=[];
  const p=new SyncProvider({doc,backend:server,outbox:new MemoryOutbox(),author:'a',session:'s',clock,onError:e=>errors.push(e.message),batch:{debounceMs:2000,maxWaitMs:9000}});
  await p.start();await settle();
  for(let i=0;i<3;i++){doc.getMap('blobs').set(`p${i}`,photo());await settle();await clock.advance(1000);}
  await clock.advance(10);
  assert.deepEqual(errors,[]);assert.equal(p.state,'saved');assert.equal(server.log.length,3,'one record per photo, sent without waiting for the batch window');
  const r=replay(server);assert.equal(r.getMap('blobs').size,3);
  await p.dispose();
});

test('one update carrying several photos (pasted together, or a recovery delta) is split under the record limit',async()=>{
  const doc=new Y.Doc({gc:false});let update;
  doc.on('update',u=>{update??=u;});
  doc.transact(()=>{for(let i=0;i<4;i++)doc.getMap('blobs').set(`p${i}`,photo());doc.getText('t').insert(0,'설명');});
  doc.getText('t').delete(0,1); // a deletion after the photos travels with the last part
  const all=Y.encodeStateAsUpdate(doc);
  const parts=splitUpdate(doc,all);
  assert.ok(parts.length>=3,`${parts.length} parts`);
  for(const part of parts)assert.ok(part.length<=RECORD_TARGET+64*1024,`part ${part.length} bytes`);
  const r=new Y.Doc({gc:false});for(const part of parts)Y.applyUpdate(r,part);
  same(r,doc);assert.equal(r.getText('t').toString(),'명');assert.equal(r.getMap('blobs').size,4);
  // Out of order delivery converges too.
  const r2=new Y.Doc({gc:false});for(const part of [...parts].reverse())Y.applyUpdate(r2,part);same(r2,doc);assert.equal(r2.getText('t').toString(),'명');
  assert.ok(update.length>RECORD_TARGET);
});

test('packing keeps small edits merged and order-independent',()=>{
  const doc=new Y.Doc({gc:false}),updates=[];doc.on('update',u=>updates.push(u));
  for(let i=0;i<50;i++)doc.getText('t').insert(i,'가');
  doc.getMap('blobs').set('a',photo(3_000_000));doc.getText('t').insert(0,'끝');
  const packed=packUpdates(updates,doc);
  assert.ok(packed.length>=2&&packed.length<=4,`${packed.length} records for 52 edits including one 3 MB photo`);
  const r=new Y.Doc({gc:false});for(const u of packed)Y.applyUpdate(r,u);same(r,doc);assert.equal(r.getText('t').toString(),doc.getText('t').toString());
});

test('a device left with a large unsent delta (e.g. stuck before this fix) recovers it in several records',async()=>{
  const clock=fakeClock(),server=fakeServer(),doc=new Y.Doc({gc:false});
  for(let i=0;i<3;i++)doc.getMap('blobs').set(`p${i}`,photo()); // edits that never reached the outbox
  const p=new SyncProvider({doc,backend:server,outbox:new MemoryOutbox(),author:'a',session:'s',clock,onError:e=>assert.fail(e.message)});
  await p.start();await settle();await p.recoverLocalState();await settle();
  assert.equal(p.state,'saved');assert.ok(server.log.length>=2);same(replay(server),doc);
  await p.dispose();
});
