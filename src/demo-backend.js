// Browser-local preview only. Never presented as Firestore or cross-device collaboration.
export class DemoBackend {
  constructor(room){this.room=room;this.key=`jongwon-demo:${room}`;this.channel=new BroadcastChannel(this.key);}
  stored(){try{return JSON.parse(localStorage.getItem(this.key)||'[]');}catch{return [];}}
  async append(e){
    const records=this.stored();if(!records.some(x=>x.id===e.id)){records.push({...e,payload:Array.from(e.payload)});localStorage.setItem(this.key,JSON.stringify(records));}
    this.channel.postMessage({...e,payload:e.payload});
  }
  listen(receive,ready,error){
    this.channel.onmessage=e=>{if(e.data.kind!=='presence')Promise.resolve(receive({...e.data,payload:new Uint8Array(e.data.payload)})).catch(error);};
    queueMicrotask(async()=>{try{for(const e of this.stored())await receive({...e,payload:new Uint8Array(e.payload)});ready();}catch(e){error(e);}});
    return()=>this.channel.close();
  }
}
