import * as Y from 'yjs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import DiffMatchPatch from 'diff-match-patch';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const diff = new DiffMatchPatch();
const serializer = new XMLSerializer();
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_EXPANDED = 96 * 1024 * 1024;
const local = n => n.localName || n.nodeName.split(':').at(-1);
const elements = n => Array.from(n.childNodes || []).filter(x => x.nodeType === 1);
const hash = x => bytesToHex(sha256(typeof x === 'string' ? strToU8(x) : x));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function attributes(n) {
  return Object.fromEntries(Array.from(n.attributes || []).map(a => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b)));
}
function parseXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('외부 엔티티가 포함된 문서는 열 수 없습니다.');
  const errors = [];
  const doc = new DOMParser({ errorHandler: { warning: () => {}, error: e => errors.push(e), fatalError: e => errors.push(e) } }).parseFromString(text, 'application/xml');
  if (errors.length || !doc.documentElement || doc.getElementsByTagName('parsererror').length) throw new Error('문서 XML이 올바르지 않습니다.');
  return doc;
}
function plainRich(n) {
  return local(n) === 'p' && elements(n).filter(x=>local(x)!=='linesegarray').every(r=>local(r)==='run');
}
function toAst(n, depth = 0) {
  if (depth > 96) throw new Error('문서 중첩 한도를 넘었습니다.');
  if (n.nodeType === 3 || n.nodeType === 4) return { tag: '#text', text: n.data, attrs: {}, children: [] };
  const ast = { tag: n.nodeName, attrs: attributes(n), children: [] };
  // Layout caches are derived, never shared: two fonts/renderers must not fight over lineseg positions.
  if (plainRich(n)) {
    ast.rich = elements(n).filter(r => local(r) === 'run').flatMap(r => elements(r).flatMap(t => {
      if(local(t)==='t' && !elements(t).length) return t.textContent ? [{insert:t.textContent,attributes:attributes(r)}] : [];
      return [{insert:{node:toAst(t,depth+1)},attributes:attributes(r)}];
    }));
  } else {
    ast.children = Array.from(n.childNodes).filter(x => x.nodeType === 1 || ((x.nodeType === 3 || x.nodeType === 4) && (local(n) === 't' || x.data.trim())))
      .filter(x => !['linesegarray'].includes(local(x))).map(x => toAst(x, depth + 1));
  }
  return ast;
}

// Native style IDs are local array indices. Turn them into content keys before merging.
// At export, rebuild compact numeric IDs so the native parser never sees sparse/hash IDs.
const groups = [
  ['borderFill', ['borderFillIDRef']], ['tabPr', ['tabPrIDRef']],
  ['numbering', ['numberingIDRef']], ['bullet', ['bulletIDRef']],
  ['charPr', ['charPrIDRef']], ['paraPr', ['paraPrIDRef']], ['style', ['styleIDRef', 'nextStyleIDRef']],
];
function canonicalize(docs, files) {
  const header = docs.get('Contents/header.xml');
  if (header) {
    for (const [tag, refs] of groups) {
      const defs = Array.from(header.getElementsByTagName('*')).filter(n => local(n) === tag && n.hasAttribute('id'));
      const ids = new Map();
      for (const n of defs) {
        const copy = n.cloneNode(true); copy.removeAttribute('id');
        // style.nextStyleIDRef may refer to itself; keep stable across round trips.
        if (tag === 'style' && copy.getAttribute('nextStyleIDRef') === n.getAttribute('id')) copy.setAttribute('nextStyleIDRef', '@self');
        ids.set(n.getAttribute('id'), `@${tag}:${hash(serializer.serializeToString(copy)).slice(0,32)}`);
      }
      for (const doc of docs.values()) for (const n of Array.from(doc.getElementsByTagName('*'))) for (const ref of refs) {
        if (n.hasAttribute(ref) && ids.has(n.getAttribute(ref))) n.setAttribute(ref, ids.get(n.getAttribute(ref)));
      }
      const seen = new Set();
      for (const n of defs) {
        const key=ids.get(n.getAttribute('id'));
        n.setAttribute('id',key);
        if(seen.has(key))n.parentNode.removeChild(n);else seen.add(key);
      }
    }
  }
  // Different users may insert image1 simultaneously. Asset names and item IDs use content identity.
  const hpf = docs.get('Contents/content.hpf');
  if (hpf) for (const item of Array.from(hpf.getElementsByTagName('*')).filter(n => local(n) === 'item')) {
    const href = item.getAttribute('href'); const bytes = files[href];
    if (!bytes || !href.startsWith('BinData/')) continue;
    const ext = href.split('.').at(-1).replace(/[^a-z0-9]/gi, '');
    const name = `BinData/${hash(bytes)}.${ext}`;
    const oldId = item.getAttribute('id'), newId = `asset-${hash(bytes).slice(0,32)}`;
    for (const doc of docs.values()) for (const n of Array.from(doc.getElementsByTagName('*'))) {
      if (n.getAttribute('binaryItemIDRef') === oldId) n.setAttribute('binaryItemIDRef', newId);
    }
    item.setAttribute('href', name); item.setAttribute('id', newId);
    files[name] = bytes; if (href !== name) delete files[href];
  }
}

