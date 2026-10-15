import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Y from 'yjs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {EditorBinding} from '../src/editor-binding.js';
import {importParts,readHwpx,writeHwpx,snapshotParts,cloneDoc,nodePlainText} from '../src/document-model.js';
import {REMOTE} from '../src/sync-provider.js';
const template=new Uint8Array(fs.readFileSync(new URL('../template.hwpx',import.meta.url)));
function seeded(bytes=template){const doc=new Y.Doc({gc:false});importParts(doc,readHwpx(bytes));return doc;}
function firstRich(n){if(n.rich)return n;for(const c of n.children){const found=firstRich(c);if(found)return found;}}
const paragraph=doc=>firstRich(snapshotParts(doc)['Contents/section0.xml'].xml);
const text=doc=>nodePlainText(doc,paragraph(doc).key);
async function setup(t){
 const doc=seeded(),errors=[],calls={replace:0,exports:0};let native=seeded(),badBytes=null;
 const studio={
  open:async bytes=>{native.destroy();native=seeded(bytes);},
  exportHwpx:()=>{calls.exports++;return badBytes||writeHwpx(native);},
  replace:async bytes=>{calls.replace++;native.destroy();native=seeded(bytes);},
  subscribe:()=>()=>{},setUndo:()=>{},setBlocked:()=>{},composing:()=>false,position:()=>null,
 };
 const binding=new EditorBinding({doc,studio,onError:e=>errors.push(e)});await binding.start();
 const edit=value=>{const rich=native.getMap('nodes').get(paragraph(native).key).get('rich');rich.delete(0,rich.length);rich.insert(0,value);binding.dirty=true;binding.capture();};
 t.after(()=>{binding.dispose();native.destroy();doc.destroy();});
 return{doc,binding,calls,errors,edit,native:()=>native,setBad:bytes=>badBytes=bytes};
}
test('unchanged document is not reloaded before photo insertion; forced layout still reloads',async t=>{
 const {binding,calls}=await setup(t),exports=calls.exports;
 await binding.applyRemote();await binding.applyRemote();assert.equal(calls.replace,0);assert.equal(calls.exports,exports);
 await binding.applyRemote({force:true});assert.equal(calls.replace,1);
});
test('delete-only peer edit invalidates the cached archive although state vector is unchanged',async t=>{
 const {doc,binding,edit,native,calls,errors}=await setup(t);edit('ABC');
 const vector=Y.encodeStateVector(doc),peer=cloneDoc(doc);
 peer.getMap('nodes').get(paragraph(peer).key).get('rich').delete(1,1);
 Y.applyUpdate(doc,Y.encodeStateAsUpdate(peer),REMOTE);peer.destroy();
 assert.deepEqual(Y.encodeStateVector(doc),vector);
 await binding.applyRemote();assert.equal(calls.replace,1);assert.equal(text(native()),'AC');assert.equal(text(doc),'AC');assert.deepEqual(errors,[]);
});
test('staged captures survive remote changes and undo/redo without resurrecting removed text',async t=>{
 const {doc,binding,edit,native,errors}=await setup(t);
 edit('first');binding.undo.stopCapturing();edit('second');
 const peer=cloneDoc(doc);peer.getMap('nodes').get(paragraph(peer).key).get('rich').insert(6,' PEER');
 Y.applyUpdate(doc,Y.encodeStateAsUpdate(peer),REMOTE);peer.destroy();await binding.applyRemote();
 assert.equal(text(native()),'second PEER');
 await binding.history('undo');assert.equal(text(native()),'first PEER');
 await binding.history('redo');assert.equal(text(native()),'second PEER');
 binding.undo.stopCapturing();edit('third PEER');await binding.applyRemote({force:true});assert.equal(text(native()),'third PEER');
 await binding.history('undo');assert.equal(text(native()),'second PEER');assert.equal(text(doc),'second PEER');assert.deepEqual(errors,[]);
});
test('invalid capture never publishes a partial delta, even after reusing the staging document',async t=>{
 const {doc,binding,edit,native,errors,setBad}=await setup(t);edit('saved');
 const before=Y.snapshot(doc),files=unzipSync(writeHwpx(native()));
 files['Contents/section0.xml']=strToU8(strFromU8(files['Contents/section0.xml']).replace(/rowSpan="\d+"/,'rowSpan="999"'));
 setBad(zipSync(files));binding.dirty=true;binding.capture();
 assert.equal(binding.stopped,true);assert.equal(errors.length,1);assert.match(errors[0].message,/표|셀/);
 assert.ok(Y.equalSnapshots(Y.snapshot(doc),before),'no local delta escaped validation');assert.equal(text(doc),'saved');
});
