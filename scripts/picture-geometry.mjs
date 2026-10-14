import assert from 'node:assert/strict';
export async function assertPictureGeometry(page){
 const result=await page.evaluate(()=>{
  const h=document.querySelector('#studio').contentWindow.__inputHandler;if(!h)return null;
  const pictures=[],texts=[],controls=[];
  for(let pageIndex=0;pageIndex<h.wasm.pageCount;pageIndex++){
   controls.push(...h.wasm.getPageControlLayout(pageIndex).controls.filter(c=>c.type==='image'));
   function walk(n,cell){
    if(n.groupKind?.kind==='tableCell')cell=n.bounds;
    for(const op of n.ops||[]){
     if(op.type==='image')pictures.push({pageIndex,bbox:op.bbox,cell});
     if(op.type==='textRun'&&op.text?.trim())texts.push({pageIndex,bbox:op.bbox});
    }
    for(const c of n.children||[])walk(c,cell);if(n.child)walk(n.child,cell);
   }
   walk(h.wasm.getPageLayerTreeObject(pageIndex).root);
  }
  const c=controls[0];const properties=c? h.wasm.getCellProperties(c.secIdx,c.paraIdx,c.cellPath[0].controlIndex,c.cellPath[0].cellIndex):null;return{pictures,texts,controls,properties};
 });
 if(!result)return;
 assert.equal(result.controls.length,1,'one hit target across all pages');
 assert.equal(result.pictures.length,1,'one rendered picture across all pages');
 const {bbox:p,cell:c,pageIndex}=result.pictures[0];assert.ok(c);
 assert.ok(p.x>=c.x-.2&&p.x+p.width<=c.x+c.width+.2,'photo must fit horizontally inside cell');
 assert.ok(p.y>=c.y-.2&&p.y+p.height<=c.y+c.height+.2,'photo must fit vertically inside cell: '+JSON.stringify({picture:p,cell:c,pageIndex,properties:result.properties,texts:result.texts.filter(t=>t.pageIndex===pageIndex).slice(0,5)}));
 for(const t of result.texts.filter(t=>t.pageIndex===pageIndex)){
  const q=t.bbox,overlap=Math.min(p.x+p.width,q.x+q.width)-Math.max(p.x,q.x)>.2&&Math.min(p.y+p.height,q.y+q.height)-Math.max(p.y,q.y)>.2;
  assert.equal(overlap,false,'photo must not cover text');
 }
}
