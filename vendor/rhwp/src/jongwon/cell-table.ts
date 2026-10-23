// 공동 활동일지: 표 칸 안에 표 만들기·붙여넣기.
//
// 편집기 기본 기능은 표 안에서 "표 만들기"를 막고, 바깥에서 복사한 표(한글·엑셀·웹의 HTML 표)를 칸에 붙이면
// 표를 버리고 글자만 넣습니다. 팀원 변경이 반영되면(문서를 다시 읽음) 편집기 안 클립보드도 비어서, 이 편집기에서
// 복사한 표도 같은 길로 빠집니다.
// 엔진은 "본문 문단에 글자처럼 취급하는 표"를 만들 수 있고 그 표를 칸에 붙일 수 있으므로, 바깥 표가 있는
// 본문 문단 끝에 표를 잠시 만들어 내용·병합까지 채운 뒤, 복사해서 칸에 붙이고 임시 표는 지웁니다.
// 모두 한 번의 되돌리기 단위(snapshot) 안에서 일어납니다.
import type { WasmBridge } from '@/core/wasm-bridge';

type CellEntry = { controlIndex: number; cellIndex: number; cellParaIndex: number };
export type TableSpec = { rows: number; cols: number; cells?: Array<{ r: number; c: number; rs: number; cs: number; text: string; fill?: string }> };

const MAX_ROWS = 200, MAX_COLS = 30;
const parse = (result: any, message: string) => {
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  if (!parsed?.ok) throw new Error(message);
  return parsed;
};
const hex = (color: string): string | undefined => {
  const m = color.trim().match(/^#([0-9a-f]{6})$/i) || color.trim().match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return m.length === 2 ? `#${m[1].toLowerCase()}` : `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/i);
  if (rgb && (rgb[4] === undefined || +rgb[4] > 0)) return '#' + rgb.slice(1, 4).map(v => (+v).toString(16).padStart(2, '0')).join('');
  return undefined;
};
const entryOf = (pos: any): CellEntry | null => {
  const e = pos.cellPath?.length ? pos.cellPath[0] : pos;
  const entry = { controlIndex: e.controlIndex ?? e.controlIdx, cellIndex: e.cellIndex ?? e.cellIdx, cellParaIndex: e.cellParaIndex ?? e.cellParaIdx };
  return [entry.controlIndex, entry.cellIndex, entry.cellParaIndex].every(Number.isInteger) ? entry : null;
};

/** A caret directly inside a body table cell (not a table inside a table, header/footer or text box). */
export function canBuildTableInCell(handler: any, pos: any): boolean {
  if (pos?.parentParaIndex === undefined || (pos.cellPath?.length ?? 1) > 1) return false;
  if (handler?.cursor?.isInHeaderFooter?.() || handler?.cursor?.isInFootnote?.() || handler?.cursor?.isInTextBox?.()) return false;
  return !!entryOf(pos);
}

/** Read the first HTML table into a grid (text only; merged cells kept). */
export function tableSpecFromHtml(html: string, doc: Document = document): TableSpec | null {
  if (!/<table[\s>]/i.test(html)) return null;
  const table = new (doc.defaultView ?? window).DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll('tr')).filter(tr => tr.closest('table') === table);
  if (!rows.length) return null;
  const taken: boolean[][] = [], cells: NonNullable<TableSpec['cells']> = [];
  let cols = 0;
  rows.slice(0, MAX_ROWS).forEach((tr, r) => {
    let c = 0;
    for (const td of Array.from(tr.children).filter(x => /^(TD|TH)$/.test(x.tagName)) as HTMLTableCellElement[]) {
      while (taken[r]?.[c]) c++;
      const rs = Math.max(1, Math.min(td.rowSpan || 1, rows.length - r)), cs = Math.max(1, td.colSpan || 1);
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) (taken[r + i] ??= [])[c + j] = true;
      const fill = hex(td.style.backgroundColor || td.getAttribute('bgcolor') || '');
      cells.push({ r, c, rs, cs, text: (td.innerText ?? td.textContent ?? '').replace(/\s+/g, ' ').trim(), ...(fill && fill !== '#ffffff' ? { fill } : {}) });
      c += cs;
      cols = Math.max(cols, c);
    }
  });
  if (!cols) return null;
  return { rows: Math.min(rows.length, MAX_ROWS), cols: Math.min(cols, MAX_COLS), cells: cells.filter(x => x.c < MAX_COLS) };
}

