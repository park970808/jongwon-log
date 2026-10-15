// Browser-local preview only. Never presented as Firestore or cross-device collaboration.
// Records are kept in localStorage (about 5 MB per site): payloads are stored as base64, not as number arrays,
// so a few photos fit. Older demo rooms stored number arrays; both are read.
const toBase64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(s);};
const fromStored=p=>typeof p==='string'?Uint8Array.from(atob(p),c=>c.charCodeAt(0)):new Uint8Array(p);
export class DemoBackend {
  constructor(room){this.room=room;this.key=`jongwon-demo:${room}`;this.channel=new BroadcastChannel(this.key);}
  stored(){try{return JSON.parse(localStorage.getItem(this.key)||'[]');}catch{return [];}}
  async append(e){
    const records=this.stored();
    if(!records.some(x=>x.id===e.id)){
      records.push({...e,payload:toBase64(e.payload)});
      try{localStorage.setItem(this.key,JSON.stringify(records));}
      catch(error){throw Object.assign(new Error('기기 내 체험은 브라우저 저장 공간(약 5MB)까지만 담을 수 있습니다. 사진이 많은 문서는 공동 편집(Firestore)으로 열어 주세요.'),{code:'invalid-argument',cause:error});}
    }
    this.channel.postMessage({...e,payload:e.payload});
  }
  listen(receive,ready,error){
    this.channel.onmessage=e=>{if(e.data.kind!=='presence')Promise.resolve(receive({...e.data,payload:new Uint8Array(e.data.payload)})).catch(error);};
    queueMicrotask(async()=>{try{for(const e of this.stored())await receive({...e,payload:fromStored(e.payload)});ready();}catch(e){error(e);}});
    return()=>this.channel.close();
  }
}
