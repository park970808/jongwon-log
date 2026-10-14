import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,writeBatch,serverTimestamp,Bytes} from 'firebase/firestore';
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
 console.log('PASS: membership, atomic seed, immutable updates/chunks, presence ownership');
}finally{await env.cleanup();}
