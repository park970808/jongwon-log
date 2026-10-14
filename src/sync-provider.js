import * as Y from 'yjs';
import { deflateSync, inflateSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CHECKPOINT } from './checkpoint-policy.js';
export const REMOTE = Symbol('remote');
export const LOCAL = Symbol('local');
const digest = b => bytesToHex(sha256(b));
const MAX_UPDATE = 4 * 1024 * 1024;
const MAX_INFLATED = 96 * 1024 * 1024;

/*
 * Firestore Spark(무료) 한도: 하루 쓰기 20,000 · 읽기 50,000.
 * 변경 묶음 하나 = 쓰기 1 + (다른 접속자 수만큼 읽기)이므로 묶음 수가 곧 비용입니다.
 * 입력이 멈추면 debounceMs 뒤에 보내고, 계속 입력해도 maxWaitMs를 넘기지 않습니다.
 * 아직 보내지 않은 입력도 이미 이 기기(IndexedDB)에 저장되어 있으므로, 간격을 늘려도 내용을 잃지 않습니다.
 * 읽기 비용은 "묶음 수 × 열려 있는 창 수"이므로, 함께 연 사람이 많을수록 묶음 간격을 늘립니다(batchForPeers).
 * 혼자·둘이서는 최대 4초, 6명이 함께 열면 최대 9초 늦게 팀원 화면에 보입니다. 커서 위치는 별도로 바로 보입니다.
 */
export const DEFAULT_BATCH = Object.freeze({ debounceMs: 1200, maxWaitMs: 4000 });
export function batchForPeers(peers) {
  const n = Number.isFinite(peers) ? Math.max(0, Math.floor(peers)) : 0;
  if (n <= 1) return DEFAULT_BATCH;
  return Object.freeze({ debounceMs: 2000, maxWaitMs: Math.min(9000, 1500 * (n + 1)) });
}
/** append()가 이 시간 안에 끝나지 않으면 "연결 끊김"으로 표시합니다(오프라인에서는 SDK가 쓰기를 보류만 하고 실패시키지 않음). */
export const APPEND_WATCHDOG_MS = 15000;
/** 로컬 캐시(IndexedDB)로 다시 열 때 이 시각부터 서버 기록을 다시 읽습니다. 지연 저장·서버 시각 차이를 덮는 여유. */
export const CURSOR_MARGIN_MS = 10 * 60 * 1000;

export function encodeEnvelope(update, author, session) {
  if (update.byteLength > MAX_INFLATED) throw new Error('변경 데이터가 너무 큽니다. 복구본을 내려받아 주세요.');
  const payload = deflateSync(update);
  if(payload.length > MAX_UPDATE) throw new Error('한 번에 저장할 수 있는 변경 크기를 넘었습니다. 큰 사진을 줄여 주세요.');
  return { id: digest(update), schema: 1, author, session, hash: digest(update), rawSize: update.length, codec: 'deflate', payload };
}
export function decodeEnvelope(e) {
  if(e.schema !== 1 || e.codec !== 'deflate' || !(e.payload instanceof Uint8Array) || e.payload.length>MAX_UPDATE || !Number.isInteger(e.rawSize) || e.rawSize < 2 || e.rawSize>MAX_INFLATED)throw new Error('지원하지 않거나 너무 큰 변경 데이터입니다.');
  const update=inflateSync(e.payload,{out:new Uint8Array(e.rawSize)});
  if(update.length!==e.rawSize || digest(update)!==e.hash || e.id!==e.hash)throw new Error('변경 데이터의 무결성 검증에 실패했습니다.');
  return update;
}

/*
 * Delete-set comparisons without Y.mergeDeleteSets: in yjs 13.6.27 it merges the first set's DeleteItem objects in
 * place, so Y.snapshotContainsUpdate(snapshot, update) extends the snapshot's own ranges and then reports adjacent
 * deletions as "already contained". These helpers never mutate their inputs.
 */
