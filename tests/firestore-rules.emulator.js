import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,updateDoc,writeBatch,serverTimestamp,Bytes,Timestamp} from 'firebase/firestore';
import fs from 'node:fs';
const env=await initializeTestEnvironment({projectId:'demo-jongwon',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.collaboration.rules','utf8')}});
try{
 await env.clearFirestore();
 await env.withSecurityRulesDisabled(async context=>{
  const db=context.firestore();
  await setDoc(doc(db,'teams','test','collaborationMembers','alice'),{role:'editor'});
  await setDoc(doc(db,'teams','test','collaborationMembers','bob'),{role:'viewer'});
 });
 const a=env.authenticatedContext('alice').firestore(),b=env.authenticatedContext('bob').firestore(),outsider=env.authenticatedContext('mallory').firestore();
 const path=['teams','test','documents','week'];const hash='a'.repeat(64);
 const batch=writeBatch(a);
 batch.set(doc(a,...path),{title:'일지',week:'2026-W42',schema:1,createdBy:'alice',createdAt:serverTimestamp(),seedId:hash});
 batch.set(doc(a,...path,'updates',hash),{schema:1,hash,author:'alice',session:'test',codec:'deflate',rawSize:100,chunks:1,createdAt:serverTimestamp()});
 batch.set(doc(a,...path,'updates',hash,'chunks','0'),{data:Bytes.fromUint8Array(new Uint8Array([1,2,3]))});
 await assertSucceeds(batch.commit());
 await assertSucceeds(getDoc(doc(b,...path)));
 await assertFails(getDoc(doc(outsider,...path)));
 await assertFails(setDoc(doc(outsider,'teams','test','collaborationMembers','mallory'),{role:'editor'}));
 await assertFails(setDoc(doc(b,...path),{title:'수정'},{merge:true}));
 await assertFails(setDoc(doc(a,...path,'updates',hash),{author:'alice'},{merge:true}));
 await assertFails(setDoc(doc(a,...path,'updates',hash,'chunks','1'),{data:Bytes.fromUint8Array(new Uint8Array([9]))}));
 await assertSucceeds(setDoc(doc(a,...path,'presence','session-a'),{uid:'alice',name:'앨리스',anchor:'null',active:true,updatedAt:serverTimestamp()}));
 // Inline (single-document) update records — Spark quota format.
 const h=c=>c.repeat(64),bytes=n=>Bytes.fromUint8Array(new Uint8Array(n).fill(7));
 const inline=(id,extra={})=>({schema:1,hash:id,author:'alice',session:'test',codec:'deflate',rawSize:100,chunks:0,data:bytes(10),createdAt:serverTimestamp(),...extra});
 await assertSucceeds(setDoc(doc(a,...path,'updates',h('c')),inline(h('c'))));
 await assertFails(setDoc(doc(a,...path,'updates',h('d')),inline(h('d'),{chunks:1})),'inline data with chunks');
 const {data:_,...noData}=inline(h('e'));await assertFails(setDoc(doc(a,...path,'updates',h('e')),noData),'chunks 0 without data');
 await assertFails(setDoc(doc(a,...path,'updates',h('f')),inline(h('f'),{data:bytes(262145)})),'inline over 256 KiB');
 await assertFails(setDoc(doc(a,...path,'updates',h('c'),'chunks','0'),{data:bytes(3)}),'no chunks under an inline record');
 await assertFails(setDoc(doc(b,...path,'updates',h('1')),{...inline(h('1')),author:'bob'}),'viewer cannot write');
 // Client checkpoints: immutable copy + pointer that only moves forward to a matching checkpoint.
 const past=ms=>Timestamp.fromMillis(Date.now()-ms);
 const checkpoint=(id,coveredUntil,by='alice')=>{const batch=writeBatch(by==='alice'?a:b);
   batch.set(doc(by==='alice'?a:b,...path,'checkpoints',id),{schema:1,hash:id,codec:'deflate',rawSize:100,chunks:1,createdAt:serverTimestamp(),createdBy:by,coveredUntil});
   batch.set(doc(by==='alice'?a:b,...path,'checkpoints',id,'chunks','0'),{data:bytes(3)});return batch.commit();};
 const t1=past(600000),t2=past(300000);
 await assertSucceeds(checkpoint(h('2'),t1));
 await assertSucceeds(checkpoint(h('3'),t2));
 await assertFails(checkpoint(h('4'),Timestamp.fromMillis(Date.now()+600000)),'coverage in the future');
 await assertFails(checkpoint(h('5'),t1,'bob'),'viewer cannot checkpoint');
 await assertFails(setDoc(doc(a,...path,'checkpoints',h('2')),{chunks:2},{merge:true}),'checkpoints are immutable');
 await assertSucceeds(updateDoc(doc(a,...path),{checkpointId:h('2'),checkpointCutoff:t1}));
 await assertSucceeds(updateDoc(doc(a,...path),{checkpointId:h('3'),checkpointCutoff:t2}));
 await assertFails(updateDoc(doc(a,...path),{checkpointId:h('2'),checkpointCutoff:t1}),'pointer cannot move backward');
 await assertFails(updateDoc(doc(a,...path),{checkpointId:h('3'),checkpointCutoff:past(100000)}),'cutoff must equal the checkpoint coverage');
 await assertFails(updateDoc(doc(a,...path),{title:'변경'}),'only the pointer may change');
 await assertFails(updateDoc(doc(b,...path),{checkpointId:h('3'),checkpointCutoff:t2}),'viewer cannot move the pointer');
 console.log('PASS: membership, atomic seed, immutable updates/chunks, presence ownership, inline records, client checkpoints');
}finally{await env.cleanup();}
