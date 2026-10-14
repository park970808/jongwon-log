import fs from 'node:fs';import {initializeTestEnvironment,assertFails,assertSucceeds}from'@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,serverTimestamp}from'firebase/firestore';
const env=await initializeTestEnvironment({projectId:'demo-jongwon',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.production.rules','utf8')}});
const hash='b'.repeat(64);
try{
 await env.clearFirestore();await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'teams','team-3','collaborationInvites',hash),{enabled:true}));
 const a=env.authenticatedContext('alice').firestore(),outsider=env.authenticatedContext('outsider').firestore(),anon=env.unauthenticatedContext().firestore();
 for(const path of [['teams','team-3'],['teams','team-3','weeks','2026-W42'],['teams','team-3','roster','m1'],['teams','team-3','presence','alice']])await assertSucceeds(setDoc(doc(a,...path),{test:true}));
 await assertFails(getDoc(doc(anon,'teams','team-3','weeks','2026-W42')));
 await assertFails(getDoc(doc(outsider,'teams','team-3','documents','private')));
 await assertFails(getDoc(doc(outsider,'teams','team-3','collaborationInvites',hash)));
 await assertFails(setDoc(doc(outsider,'teams','team-3','collaborationMembers','outsider'),{role:'editor',inviteHash:'c'.repeat(64),joinedAt:serverTimestamp()}));
 await assertSucceeds(setDoc(doc(a,'teams','team-3','collaborationMembers','alice'),{role:'editor',inviteHash:hash,joinedAt:serverTimestamp()}));
 await assertSucceeds(getDoc(doc(a,'teams','team-3','documents','private')));
 await assertFails(setDoc(doc(a,'teams','team-3','collaborationMembers','another'),{role:'editor',inviteHash:hash,joinedAt:serverTimestamp()}));
 console.log('PASS production rules: legacy paths retained; no invite listing; valid invite self-join only; outsider denied');
}finally{await env.cleanup();}
