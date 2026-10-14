import * as Y from 'yjs';
import { deflateSync, inflateSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export const REMOTE = Symbol('remote');
export const LOCAL = Symbol('local');
const digest = b => bytesToHex(sha256(b));
const MAX_UPDATE = 4 * 1024 * 1024;
const MAX_INFLATED = 96 * 1024 * 1024;

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

/** Durable append-only transport. Backend is Firestore in production, a fake in tests. */
export class SyncProvider {
  constructor({doc,backend,outbox,author,session,onStatus=()=>{},onError=()=>{},batchMs=300}) {
    Object.assign(this,{doc,backend,outbox,author,session,onStatus,onError,batchMs});
    this.serverDoc=new Y.Doc({gc:false});this.buffer=[];this.seen=new Set();this.ready=false;this.disposed=false;this.sending=false;this.retry=0;this.pending=new Map();
    this.onUpdate=(u,origin)=>{if(origin===REMOTE || this.disposed)return;this.buffer.push(u);this.status('saving');if(!this.timer)this.timer=setTimeout(()=>{this.timer=null;void this.flush();},batchMs);};
    doc.on('update',this.onUpdate);
  }
  status(state){this.state=state;this.onStatus({state,pending:this.pending.size+Number(this.buffer.length>0)});}
  async start(){
    for(const e of await this.outbox.list())this.pending.set(e.id,e);
    this.unsubscribe=this.backend.listen(async e=>{
      if(this.disposed||this.seen.has(e.id))return;
      try { const u=decodeEnvelope(e);Y.applyUpdate(this.serverDoc,u,REMOTE);Y.applyUpdate(this.doc,u,REMOTE);this.seen.add(e.id); }
      catch(error){this.fatal=true;this.ready=false;this.status('error');this.onError(error);throw error;}
    },()=>{if(this.fatal)return;this.ready=true;void this.flush();},error=>{this.status('error');this.onError(error);});
    this.status('connecting');
  }
  async flush(){
    if(this.disposed||this.fatal)return;
    if(this.flushing)return this.flushing;
    this.flushing=this.doFlush().finally(()=>{this.flushing=null;});return this.flushing;
  }
  async doFlush(){
    if(this.buffer.length){
      const count=this.buffer.length;
      try{
        const e=encodeEnvelope(Y.mergeUpdates(this.buffer.slice(0,count)),this.author,this.session);
        await this.outbox.put(e); // never acknowledge before durable local outbox
        this.buffer.splice(0,count);this.pending.set(e.id,e);
      }catch(error){this.status('error');this.onError(error);return;}
    }
    if(!this.ready){this.status('connecting');return;}
    for(const e of this.pending.values()){
      if(this.disposed)return;
      try{
        await this.backend.append(e);
        Y.applyUpdate(this.serverDoc,decodeEnvelope(e),REMOTE);
        await this.outbox.remove(e.id);this.pending.delete(e.id);this.seen.add(e.id);this.retry=0;
      }catch(error){
        const denied=/permission-denied|unauthenticated|invalid-argument/.test(error.code||'');
        this.status(denied?'error':'offline');this.onError(error);
        if(!denied&&!this.retryTimer)this.retryTimer=setTimeout(()=>{this.retryTimer=null;void this.flush();},Math.min(30000,1000*2**this.retry++));
        return;
      }
    }
    if(this.buffer.length){this.timer ||= setTimeout(()=>{this.timer=null;void this.flush();},this.batchMs);this.status('saving');}
    else this.status('saved');
  }
  async recoverLocalState(){const delta=Y.encodeStateAsUpdate(this.doc,Y.encodeStateVector(this.serverDoc));if(delta.length>2)this.buffer.push(delta);return this.flush();}
  async dispose(){await this.flush();this.disposed=true;clearTimeout(this.timer);clearTimeout(this.retryTimer);this.unsubscribe?.();this.doc.off('update',this.onUpdate);this.serverDoc.destroy();}
}

export class MemoryOutbox {
  constructor(){this.entries=new Map();} async list(){return [...this.entries.values()];}async put(e){this.entries.set(e.id,e);}async remove(id){this.entries.delete(id);}
}
export class IndexedOutbox {
  constructor(name){this.database=new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('outbox',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  async run(mode,operation){const db=await this.database;return new Promise((resolve,reject)=>{const tx=db.transaction('outbox',mode);let result;const request=operation(tx.objectStore('outbox'));request.onsuccess=()=>result=request.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  list(){return this.run('readonly',s=>s.getAll());}put(e){return this.run('readwrite',s=>s.put(e));}remove(id){return this.run('readwrite',s=>s.delete(id));}
}
