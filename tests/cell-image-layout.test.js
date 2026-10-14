import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCellImageLayout,removeDuplicateCellImagePaint} from '../vendor/rhwp/src/core/cell-image-layout.js';
const control=(x,id=0,cell=24)=>({type:'image',secIdx:0,paraIdx:1,controlIdx:id,cellPath:[{controlIndex:0,cellIndex:cell,cellParaIndex:3}],x,y:58.6,w:158.9,h:474});
const paint=x=>({type:'image',base64:'same-photo',bbox:{x,y:58.6,width:158.9,height:474}});
function cell(a,b){return {groupKind:{kind:'tableCell'},children:[{groupKind:{kind:'textLine'},ops:[a]},{ops:[b]}]};}
for(const x of [183,390])test(`removes fallback paint, including coincident bounds (${x})`,()=>{
 const keep=paint(390),fallback=paint(x),tree={root:cell(keep,fallback)};
 const result=normalizeCellImageLayout([control(390),control(x)]);
 assert.equal(result.controls.length,1);removeDuplicateCellImagePaint(tree,result.duplicates);
 assert.deepEqual(tree.root.children[0].ops,[keep]);assert.deepEqual(tree.root.children[1].ops,[]);
});
test('intentionally repeated images have distinct model identities',()=>{
 const controls=[control(390),control(183,1),control(183,0,25)];
 assert.deepEqual(normalizeCellImageLayout(controls),{controls,duplicates:[]});
});
test('does not remove same source paint from another cell',()=>{
 const original=paint(390),other=paint(183),root={children:[{groupKind:{kind:'tableCell'},children:[{groupKind:{kind:'textLine'},ops:[original]}]},{groupKind:{kind:'tableCell'},ops:[other]}]};
 removeDuplicateCellImagePaint({root},normalizeCellImageLayout([control(390),control(183)]).duplicates);
 assert.deepEqual(root.children[1].ops,[other]);
});