/**
 * Build a table (as a character) inside the cell at pos. Returns the caret position just after it in that cell.
 */
export function buildTableInCell(wasm: WasmBridge, pos: any, spec: TableSpec): any {
  const entry = entryOf(pos);
  if (!entry) throw new Error('표를 넣을 칸을 찾지 못했습니다.');
  const sec = pos.sectionIndex, outer = pos.parentParaIndex;
  const rows = Math.max(1, Math.min(spec.rows, MAX_ROWS)), cols = Math.max(1, Math.min(spec.cols, MAX_COLS));
  const cell = wasm.getCellProperties(sec, outer, entry.controlIndex, entry.cellIndex);
  const inner = Math.max(cols * 1000, cell.width - cell.paddingLeft - cell.paddingRight - 300);
  const colWidths = Array.from({ length: cols }, () => Math.floor(inner / cols));
  // the letters of the new table look like the text of the cell it goes into
  let charShape: number | undefined;
  try { charShape = wasm.getCellCharPropertiesAt(sec, outer, entry.controlIndex, entry.cellIndex, pos.cellParaIndex ?? entry.cellParaIndex, pos.charOffset).charShapeId; } catch { /* default */ }
  // 1) a temporary character-like table at the end of the outer table's body paragraph
  const anchorLength = wasm.getParagraphLength(sec, outer);
  const made = wasm.createTableEx({ sectionIdx: sec, paraIdx: outer, charOffset: anchorLength, rowCount: rows, colCount: cols, treatAsChar: true, colWidths });
  if (!made?.ok) throw new Error('표를 만들지 못했습니다.');
  const temp = { para: made.paraIdx, control: made.controlIdx };
  let copied = false;
  try {
    // 2) contents, then merged cells (cell numbers are row-major before merging)
    for (const c of spec.cells ?? []) {
      if (c.r >= rows || c.c >= cols) continue;
      if (c.text) {
        parse(wasm.insertTextInCell(sec, temp.para, temp.control, c.r * cols + c.c, 0, 0, c.text), '표 내용을 넣지 못했습니다.');
        if (charShape !== undefined) { try { (wasm as any).doc.setCharShapeIdInCell(sec, temp.para, temp.control, c.r * cols + c.c, 0, 0, c.text.length, charShape); } catch { /* keep */ } }
      }
      if (c.fill) { try { wasm.setCellProperties(sec, temp.para, temp.control, c.r * cols + c.c, { fillType: 'solid', fillColor: c.fill } as any); } catch { /* keep plain */ } }
    }
    for (const c of [...(spec.cells ?? [])].filter(x => x.rs > 1 || x.cs > 1).sort((a, b) => b.r - a.r || b.c - a.c)) {
      const endRow = Math.min(rows, c.r + c.rs) - 1, endCol = Math.min(cols, c.c + c.cs) - 1;
      if (endRow > c.r || endCol > c.c) {
        try { parse((wasm as any).doc.mergeTableCells(sec, temp.para, temp.control, c.r, c.c, endRow, endCol), ''); } catch { /* keep unmerged */ }
      }
    }
    parse(wasm.copyControl(sec, temp.para, temp.control), '표를 복사하지 못했습니다.');
    copied = true;
  } finally {
    // 3) remove the temporary table; the body paragraph is back to what it was
    parse(wasm.deleteTableControl(sec, temp.para, temp.control), '임시 표를 지우지 못했습니다.');
  }
  if (!copied || wasm.getParagraphLength(sec, outer) !== anchorLength) throw new Error('표를 만드는 중 문서가 바뀌었습니다.');
  // 4) paste it into the cell
  const path = [{ controlIndex: entry.controlIndex, cellIndex: entry.cellIndex, cellParaIndex: pos.cellParaIndex ?? entry.cellParaIndex }];
  const pasted = parse(wasm.pasteInternalInCellByPath(sec, outer, JSON.stringify(path), pos.charOffset), '칸에 표를 붙이지 못했습니다.');
  const para = pasted.cellParaIdx ?? path[0].cellParaIndex;
  return {
    ...pos,
    cellParaIndex: para,
    paragraphIndex: para,
    charOffset: pasted.charOffset ?? pos.charOffset,
    cellPath: [{ ...path[0], cellParaIndex: para }],
  };
}
