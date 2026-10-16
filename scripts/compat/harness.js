// Compatibility harness: runs one HWP/HWPX file through the same path the collaborative editor uses.
import * as Y from 'yjs';
import {readHwpx,importParts,writeHwpx} from '/src/document-model.js';
import {EditorBinding} from '/src/editor-binding.js';

const frame=document.getElementById('studio');
const studio=async()=>{for(let i=0;i<300;i++){const s=frame.contentWindow?.jongwonStudio;if(s){await s.ready();return s;}await new Promise(r=>setTimeout(r,100));}throw new Error('studio not ready');};
const handler=()=>frame.contentWindow.__inputHandler;
const bridge=()=>handler().wasm;

function sectionsOf(bytes){
  // plain text + element histogram per section, ignoring derived layout caches
  const files=readHwpx(bytes);const out={text:'',tags:{}};
  for(const name of Object.keys(files).filter(n=>/^Contents\/section\d+\.xml$/.test(n)).sort()){
    const walk=n=>{if(!n||n.tag==='#text')return;const t=n.tag.replace(/^.*:/,'');if(t!=='linesegarray'&&t!=='lineseg')out.tags[t]=(out.tags[t]||0)+1;
      if(n.rich)for(const op of n.rich){if(typeof op.insert==='string'){out.text+=op.insert;out.tags.t=(out.tags.t||0)+1;out.tags.run=(out.tags.run||0)+1;}else{out.tags.run=(out.tags.run||0)+1;walk(op.insert.node);}}
      if(t==='t'&&!n.rich)out.text+=textOf(n);
      for(const c of n.children||[])walk(c);};
    const textOf=n=>n.tag==='#text'?n.text:(n.children||[]).map(textOf).join('');
    walk(files[name].xml);
  }
  return out;
}
function diffTags(a,b){const d={};for(const k of new Set([...Object.keys(a),...Object.keys(b)]))if((a[k]||0)!==(b[k]||0))d[k]=[a[k]||0,b[k]||0];return d;}
function layout(){
  // visual lines (text joined per page and baseline), compared as a multiset: same lines = same line breaking
  const w=bridge(),doc=w.doc;const pages=w.pageCount;const lines=[];
  for(let p=0;p<Math.min(pages,60);p++){let j;try{j=JSON.parse(doc.getPageTextLayout(p));}catch{continue;}
    const by=new Map();for(const r of j.runs||[]){if(r.paraIdx===4294967295)continue;const k=Math.round(r.y);by.set(k,(by.get(k)||'')+r.text);}
    for(const t of by.values())if(t.trim())lines.push(t);}
  return {pages,lines};
}
function sameLines(a,b){const m=new Map();for(const l of b)m.set(l,(m.get(l)||0)+1);let n=0;for(const l of a){const c=m.get(l);if(c){n++;m.set(l,c-1);}}return n;}
async function openBytes(s,bytes,name){const t=performance.now();await s.open(bytes,name);return {ms:Math.round(performance.now()-t),pages:bridge().pageCount};}

window.compat={
  async run(bytes,name){
    bytes=new Uint8Array(bytes);const r={name,stage:'open'};const s=await studio();s.setBlocked(false);
    try{
      // 1. open the original (what a user imports)
      const o=await openBytes(s,bytes,name);r.openMs=o.ms;r.pages=o.pages;
      if(!(o.pages>0))throw new Error('no pages after open');
      const L0=layout();
      // 2. engine export to HWPX (also the .hwp → .hwpx conversion)
      r.stage='export';const first=s.exportHwpx();await openBytes(s,first,name);const native=s.exportHwpx(); // app: open its own copy once more
      // 3. shared model round trip
      r.stage='model';const base=sectionsOf(native);
      const doc=new Y.Doc({gc:false});importParts(doc,readHwpx(native));const projected=writeHwpx(doc);
      const proj=sectionsOf(projected);
      r.textLoss=base.text===proj.text?0:Math.max(1,Math.abs(base.text.length-proj.text.length));r.textChars=base.text.length;
      r.tagDiff=diffTags(base.tags,proj.tags);
      // 4. what teammates see: reopen the shared document
      r.stage='reopen';await openBytes(s,native,name);const LN=layout();r.pagesNative=LN.pages;
      await openBytes(s,projected,name);const L1=layout();
      r.pagesShared=L1.pages;r.layoutLines=L0.lines.length;r.layoutNative=sameLines(L0.lines,LN.lines);r.layoutShared=sameLines(L0.lines,L1.lines);
      // 5. collaborative editing: binding on the shared document, typing at a few text positions
      r.stage='edit';const errors=[];const binding=new EditorBinding({doc,studio:s,onError:e=>errors.push(String(e?.message||e))});
      await binding.start();window.__binding=binding;window.__errors=errors;
      r.stage='ready';
      return r;
    }catch(e){r.error=String(e?.message||e).slice(0,300);return r;}
  },
  // text positions to type at: start of a few laid-out text lines spread over the document
  targets(){const h=handler(),w=h.wasm,doc=w.doc;const out=[];const pages=w.pageCount;
    for(const p of [...new Set([0,Math.floor(pages/2),pages-1])]){let j;try{j=JSON.parse(doc.getPageTextLayout(p));}catch{continue;}
      const runs=(j.runs||j.lines||j.items||[]).filter(r=>(r.text||'').trim());if(!runs.length)continue;const r=runs[Math.floor(runs.length/2)];
      try{const hit=w.hitTest(p,(r.x??0)+1,(r.y??0)+(r.h??r.height??8)/2);if(hit&&hit.paragraphIndex!==undefined)out.push(hit);}catch{}}
    return out;},
  async finishEdit(marker){
    await new Promise(r=>setTimeout(r,700));const b=window.__binding;b.capture();
    const text=sectionsOf(writeHwpx(b.doc)).text;const n=(text.match(new RegExp(marker,'g'))||[]).length;
    const errors=window.__errors.slice();try{b.dispose();}catch{}frame.contentWindow.jongwonStudio.setBlocked(false);return {found:n,errors};
  },
};
window.compatReady=true;
