import test from 'node:test';import assert from 'node:assert/strict';import * as Y from 'yjs';
import {SyncProvider,MemoryOutbox,encodeEnvelope,decodeEnvelope,REMOTE} from '../src/sync-provider.js';
const tick=()=>new Promise(r=>setTimeout(r,10));
function backend(){const log=new Map(),listeners=new Set();return {log,fail:false,append:async function(e){if(this.fail)throw new Error('offline');log.set(e.id,e);for(const l of listeners)await l(e);},listen(fn,ready){listeners.add(fn);queueMicrotask(async()=>{for(const e of log.values())await fn(e);ready();});return()=>listeners.delete(fn);}};}
test('Firestore-shaped transport propagates a real Yjs update and does not echo it',async()=>{
 const back=backend(),a=new Y.Doc(),b=new Y.Doc();const make=d=>new SyncProvider({doc:d,backend:back,outbox:new MemoryOutbox(),author:'user',session:crypto.randomUUID()});
 const pa=make(a),pb=make(b);await pa.start();await pb.start();await tick();a.getText('t').insert(0,'같은 칸');await pa.flush();await tick();assert.equal(b.getText('t').toString(),'같은 칸');assert.equal(back.log.size,1);await pa.dispose();await pb.dispose();
});
test('failed write remains in durable outbox and retry cannot lose it',async()=>{
 const back=backend(),outbox=new MemoryOutbox(),a=new Y.Doc(),p=new SyncProvider({doc:a,backend:back,outbox,author:'a',session:'s'});await p.start();await tick();back.fail=true;a.getText('t').insert(0,'보존');await p.flush();assert.equal((await outbox.list()).length,1);assert.equal(p.state,'offline');back.fail=false;await p.flush();assert.equal((await outbox.list()).length,0);assert.equal(p.state,'saved');await p.dispose();
});
test('corrupt and oversized envelopes rejected before applying',()=>{
 const a=new Y.Doc();a.getText('t').insert(0,'검증');const e=encodeEnvelope(Y.encodeStateAsUpdate(a),'u','s');assert.doesNotThrow(()=>decodeEnvelope(e));assert.throws(()=>decodeEnvelope({...e,hash:'0'.repeat(64)}));assert.throws(()=>decodeEnvelope({...e,rawSize:1024**3}));
});
test('reload recovery sends only missing local edits, not the whole saved document',async()=>{
 const back=backend(),server=new Y.Doc();server.getText('t').insert(0,'기존 본문'.repeat(10000));await back.append(encodeEnvelope(Y.encodeStateAsUpdate(server),'u','old'));
 const doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(server));doc.getText('t').insert(0,'기기복구');
 const provider=new SyncProvider({doc,backend:back,outbox:new MemoryOutbox(),author:'u',session:'new'});await provider.start();await tick();await provider.recoverLocalState();await tick();
 assert.equal(back.log.size,2);const last=[...back.log.values()].at(-1);assert.ok(decodeEnvelope(last).length<200);
 const recovered=new Y.Doc();for(const e of back.log.values())Y.applyUpdate(recovered,decodeEnvelope(e));assert.equal(recovered.getText('t').toString(),doc.getText('t').toString());await provider.dispose();
});
