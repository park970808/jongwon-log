// The shared copy must keep each paragraph's line layout, or teammates see re-wrapped lines and shifted pages.
import test from 'node:test';import assert from 'node:assert/strict';import * as Y from 'yjs';import fs from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {readHwpx,importParts,writeHwpx,reconcileParts,snapshotParts} from '../src/document-model.js';

const original=new Uint8Array(fs.readFileSync(new URL('../template.hwpx',import.meta.url)));
const section=bytes=>strFromU8(unzipSync(bytes)['Contents/section0.xml']);
const segs=xml=>(xml.match(/<hp:lineseg /g)||[]).length;
const TEAM=/(<hp:t>팀 명<\/hp:t><\/hp:run>)(<hp:linesegarray>.*?<\/hp:linesegarray>)/;

test('line layout survives the shared document round trip',()=>{
  const doc=new Y.Doc({gc:false});importParts(doc,readHwpx(original));
  assert.ok(segs(section(original))>0);
  assert.equal(segs(section(writeHwpx(doc))),segs(section(original)));
});

test('an edited paragraph loses its stale layout; the others keep theirs',()=>{
  const doc=new Y.Doc({gc:false});importParts(doc,readHwpx(original));
  const baseline=snapshotParts(doc),xml=section(original),dropped=segs(xml.match(TEAM)[2]);
  // what the editor exports after an edit in that paragraph: the paragraph without its linesegarray
  const archive=unzipSync(original);archive['Contents/section0.xml']=strToU8(xml.replace(TEAM,'$1'));
  reconcileParts(doc,baseline,readHwpx(zipSync(archive)),'local');
  assert.equal(segs(section(writeHwpx(doc))),segs(xml)-dropped);
});
