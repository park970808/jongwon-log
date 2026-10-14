import {collection,doc,getDoc,getDocFromServer,getDocsFromServer,onSnapshot,writeBatch,Bytes,serverTimestamp,setDoc,deleteDoc,runTransaction,query,where,Timestamp} from 'firebase/firestore';
import {CorruptRecordError,decodeEnvelope,encodeEnvelope} from './sync-provider.js';
import {chooseCheckpointCutoff} from './checkpoint-policy.js';
const CHUNK=128*1024;
/**
 * 작은 변경(대부분의 글자 입력)은 기록 문서 한 장에 바로 담습니다: 쓰기 1회, 받는 쪽 읽기 1회.
 * 이보다 큰 변경(사진 등)만 예전처럼 128 KiB 조각으로 나눕니다. 규칙의 data 크기 제한과 같아야 합니다.
 */
export const INLINE_MAX=256*1024;
/** 접속자 정보(anchor)에 넣는 클라이언트 형식 번호. 2 이상이면 인라인 기록을 읽을 수 있는 버전입니다. */
export const CLIENT_FORMAT=2;
const FETCH_CONCURRENCY=6;
const validId=x=>/^[A-Za-z0-9_-]{1,100}$/.test(x);
const millis=t=>typeof t?.toMillis==='function'?t.toMillis():null;

async function mapLimited(items,limit,fn){
  const results=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;results[i]=await fn(items[i]);}}));
  return results;
}

