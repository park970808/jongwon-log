// 공동 활동일지: 표 칸 안에 표 만들기·붙여넣기 (한글처럼 몇 단계든).
//
// 편집기 기본 기능은 표 안에서 "표 만들기"를 막고, 바깥에서 복사한 표(한글·엑셀·웹의 HTML 표)를 칸에 붙이면
// 표를 버리고 글자만 넣습니다. 팀원 변경이 반영되면(문서를 다시 읽음) 편집기 안 클립보드도 비어서, 이 편집기에서
// 복사한 표도 같은 길로 빠집니다.
// 엔진은 "본문 문단에 글자처럼 취급하는 표"를 만들 수 있고, 그 표를 어느 깊이의 칸에든 붙일 수 있습니다.
// 그래서 바깥 표가 있는 본문 문단 끝에 표를 잠시 만들어 열 너비·줄 높이·내용(글자 서식 포함)·테두리·배경·병합까지
// 채운 뒤, 복사해서 칸에 붙이고 임시 표는 지웁니다. 모두 한 번의 되돌리기 단위(snapshot) 안에서 일어납니다.
// 이 편집기에서 복사한 표가 칸에 들어가는 크기면 엔진 클립보드 그대로 붙여 모든 서식을 유지합니다.
import type { WasmBridge } from '@/core/wasm-bridge';
import type { BorderLineInfo } from '@/core/types';

type CellEntry = { controlIndex: number; cellIndex: number; cellParaIndex: number };
type Borders = Partial<Record<'borderLeft' | 'borderRight' | 'borderTop' | 'borderBottom', BorderLineInfo>>;
export type CellSpec = { r: number; c: number; rs: number; cs: number; text: string; html?: string; fill?: string; borders?: Borders };
export type TableSpec = { rows: number; cols: number; colWidths?: number[]; rowHeights?: number[]; cells?: CellSpec[] };

const MAX_ROWS = 200, MAX_COLS = 30;
const HU_PER = { px: 75, pt: 100, mm: 283.465, cm: 2834.65, in: 7200 } as Record<string, number>;
/** Border widths the editor knows, in mm (index = BorderLineInfo.width). */
const BORDER_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4];

