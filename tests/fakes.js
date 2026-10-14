// Shared deterministic fakes for the sync tests (not a test file itself).
import {CorruptRecordError,encodeEnvelope} from '../src/sync-provider.js';
import {chooseCheckpointCutoff} from '../src/checkpoint-policy.js';

export const settle=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};

/** Deterministic timers: advance() fires due callbacks in time order and lets promises settle between them. */
export function fakeClock(){
  let now=1_000_000,seq=0;const timers=new Map();
  return {now:()=>now,set:(fn,ms)=>{const id=++seq;timers.set(id,{at:now+ms,fn});return id;},clear:id=>timers.delete(id),
    pending:()=>timers.size,
    async advance(ms){
      const end=now+ms;
      for(;;){
        const due=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
        if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].fn();await settle();
      }
      now=end;await settle();
    }};
}

/** Firestore-shaped fake with server timestamps, `since` queries and checkpoints, mirroring FirestoreBackend. */
export function fakeServer(){
  let time=5_000_000;const log=[];const subs=new Set();
  const server={log,listens:0,fail:false,failListen:null,meta:{},checkpoints:new Map(),advance(ms){time+=ms;},now:()=>time,
    record(e){if(!log.some(r=>r.id===e.id))log.push({...e,createdAt:time+=1000});},
    async append(e){if(server.fail)throw Object.assign(new Error('offline'),{code:'unavailable'});const before=log.length;server.record(e);if(log.length>before)for(const s of subs)await s.deliver([log.at(-1)]);},
    async createCheckpoint({state,cutoff,author,minAdvanceMs=0,repair=false,maxCutoff=cutoff}){
      server.checkpointCalls=(server.checkpointCalls||0)+1;
      cutoff=chooseCheckpointCutoff({current:server.meta.checkpointCutoff??null,cutoff,minAdvanceMs,repair,maxCutoff});
      if(cutoff===null)return 'exists';
      const e=encodeEnvelope(state,author,'checkpoint');server.checkpoints.set(e.id,{...e,coveredUntil:cutoff});
      if((server.meta.checkpointCutoff??null)!==null&&server.meta.checkpointCutoff>=cutoff)return 'exists';
      server.meta={checkpointId:e.id,checkpointCutoff:cutoff};return 'created';
    },
    listen(receive,ready,error,options={}){
      server.listens++;
      let {since=null}=options;const {isKnown=()=>false,onInvalid=(id,e)=>{throw e;},onSynced=()=>{},ignoreCheckpoint=false}=options;
      const sub={delivered:0,async deliver(records){
        let newest=null,count=0;
        for(const r of records){
          if(since!==null&&r.createdAt<since)continue;
          sub.delivered++;count++;
          if(r.corrupt)onInvalid(r.id,new CorruptRecordError('missing chunk'));
          else if(!isKnown(r.id))await receive(r);
          newest=Math.max(newest??0,r.createdAt);
        }
        onSynced(newest,count,false);
      }};
      server.lastSub=sub;
      if(server.failListen){const e=server.failListen;server.failListen=null;queueMicrotask(()=>error(e));return()=>{};}
      subs.add(sub);
      queueMicrotask(async()=>{
        const cut=server.meta.checkpointCutoff??null;
        if(!ignoreCheckpoint&&server.meta.checkpointId&&!(since!==null&&since>=cut)){
          sub.delivered++;await receive({...server.checkpoints.get(server.meta.checkpointId),id:server.meta.checkpointId});
          onSynced(cut,0,false);since=cut;
        }
        await sub.deliver([...log]);ready();
      });
      return()=>subs.delete(sub);
    }};
  return server;
}
