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
// ── caret anchors: text context, to follow the caret's words across paragraph splits/joins ──
const CONTEXT=16;
// A paragraph's Yjs text holds plain runs as characters but a run with a line break (Shift+Enter), tab or object
// as ONE embedded item. The editor counts every character, line break and object, so map between the two.
const INLINE={'hp:lineBreak':'\n','hp:tab':'\t','hp:nbSpace':' ','hp:fwSpace':' ','hp:hyphen':'-'};
function nodeText(nodes,key,depth=0){
 const n=nodes.get(key);if(!n||depth>40)return '';
 const tag=n.get('tag');
 if(n.has('text'))return n.get('text').toString();
 if(tag==='hp:t')return n.get('children').toArray().map(k=>nodeText(nodes,k,depth+1)).join('');
 if(tag in INLINE)return INLINE[tag];
 return depth===0?'￼':''; // an object in the run (picture, table, field) counts as one character
}
/** Editor-visible text of a paragraph and, per Yjs item run, where it starts in Yjs and in the editor. */
function flatten(text){
 if(!text)return {plain:'',ops:[]};
 const nodes=text.doc?.getMap('nodes');let y=0,r=0,plain='';const ops=[];
 for(const op of text.toDelta()){
   const embed=typeof op.insert!=='string',t=embed?(nodes?nodeText(nodes,op.insert.node):'￼'):op.insert;
   ops.push({y,r,ylen:embed?1:op.insert.length,rlen:t.length,embed});plain+=t;y+=embed?1:op.insert.length;r+=t.length;
 }
 return {plain,ops};
}
function richText(text){return flatten(text).plain;}
/** Editor offset → [Yjs index, offset inside an embedded run]. */
function toYIndex(ops,offset){
 for(const o of ops){if(offset<o.r+o.rlen||o===ops.at(-1)){if(offset<=o.r)return [o.y,0];return o.embed?[o.y,Math.min(offset-o.r,o.rlen)]:[o.y+Math.min(offset-o.r,o.ylen),0];}}
 return [0,0];
}
/** Yjs index (+ offset inside the embedded run it starts) → editor offset. */
function toEditorOffset(ops,index,inner=0){
 for(const o of ops){if(index<o.y+o.ylen){return o.embed?o.r+Math.min(inner,o.rlen):o.r+(index-o.y);}}
 const last=ops.at(-1);return last?last.r+last.rlen:0;
}
function paraIndex(position){return position.cellPath?.length?position.cellPath.at(-1).cellParaIndex:position.paragraphIndex;}
function sameContainer(a,b){
 if(a.sectionIndex!==b.sectionIndex)return false;
 const pa=a.cellPath||[],pb=b.cellPath||[];
 if(pa.length!==pb.length)return false;
 if(!pa.length)return true;
 if(a.parentParaIndex!==b.parentParaIndex)return false;
 const key=path=>JSON.stringify(path.map((e,i)=>i===path.length-1?[e.controlIndex,e.cellIndex]:[e.controlIndex,e.cellIndex,e.cellParaIndex]));
 return key(pa)===key(pb);
}
/** How many context characters around offset in text match the anchor's (before: suffix, after: prefix). */
function contextScore(text,offset,anchor){
 if(anchor.before===undefined)return 0;
 const plain=typeof text==='string'?text:richText(text),b=anchor.before,a=anchor.after;
 let s=0;while(s<b.length&&offset-s-1>=0&&plain[offset-s-1]===b[b.length-s-1])s++;
 let t=0;while(t<a.length&&offset+t<plain.length&&plain[offset+t]===a[t])t++;
 return s+t;
}
function bestContextOffset(text,anchor){
 const plain=richText(text),b=anchor.before,a=anchor.after;
 if(!plain||(!b&&!a))return null;
 let best=null;
 const consider=offset=>{const score=contextScore(plain,offset,anchor);if(!best||score>best.score)best={offset,score};};
 // Candidate offsets: right after an occurrence of the last characters before the caret, or right before an
 // occurrence of the first characters after it.
 const tail=b.slice(-Math.min(4,b.length)),head=a.slice(0,Math.min(4,a.length));
 for(let i=tail?plain.indexOf(tail):-1;i>=0;i=plain.indexOf(tail,i+1))consider(i+tail.length);
 for(let i=head?plain.indexOf(head):-1;i>=0;i=plain.indexOf(head,i+1))consider(i);
 return best;
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
   const {plain,ops}=flatten(text),offset=Math.min(position.charOffset,plain.length),[index,inner]=toYIndex(ops,offset);
   // assoc -1: the caret sticks to the character before it, so a teammate typing at the very same spot does not
   // push it. The text around the caret lets it follow its words when a teammate splits or joins its paragraph,
   // and places it inside a run with line breaks (which Yjs holds as one item).
   return {key:p.node.key,relative:Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text,index,inner?0:-1))),inner,
     before:plain.slice(Math.max(0,offset-CONTEXT),offset),after:plain.slice(offset,offset+CONTEXT),fallback:position};
 }
 resolveAnchor(anchor,doc=this.doc){
   if(!anchor)return null;
   const list=paragraphs(snapshotParts(doc)),nodes=doc.getMap('nodes');
   const p=anchor.key?list.find(x=>x.node.key===anchor.key):null;
   let found=null;
   if(p){
     const text=nodes.get(p.node.key)?.get('rich'),{plain,ops}=flatten(text);
     let offset=anchor.offset||0;
     if(anchor.relative){const abs=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(new Uint8Array(anchor.relative)),doc);if(abs)offset=toEditorOffset(ops,abs.index,anchor.inner||0);}
     found={position:{...p.position,charOffset:offset},score:contextScore(plain,offset,anchor)};
   }
   // The caret's words may now be in a neighbouring paragraph of the same cell (Enter or Backspace by a teammate):
   // follow them there when they match better than where the caret's own paragraph left it.
   if(anchor.before!==undefined&&(!found||found.score<(anchor.before.length+anchor.after.length))){
     const home=p?.position??anchor.fallback,near=list.filter(x=>sameContainer(x.position,home)&&Math.abs(paraIndex(x.position)-paraIndex(home))<=6);
     for(const x of near){
       const best=bestContextOffset(nodes.get(x.node.key)?.get('rich'),anchor);
       if(best&&best.score>=2&&(!found||best.score>found.score))found={position:{...x.position,charOffset:best.offset},score:best.score};
     }
   }
   if(found)return found.position;
   if(!anchor.key)return anchor.fallback;
   // Its paragraph is gone and nothing matched: stay at the same place in the same cell, never the document start.
   const home=anchor.fallback,near=home?list.filter(x=>sameContainer(x.position,home)):[];
   if(near.length){const x=near.reduce((a,b)=>Math.abs(paraIndex(b.position)-paraIndex(home))<Math.abs(paraIndex(a.position)-paraIndex(home))?b:a);return {...x.position,charOffset:0};}
   return home??{sectionIndex:0,paragraphIndex:0,charOffset:0};
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