const parse = (result: any, message: string) => {
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  if (!parsed?.ok) throw new Error(message);
  return parsed;
};
const hex = (color: string): string | undefined => {
  const value = (color || '').trim();
  const m = value.match(/^#([0-9a-f]{6})$/i) || value.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return m.length === 2 ? `#${m[1].toLowerCase()}` : `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  const rgb = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/i);
  if (rgb && (rgb[4] === undefined || +rgb[4] > 0)) return '#' + rgb.slice(1, 4).map(v => (+v).toString(16).padStart(2, '0')).join('');
  const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', gray: '#808080', grey: '#808080' };
  return named[value.toLowerCase()];
};
/** A CSS/HTML length in HWPUNIT (bare numbers are pixels, as in width="113"). */
const toHu = (value: string | null | undefined): number | undefined => {
  const m = (value || '').trim().match(/^([\d.]+)\s*(px|pt|mm|cm|in)?$/i);
  return m ? Math.round(parseFloat(m[1]) * HU_PER[(m[2] || 'px').toLowerCase()]) : undefined;
};
const border = (style: string, width: string, color: string): BorderLineInfo | undefined => {
  const s = (style || '').toLowerCase();
  if (!s) return undefined;
  if (s === 'none' || s === 'hidden') return { type: 0, width: 0, color: '#000000' };
  const mm = (toHu(width) ?? 34) / HU_PER.mm;
  let index = 0;
  BORDER_MM.forEach((v, i) => { if (Math.abs(v - mm) < Math.abs(BORDER_MM[index] - mm)) index = i; });
  return { type: s === 'dashed' ? 2 : s === 'dotted' ? 3 : 1, width: index, color: hex(color) ?? '#000000' };
};
const entryOf = (e: any): CellEntry | null => {
  const entry = { controlIndex: e?.controlIndex ?? e?.controlIdx, cellIndex: e?.cellIndex ?? e?.cellIdx, cellParaIndex: e?.cellParaIndex ?? e?.cellParaIdx };
  return [entry.controlIndex, entry.cellIndex, entry.cellParaIndex].every(Number.isInteger) ? entry : null;
};
/** The full path to the caret's cell (any depth), with the caret's own paragraph in the last entry. */
const pathOf = (pos: any): CellEntry[] | null => {
  const raw = pos?.cellPath?.length ? pos.cellPath : [pos];
  const path = raw.map(entryOf);
  if (!path.length || path.some((e: CellEntry | null) => !e)) return null;
  // (for a nested cell the top-level cellParaIndex is the outer cell's paragraph; the path is authoritative)
  if (!pos?.cellPath?.length && Number.isInteger(pos.cellParaIndex)) path[0].cellParaIndex = pos.cellParaIndex;
  return path as CellEntry[];
};

/** A caret inside a body table cell at any depth (not header/footer, footnote or text box). */
export function canBuildTableInCell(handler: any, pos: any): boolean {
  if (pos?.parentParaIndex === undefined) return false;
  if (handler?.cursor?.isInHeaderFooter?.() || handler?.cursor?.isInFootnote?.() || handler?.cursor?.isInTextBox?.()) return false;
  return !!pathOf(pos);
}

/** Width available for a table inside the caret's cell, in HWPUNIT. */
export function cellInnerWidth(wasm: WasmBridge, pos: any): number {
  const path = pathOf(pos)!, sec = pos.sectionIndex, outer = pos.parentParaIndex, last = path[path.length - 1];
  if (path.length === 1) {
    const cell = wasm.getCellProperties(sec, outer, last.controlIndex, last.cellIndex);
    return cell.width - cell.paddingLeft - cell.paddingRight - 300;
  }
  const boxes = JSON.parse((wasm as any).doc.getTableCellBboxesByPath(sec, outer, JSON.stringify(path)));
  const box = boxes.find((b: any) => b.cellIdx === last.cellIndex);
  return Math.round((box?.w ?? 200) * 75) - 1020 - 300;
}

/** Read the first HTML table: grid with merged cells, column widths, row heights, contents with their formatting,
 *  borders and background colours. */
export function tableSpecFromHtml(html: string, doc: Document = document): TableSpec | null {
  if (!/<table[\s>]/i.test(html)) return null;
  const view = doc.defaultView ?? window;
  const table = new view.DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll('tr')).filter(tr => tr.closest('table') === table).slice(0, MAX_ROWS);
  if (!rows.length) return null;
  const framed = (table.getAttribute('border') ?? '0') !== '0';
  const taken: boolean[][] = [], cells: CellSpec[] = [], widths: (number | undefined)[] = [], heights: (number | undefined)[] = [];
  let cols = 0;
  Array.from(table.querySelectorAll('col')).forEach((col, i) => { widths[i] = toHu(col.getAttribute('width') || (col as HTMLElement).style.width); });
  rows.forEach((tr, r) => {
    let c = 0;
    heights[r] = toHu(tr.getAttribute('height') || tr.style.height);
    for (const td of Array.from(tr.children).filter(x => /^(TD|TH)$/.test(x.tagName)) as HTMLTableCellElement[]) {
      while (taken[r]?.[c]) c++;
      const rs = Math.max(1, Math.min(td.rowSpan || 1, rows.length - r)), cs = Math.max(1, td.colSpan || 1);
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) (taken[r + i] ??= [])[c + j] = true;
      const w = toHu(td.getAttribute('width') || td.style.width);
      if (cs === 1 && w && widths[c] === undefined) widths[c] = w;
      const h = toHu(td.getAttribute('height') || td.style.height);
      if (rs === 1 && h) heights[r] = Math.max(heights[r] ?? 0, h);
      const st = td.style;
      const borders: Borders = {};
      for (const [key, side] of [['borderLeft', 'Left'], ['borderRight', 'Right'], ['borderTop', 'Top'], ['borderBottom', 'Bottom']] as const) {
        const b = border((st as any)[`border${side}Style`], (st as any)[`border${side}Width`], (st as any)[`border${side}Color`]) ?? (framed ? { type: 1, width: 1, color: '#000000' } : undefined);
        if (b) borders[key] = b;
      }
      const fill = hex(st.backgroundColor || td.getAttribute('bgcolor') || '');
      const text = (td.innerText ?? td.textContent ?? '').replace(/\s+/g, ' ').trim();
      cells.push({ r, c, rs, cs, text, html: td.innerHTML, ...(fill && fill !== '#ffffff' ? { fill } : {}), ...(Object.keys(borders).length ? { borders } : {}) });
      c += cs;
      cols = Math.max(cols, c);
    }
  });
  if (!cols) return null;
  cols = Math.min(cols, MAX_COLS);
  const spec: TableSpec = { rows: rows.length, cols, cells: cells.filter(x => x.c < MAX_COLS) };
  const known = widths.slice(0, cols).filter((w): w is number => !!w);
  if (known.length) { const avg = known.reduce((a, b) => a + b, 0) / known.length; spec.colWidths = Array.from({ length: cols }, (_, i) => widths[i] || avg); }
  if (heights.every(Boolean)) spec.rowHeights = heights as number[];
  return spec;
}