function mergedRanges(items = []) {
  const merged = [];
  for (const [start, end] of items.map(d => [d.clock, d.clock + d.len]).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  return merged;
}
/** Every deletion in `inner` is also in `outer`. */
export function deleteSetCovers(outer, inner) {
  for (const [client, items] of inner.clients) {
    const ranges = mergedRanges(outer.clients.get(client));
    for (const d of items) if (d.len > 0 && !ranges.some(([a, b]) => a <= d.clock && d.clock + d.len <= b)) return false;
  }
  return true;
}
/** The server state (snapshot) already holds every insertion and deletion in `update`. */
export function snapshotHoldsUpdate(snapshot, update) {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.every(s => (snapshot.sv.get(s.id.client) || 0) >= s.id.clock + s.length) && deleteSetCovers(snapshot.ds, ds);
}

const realClock = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) };

/** Pause-aware batching: fire debounceMs after the last change, but never later than maxWaitMs after the first. */
export class FlushScheduler {
  constructor({ debounceMs = DEFAULT_BATCH.debounceMs, maxWaitMs = DEFAULT_BATCH.maxWaitMs, onFire, clock = realClock }) {
    if (!(maxWaitMs > 0) || !(debounceMs > 0)) throw new Error('batch timings must be positive');
    Object.assign(this, { debounceMs, maxWaitMs, onFire, clock });
    this.timer = null; this.firstAt = null;
  }
  touch() {
    const now = this.clock.now();
    if (this.firstAt === null) this.firstAt = now;
    if (this.timer !== null) this.clock.clear(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstAt + this.maxWaitMs - now));
    this.timer = this.clock.set(() => { this.timer = null; this.firstAt = null; this.onFire(); }, wait);
  }
  cancel() { if (this.timer !== null) this.clock.clear(this.timer); this.timer = null; this.firstAt = null; }
  /** New timings apply from the next change; a pending send is not delayed. */
  configure({ debounceMs, maxWaitMs }) { if (maxWaitMs > 0 && debounceMs > 0) Object.assign(this, { debounceMs, maxWaitMs }); }
  get scheduled() { return this.timer !== null; }
}

/** Raised by backends for records whose stored bytes are structurally invalid (not for network/permission errors). */
export class CorruptRecordError extends Error {}