export function readHwpx(bytes) {
  if (bytes.length > MAX_ARCHIVE) throw new Error('문서 파일은 32MB 이하로 열어주세요.');
  let total = 0;
  const files = unzipSync(bytes, { filter: f => {
    total += f.originalSize;
    if (total > MAX_EXPANDED || f.originalSize > MAX_EXPANDED || f.name.includes('..') || f.name.startsWith('/')) throw new Error('압축 문서 크기 또는 경로가 허용 범위를 넘었습니다.');
    return !f.name.endsWith('/');
  } });
  if (!files['Contents/header.xml'] || !files['Contents/section0.xml']) throw new Error('유효한 HWPX 문서가 아닙니다.');
  const docs = new Map();
  for (const [name, data] of Object.entries(files)) if (/\.(xml|hpf|rdf)$/.test(name)) docs.set(name, parseXml(strFromU8(data)));
  canonicalize(docs, files);
  const parts = {};
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('Preview/') || name === 'settings.xml') continue;
    parts[name] = docs.has(name) ? { xml: toAst(docs.get(name).documentElement) } : { binary: data };
  }
  return parts;
}

function createNode(ast, registry) {
  if(ast.reuseKey && registry.has(ast.reuseKey)){const key=ast.reuseKey;reconcileNode(snapshotNode(key,registry),ast,registry);return key;}
  const id = crypto.randomUUID();
  const n = new Y.Map(); registry.set(id, n);
  n.set('tag', ast.tag); n.set('attrs', new Y.Map(Object.entries(ast.attrs)));
  n.set('children', new Y.Array());
  if (ast.rich) { const t = new Y.Text(); n.set('rich', t); t.applyDelta(ast.rich.map(op=>({...op,insert:typeof op.insert==='string'?op.insert:{node:createNode(op.insert.node,registry)}}))); }
  if (ast.tag === '#text') { const t = new Y.Text(); n.set('text', t); t.insert(0, ast.text); }
  n.get('children').push(ast.children.map(c => createNode(c, registry)));
  ast.key = id;
  return id;
}
function identity(ast) {
  const id = ast.attrs?.id;
  return id && id !== '0' && id !== '2147483648' ? `${ast.tag}:${id}` : null;
}
function signature(ast) {
  // HWPX's p.id is regenerated by native export; it is not a stable collaborative ID.
  if(ast.tag.endsWith(':p'))return ast.tag;
  if (identity(ast)) return identity(ast);
  if (ast.tag.endsWith(':tc')) {
    const address = ast.children.find(x => x.tag.endsWith(':cellAddr'));
    if (address) return `${ast.tag}:${address.attrs.colAddr}`;
  }
  return ast.tag;
}
const fingerprints=new WeakMap();
function fingerprint(ast) {
  if(fingerprints.has(ast))return fingerprints.get(ast);
  const attrs=Object.fromEntries(Object.entries(ast.attrs).filter(([k])=>!['id','rowAddr','colAddr','rowCnt','colCnt','itemCnt'].includes(k)));
  const value=hash(JSON.stringify([ast.tag,attrs,ast.text,ast.rich?.map(op=>[typeof op.insert==='string'?op.insert:fingerprint(op.insert.node),op.attributes]),ast.children.map(fingerprint)]));
  fingerprints.set(ast,value);return value;
}
function editText(ytext, before, after) {
  let at = 0;
  for (const [kind, text] of diff.diff_main(before, after)) {
    if (kind === 0) at += text.length;
    if (kind === -1) ytext.delete(at, text.length);
    if (kind === 1) { ytext.insert(at, text); at += text.length; }
  }
}
function marks(delta) { return delta.flatMap(x => Array.from({ length: typeof x.insert==='string'?x.insert.length:1 }, () => x.attributes || {})); }
function reconcileRich(text, before, after, registry) {
  const allStrings=[...before,...after].filter(x=>typeof x.insert==='string').map(x=>x.insert).join('');
  const tokens=new Map();let cp=0xe000;
  function encode(ops){return ops.map(op=>{
    if(typeof op.insert==='string')return op.insert;
    const node=op.insert.node,key=identity(node)||node.tag;
    if(!tokens.has(key)){while(allStrings.includes(String.fromCharCode(cp)))cp++;if(cp>0xf8ff)throw new Error('문단의 개체 수가 너무 많습니다.');tokens.set(key,String.fromCharCode(cp++));}
    return tokens.get(key);
  }).join('');}
  const oldText=encode(before),newText=encode(after);
  function units(ops){return ops.flatMap(op=>typeof op.insert==='string'?op.insert.split('').map(c=>({insert:c,attributes:op.attributes})): [op]);}
  const oldUnits=units(before),newUnits=units(after);let oldAt=0,newAt=0,pos=0;
  for(const [kind,value] of diff.diff_main(oldText,newText)){
    if(kind===0){for(let i=0;i<value.length;i++)if(typeof oldUnits[oldAt+i].insert!=='string')reconcileNode(oldUnits[oldAt+i].insert.node,newUnits[newAt+i].insert.node,registry);oldAt+=value.length;newAt+=value.length;pos+=value.length;}
    if(kind===-1){text.delete(pos,value.length);oldAt+=value.length;}
    if(kind===1){
      for(let i=0;i<value.length;i++){
        const op=newUnits[newAt+i];
        if(typeof op.insert==='string')text.insert(pos++,op.insert,op.attributes);
        else text.insertEmbed(pos++,{node:createNode(op.insert.node,registry)},op.attributes);
      }
      newAt+=value.length;
    }
  }
  const current = marks(text.toDelta()), next = marks(after);
  let i = 0;
  while (i < next.length) {
    const patch = {};
    for (const k of new Set([...Object.keys(current[i] || {}), ...Object.keys(next[i])])) if (current[i]?.[k] !== next[i][k]) patch[k] = next[i][k] ?? null;
    let end = i + 1; while (end < next.length && equal(next[end], next[i]) && equal(current[end], current[i])) end++;
    if (Object.keys(patch).length) text.format(i, end - i, patch);
    i = end;
  }
}
function reconcileNode(before, after, registry) {
  after.key = before.key;
  const n = registry.get(before.key), attrs = n.get('attrs');
  for (const k of new Set([...Object.keys(before.attrs), ...Object.keys(after.attrs)])) {
    if (before.attrs[k] !== after.attrs[k]) after.attrs[k] === undefined ? attrs.delete(k) : attrs.set(k, after.attrs[k]);
  }
  if (before.rich && after.rich) reconcileRich(n.get('rich'), before.rich, after.rich,registry);
  else if (!!before.rich !== !!after.rich) throw new Error('복합 개체가 포함된 문단으로 변경되었습니다. 복구본을 저장하고 새 문서로 가져와 주세요.');
  if (after.tag === '#text') editText(n.get('text'), before.text, after.text);
  const children = n.get('children');
  // Bounded lookahead preserves existing nodes across insertions without O(n²) XML diffing.
  let oi = 0, ni = 0, pos = 0;
  while (ni < after.children.length || oi < before.children.length) {
    const old = before.children[oi], next = after.children[ni];
    if (!next) { children.delete(pos, before.children.length - oi); break; }
    if(old && fingerprint(old)!==fingerprint(next)){
      const oldMatch=before.children.findIndex((x,i)=>i>oi&&i<oi+32&&fingerprint(x)===fingerprint(next));
      const newMatch=after.children.findIndex((x,i)=>i>ni&&i<ni+32&&fingerprint(x)===fingerprint(old));
      if(newMatch!==-1 && (oldMatch===-1 || newMatch-ni<=oldMatch-oi)){
        children.insert(pos,[createNode(next,registry)]);ni++;pos++;continue;
      }
      if(oldMatch!==-1){children.delete(pos,oldMatch-oi);oi=oldMatch;continue;}
    }
    if (old && next && signature(old) === signature(next)) { reconcileNode(old, next, registry); oi++; ni++; pos++; continue; }
    const found = before.children.findIndex((x, i) => i >= oi && signature(x) === signature(next));
    if (old && found >= oi && found < oi + 16) { children.delete(pos, found - oi); oi = found; continue; }
    children.insert(pos, [createNode(next, registry)]); ni++; pos++;
  }
}