// ── a table copied in this editor ─────────────────────────────────────────────────────────────────────────
let copiedTable: { marker: string; text: string; colWidths: number[]; rowHeights: number[]; width: number } | null = null;
const markerOf = (html: string) => html.match(/rhwp-studio-clipboard:([\w-]+)/)?.[1] ?? '';

/** Remember the size of a table the user copied here (its HTML copy carries no sizes). */
export function noteTableCopied(wasm: WasmBridge, ref: any, markedHtml: string, text: string): void {
  copiedTable = null;
  try {
    const path = ref.cellPath?.length ? ref.cellPath : null;
    const boxes: any[] = path ? JSON.parse((wasm as any).doc.getTableCellBboxesByPath(ref.sec, ref.ppi, JSON.stringify(path)))
      : wasm.getTableCellBboxes(ref.sec, ref.ppi, ref.ci);
    const page = boxes[0]?.pageIndex;
    const first = boxes.filter(b => b.pageIndex === page);
    const xs = [...new Set(first.flatMap(b => [Math.round(b.x * 10), Math.round((b.x + b.w) * 10)]))].sort((a, b) => a - b);
    const ys = [...new Set(first.flatMap(b => [Math.round(b.y * 10), Math.round((b.y + b.h) * 10)]))].sort((a, b) => a - b);
    const colWidths = xs.slice(1).map((x, i) => Math.round((x - xs[i]) * 7.5));
    copiedTable = { marker: markerOf(markedHtml), text, colWidths, rowHeights: ys.slice(1).map((y, i) => Math.round((y - ys[i]) * 7.5)), width: colWidths.reduce((a, b) => a + b, 0) };
  } catch { /* sizes unknown: columns get equal widths */ }
}
export function forgetCopiedTable(): void { copiedTable = null; }
/** Sizes of the table copied here when html is that copy. */
export function copiedTableFor(html: string): { colWidths: number[]; rowHeights: number[]; width: number } | null {
  return copiedTable && copiedTable.marker && markerOf(html) === copiedTable.marker ? copiedTable : null;
}

/** Use the copied table's own column widths and row heights when the HTML copy matches its grid. */
export function withCopiedSizes(spec: TableSpec | null, sizes: { colWidths: number[]; rowHeights: number[] } | null): TableSpec | null {
  if (!spec || !sizes) return spec;
  return { ...spec, ...(sizes.colWidths.length === spec.cols ? { colWidths: sizes.colWidths } : {}), ...(sizes.rowHeights.length === spec.rows ? { rowHeights: sizes.rowHeights } : {}) };
}

/** Paste the editor's own clipboard (a copied table) into the cell as it is, keeping every format. */
export function pasteClipboardTableInCell(wasm: WasmBridge, pos: any): any {
  const path = pathOf(pos)!;
  const pasted = parse(wasm.pasteInternalInCellByPath(pos.sectionIndex, pos.parentParaIndex, JSON.stringify(path), pos.charOffset), '칸에 표를 붙이지 못했습니다.');
  return after(pos, path, pasted);
}

function after(pos: any, path: CellEntry[], pasted: any): any {
  const para = pasted.cellParaIdx ?? path[path.length - 1].cellParaIndex;
  const cellPath = path.map((e, i) => i === path.length - 1 ? { ...e, cellParaIndex: para } : e);
  return { ...pos, ...(path.length === 1 ? { cellParaIndex: para, paragraphIndex: para } : {}), charOffset: pasted.charOffset ?? pos.charOffset, cellPath };
}

/**
 * Build a table (as a character) inside the cell at pos, at any depth. Returns the caret position just after it.
 */
