import {collection,doc,getDoc,getDocs,onSnapshot,writeBatch,Bytes,serverTimestamp,setDoc,deleteDoc,runTransaction,query,where} from 'firebase/firestore';
const CHUNK=128*1024;
const validId=x=>/^[A-Za-z0-9_-]{1,100}$/.test(x);
export class FirestoreBackend {
  constructor(db,teamId,documentId){
    if(!validId(teamId)||!validId(documentId))throw new Error('문서 주소가 올바르지 않습니다.');
    this.db=db;this.root=doc(db,'teams',teamId,'documents',documentId);this.updates=collection(this.root,'updates');
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
  async append(e){
    const ref=doc(this.updates,e.id);
    // Existing immutable record makes retry idempotent, including ambiguous network outcomes.
    if((await getDoc(ref)).exists())return;
    const batch=writeBatch(this.db),chunks=Math.ceil(e.payload.length/CHUNK);
    batch.set(ref,{schema:e.schema,hash:e.hash,author:e.author,session:e.session,codec:e.codec,rawSize:e.rawSize,chunks,createdAt:serverTimestamp()});
    for(let i=0;i<chunks;i++)batch.set(doc(ref,'chunks',String(i)),{data:Bytes.fromUint8Array(e.payload.slice(i*CHUNK,(i+1)*CHUNK))});
    try{await batch.commit();}catch(error){if((await getDoc(ref)).exists())return;throw error;}
  }
  listen(receive,ready,error){
    let active=true,chain=Promise.resolve(),off=()=>{};const loaded=new Set();
    const readRecord=async(d)=>{
      const m=d.data();if(!Number.isInteger(m.chunks)||m.chunks<1||m.chunks>32)throw new Error('잘못된 변경 묶음입니다.');
      const chunks=await getDocs(collection(d.ref,'chunks'));
      const ordered=Array.from({length:m.chunks},(_,i)=>chunks.docs.find(c=>c.id===String(i))?.data().data?.toUint8Array());
      if(ordered.some(c=>!c||c.length>CHUNK))throw new Error('변경 데이터 일부를 읽지 못했습니다.');
      const payload=new Uint8Array(ordered.reduce((n,c)=>n+c.length,0));let at=0;for(const c of ordered){payload.set(c,at);at+=c.length;}
      if(active)await receive({...m,id:d.id,payload});
    };
    const start=async()=>{
      const meta=await this.metadata();
      let source=this.updates;
      if(meta?.checkpointId){
        const checkpoint=await getDoc(doc(this.root,'checkpoints',meta.checkpointId));
        if(!checkpoint.exists())throw new Error('저장된 체크포인트를 읽지 못했습니다.');
        await readRecord(checkpoint);
        // Inclusive boundary: equal server timestamps overlap safely (Yjs is idempotent).
        source=query(this.updates,where('createdAt','>=',meta.checkpointCutoff));
      }
      if(!active)return;
      off=onSnapshot(source,{includeMetadataChanges:true},snap=>{
      chain=chain.then(async()=>{
        for(const change of snap.docChanges({includeMetadataChanges:true})){
          const d=change.doc;if(change.type==='removed'||d.metadata.hasPendingWrites||loaded.has(d.id))continue;
          await readRecord(d);loaded.add(d.id);
        }
        if(active&&!snap.metadata.fromCache)ready();
      }).catch(e=>{if(active)error(e);});
      },error);
    };
    void start().catch(error);
    return()=>{active=false;off();};
  }
  presence(session,data){return setDoc(doc(this.root,'presence',session),{...data,updatedAt:serverTimestamp()});}
  leave(session){return deleteDoc(doc(this.root,'presence',session));}
  watchPresence(fn,error){return onSnapshot(collection(this.root,'presence'),s=>fn(s.docs.map(d=>({id:d.id,...d.data()}))),error);}
}
