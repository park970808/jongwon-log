import * as Y from 'yjs';
import {cloneDoc,deduplicateMovedParagraphs,snapshotParts,readHwpx,reconcileParts,writeHwpx} from './document-model.js';
import {LOCAL,REMOTE} from './sync-provider.js';
const is=(n,name)=>n.tag?.split(':').at(-1)===name;
const child=(n,name)=>n.children.filter(c=>is(c,name));
function owned(n,name){const out=[];for(const c of [...n.children,...(n.rich||[]).filter(x=>typeof x.insert!=='string').map(x=>x.insert.node)]){if(is(c,name))out.push(c);else if(!is(c,'p'))out.push(...owned(c,name));}return out;}
function paragraphs(parts){
 const found=[];
 const sections=Object.keys(parts).filter(n=>/^Contents\/section\d+\.xml$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 sections.forEach((name,sectionIndex)=>{
   child(parts[name].xml,'p').forEach((p,paragraphIndex)=>{
     found.push({node:p,position:{sectionIndex,paragraphIndex,charOffset:0}});
     function tables(n,parentParaIndex,path=[]){
       owned(n,'tbl').forEach((table,controlIndex)=>{
         const cells=child(table,'tr').flatMap(row=>child(row,'tc'));
         cells.forEach((cell,cellIndex)=>{
           const list=child(cell,'subList')[0];if(!list)return;
           child(list,'p').forEach((para,cellParaIndex)=>{
             const cellPath=[...path,{controlIndex,cellIndex,cellParaIndex}];
             found.push({node:para,position:{sectionIndex,paragraphIndex:cellParaIndex,parentParaIndex,controlIndex:cellPath[0].controlIndex,cellIndex:cellPath[0].cellIndex,cellParaIndex:cellPath[0].cellParaIndex,cellPath,charOffset:0}});
             tables(para,parentParaIndex,cellPath);
           });
         });
       });
     }
     tables(p,paragraphIndex);
   });
 });
 return found;
}
function matchPosition(a,b){
 if(a.sectionIndex!==b.sectionIndex)return false;
 if(a.cellIndex===undefined||b.cellIndex===undefined)return a.cellIndex===b.cellIndex&&a.paragraphIndex===b.paragraphIndex;
 return a.parentParaIndex===b.parentParaIndex && JSON.stringify(a.cellPath||[{controlIndex:a.controlIndex,cellIndex:a.cellIndex,cellParaIndex:a.cellParaIndex}])===JSON.stringify(b.cellPath||[{controlIndex:b.controlIndex,cellIndex:b.cellIndex,cellParaIndex:b.cellParaIndex}]);
}
function bindKeys(reference,native){
 if(reference.tag!==native.tag||reference.children.length!==native.children.length||!!reference.rich!==!!native.rich)throw new Error(`알한글 문서 구조 변환 감지: ${reference.tag}(${reference.children.length}) → ${native.tag}(${native.children.length}). 복구본을 보존합니다.`);
 native.key=reference.key;
 reference.children.forEach((c,i)=>bindKeys(c,native.children[i]));
 const oldObjects=(reference.rich||[]).filter(x=>typeof x.insert!=='string'),newObjects=(native.rich||[]).filter(x=>typeof x.insert!=='string');
 if(oldObjects.length!==newObjects.length)throw new Error('알한글 문서 개체 수가 변경되었습니다. 복구본을 보존합니다.');
 oldObjects.forEach((op,i)=>bindKeys(op.insert.node,newObjects[i].insert.node));
}

export class EditorBinding {
 constructor({doc,studio,onError=()=>{},onChange=()=>{}}){
   Object.assign(this,{doc,studio,onError,onChange});deduplicateMovedParagraphs(doc);this.mirror=cloneDoc(doc);this.baseline=snapshotParts(this.mirror);this.applying=false;this.stopped=false;this.dirty=false;
   const writer=new Y.Doc();this.writerId=writer.clientID;writer.destroy();
   // Keep an isolated staging document: cloning the complete photo/undo history on every edit is expensive.
   // Only validated deltas leave this document, so failed edits still cannot partially reach teammates.
   this.candidate=cloneDoc(this.mirror);this.projection=null;this.needsProjection=false;
   this.undo=new Y.UndoManager([doc.getMap('nodes'),doc.getMap('parts'),doc.getMap('blobs')],{trackedOrigins:new Set([LOCAL]),captureTimeout:500});
   this.mirror.on('update',(u,origin)=>{if(origin===LOCAL)Y.applyUpdate(this.doc,u,LOCAL);});
   this.liveUpdate=(_u,origin)=>{if(origin!==LOCAL)this.scheduleRemote();};
   doc.on('update',this.liveUpdate);
 }
 async start({alreadyOpen=false}={}){
   if(!alreadyOpen)await this.studio.open(writeHwpx(this.doc),'활동일지.hwpx');
   this.adoptNativeBaseline();
   this.off=this.studio.subscribe(()=>{if(this.applying||this.stopped)return;this.dirty=true;clearTimeout(this.captureTimer);this.captureTimer=setTimeout(()=>this.capture(),100);});
   this.studio.setUndo(()=>void this.history('undo'),()=>void this.history('redo'));
   // Photo edits that change a cell's height are redrawn from the shared document, exactly as teammates see it.
   // Redraw once the person pauses (not after every photo action): each redraw reloads the whole document.
   this.studio.setRefreshRequest?.(()=>{this.dirty=true;clearTimeout(this.refreshTimer);this.refreshTimer=setTimeout(()=>{this.refreshTimer=null;void this.refreshLayout();},350);});
   this.studio.setImageInsertionFactory?.(()=>{
     this.capture();const anchor=this.anchor();
     return async(...args)=>{
       const deadline=Date.now()+15000;
       while(this.applying||this.studio.composing()||this.studio.interacting?.()){if(Date.now()>deadline)throw new Error('문서 갱신 후 그림을 다시 선택해 주세요.');await new Promise(r=>setTimeout(r,20));}
       if(this.stopped)throw new Error('문서 편집이 중단되어 그림을 넣지 않았습니다.');
       await this.applyRemote();
       if(this.stopped)throw new Error('문서를 갱신하지 못해 그림을 넣지 않았습니다.');
       if(!anchor?.key||!paragraphs(snapshotParts(this.mirror)).some(p=>p.node.key===anchor.key))throw new Error('선택한 문단이 삭제되었습니다. 삽입 위치를 다시 선택해 주세요.');
       this.studio.insertImage(this.resolveAnchor(anchor,this.mirror),...args);
       this.capture();
     };
   });
 }
 adoptNativeBaseline(){
   const current=readHwpx(this.studio.exportHwpx()),reference=snapshotParts(this.mirror);
   for(const [name,part] of Object.entries(current))if(part.xml){if(!reference[name]?.xml)throw new Error('문서 구성 파일이 변경되었습니다.');bindKeys(reference[name].xml,part.xml);}
   this.baseline=current;
 }
 fail(error){this.stopped=true;this.studio.setBlocked(true);this.onError(error);}
 capture(){
   if(this.applying||this.stopped||this.studio.composing()||this.studio.interacting?.()||!this.dirty)return;
   try{
     const next=readHwpx(this.studio.exportHwpx());
     // Yjs transactions do not roll back exceptions. Stage + validate in an isolated clone,
     // then publish the complete delta; a failed table edit must never leak a partial update.
     const candidate=this.candidate;
     Y.applyUpdate(candidate,Y.encodeStateAsUpdate(this.mirror,Y.encodeStateVector(candidate)),REMOTE);
     candidate.clientID=this.writerId;
     const {normalized}=reconcileParts(candidate,this.baseline,next,LOCAL);
     const bytes=writeHwpx(candidate);
     Y.applyUpdate(this.mirror,Y.encodeStateAsUpdate(candidate,Y.encodeStateVector(this.mirror)),LOCAL);
     // The redraw can use this already validated archive until either contents OR deletions change.
     this.projection={bytes,snapshot:Y.snapshot(this.mirror)};
     if(normalized){this.needsProjection=true;this.scheduleRemote();}
     this.baseline=next;this.dirty=false;this.onChange();
   }catch(error){this.fail(error);}
 }
 anchor(){
   const position=this.studio.position();if(!position)return null;
   return this.anchorOf(position);
 }
 /** The fixed end of a dragged text selection, anchored like the caret so it survives a teammate's change. */
 selectionEnd(){const start=this.studio.selectionAnchor?.();return start?this.anchorOf(start):null;}
 anchorOf(position){
   const p=paragraphs(snapshotParts(this.mirror)).find(x=>matchPosition(x.position,position));
   if(!p)return {fallback:position};
   const text=this.mirror.getMap('nodes').get(p.node.key)?.get('rich');
   if(!text)return {key:p.node.key,offset:position.charOffset,fallback:position};
   return {key:p.node.key,relative:Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text,Math.min(position.charOffset,text.length)))),fallback:position};
 }
 resolveAnchor(anchor,doc=this.doc){
   if(!anchor)return null;
   const p=paragraphs(snapshotParts(doc)).find(x=>x.node.key===anchor.key);
   if(!p)return anchor.key ? {sectionIndex:0,paragraphIndex:0,charOffset:0}:anchor.fallback;
   let offset=anchor.offset||0;
   if(anchor.relative){const abs=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(new Uint8Array(anchor.relative)),doc);if(abs)offset=abs.index;}
   return {...p.position,charOffset:offset};
 }
 scheduleRemote(){
   if(this.remoteTimer||this.stopped)return;
   this.remoteTimer=setTimeout(()=>{this.remoteTimer=null;void this.applyRemote();},200);
 }
 async applyRemote({force=false}={}){
   if(force)this.needsProjection=true;
   if(this.stopped)return;
   if(this.applying||this.studio.composing()||this.studio.interacting?.()){this.scheduleRemote();return;}
   this.capture();if(this.stopped)return;
   this.applying=true;
   try{
     deduplicateMovedParagraphs(this.doc);
     // Equal state vectors alone miss deletion-only edits (including undo/cut).
     if(!this.needsProjection&&Y.equalSnapshots(Y.snapshot(this.doc),Y.snapshot(this.mirror)))return;
     const anchor=this.anchor(),end=this.selectionEnd();
     const update=Y.encodeStateAsUpdate(this.doc,Y.encodeStateVector(this.mirror));
     Y.applyUpdate(this.mirror,update,REMOTE);
     const bytes=this.projection&&Y.equalSnapshots(this.projection.snapshot,Y.snapshot(this.mirror))?this.projection.bytes:writeHwpx(this.mirror);
     const position=this.resolveAnchor(anchor,this.mirror);
     // A selection end whose paragraph a teammate deleted is dropped (never widened to the document start).
     const selection=end&&(!end.key||paragraphs(snapshotParts(this.mirror)).some(x=>x.node.key===end.key))?this.resolveAnchor(end,this.mirror):null;
     this.needsProjection=false;
     await this.studio.replace(bytes,position,selection);
     this.adoptNativeBaseline();this.projection=null;
   }catch(error){this.fail(error);}finally{this.applying=false;if(!this.stopped)this.studio.flushInput?.();}
 }
 /**
  * Redraw from the shared document after a photo edit, then grow any cell whose photo the full layout cuts off
  * (the in-place layout and a full layout can split a tall table row differently). At most a few rounds.
  */
 async refreshLayout(){
   if(this.refreshing){this.refreshAgain=true;return;}
   this.refreshing=true;
   try{
     for(let round=0;round<3&&!this.stopped;round++){
       const deadline=Date.now()+10000;
       while((this.applying||this.studio.composing()||this.studio.interacting?.())&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
       this.refreshAgain=false;
       await this.applyRemote({force:true});
       if(this.stopped||!this.studio.fitCellPhotos?.())break;
       // The height fix belongs to the photo edit just made: merge it into that undo step instead of a new one.
       this.undo.lastChange=Date.now();
       this.dirty=true;this.capture();
     }
   }finally{this.refreshing=false;if(this.refreshAgain&&!this.stopped){this.refreshAgain=false;void this.refreshLayout();}}
 }
 async history(action){
   if(this.stopped||this.applying||this.studio.composing()||this.studio.interacting?.())return;
   this.capture();this.undo.stopCapturing();this.undo[action]();await this.applyRemote();this.onChange();
 }
 dispose(){this.capture();clearTimeout(this.captureTimer);clearTimeout(this.refreshTimer);clearTimeout(this.remoteTimer);this.off?.();this.doc.off('update',this.liveUpdate);this.undo.destroy();this.candidate.destroy();this.mirror.destroy();this.projection=null;}
}
