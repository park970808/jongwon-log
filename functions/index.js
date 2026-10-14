import {initializeApp} from 'firebase-admin/app';
import {getFirestore,FieldValue} from 'firebase-admin/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {createHash} from 'node:crypto';
import * as Y from 'yjs';
import {deflateSync,inflateSync} from 'fflate';
initializeApp();
const db=getFirestore(),chunkSize=128*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function checkpointDocument(root) {
  // A single consistent query snapshot supplies a SERVER read-time fence.
  // Late/offline writes receive a newer serverTimestamp and remain in the tail query.
  const snapshot=await root.collection('updates').get();
  if(snapshot.size<100)return {skipped:true};
  const shared=new Y.Doc({gc:false});
  try{
    for(const record of snapshot.docs){
      const data=record.data();if(data.schema!==1||data.rawSize>96*1024*1024||data.rawSize<2||!Number.isInteger(data.chunks)||data.chunks>32||data.chunks<0)throw new Error('Invalid update envelope');
      let payload;
      if(data.chunks===0){ // small update stored inline in the record itself
        if(!Buffer.isBuffer(data.data)||!data.data.length||data.data.length>256*1024)throw new Error('Invalid inline update');
        payload=data.data;
      }else{
        const pieces=await record.ref.collection('chunks').get();
        const buffers=Array.from({length:data.chunks},(_,i)=>pieces.docs.find(c=>c.id===String(i))?.data().data);
        if(buffers.some(x=>!Buffer.isBuffer(x)||x.length>chunkSize))throw new Error('Incomplete update');
        payload=Buffer.concat(buffers);
      }
      const update=inflateSync(payload,{out:new Uint8Array(data.rawSize)});
      if(hash(update)!==data.hash||record.id!==data.hash)throw new Error('Invalid update hash');
      Y.applyUpdate(shared,update);
    }
    const state=Y.encodeStateAsUpdate(shared),payload=deflateSync(state);
    if(payload.length>4*1024*1024)throw new Error('Checkpoint exceeds inline capacity; retain logs and migrate checkpoint blobs to Storage before continuing.');
    const id=hash(state),ref=root.collection('checkpoints').doc(id),chunks=Math.ceil(payload.length/chunkSize);
    const batch=db.batch();
    batch.set(ref,{schema:1,hash:id,codec:'deflate',rawSize:state.length,chunks,createdAt:FieldValue.serverTimestamp(),coveredCount:snapshot.size,coveredUntil:snapshot.readTime}); // clients verify coveredUntil == pointer
    for(let i=0;i<chunks;i++)batch.set(ref.collection('chunks').doc(String(i)),{data:Buffer.from(payload.slice(i*chunkSize,(i+1)*chunkSize))});
    await batch.commit();
    await db.runTransaction(async tx=>{
      const current=await tx.get(root),cutoff=current.data()?.checkpointCutoff;
      if(cutoff && cutoff.toMillis()>=snapshot.readTime.toMillis())return; // forward only, like the client rules
      tx.update(root,{checkpointId:id,checkpointCutoff:snapshot.readTime});
    });
    // Deliberately retain append-only history. No TTL/delete: old offline clients and recovery remain safe.
    return {id,updates:snapshot.size};
  }finally{shared.destroy();}
}

export const checkpointDocuments=onSchedule({schedule:'every 24 hours',region:'asia-northeast3',timeoutSeconds:540,memory:'512MiB'},async()=>{
  const docs=await db.collectionGroup('documents').where('schema','==',1).get();
  for(const d of docs.docs)if(/^teams\/[^/]+\/documents\/[^/]+$/.test(d.ref.path)){
    try{await checkpointDocument(d.ref);}catch(error){console.error('Checkpoint left existing data untouched',d.ref.path,error);}
  }
});
