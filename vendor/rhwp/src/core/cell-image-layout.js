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

// A split table row can have less space on its continuation page than its stored
// cell height suggests. Measure content in the actual cell fragment, not the row.
export function measureCellPictureOverflow(tree){
  const cells=[];
  function walk(node,cell=null){
    if(node.groupKind?.kind==='tableCell'){cell={bounds:node.bounds,ops:[]};cells.push(cell);}
    for(const op of node.ops||[])if(cell&&(op.type==='image'||(op.type==='textRun'&&op.text?.trim())))cell.ops.push(op);
    for(const child of node.children||[])walk(child,cell);
    if(node.child)walk(node.child,cell);
  }
  walk(tree.root);
  for(const cell of cells)cell.bottom=Math.max(...cell.ops.map(op=>op.bbox.y+op.bbox.height));
  // pageBottom: where the page body ends. A cell that reaches it continues on the next page; a photo cut there
  // is cut by the page split, which a taller cell cannot fix (growing it then only added blank pages, endlessly).
  return (control,padding=4,pageBottom=Infinity)=>{
    const cell=cells.find(c=>c.ops.some(op=>op.type==='image'&&matches(op,control)));
    if(!cell||cell.bounds.y+cell.bounds.height>=pageBottom-2)return 0;
    return Math.max(0,cell.bottom+padding-cell.bounds.y-cell.bounds.height);
  };
}
export function cellPictureOverflow(tree,control,padding=4,pageBottom=Infinity){
  return measureCellPictureOverflow(tree)(control,padding,pageBottom);
}