/** Durable append-only transport. Backend is Firestore in production, a fake in tests. */
export class SyncProvider {
  constructor({doc,backend,outbox,author,session,onStatus=()=>{},onError=()=>{},onWarning=()=>{},batch=DEFAULT_BATCH,clock=realClock,knownServerSnapshot=null,listenOptions={},checkpoint=CHECKPOINT,random=Math.random}) {
    Object.assign(this,{doc,backend,outbox,author,session,onStatus,onError,onWarning,clock,listenOptions,checkpointPolicy:checkpoint,random});
    this.serverDoc=new Y.Doc({gc:false});this.buffer=[];this.seen=new Set();this.ready=false;this.disposed=false;this.retry=0;this.pending=new Map();
    this.rejected=[];this.serverTime=0;this.newestSeen=0;this.online=false;this.recordsSinceBase=0;this.checkpointing=false;
    this.checkpointDisabled=false;this.checkpointFailures=0;this.checkpointRetryAt=0;
    // Incremental reopen: rebuild "what the server already had" from the local cache, so the downloaded tail
    // integrates and recovery uploads only edits that never reached the server. Any doubt → full download.
    this.since=null;
    if(knownServerSnapshot&&Number.isFinite(listenOptions.since)){
      try{this.seedServerDoc(knownServerSnapshot);this.since=listenOptions.since;}
      catch(error){console.warn('Incremental reopen disabled; downloading the full history.',error);this.serverDoc.destroy();this.serverDoc=new Y.Doc({gc:false});}
    }
    this.scheduler=new FlushScheduler({...batch,clock,onFire:()=>void this.flush()});
    this.onUpdate=(u,origin)=>{if(origin===REMOTE || this.disposed)return;this.buffer.push(u);this.status('saving');this.scheduler.touch();};
    doc.on('update',this.onUpdate);
  }
  status(state){this.state=state;this.onStatus({state,pending:this.pending.size+Number(this.buffer.length>0)});}
  /** Skip a record that can never be applied, so one bad entry cannot stop every teammate's editor. */
  quarantine(id,error){
    if(this.seen.has(id))return;
    this.seen.add(id);this.rejected.push({id,message:error?.message||String(error)});
    console.error('Skipped unreadable update',id,error);
    this.onWarning(new Error(`읽을 수 없는 변경 기록 1개를 건너뛰었습니다 (${String(id).slice(0,8)}…). 나머지 내용은 정상적으로 동기화됩니다.`));
  }
  seedServerDoc(bytes){
    const snapshot=Y.decodeSnapshot(bytes),local=Y.decodeStateVector(Y.encodeStateVector(this.doc));
    for(const [client,clock] of snapshot.sv)if(!(local.get(client)>=clock))throw new Error('local cache is older than the stored server snapshot');
    // Deletions too: a snapshot claiming deletions the cache does not hold would make createDocFromSnapshot wrong.
    if(!deleteSetCovers(Y.createDeleteSetFromStructStore(this.doc.store),snapshot.ds))throw new Error('local cache lacks deletions recorded in the stored server snapshot');
    const base=Y.createDocFromSnapshot(this.doc,snapshot); // requires the local doc to keep history (gc:false)
    try{Y.applyUpdate(this.serverDoc,Y.encodeStateAsUpdate(base),REMOTE);}finally{base.destroy();}
  }
  async start(){
    for(const e of await this.outbox.list())this.pending.set(e.id,e);
    this.listen(this.since);
    this.status('connecting');
  }
  /** A failed Firestore listener never resumes by itself (e.g. after the daily read quota resets), so re-subscribe. */
  listenFailed(error){
    if(this.disposed)return;
    this.online=false;this.status('error');this.onError(error);
    if(/permission-denied|unauthenticated/.test(error?.code||'')||this.relistenTimer)return;
    const delay=Math.min(60000,5000*2**(this.relisten=(this.relisten||0)+1)-5000);
    this.relistenTimer=this.clock.set(()=>{
      this.relistenTimer=null;if(this.disposed)return;
      this.unsubscribe?.();
      // serverTime only advances when a whole server snapshot was applied, and the backend stops a listener at the
      // first failed snapshot, so everything older than serverTime is applied. Before the first complete load,
      // start over from the original position (Yjs ignores duplicates).
      this.listen(this.ready&&this.serverTime>0?this.serverTime-CURSOR_MARGIN_MS:this.since);
    },Math.max(5000,delay));
  }
  listen(since){
    const options={...this.listenOptions,since,
      isKnown:id=>this.seen.has(id),
      onInvalid:(id,error)=>this.quarantine(id,error),
      onSynced:(time,count=0,fromCache=false)=>{
        if(Number.isFinite(time)&&time>this.newestSeen)this.newestSeen=time;
        // Only a server-confirmed snapshot proves nothing older is missing (a cache snapshot can be partial).
        this.online=!fromCache;if(!fromCache&&this.newestSeen>this.serverTime)this.serverTime=this.newestSeen;
        this.recordsSinceBase+=count;this.maybeCheckpoint();
      }};
    // Returns false only when the record could not be applied (it is then quarantined).
    this.unsubscribe=this.backend.listen(async e=>{
      if(this.disposed||this.seen.has(e.id))return true;
      let update;
      try{update=decodeEnvelope(e);Y.applyUpdate(this.serverDoc,update,REMOTE);} // serverDoc doubles as a validation probe
      catch(error){
        // An unusable checkpoint is not lost content: the backend then reads the full log instead.
        if(e.kind==='checkpoint'){console.warn('Checkpoint could not be applied; reading the full log.',error);return false;}
        this.quarantine(e.id,error);return false;
      }
      Y.applyUpdate(this.doc,update,REMOTE);this.seen.add(e.id);
      // The server already holds an entry this browser was still waiting to send (ambiguous earlier commit).
      if(this.pending.has(e.id)){this.pending.delete(e.id);void this.outbox.remove(e.id).catch(()=>{});}
      return true;
    },()=>{this.ready=true;this.relisten=0;void this.flush();this.maybeCheckpoint();},error=>this.listenFailed(error),options);
  }
  /**
   * Client-side compaction (Spark has no Cloud Functions): see checkpoint-policy.js for the safety conditions.
   * The checkpoint is built from serverDoc only, so unsent local edits are never part of it.
   */
  maybeCheckpoint(){
    const p=this.checkpointPolicy;
    if(this.checkpointing||this.checkpointDisabled||this.disposed||!this.ready||!this.online||this.since!==null||!p||typeof this.backend.createCheckpoint!=='function')return;
    // Quarantined records do not block compaction: chunks are read from the server and written in the same batch
    // as their record, so a record judged corrupt is corrupt for every reader, with or without a checkpoint.
    if(this.clock.now()<this.checkpointRetryAt)return;
    // ?fullload=1 (repair): the session ignored the stored checkpoint, so replace it as soon as possible.
    const repair=Boolean(this.listenOptions.ignoreCheckpoint);
    if((!repair&&this.recordsSinceBase<p.everyRecords)||!(this.serverTime>p.lagMs))return;
    this.checkpointing=true;
    const [lo,hi]=p.jitterMs;
    this.checkpointTimer=this.clock.set(async()=>{
      this.checkpointTimer=null;
      try{
        if(this.disposed||!this.online)return;
        // Whole milliseconds: Timestamp.fromMillis drops sub-millisecond parts, and coverage is compared exactly.
        const newest=Math.floor(this.serverTime);
        const result=await this.backend.createCheckpoint({state:Y.encodeStateAsUpdate(this.serverDoc),cutoff:newest-p.lagMs,author:this.author,
          minAdvanceMs:repair?0:p.minAdvanceMs,repair,maxCutoff:newest});
        this.checkpointFailures=0;
        if(result==='too-large')this.checkpointDisabled=true; // will not shrink in this session; the log still works
        else if(repair){
          // A repair is done only when this session's own checkpoint replaced the stored one.
          if(result==='created'){this.checkpointDisabled=true;this.recordsSinceBase=0;this.onWarning(new Error('전체 기록으로 압축본을 새로 만들었습니다. 이제 주소에서 ?fullload=1 을 빼고 사용하셔도 됩니다.'));}
          else this.retryCheckpointIn(60000); // nothing newer to cover yet; try again after the next edits
        }
        else this.recordsSinceBase=0; // made by us or already by a teammate
      }catch(error){
        console.warn('Checkpoint not created; the full history remains available.',error);
        if(/permission-denied|unauthenticated|invalid-argument/.test(error?.code||''))this.checkpointDisabled=true; // rules not deployed yet
        else this.retryCheckpointIn(Math.min(60*60*1000,60000*2**this.checkpointFailures++));
      }
      finally{this.checkpointing=false;}
    },lo+(hi-lo)*this.random());
  }
  retryCheckpointIn(ms){
    this.checkpointRetryAt=this.clock.now()+ms;
    if(this.checkpointRetryTimer)this.clock.clear(this.checkpointRetryTimer);
    this.checkpointRetryTimer=this.clock.set(()=>{this.checkpointRetryTimer=null;this.maybeCheckpoint();},ms);
  }
  /** Fewer, larger records when more sessions are open (each record is read once per open session). */
  setBatch(timing){this.scheduler.configure(timing);}
  async flush(){
    if(this.disposed)return;
    if(this.flushing)return this.flushing;
    this.flushing=this.doFlush().finally(()=>{
      this.flushing=null;
      // Edits made while this flush was busy with an earlier batch must not wait for the next keystroke.
      if(!this.disposed&&this.buffer.length&&!this.scheduler.scheduled&&this.state!=='error')this.scheduler.touch();
    });return this.flushing;
  }
  async doFlush(){
    if(this.buffer.length){
      const count=this.buffer.length;this.scheduler.cancel(); // later edits re-arm the scheduler themselves
      try{
        const e=encodeEnvelope(Y.mergeUpdates(this.buffer.slice(0,count)),this.author,this.session);
        await this.outbox.put(e); // never acknowledge before durable local outbox
        this.buffer.splice(0,count);this.pending.set(e.id,e);
      }catch(error){this.status('error');this.onError(error);return;}
    }
    if(!this.ready){this.status('connecting');return;}
    for(const e of this.pending.values()){
      if(this.disposed)return;
      // With the offline cache the SDK queues a write instead of failing it; show "offline" while it waits.
      const watchdog=this.clock.set(()=>{if(!this.disposed&&this.state!=='error')this.status('offline');},APPEND_WATCHDOG_MS);
      try{
        try{await this.backend.append(e);}finally{this.clock.clear(watchdog);}
        Y.applyUpdate(this.serverDoc,decodeEnvelope(e),REMOTE);
        await this.outbox.remove(e.id);this.pending.delete(e.id);this.seen.add(e.id);this.retry=0;
      }catch(error){
        // resource-exhausted(무료 한도 소진)는 재시도합니다: 한도가 풀리면 outbox의 변경이 자동으로 저장됩니다.
        const denied=/permission-denied|unauthenticated|invalid-argument/.test(error.code||'');
        this.status(denied?'error':'offline');this.onError(error);
        if(!denied&&!this.retryTimer)this.retryTimer=this.clock.set(()=>{this.retryTimer=null;void this.flush();},Math.min(30000,1000*2**this.retry++));
        return;
      }
    }
    if(this.buffer.length){if(!this.scheduler.scheduled)this.scheduler.touch();this.status('saving');}
    else this.status('saved');
  }
  /** Everything the server is known to hold (downloaded, sent and acknowledged, or rebuilt from the stored snapshot). */
  serverStateVector(){return Y.encodeStateVector(this.serverDoc);}
  /**
   * Resume point for the next incremental open, or null when unsafe to store one.
   * Only after the initial download finished (ready) and only up to the newest fully applied server batch.
   */
  syncCursor(){
    if(!this.ready||this.disposed||!(this.serverTime>0))return null;
    return {v:2,since:this.serverTime-CURSOR_MARGIN_MS,snapshot:Y.encodeSnapshot(Y.snapshot(this.serverDoc))};
  }
  /**
   * Upload local Yjs changes that never reached the transport (e.g. the tab closed between an edit and the outbox).
   * encodeStateAsUpdate always carries the whole delete set, so "already on the server" is checked with a snapshot
   * (snapshotHoldsUpdate, not Y.snapshotContainsUpdate — see above).
   */
  async recoverLocalState(){
    const delta=Y.encodeStateAsUpdate(this.doc,this.serverStateVector());
    if(delta.length>2&&!snapshotHoldsUpdate(Y.snapshot(this.serverDoc),delta)){this.buffer.push(delta);this.scheduler.cancel();}
    return this.flush();
  }
  async dispose(){await this.flush();this.disposed=true;this.scheduler.cancel();if(this.retryTimer)this.clock.clear(this.retryTimer);if(this.relistenTimer)this.clock.clear(this.relistenTimer);if(this.checkpointTimer)this.clock.clear(this.checkpointTimer);if(this.checkpointRetryTimer)this.clock.clear(this.checkpointRetryTimer);this.unsubscribe?.();this.doc.off('update',this.onUpdate);this.serverDoc.destroy();}
}

export class MemoryOutbox {
  constructor(){this.entries=new Map();} async list(){return [...this.entries.values()];}async put(e){this.entries.set(e.id,e);}async remove(id){this.entries.delete(id);}
}
export class IndexedOutbox {
  constructor(name){this.database=new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('outbox',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  async run(mode,operation){const db=await this.database;return new Promise((resolve,reject)=>{const tx=db.transaction('outbox',mode);let result;const request=operation(tx.objectStore('outbox'));request.onsuccess=()=>result=request.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  list(){return this.run('readonly',s=>s.getAll());}put(e){return this.run('readwrite',s=>s.put(e));}remove(id){return this.run('readwrite',s=>s.delete(id));}
}