export function importParts(doc, parts, origin = 'import') {
  doc.transact(() => {
    const roots = doc.getMap('parts'), nodes = doc.getMap('nodes'), blobs = doc.getMap('blobs');
    for (const [name, part] of Object.entries(parts)) {
      if (part.xml) roots.set(name, createNode(part.xml, nodes));
      else blobs.set(name, part.binary);
    }
    doc.getMap('meta').set('schemaVersion', 1);
  }, origin);
  return parts;
}
// Native merge drops empty donor paragraphs. Keep their shared identities so an
// offline peer's text in that formerly empty cell survives the merge.
function preserveMergedParagraphs(before,after) {
  const allTables=n=>{const result=[];function walk(x){if(x.tag==='hp:tbl')result.push(x);for(const c of [...x.children,...(x.rich||[]).filter(o=>typeof o.insert!=='string').map(o=>o.insert.node)])walk(c);}walk(n);return result;};
  const child=(n,tag)=>n.children.filter(x=>x.tag===tag);
  const cells=t=>child(t,'hp:tr').flatMap(r=>child(r,'hp:tc'));
  const bounds=c=>{const a=child(c,'hp:cellAddr')[0]?.attrs,s=child(c,'hp:cellSpan')[0]?.attrs;return a&&s?{r:+a.rowAddr,c:+a.colAddr,rs:+s.rowSpan,cs:+s.colSpan}:null;};
  let changed=false;
  const previous=new Map(allTables(before).map(t=>[identity(t),t]));
  for(const table of allTables(after)){
    const old=previous.get(identity(table));if(!old||child(old,'hp:tr').length!==child(table,'hp:tr').length)continue;
    for(const cell of cells(table)){
      const b=bounds(cell);if(!b)continue;
      const donors=cells(old).filter(c=>{const a=bounds(c);return a&&a.r>=b.r&&a.c>=b.c&&a.r+a.rs<=b.r+b.rs&&a.c+a.cs<=b.c+b.cs;});
      if(donors.length<2)continue;
      const list=child(cell,'hp:subList')[0];if(!list)continue;
      const paras=donors.flatMap(c=>child(c,'hp:subList').flatMap(l=>child(l,'hp:p')));
      const native=child(list,'hp:p');let at=0;
      const moved=paras.map(p=>{
        let target;
        if(native[at]&&fingerprint(p)===fingerprint(native[at]))target=native[at++];
        else if(p.rich?.length===0){target=structuredClone(p);changed=true;}
        else throw new Error('셀 병합 문단을 안전하게 대응할 수 없습니다. 병합 전 내용을 복구본으로 보존해 주세요.');
        target.reuseKey=p.key;return target;
      });
      if(at!==native.length)throw new Error('셀 병합 중 예상하지 못한 문단 변경을 발견했습니다.');
      list.children=moved;
    }
  }
  return changed;
}

