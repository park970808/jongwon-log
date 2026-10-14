import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {FirestoreBackend} from '../src/firestore-backend.js';
import {encodeEnvelope,decodeEnvelope} from '../src/sync-provider.js';
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
process.env.GCLOUD_PROJECT='demo-jongwon';
const {checkpointDocument}=await import('../functions/index.js');
const requireFunctions=createRequire(new URL('../functions/package.json',import.meta.url));
const {getFirestore,FieldValue}=requireFunctions('firebase-admin/firestore');
const admin=getFirestore();
const env=await initializeTestEnvironment({projectId:'demo-jongwon',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.collaboration.rules','utf8')}});
const id='checkpoint-'+Date.now(),root=admin.doc(`teams/test/documents/${id}`),source=new Y.Doc();
let off;
try{
 await admin.doc('teams/test/collaborationMembers/checkpoint-user').set({role:'editor'});
 await root.set({schema:1,title:'checkpoint test'});
 async function append(text){
  const before=Y.encodeStateVector(source);source.getText('text').insert(source.getText('text').length,text);
  const e=encodeEnvelope(Y.encodeStateAsUpdate(source,before),'checkpoint-user','test');
  const ref=root.collection('updates').doc(e.id),batch=admin.batch();
  const {id:_,payload,...meta}=e;batch.set(ref,{...meta,chunks:1,createdAt:FieldValue.serverTimestamp()});
  batch.set(ref.collection('chunks').doc('0'),{data:Buffer.from(payload)});await batch.commit();
 }
 for(let i=0;i<100;i++)await append(String(i)+',');
 const result=await checkpointDocument(root);assert.equal(result.updates,100);
 await append('late-offline-write');
 const backend=new FirestoreBackend(env.authenticatedContext('checkpoint-user').firestore(),'test',id),fresh=new Y.Doc();let received=0;
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('checkpoint load timeout')),10000);off=backend.listen(e=>{received++;Y.applyUpdate(fresh,decodeEnvelope(e));},()=>{clearTimeout(timer);resolve();},reject);});
 assert.equal(fresh.getText('text').toString(),source.getText('text').toString());
 assert.equal(received,2,'fresh client should load one checkpoint plus one late update');
 assert.equal((await root.collection('updates').get()).size,101,'checkpoint must not delete history');
 console.log('PASS: checkpoint + late/offline tail reconstruct complete state; all 101 updates retained');
}finally{off?.();await env.cleanup();await admin.terminate();}
