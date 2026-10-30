// 공동 활동일지: 한글처럼 문서 끝의 표 뒤에는 항상 빈 문단을 둡니다. 없으면 마지막 표 아래를 클릭해도 표 안으로만
// 들어가 표 밖에 글을 쓰거나 다른 문서의 표를 붙여 넣을 수 없습니다.
import type { WasmBridge } from '@/core/wasm-bridge';

/** Whether a body paragraph holds a table. */
export function holdsTable(wasm: WasmBridge, sec: number, para: number): boolean {
  let count = 0;
  try { count = JSON.parse((wasm as any).doc.getControlTextPositions(sec, para)).length; } catch { return false; }
  for (let i = 0; i < count; i++) {
    try { if (wasm.getTableProperties(sec, para, i)) return true; } catch { /* not a table */ }
  }
  return false;
}

/** Adds an empty paragraph after a table that ends a section. Returns true when one was added. */
export function ensureParagraphAfterLastTable(wasm: WasmBridge): boolean {
  let changed = false;
  const sections = wasm.getSectionCount();
  for (let sec = 0; sec < sections; sec++) {
    const count = wasm.getParagraphCount(sec);
    if (count < 1 || !holdsTable(wasm, sec, count - 1)) continue;
    try { if (JSON.parse((wasm as any).doc.insertParagraph(sec, count)).ok) changed = true; }
    catch (error) { console.warn('[jongwon] 표 뒤 빈 문단을 만들지 못했습니다:', error); }
  }
  return changed;
}

/**
 * After a table was pasted into the body: like 한글, keep a paragraph after it and put the caret there (the caret
 * cannot sit in the table's own paragraph, so the person could not go on writing below the table).
 */
export function caretAfterPastedTable(wasm: WasmBridge, pos: any): any {
  if (!pos || pos.parentParaIndex !== undefined) return pos;
  ensureParagraphAfterLastTable(wasm);
  let para = pos.paragraphIndex;
  const count = wasm.getParagraphCount(pos.sectionIndex);
  if (para >= count) para = count - 1;
  if (holdsTable(wasm, pos.sectionIndex, para) && wasm.getParagraphLength(pos.sectionIndex, para) === 0 && para + 1 < count)
    return { sectionIndex: pos.sectionIndex, paragraphIndex: para + 1, charOffset: 0 };
  return { ...pos, paragraphIndex: para };
}