export function buildTableInCell(wasm: WasmBridge, pos: any, spec: TableSpec): any {
  const path = pathOf(pos);
  if (!path) throw new Error('표를 넣을 칸을 찾지 못했습니다.');
  const sec = pos.sectionIndex, outer = pos.parentParaIndex, last = path[path.length - 1];
  const rows = Math.max(1, Math.min(spec.rows, MAX_ROWS)), cols = Math.max(1, Math.min(spec.cols, MAX_COLS));
  const inner = Math.max(cols * 1000, cellInnerWidth(wasm, pos));
  const wanted = spec.colWidths?.length === cols ? spec.colWidths : Array.from({ length: cols }, () => 1);
  const scale = inner / wanted.reduce((a, b) => a + b, 0);
  const colWidths = wanted.map(w => Math.max(800, Math.floor(w * Math.min(scale, spec.colWidths ? 1 : scale))));
  // shrink only when too wide (a narrower source keeps its size, like 한글)
  if (colWidths.reduce((a, b) => a + b, 0) > inner) { const k = inner / colWidths.reduce((a, b) => a + b, 0); colWidths.forEach((w, i) => { colWidths[i] = Math.max(800, Math.floor(w * k)); }); }
  // plain contents look like the text of the cell they go into
  let charShape: number | undefined;
  try {
    charShape = path.length === 1
      ? wasm.getCellCharPropertiesAt(sec, outer, last.controlIndex, last.cellIndex, last.cellParaIndex, pos.charOffset).charShapeId
      : wasm.getCellCharPropertiesAtByPath(sec, outer, JSON.stringify(path), pos.charOffset).charShapeId;
  } catch { /* default */ }
  // 1) a temporary character-like table at the end of the outer table's body paragraph
  const anchorLength = wasm.getParagraphLength(sec, outer);
  const made = wasm.createTableEx({
    sectionIdx: sec, paraIdx: outer, charOffset: anchorLength, rowCount: rows, colCount: cols, treatAsChar: true, colWidths,
    ...(spec.rowHeights?.length === rows ? { rowHeights: spec.rowHeights.map(h => Math.max(500, Math.round(h))) } : {}),
  });
  if (!made?.ok) throw new Error('표를 만들지 못했습니다.');
  const temp = { para: made.paraIdx, control: made.controlIdx };
  const doc = (wasm as any).doc;
  let copied = false;
  try {
    // 2) contents (with their formatting), borders, backgrounds; then merged cells (row-major numbers before merging)
    for (const c of spec.cells ?? []) {
      if (c.r >= rows || c.c >= cols) continue;
      const idx = c.r * cols + c.c;
      let filled = false;
      if (c.html && /<(span|b|strong|i|em|u|font|p|div|br)\b/i.test(c.html)) {
        try { filled = JSON.parse(doc.pasteHtmlInCell(sec, temp.para, temp.control, idx, 0, 0, c.html)).ok === true; } catch { filled = false; }
      }
      if (!filled && c.text) {
        parse(wasm.insertTextInCell(sec, temp.para, temp.control, idx, 0, 0, c.text), '표 내용을 넣지 못했습니다.');
        if (charShape !== undefined) { try { doc.setCharShapeIdInCell(sec, temp.para, temp.control, idx, 0, 0, c.text.length, charShape); } catch { /* keep */ } }
      }
      const props: Record<string, unknown> = { ...(c.borders ?? {}) };
      if (c.fill) Object.assign(props, { fillType: 'solid', fillColor: c.fill });
      if (Object.keys(props).length) { try { wasm.setCellProperties(sec, temp.para, temp.control, idx, props as any); } catch { /* keep plain */ } }
    }
    for (const c of [...(spec.cells ?? [])].filter(x => x.rs > 1 || x.cs > 1).sort((a, b) => b.r - a.r || b.c - a.c)) {
      const endRow = Math.min(rows, c.r + c.rs) - 1, endCol = Math.min(cols, c.c + c.cs) - 1;
      if (endRow > c.r || endCol > c.c) { try { parse(doc.mergeTableCells(sec, temp.para, temp.control, c.r, c.c, endRow, endCol), ''); } catch { /* keep unmerged */ } }
    }
    parse(wasm.copyControl(sec, temp.para, temp.control), '표를 복사하지 못했습니다.');
    copied = true;
  } finally {
    // 3) remove the temporary table; the body paragraph is back to what it was
    parse(wasm.deleteTableControl(sec, temp.para, temp.control), '임시 표를 지우지 못했습니다.');
  }
  if (!copied || wasm.getParagraphLength(sec, outer) !== anchorLength) throw new Error('표를 만드는 중 문서가 바뀌었습니다.');
  // 4) paste it into the cell
  const pasted = parse(wasm.pasteInternalInCellByPath(sec, outer, JSON.stringify(path), pos.charOffset), '칸에 표를 붙이지 못했습니다.');
  return after(pos, path, pasted);
}
