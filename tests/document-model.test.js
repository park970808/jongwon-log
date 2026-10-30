import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Y from 'yjs';
import { readHwpx, writeHwpx, importParts, snapshotParts, reconcileParts, cloneDoc, nodePlainText } from '../src/document-model.js';
const input = new Uint8Array(fs.readFileSync(new URL('../template.hwpx',import.meta.url)));
function seeded() {const doc=new Y.Doc({gc:false});importParts(doc,readHwpx(input));return doc;}
function firstRich(parts) {function visit(n,cell=false){cell ||= n.tag==='hp:tc';if(cell&&n.rich)return n;for(const c of [...n.children,...(n.rich||[]).filter(x=>typeof x.insert!=='string').map(x=>x.insert.node)]){const v=visit(c,cell);if(v)return v;}}return visit(parts['Contents/section0.xml'].xml);}
test('activity-log HWPX round trip preserves text and table layout',()=>{
  const doc=seeded(); const parts=readHwpx(writeHwpx(doc));
  assert.ok(parts['Contents/section0.xml']);
  const text=nodePlainText(doc,doc.getMap('parts').get('Contents/section0.xml'));
  assert.match(text,/팀 명/);
  const again=new Y.Doc();importParts(again,parts);assert.equal(nodePlainText(again,again.getMap('parts').get('Contents/section0.xml')),text);
});
test('same-cell offline insertions merge in either order, including duplicate delivery',()=>{
  const base=seeded();const a=cloneDoc(base),b=cloneDoc(base);
  const beforeA=snapshotParts(a),beforeB=snapshotParts(b);
  const afterA=structuredClone(beforeA),afterB=structuredClone(beforeB);
  const pa=firstRich(afterA),pb=firstRich(afterB);const key=pa.key;
  pa.rich.push({insert:' A의 입력'});pb.rich.push({insert:' B의 입력'});
  reconcileParts(a,beforeA,afterA,'local');reconcileParts(b,beforeB,afterB,'local');
  const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);Y.applyUpdate(b,ua);
  assert.equal(nodePlainText(a,key),nodePlainText(b,key));
  assert.match(nodePlainText(a,key),/A의 입력/);assert.match(nodePlainText(a,key),/B의 입력/);
  assert.doesNotThrow(()=>writeHwpx(a));
});
test('selective undo keeps another user’s concurrent text',()=>{
 const base=seeded(),a=cloneDoc(base),b=cloneDoc(base);const origin={local:true};
 const undo=new Y.UndoManager(a.getMap('nodes'),{trackedOrigins:new Set([origin])});
 const before=snapshotParts(a),after=structuredClone(before),p=firstRich(after),key=p.key;p.rich.push({insert:'내수정'});reconcileParts(a,before,after,origin);
 const bb=snapshotParts(b),ba=structuredClone(bb);firstRich(ba).rich.push({insert:'동료수정'});reconcileParts(b,bb,ba,'peer');
 Y.applyUpdate(a,Y.encodeStateAsUpdate(b),'remote');undo.undo();
 assert.doesNotMatch(nodePlainText(a,key),/내수정/);assert.match(nodePlainText(a,key),/동료수정/);
});
test('invalid XML does not silently become a shared document',()=>{
 assert.throws(()=>readHwpx(new Uint8Array([1,2,3])));
});
test('pictures no part of the document refers to are dropped (deleted photos the editor still writes out)',async()=>{
  const {unzipSync,zipSync,strFromU8,strToU8}=await import('fflate');
  const files=unzipSync(input);
  const hpf=strFromU8(files['Contents/content.hpf']);
  files['Contents/content.hpf']=strToU8(hpf.replace(/(<opf:manifest[^>]*>)/,'$1<opf:item id="image9" href="BinData/image9.jpg" media-type="image/jpeg" isEmbeded="1"/><opf:item id="image10" href="BinData/image10.jpg" media-type="image/jpeg" isEmbeded="1"/>'));
  files['BinData/image9.jpg']=new Uint8Array([1,2,3]);files['BinData/image10.jpg']=new Uint8Array([4,5,6]);
  // image10 is used by a cell background (border/fill image), image9 by nothing
  files['Contents/header.xml']=strToU8(strFromU8(files['Contents/header.xml']).replace('</hh:refList>','<hh:note binaryItemIDRef="image10"/></hh:refList>'));
  const parts=readHwpx(zipSync(files));
  const bins=Object.keys(parts).filter(k=>k.startsWith('BinData/'));
  assert.equal(bins.length,1,'only the referenced picture stays: '+bins);
  assert.equal(JSON.stringify(parts['Contents/content.hpf'].xml).match(/BinData\//g)?.length,1);
});