export function reconcileParts(doc, before, after, origin) {
  let normalized=false;
  for(const [name,part] of Object.entries(after))if(part.xml&&before[name]?.xml)normalized=preserveMergedParagraphs(before[name].xml,part.xml)||normalized;
  // Validate representation changes before mutation (Yjs transactions are not rollback transactions).
  function check(a,b) {
    if (!!a.rich !== !!b.rich) throw new Error('이 개체 편집은 아직 공동 편집에서 지원하지 않습니다. 복구본을 내려받아 주세요.');
    for(let i=0;i<Math.min(a.children.length,b.children.length);i++) if(signature(a.children[i])===signature(b.children[i])) check(a.children[i],b.children[i]);
  }
  for (const [name, part] of Object.entries(after)) if (part.xml && before[name]?.xml) check(before[name].xml,part.xml);
  doc.transact(() => {
    const nodes = doc.getMap('nodes'), roots = doc.getMap('parts'), blobs = doc.getMap('blobs');
    for (const [name, part] of Object.entries(after)) {
      if (part.xml) {
        if (before[name]?.xml) reconcileNode(before[name].xml, part.xml, nodes);
        else roots.set(name, createNode(part.xml, nodes));
      } else if (!before[name]?.binary || hash(before[name].binary) !== hash(part.binary)) blobs.set(name, part.binary);
    }
    for (const name of Object.keys(before)) if (!after[name]) { roots.delete(name); blobs.delete(name); }
  }, origin);
  return {normalized};
}
// Concurrent identical cell merges can insert the same moved paragraph reference twice.
// Keep the first reference in CRDT order; both refer to the very same text object.
export function deduplicateMovedParagraphs(doc) {
  doc.transact(()=>{
    for(const node of doc.getMap('nodes').values()) {
      if(node.get('tag')!=='hp:subList')continue;
      const children=node.get('children'),seen=new Set(),duplicates=[];
      children.toArray().forEach((key,i)=>{if(seen.has(key))duplicates.push(i);else seen.add(key);});
      for(const i of duplicates.reverse())children.delete(i,1);
    }
  },'normalize-moved-paragraphs');
}
function snapshotNode(key, nodes, seen = new Set()) {
  if (seen.has(key) || seen.size > 96) throw new Error('문서 구조가 순환하거나 너무 깊습니다.');
  const n = nodes.get(key); if (!n) throw new Error('문서 구성 요소가 누락되었습니다.');
  const next = new Set(seen); next.add(key);
  const ast = { key, tag: n.get('tag'), attrs: n.get('attrs').toJSON(), children: n.get('children').toArray().map(id => snapshotNode(id,nodes,next)) };
  if (n.has('rich')) ast.rich = n.get('rich').toDelta().map(op=>({...op,insert:typeof op.insert==='string'?op.insert:{node:snapshotNode(op.insert.node,nodes,next)}}));
  if (n.has('text')) ast.text = n.get('text').toString();
  return ast;
}
export function snapshotParts(doc) {
  const parts = {};
  for (const [name,id] of doc.getMap('parts')) parts[name] = { xml: snapshotNode(id,doc.getMap('nodes')) };
  for (const [name,binary] of doc.getMap('blobs')) parts[name] = { binary };
  return parts;
}
const escape = v => String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\r/g,'&#13;');
function xmlNode(ast) {
  if (ast.tag === '#text') return escape(ast.text);
  if (!/^[A-Za-z_][\w.:-]*$/.test(ast.tag)) throw new Error('잘못된 XML 요소 이름');
  const attrs = Object.entries(ast.attrs).map(([k,v]) => {
    if (!/^[A-Za-z_][\w.:-]*$/.test(k)) throw new Error('잘못된 XML 속성 이름');
    return ` ${k}="${escape(v)}"`;
  }).join('');
  const body = ast.rich ? (ast.rich.length ? ast.rich : [{insert:'',attributes:{charPrIDRef:'0'}}]).map(op => `<hp:run${Object.entries(op.attributes || {}).map(([k,v])=>` ${k}="${escape(v)}"`).join('')}>${typeof op.insert==='string'?`<hp:t>${escape(op.insert)}</hp:t>`:xmlNode(op.insert.node)}</hp:run>`).join('') : ast.children.map(xmlNode).join('');
  return `<${ast.tag}${attrs}>${body}</${ast.tag}>`;
}
export function writeHwpx(doc) {
  const parts = snapshotParts(doc), files = {}, docs = new Map();
  for (const [name,part] of Object.entries(parts)) {
    if (part.xml) docs.set(name,parseXml(xmlNode(part.xml))); else files[name]=part.binary;
  }
  const header = docs.get('Contents/header.xml');
  if (!header) throw new Error('문서 머리 정보가 없습니다.');
  for (const [tag, refs] of groups) {
    const defs = Array.from(header.getElementsByTagName('*')).filter(n=>local(n)===tag && n.hasAttribute('id'));
    const ids = new Map(); const unique = [];
    for (const n of defs) {
      const key=n.getAttribute('id');
      if (ids.has(key)) n.parentNode.removeChild(n); else { ids.set(key,String(unique.length + (tag==='borderFill'?1:0))); unique.push(n); }
    }
    for (const doc of docs.values()) for (const n of Array.from(doc.getElementsByTagName('*'))) for (const ref of refs) if (ids.has(n.getAttribute(ref))) n.setAttribute(ref,ids.get(n.getAttribute(ref)));
    for (const n of unique) n.setAttribute('id',ids.get(n.getAttribute('id')));
  }
  for (const doc of docs.values()) for (const n of Array.from(doc.getElementsByTagName('*'))) {
    if (n.hasAttribute('itemCnt')) n.setAttribute('itemCnt',String(elements(n).length));
    if (local(n)==='tbl') {
      const rows=elements(n).filter(x=>local(x)==='tr');
      const occupied=new Set(); let columns=0;
      rows.forEach((row,r)=>elements(row).filter(x=>local(x)==='tc').forEach(cell=>{
        const a=elements(cell).find(x=>local(x)==='cellAddr'), s=elements(cell).find(x=>local(x)==='cellSpan');
        if(!a||!s)throw new Error('표 구조를 확인할 수 없습니다.');
        const c=Number(a.getAttribute('colAddr')), cs=Number(s.getAttribute('colSpan')), rs=Number(s.getAttribute('rowSpan'));
        if(!Number.isInteger(c)||c<0||!Number.isInteger(cs)||cs<1||!Number.isInteger(rs)||rs<1||r+rs>rows.length)throw new Error('표 구조 변경이 충돌했습니다. 복구본을 확인해 주세요.');
        a.setAttribute('rowAddr',String(r)); columns=Math.max(columns,c+cs);
        for(let y=r;y<r+rs;y++)for(let x=c;x<c+cs;x++){const k=`${y}:${x}`;if(occupied.has(k))throw new Error('표 셀 병합이 충돌했습니다. 복구본을 확인해 주세요.');occupied.add(k);}
      }));
      if(columns*rows.length!==occupied.size)throw new Error('표에 겹치거나 비어 있는 영역이 있습니다. 복구본을 확인해 주세요.');
      n.setAttribute('rowCnt',String(rows.length));n.setAttribute('colCnt',String(columns));
    }
  }
  for(const [name,doc] of docs) files[name]=strToU8('<?xml version="1.0" encoding="UTF-8"?>'+serializer.serializeToString(doc.documentElement));
  // mimetype must be the first, uncompressed ZIP entry.
  const ordered={mimetype:[files.mimetype || strToU8('application/hwp+zip'),{level:0}]};
  for(const [name,data] of Object.entries(files))if(name!=='mimetype')ordered[name]=data;
  return zipSync(ordered,{level:1});
}

export function cloneDoc(doc) { const copy=new Y.Doc({gc:false});Y.applyUpdate(copy,Y.encodeStateAsUpdate(doc),'clone');return copy; }
export function nodePlainText(doc,key) { const n=doc.getMap('nodes').get(key);if(!n)return '';return n.get('rich')?.toDelta().map(op=>typeof op.insert==='string'?op.insert:nodePlainText(doc,op.insert.node)).join('') ?? n.get('text')?.toString() ?? n.get('children').toArray().map(k=>nodePlainText(doc,k)).join(''); }
