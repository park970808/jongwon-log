// A continued table cell can expose the same inline picture twice: once in its
// text line and again through the native cell fallback. Match document identity,
// never image bytes alone: intentionally inserting the same photo twice is valid.
export function normalizeCellImageLayout(controls) {
  const seen=new Map(),unique=[],duplicates=[];
  for(const control of controls){
    if(control.type!=='image'||!control.cellPath?.length){unique.push(control);continue;}
    const path=control.cellPath.map(p=>[p.controlIndex??p.controlIdx,p.cellIndex??p.cellIdx,p.cellParaIndex??p.cellParaIdx]);
    const key=JSON.stringify([control.secIdx,control.paraIdx,control.controlIdx,path]);
    const first=seen.get(key);
    if(first)duplicates.push({keep:first,drop:control});
    else{seen.set(key,control);unique.push(control);}
  }
  return {controls:unique,duplicates};
}
const matches=(op,c)=>Math.abs(op.bbox.x-c.x)<.11&&Math.abs(op.bbox.y-c.y)<.11&&Math.abs(op.bbox.width-c.w)<.11&&Math.abs(op.bbox.height-c.h)<.11;
const source=op=>op.sourceImageKey??op.imageRef??op.base64;
export function removeDuplicateCellImagePaint(tree,duplicates){
  if(!duplicates.length)return tree;
  const images=[];
  function walk(node,cell=null,inLine=false){
    if(node.groupKind?.kind==='tableCell'){cell=node;inLine=false;}
    if(node.groupKind?.kind==='textLine')inLine=true;
    for(const op of node.ops||[])if(op.type==='image'&&cell)images.push({node,op,cell,inLine});
    for(const child of node.children||[])walk(child,cell,inLine);
    if(node.child)walk(node.child,cell,inLine);
  }
  walk(tree.root);const removed=new Set();
  for(const {keep,drop}of duplicates){
    const original=images.find(x=>x.inLine&&matches(x.op,keep)&&!removed.has(x.op));
    if(!original||source(original.op)===undefined)continue;
    const extra=images.find(x=>!x.inLine&&x.cell===original.cell&&source(x.op)===source(original.op)&&matches(x.op,drop)&&!removed.has(x.op));
    if(extra)removed.add(extra.op);
  }
  for(const {node}of images)node.ops=node.ops.filter(op=>!removed.has(op));
  return tree;
}