export class FirestoreBackend {
  constructor(db,teamId,documentId){
    if(!validId(teamId)||!validId(documentId))throw new Error('문서 주소가 올바르지 않습니다.');
    this.db=db;this.root=doc(db,'teams',teamId,'documents',documentId);this.updates=collection(this.root,'updates');
    this.inline=true;       // switched off for this session if the deployed rules predate inline records
    this.legacyPeers=true;  // an open tab running the previous version cannot read inline records; the app clears
                            // this from presence once every recent teammate runs CLIENT_FORMAT >= 2
  }
  async metadata(){return (await getDoc(this.root)).data();}
  async create({title,week,seed,author,session}){
    // One seed per document, even when two users create it at the same time.
    const chunks=Math.ceil(seed.payload.length/CHUNK);
    await runTransaction(this.db,async tx=>{
      const exists=await tx.get(this.root);if(exists.exists())throw new Error('문서가 이미 있습니다. 기존 문서를 열어주세요.');
      tx.set(this.root,{title,week,schema:1,createdBy:author,createdAt:serverTimestamp(),seedId:seed.id});
      const ref=doc(this.updates,seed.id);
      tx.set(ref,{schema:1,hash:seed.hash,author,session,codec:seed.codec,rawSize:seed.rawSize,chunks,createdAt:serverTimestamp()});
      for(let i=0;i<chunks;i++)tx.set(doc(ref,'chunks',String(i)),{data:Bytes.fromUint8Array(seed.payload.slice(i*CHUNK,(i+1)*CHUNK))});
    });
  }
  writeRecord(e,inline){
    const ref=doc(this.updates,e.id),batch=writeBatch(this.db);
    const meta={schema:e.schema,hash:e.hash,author:e.author,session:e.session,codec:e.codec,rawSize:e.rawSize,createdAt:serverTimestamp()};
    if(inline){batch.set(ref,{...meta,chunks:0,data:Bytes.fromUint8Array(e.payload)});}
    else{
      const chunks=Math.ceil(e.payload.length/CHUNK);batch.set(ref,{...meta,chunks});
      for(let i=0;i<chunks;i++)batch.set(doc(ref,'chunks',String(i)),{data:Bytes.fromUint8Array(e.payload.slice(i*CHUNK,(i+1)*CHUNK))});
    }
    return batch.commit();
  }
  /** Server-confirmed only: with the offline cache a plain getDoc could answer "missing" from a stale cache. */
  async exists(id){return (await getDocFromServer(doc(this.updates,id))).exists();}
  async append(e){
    // No read before writing: records are immutable, so re-sending an id the server already has is rejected by the
    // rules and resolved below with a single existence check. That check only happens on the rare retry path.
    const inline=this.inline&&!this.legacyPeers&&e.payload.length<=INLINE_MAX;
    try{await this.writeRecord(e,inline);}
    catch(error){
      if(await this.exists(e.id))return; // an earlier ambiguous attempt already committed it
      if(inline&&error?.code==='permission-denied'){
        // Rules without inline support are still deployed: keep working in the chunked format.
        await this.writeRecord(e,false);
        console.warn('Inline update records are not allowed by the deployed rules; using chunked records.');
        this.inline=false;return;
      }
      throw error;
    }
  }
  /**
   * Store a compacted copy of the document (see checkpoint-policy.js) and move the document's checkpoint pointer
   * forward. Returns 'created' | 'exists' (a teammate's is at least as recent) | 'too-large'.
   * repair (?fullload=1): replace the stored checkpoint even if it is recent (see chooseCheckpointCutoff).
   */
  async createCheckpoint({state,cutoff,author,minAdvanceMs=0,repair=false,maxCutoff=cutoff}){
    const chosen=chooseCheckpointCutoff({current:millis((await this.metadata())?.checkpointCutoff),cutoff,minAdvanceMs,repair,maxCutoff});
    if(chosen===null)return 'exists';
    cutoff=chosen;
    let e;try{e=encodeEnvelope(state,author,'checkpoint');}catch{return 'too-large';}
    if(e.payload.length>32*CHUNK)return 'too-large';
    const ref=doc(this.root,'checkpoints',e.id),chunks=Math.ceil(e.payload.length/CHUNK),coveredUntil=Timestamp.fromMillis(cutoff);
    const batch=writeBatch(this.db);
    batch.set(ref,{schema:1,hash:e.hash,codec:e.codec,rawSize:e.rawSize,chunks,createdAt:serverTimestamp(),createdBy:author,coveredUntil});
    for(let i=0;i<chunks;i++)batch.set(doc(ref,'chunks',String(i)),{data:Bytes.fromUint8Array(e.payload.slice(i*CHUNK,(i+1)*CHUNK))});
    try{await batch.commit();}
    catch(error){
      // Identical content was already stored (ids are content hashes; the rules make checkpoints immutable).
      const existing=await getDocFromServer(ref).catch(()=>null);
      if(!existing?.exists()||millis(existing.data().coveredUntil)!==cutoff)throw error;
    }
    return runTransaction(this.db,async tx=>{
      const latest=millis((await tx.get(this.root)).data()?.checkpointCutoff);
      if(latest!==null&&latest>=cutoff)return 'exists';
      tx.update(this.root,{checkpointId:e.id,checkpointCutoff:coveredUntil});
      return 'created';
    });
  }
  /**
   * Chunks always come from the server: with the offline cache, an offline getDocs would return an empty or partial
   * cached result, and a record must never be declared corrupt (and skipped forever) because of a network outage.
   */
  fetchChunks(ref){return getDocsFromServer(collection(ref,'chunks'));}
  async readPayload(d){
    const m=d.data();
    if(m.chunks===0){
      const p=m.data?.toUint8Array?.();
      if(!p||!p.length||p.length>INLINE_MAX)throw new CorruptRecordError('변경 데이터가 비어 있거나 너무 큽니다.');
      return p;
    }
    if(!Number.isInteger(m.chunks)||m.chunks<1||m.chunks>32)throw new CorruptRecordError('잘못된 변경 묶음입니다.');
    const chunks=await this.fetchChunks(d.ref); // network/permission errors propagate as real errors
    const ordered=Array.from({length:m.chunks},(_,i)=>chunks.docs.find(c=>c.id===String(i))?.data().data?.toUint8Array());
    if(ordered.some(c=>!c||c.length>CHUNK))throw new CorruptRecordError('변경 데이터 일부가 없습니다.');
    const payload=new Uint8Array(ordered.reduce((n,c)=>n+c.length,0));let at=0;for(const c of ordered){payload.set(c,at);at+=c.length;}
    return payload;
  }
  /**
   * The latest checkpoint as a verified envelope, or null when it cannot be used (missing, damaged, or not matching
   * its hash). Then the caller reads the log instead: a bad checkpoint costs reads, never content.
   */
  checkpointSnapshot(id){return getDocFromServer(doc(this.root,'checkpoints',id));}
  async readCheckpoint(id,cutoff){
    const snap=await this.checkpointSnapshot(id);
    if(!snap.exists()){console.warn('Checkpoint pointer refers to a missing checkpoint; reading the full log.');return null;}
    const data=snap.data();
    if(millis(data.coveredUntil)!==cutoff){console.warn('Checkpoint coverage does not match the pointer; reading the full log.');return null;}
    try{const e={...data,id:snap.id,kind:'checkpoint',payload:await this.readPayload(snap)};decodeEnvelope(e);return e;}
    catch(error){if(error instanceof CorruptRecordError||!error?.code){console.warn('Damaged checkpoint ignored; reading the full log.',error);return null;}throw error;}
  }
  tailQuery(fromMillis){return fromMillis===null?this.updates:query(this.updates,where('createdAt','>=',Timestamp.fromMillis(Math.max(0,fromMillis))));}
  subscribe(source,next,fail){return onSnapshot(source,{includeMetadataChanges:true},next,fail);}
  /**
   * options.since            서버 시각(ms). 이 시각 이후 기록만 읽습니다(이미 로컬 캐시에 있는 내용은 다시 받지 않음).
   * options.isKnown          이미 적용한 기록이면 데이터를 내려받지 않습니다(내가 보낸 기록의 에코 등).
   * options.onInvalid        손상된 기록을 알려 건너뛰게 합니다.
   * options.onSynced         스냅샷 하나를 모두 처리한 뒤 (가장 최근 서버 시각|null, 기록 수, 캐시에서 왔는지)를 알려 줍니다.
   * options.ignoreCheckpoint 압축본을 쓰지 않고 전체 기록을 읽습니다(?fullload=1 복구용).
   * receive()가 false를 돌려주면 그 기록을 적용하지 못한 것입니다(압축본이면 전체 기록으로 대신 읽음).
   *
   * 한 스냅샷의 처리 중 오류가 나면 이 리스너는 즉시 멈추고 error()를 부릅니다. 그 스냅샷의 나머지 기록을 놓친 채
   * 이후 스냅샷을 계속 받으면 "다 받았다"는 잘못된 동기화 위치가 저장될 수 있기 때문입니다. 다시 구독하는 것은 호출자의 몫입니다.
   */
  listen(receive,ready,error,options={}){
    const {since=null,isKnown=()=>false,onInvalid=(id,e)=>{throw e;},onSynced=()=>{},ignoreCheckpoint=false}=options;
    let active=true,chain=Promise.resolve(),off=()=>{};const loaded=new Set();
    const stop=e=>{if(!active)return;active=false;off();error(e);};
    const start=async()=>{
      const meta=await this.metadata();
      let from=Number.isFinite(since)?since:null;
      const cutoff=millis(meta?.checkpointCutoff);
      if(!ignoreCheckpoint&&meta?.checkpointId&&cutoff!==null&&!(from!==null&&from>=cutoff)){
        // A checkpoint newer than the local cache is cheaper than replaying the log before it.
        const checkpoint=await this.readCheckpoint(meta.checkpointId,cutoff);
        if(!active)return;
        if(checkpoint&&await receive(checkpoint)!==false){
          if(!active)return;
          onSynced(cutoff,0,false);
          from=cutoff; // inclusive boundary: equal server timestamps overlap safely (Yjs is idempotent)
        }
      }
      if(!active)return;
      off=this.subscribe(this.tailQuery(from),snap=>{
        chain=chain.then(async()=>{
          if(!active)return;
          const docs=[];
          for(const change of snap.docChanges({includeMetadataChanges:true})){
            const d=change.doc;if(change.type==='removed'||d.metadata.hasPendingWrites||loaded.has(d.id))continue;
            loaded.add(d.id);docs.push(d);
          }
          // Download large (chunked) records in parallel, then apply in snapshot order.
          const payloads=await mapLimited(docs,FETCH_CONCURRENCY,async d=>{
            if(isKnown(d.id))return {known:true};
            try{return {payload:await this.readPayload(d)};}
            catch(e){if(e instanceof CorruptRecordError)return {invalid:e};throw e;}
          });
          let newest=null;
          for(let i=0;i<docs.length;i++){
            if(!active)return;
            const d=docs[i],r=payloads[i];
            if(r.invalid)onInvalid(d.id,r.invalid);
            else if(!r.known)await receive({...d.data(),id:d.id,payload:r.payload});
            const t=millis(d.data().createdAt);if(t!==null&&(newest===null||t>newest))newest=t;
          }
          if(!active)return;
          onSynced(newest,docs.length,snap.metadata.fromCache);
          if(!snap.metadata.fromCache)ready();
        }).catch(stop);
      },stop);
    };
    void start().catch(stop);
    return()=>{active=false;off();};
  }
  presence(session,data){return setDoc(doc(this.root,'presence',session),{...data,updatedAt:serverTimestamp()});}
  leave(session){return deleteDoc(doc(this.root,'presence',session));}
  /**
   * Only recent sessions: old presence documents (crashed tabs; closed tabs delete theirs) are not re-read on every
   * open. The window is wide because it uses this device's clock; the app applies exact limits with server time.
   */
  watchPresence(fn,error,{recentMs=12*60*60*1000}={}){
    const recent=query(collection(this.root,'presence'),where('updatedAt','>=',Timestamp.fromMillis(Date.now()-recentMs)));
    return onSnapshot(recent,s=>fn(s.docs.map(d=>({id:d.id,...d.data()}))),error);
  }
}
