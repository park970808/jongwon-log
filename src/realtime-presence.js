// 팀원 커서를 Firebase Realtime Database로 주고받습니다(문서 내용은 그대로 Firestore).
// Realtime Database는 횟수가 아니라 데이터 양으로 무료 한도를 세므로(월 10GB 다운로드, 동시 접속 100),
// 커서를 0.25초 간격으로 보내도 됩니다. 창을 닫거나 연결이 끊기면 서버가 커서를 지웁니다(onDisconnect).
// Realtime Database가 아직 없거나 규칙이 막으면 자동으로 예전 방식(Firestore, 느린 간격)으로 돌아갑니다.
import {getDatabase,ref,child,set,remove,onValue,onDisconnect,serverTimestamp} from 'firebase/database';

const FIRST_WRITE_MS=8000;

export class RealtimePresence {
  constructor(app,url,team,documentId){
    this.db=getDatabase(app,url);this.base=ref(this.db,`presence/${team}/${documentId}`);this.offset=0;this.armed=false;
    this.offOffset=onValue(ref(this.db,'.info/serverTimeOffset'),s=>{this.offset=Number(s.val())||0;});
  }
  serverNow(){return Date.now()+this.offset;}
  async presence(session,data){
    const r=child(this.base,session);
    if(!this.armed){await onDisconnect(r).remove();this.armed=true;}
    await set(r,{...data,t:serverTimestamp()});
  }
  leave(session){return remove(child(this.base,session));}
  watchPresence(fn,error){
    return onValue(this.base,snap=>{
      const list=[];snap.forEach(c=>{const v=c.val()||{};list.push({id:c.key,...v,updatedAt:{toMillis:()=>Number(v.t)||0}});});
      fn(list);
    },error);
  }
  close(){this.offOffset?.();}
}

/**
 * Realtime Database first; Firestore (the document backend's presence) when the database is missing, unreachable
 * or not allowed. `fast` tells the caller which sending policy applies.
 */
export class PresenceChannel {
  constructor(realtime,fallback,onFallback=()=>{}){
    Object.assign(this,{realtime,fallback,onFallback});
    this.fast=!!realtime;this.confirmed=false;this.watchers=new Set();
  }
  get active(){return this.fast?this.realtime:this.fallback;}
  serverNow(){return this.fast?this.realtime.serverNow():null;}
  switchToFallback(reason){
    if(!this.fast)return;
    console.warn('실시간 커서(Realtime Database)를 쓸 수 없어 Firestore로 전환합니다.',reason);
    this.fast=false;
    for(const w of this.watchers){w.off?.();w.off=this.fallback.watchPresence(w.fn,w.error);}
    this.realtime.close();this.onFallback(reason);
  }
  async presence(session,data){
    if(!this.fast)return this.fallback.presence(session,data);
    try{
      const write=this.realtime.presence(session,data);
      // A database that does not exist never answers: writes wait forever instead of failing.
      if(!this.confirmed)await Promise.race([write,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Realtime Database 응답 없음')),FIRST_WRITE_MS))]);
      else await write;
      this.confirmed=true;
    }catch(error){
      this.switchToFallback(error);
      return this.fallback.presence(session,data);
    }
  }
  leave(session){return this.active.leave(session);}
  watchPresence(fn,error){
    const w={fn,error};
    w.off=this.active.watchPresence(fn,e=>{if(this.fast)this.switchToFallback(e);else error(e);});
    this.watchers.add(w);
    return()=>{w.off?.();this.watchers.delete(w);};
  }
}
