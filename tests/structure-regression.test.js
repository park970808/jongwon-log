import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import * as Y from 'yjs';
import {importParts,deduplicateMovedParagraphs,snapshotParts,reconcileParts,cloneDoc,writeHwpx,nodePlainText} from '../src/document-model.js';
function fixture(name){const p=JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url)));for(const part of Object.values(p))if(part.binary)part.binary=new Uint8Array(part.binary);return p;}
function table(n){if(n.tag==='hp:tbl')return n;for(const c of [...n.children,...(n.rich||[]).filter(x=>typeof x.insert!=='string').map(x=>x.insert.node)]){const t=table(c);if(t)return t;}}
test('two native row insertions retain existing cell identities below the insertion',()=>{
 const base=new Y.Doc({gc:false});importParts(base,fixture('row-insert-before'));const a=cloneDoc(base),b=cloneDoc(base);
 for(const doc of[a,b])reconcileParts(doc,snapshotParts(doc),fixture('row-insert-after'),'local');
 Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));
 for(const doc of[a,b]){deduplicateMovedParagraphs(doc);assert.doesNotThrow(()=>writeHwpx(doc));const t=table(snapshotParts(doc)['Contents/section0.xml'].xml);assert.equal(t.children.filter(x=>x.tag==='hp:tr').length,12);}
});
test('merging an empty donor cell preserves concurrent text through its original paragraph identity',()=>{
 const base=new Y.Doc({gc:false});importParts(base,fixture('cell-merge-before'));const a=cloneDoc(base),b=cloneDoc(base);
 const beforeB=snapshotParts(b),afterB=structuredClone(beforeB),t=table(afterB['Contents/section0.xml'].xml),row=t.children.find(x=>x.tag==='hp:tr'),cell=row.children.filter(x=>x.tag==='hp:tc')[1],p=cell.children.find(x=>x.tag==='hp:subList').children[0];
 p.rich.push({insert:'동시 입력 보존'});reconcileParts(b,beforeB,afterB,'local');
 reconcileParts(a,snapshotParts(a),fixture('cell-merge-after'),'local');Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));
 for(const doc of[a,b]){deduplicateMovedParagraphs(doc);assert.doesNotThrow(()=>writeHwpx(doc));assert.match(nodePlainText(doc,doc.getMap('parts').get('Contents/section0.xml')),/동시 입력 보존/);}
});
test('two users merging the same cells do not duplicate moved paragraphs',()=>{
 const base=new Y.Doc({gc:false});importParts(base,fixture('cell-merge-before'));const a=cloneDoc(base),b=cloneDoc(base);
 for(const doc of[a,b])reconcileParts(doc,snapshotParts(doc),fixture('cell-merge-after'),'local');
 const expected=nodePlainText(a,a.getMap('parts').get('Contents/section0.xml'));
 const cellList=doc=>table(snapshotParts(doc)['Contents/section0.xml'].xml).children.find(x=>x.tag==='hp:tr').children.find(x=>x.tag==='hp:tc').children.find(x=>x.tag==='hp:subList').children;
 const count=cellList(a).length;
 Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));
 for(const doc of[a,b]){deduplicateMovedParagraphs(doc);assert.doesNotThrow(()=>writeHwpx(doc));assert.equal(nodePlainText(doc,doc.getMap('parts').get('Contents/section0.xml')),expected);assert.equal(cellList(doc).length,count);}
});
