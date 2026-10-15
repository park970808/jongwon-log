// 공동 활동일지: 표 칸 안의 "글자처럼 취급" 사진을 넣기·옮기기·잘라내기·붙이기·지우기.
//
// 칸 안 사진은 한글 원본 파일처럼 글자처럼 취급(treatAsChar)해야 칸과 함께 흐르지만, 편집기 기본 기능은
// - 떠 있는 개체만 끌어서 옮길 수 있고,
// - 붙여넣기 때 사진을 기존 글자와 같은 줄에 넣어(배치가 깨지고 다시 그릴 때 위치가 달라짐),
// - 사진을 빼도 사진 때문에 늘린 칸 높이를 줄이지 않습니다.
// 그래서 사진은 항상 "혼자 한 줄"로 두고, 칸 높이는 넣을 때 늘린 만큼(RESERVE 포함) 뺄 때 줄입니다.
// 같은 칸 안에서 옮길 때는 칸 높이를 바꾸지 않습니다(양식 칸 높이가 조금씩 변하지 않도록).
import type { WasmBridge } from '@/core/wasm-bridge';

type CellEntry = { controlIndex: number; cellIndex: number; cellParaIndex: number };
export type CellPictureRef = { sec: number; ppi: number; ci: number; type: string; cellPath?: CellEntry[] };
export type CellTarget = { sectionIndex: number; parentParaIndex: number; cellPath: CellEntry[]; charOffset: number };

/** Text room kept around a photo, as when it is first inserted. */
const RESERVE = 4000;
const MIN_CELL_HEIGHT = 1000;
const PHOTO_PARA_FORMAT = JSON.stringify({ alignment: 'left', indent: 0, marginLeft: 0, marginRight: 0, lineSpacingType: 'Percent', lineSpacing: 100 });

const entryOf = (path: any[]): CellEntry => {
  const e = path[0];
  return { controlIndex: e.controlIndex ?? e.controlIdx, cellIndex: e.cellIndex ?? e.cellIdx, cellParaIndex: e.cellParaIndex ?? e.cellParaIdx };
};
const ok = (result: any, message: string) => {
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  if (!parsed?.ok) throw new Error(message);
  return parsed;
};

/** A photo directly inside a (non-nested) body table cell, laid out as a character. */
export function isCellInlinePicture(handler: any, ref: CellPictureRef | null | undefined): boolean {
  if (!ref || ref.type !== 'image' || ref.cellPath?.length !== 1) return false;
  const r = ref as any; // header/footer, footnote and text-box objects use other index spaces
  if (r.headerFooter || r.noteRef || r.isTextBox || handler.cursor?.isInHeaderFooter?.()) return false;
  try { return !!handler.getObjectProperties(ref).treatAsChar; } catch { return false; }
}

function pictureAt(wasm: WasmBridge, sec: number, ppi: number, entry: CellEntry, ci: number): any | null {
  try { return wasm.getCellPicturePropertiesByPath(sec, ppi, [entry], ci); } catch { return null; }
}

function reserveFor(wasm: WasmBridge, sec: number, ppi: number, entry: CellEntry, pictureHeight: number): number {
  const cell = wasm.getCellProperties(sec, ppi, entry.controlIndex, entry.cellIndex);
  return pictureHeight + RESERVE + cell.paddingTop + cell.paddingBottom;
}

/** Grow the cell where any of its photos would be cut off (text grows the row by itself; photos do not). */
function ensureCellPhotos(wasm: WasmBridge, sec: number, ppi: number, controlIndex: number, cellIndex: number): void {
  const count = wasm.getCellParagraphCount(sec, ppi, controlIndex, cellIndex);
  for (let p = 0; p < count; p++) {
    const entry = { controlIndex, cellIndex, cellParaIndex: p };
    for (let ci = 0; ci < 8 && pictureAt(wasm, sec, ppi, entry, ci); ci++) wasm.ensureCellPictureHeight(sec, ppi, [entry], ci);
  }
}

/**
 * Put the control on the internal clipboard (a photo) into the cell at target, on its own line, and make the
 * cell tall enough. Returns the position just after the photo.
 */
export function placeClipboardPictureInCell(wasm: WasmBridge, target: CellTarget, { keepHeight = false } = {}): any {
  const sec = target.sectionIndex, ppi = target.parentParaIndex;
  const entry = { ...entryOf(target.cellPath) };
  const { controlIndex, cellIndex } = entry;
  const length = (p: number) => wasm.getCellParagraphLength(sec, ppi, controlIndex, cellIndex, p);
  const blank = (p: number) => length(p) === 0 && !pictureAt(wasm, sec, ppi, { controlIndex, cellIndex, cellParaIndex: p }, 0);
  const count = wasm.getCellParagraphCount(sec, ppi, controlIndex, cellIndex);
  const lineLength = length(entry.cellParaIndex), linePhoto = !!pictureAt(wasm, sec, ppi, entry, 0);
  let trailing: boolean;
  if (target.charOffset > 0 && target.charOffset >= lineLength && !linePhoto && entry.cellParaIndex + 1 < count && blank(entry.cellParaIndex + 1)) {
    entry.cellParaIndex += 1; trailing = false; // end of a line followed by a blank line: use that line
  } else if (target.charOffset > 0) {
    const split = ok(wasm.splitParagraphInCellByPath(sec, ppi, JSON.stringify([entry]), target.charOffset), '사진 앞의 문단을 나누지 못했습니다.');
    entry.cellParaIndex = split.cellParaIndex;
    trailing = target.charOffset < lineLength;
  } else {
    trailing = lineLength > 0 || linePhoto;
  }
  const path = JSON.stringify([entry]);
  ok(wasm.pasteInternalInCellByPath(sec, ppi, path, 0), '사진을 선택한 칸에 넣지 못했습니다.');
  // Native inline photos do not wrap reliably beside text: what follows goes to its own line. The last line of
  // a cell is also split so the caret has a line to continue on below the photo.
  const last = entry.cellParaIndex === wasm.getCellParagraphCount(sec, ppi, controlIndex, cellIndex) - 1;
  if (trailing || last) ok(wasm.splitParagraphInCellByPath(sec, ppi, path, 1), '사진 뒤의 문단을 나누지 못했습니다.');
  ok(wasm.applyParaFormatInCell(sec, ppi, controlIndex, cellIndex, entry.cellParaIndex, PHOTO_PARA_FORMAT), '사진 문단의 간격을 설정하지 못했습니다.');
  let picture = pictureAt(wasm, sec, ppi, entry, 0);
  if (picture) {
    // A photo copied from the page body may float and be wider than the cell: make it a character and fit it.
    const inner = (() => { const c = wasm.getCellProperties(sec, ppi, controlIndex, cellIndex); return c.width - c.paddingLeft - c.paddingRight; })();
    const fit: Record<string, unknown> = {};
    if (!picture.treatAsChar) fit.treatAsChar = true;
    if (picture.width > inner && inner > 0) { fit.width = Math.round(inner); fit.height = Math.max(75, Math.round(picture.height * inner / picture.width)); }
    if (Object.keys(fit).length) { wasm.setCellPicturePropertiesByPath(sec, ppi, [entry], 0, fit); picture = pictureAt(wasm, sec, ppi, entry, 0) ?? picture; }
    if (!keepHeight) {
      const cell = wasm.getCellProperties(sec, ppi, controlIndex, cellIndex);
      ok(wasm.setCellProperties(sec, ppi, controlIndex, cellIndex, { height: cell.height + reserveFor(wasm, sec, ppi, entry, picture.height), verticalAlign: 0 }), '사진에 맞춰 칸 높이를 조절하지 못했습니다.');
    }
    ensureCellPhotos(wasm, sec, ppi, controlIndex, cellIndex);
  }
  const next = entry.cellParaIndex + 1;
  return { sectionIndex: sec, parentParaIndex: ppi, controlIndex, cellIndex, cellParaIndex: next, paragraphIndex: next, cellPath: [{ controlIndex, cellIndex, cellParaIndex: next }], charOffset: 0 };
}

/**
 * Remove a photo from its cell: the photo, its now-empty line, and the height it added.
 * Returns a valid caret position where the photo was, and whether its paragraph was removed.
 */
export function removeCellPicture(wasm: WasmBridge, ref: CellPictureRef, { keepHeight = false } = {}): { position: any; removedParagraph: boolean } {
  const sec = ref.sec, ppi = ref.ppi, entry = entryOf(ref.cellPath!);
  const picture = pictureAt(wasm, sec, ppi, entry, ref.ci);
  const reserve = picture ? reserveFor(wasm, sec, ppi, entry, picture.height) : 0;
  ok(wasm.deleteCellPictureControlByPath(sec, ppi, [entry], ref.ci), '사진을 지우지 못했습니다.');
  let para = entry.cellParaIndex, offset = 0, removedParagraph = false;
  const count = wasm.getCellParagraphCount(sec, ppi, entry.controlIndex, entry.cellIndex);
  const empty = wasm.getCellParagraphLength(sec, ppi, entry.controlIndex, entry.cellIndex, para) === 0 && !pictureAt(wasm, sec, ppi, entry, 0);
  // Merge the emptied line into the line above (which keeps its own alignment). A photo on the first line of the
  // cell leaves an empty first line instead: merging the next line into it would give that text the photo format.
  if (empty && count > 1 && para > 0) {
    const merged = ok(wasm.mergeParagraphInCell(sec, ppi, entry.controlIndex, entry.cellIndex, para), '사진 줄을 정리하지 못했습니다.');
    para = merged.cellParaIndex ?? para - 1; offset = merged.charOffset ?? 0;
    removedParagraph = true;
  }
  if (reserve > 0 && !keepHeight) {
    // Give back exactly what placing the photo added (never more, so a form's own cell height is kept).
    // Remaining photos grow the cell again if they would be cut off; text makes a row taller by itself.
    const cell = wasm.getCellProperties(sec, ppi, entry.controlIndex, entry.cellIndex);
    wasm.setCellProperties(sec, ppi, entry.controlIndex, entry.cellIndex, { height: Math.max(MIN_CELL_HEIGHT, cell.height - reserve) });
    ensureCellPhotos(wasm, sec, ppi, entry.controlIndex, entry.cellIndex);
  }
  const at = { ...entry, cellParaIndex: para };
  return {
    removedParagraph,
    position: { sectionIndex: sec, parentParaIndex: ppi, controlIndex: entry.controlIndex, cellIndex: entry.cellIndex, cellParaIndex: para, paragraphIndex: para, cellPath: [at], charOffset: offset },
  };
}

/**
 * Move a photo to target (a caret position in a cell). Returns the new caret position, or null when the target
 * is the photo's own line (nothing to do) or not a single-level cell.
 */
/** Whether dropping the photo at hit would move it (a cell drop target other than the photo's own line). */
export function isMoveTarget(ref: CellPictureRef, hit: any): boolean {
  if (!hit || hit.isTextBox || hit.parentParaIndex === undefined || hit.cellPath?.length !== 1) return false;
  const source = entryOf(ref.cellPath!), dest = entryOf(hit.cellPath);
  return !(hit.sectionIndex === ref.sec && hit.parentParaIndex === ref.ppi && dest.controlIndex === source.controlIndex && dest.cellIndex === source.cellIndex && dest.cellParaIndex === source.cellParaIndex);
}

export function moveCellPicture(wasm: WasmBridge, ref: CellPictureRef, hit: any): any | null {
  if (!isMoveTarget(ref, hit)) return null;
  const source = entryOf(ref.cellPath!), dest = { ...entryOf(hit.cellPath) };
  const sameCell = hit.sectionIndex === ref.sec && hit.parentParaIndex === ref.ppi && dest.controlIndex === source.controlIndex && dest.cellIndex === source.cellIndex;
  ok(wasm.copyControl(ref.sec, ref.ppi, ref.ci, JSON.stringify([source])), '사진을 옮기지 못했습니다.');
  const removed = removeCellPicture(wasm, ref, { keepHeight: sameCell });
  if (sameCell && removed.removedParagraph && dest.cellParaIndex > source.cellParaIndex) dest.cellParaIndex -= 1;
  return placeClipboardPictureInCell(wasm, { sectionIndex: hit.sectionIndex, parentParaIndex: hit.parentParaIndex, cellPath: [dest], charOffset: hit.charOffset ?? 0 }, { keepHeight: sameCell });
}

/** Ask the host to redraw from the shared document (see jongwonStudio.setRefreshRequest). */
export function requestLayoutRefresh(handler: any): void {
  try { (handler.container.ownerDocument.defaultView as any).jongwonStudio?.requestRefresh?.(); } catch { /* standalone studio */ }
}

// ── clipboard ──
// The editor keeps copied objects in the document instance, and the shared document is reloaded whenever a
// teammate's change (or our own photo layout refresh) is applied, which empties that clipboard. So a copied photo
// is also kept here (bytes + size/crop/effects) and pasted from this copy when the editor's clipboard is gone.
type PictureRecord = { data: Uint8Array; ext: string; props: any; text: string };
let copiedPictureText: string | null = null;
let copiedPicture: PictureRecord | null = null;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp' };
const KEPT = ['width', 'height', 'cropLeft', 'cropTop', 'cropRight', 'cropBottom', 'brightness', 'contrast', 'effect', 'transparency', 'horzFlip', 'vertFlip', 'description'];

export function notePictureCopied(wasm: WasmBridge, ref?: CellPictureRef | null): void {
  try { copiedPictureText = wasm.getClipboardText(); } catch { copiedPictureText = null; }
  copiedPicture = null;
  if (!ref || ref.type !== 'image') return;
  try {
    const path = ref.cellPath?.length ? JSON.stringify(ref.cellPath) : '';
    const data = wasm.getControlImageData(ref.sec, ref.ppi, ref.ci, path);
    const mime = wasm.getControlImageMime(ref.sec, ref.ppi, ref.ci, path);
    const props = ref.cellPath?.length ? wasm.getCellPicturePropertiesByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci) : wasm.getPictureProperties(ref.sec, ref.ppi, ref.ci);
    if (data?.length) copiedPicture = { data: data.slice(), ext: EXT[mime] || 'png', props, text: copiedPictureText || '[그림]' };
  } catch (error) { console.warn('[jongwon] 복사한 사진을 보관하지 못했습니다:', error); copiedPicture = null; }
}
export function noteOtherCopy(): void { copiedPictureText = null; copiedPicture = null; }
/** The editor's own clipboard still holds the photo copied here. */
export function clipboardHoldsCopiedPicture(wasm: WasmBridge): boolean {
  try { return copiedPictureText !== null && wasm.clipboardHasControl() && wasm.getClipboardText() === copiedPictureText; } catch { return false; }
}
/** A photo copied in this editor is available even though the editor's clipboard was emptied by a reload. */
export function hasKeptPicture(): boolean { return copiedPicture !== null; }
export function keptPictureText(): string | null { return copiedPicture?.text ?? null; }

/** Paste the kept photo (see above) into a cell, with its size, crop and effects. */
export function insertKeptPictureInCell(wasm: WasmBridge, target: CellTarget): any {
  const record = copiedPicture;
  if (!record) throw new Error('붙여넣을 사진이 없습니다.');
  const sec = target.sectionIndex, ppi = target.parentParaIndex, p = record.props;
  const natural = (v: number, fallback: number) => Math.max(1, Math.round((v || fallback) / 75));
  // Same route as a new photo: a temporary body picture, made inline, copied, removed, then placed in the cell.
  const created = wasm.insertPicture(sec, ppi, 0, '', record.data, p.width, p.height, natural(p.originalWidth, p.width), natural(p.originalHeight, p.height), record.ext, p.description || '');
  if (!created.ok) throw new Error('사진을 붙여넣지 못했습니다.');
  const props: Record<string, unknown> = { treatAsChar: true };
  for (const key of KEPT) if (p[key] !== undefined) props[key] = p[key];
  wasm.setPictureProperties(sec, created.paraIdx, created.controlIdx, props);
  ok(wasm.copyControl(sec, created.paraIdx, created.controlIdx), '사진을 붙여넣지 못했습니다.');
  ok(wasm.deletePictureControl(sec, created.paraIdx, created.controlIdx), '임시 사진을 정리하지 못했습니다.');
  return placeClipboardPictureInCell(wasm, target);
}

// ── dragging an inline cell photo ──
/**
 * Start dragging a selected inline cell photo. A line follows the pointer where the photo will go; releasing
 * moves it there (one undo step). Returns true when the drag took over the mouse.
 */
export function startCellPictureDrag(handler: any, e: MouseEvent, ref: CellPictureRef): boolean {
  if (!isCellInlinePicture(handler, ref)) return false;
  const doc = handler.container.ownerDocument as Document, win = doc.defaultView as any;
  const startX = e.clientX, startY = e.clientY;
  let dragging = false, target: any = null;
  const marker = doc.createElement('div');
  marker.style.cssText = 'position:fixed;width:3px;background:#2563eb;border-radius:2px;pointer-events:none;z-index:9999;display:none;box-shadow:0 0 0 2px rgba(37,99,235,.2)';
  // While set, the host postpones teammates' changes (jongwonStudio.interacting), so ref stays valid until the drop.
  handler.isCellPictureDragging = true;
  const finish = () => {
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('mouseup', onUp, true);
    doc.removeEventListener('keydown', onKey, true);
    win.removeEventListener('blur', cancel);
    marker.remove(); handler.container.style.cursor = '';
    handler.isCellPictureDragging = false;
  };
  const cancel = () => { finish(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
  const onMove = (ev: MouseEvent) => {
    if (ev.buttons === 0) { cancel(); return; } // the button was released outside the window
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    if (!dragging) { dragging = true; doc.body.appendChild(marker); handler.container.style.cursor = 'grabbing'; }
    ev.preventDefault();
    target = handler.hitTestFromClientPoint?.(ev.clientX, ev.clientY) ?? null;
    const rect = isMoveTarget(ref, target) ? win.jongwonStudio?.caretRect?.({ ...target, cellIndex: target.cellIndex ?? target.cellPath[0].cellIndex }) : null;
    if (rect) { marker.style.display = 'block'; marker.style.left = `${rect.x - 1}px`; marker.style.top = `${rect.y}px`; marker.style.height = `${Math.max(14, rect.height)}px`; }
    else marker.style.display = 'none';
  };
  const onUp = (ev: MouseEvent) => {
    finish();
    if (!dragging) { handler.renderPictureObjectSelection?.(); handler.eventBus.emit('picture-object-selection-changed', true); return; } // a plain click keeps the photo selected
    ev.preventDefault();
    const hit = handler.hitTestFromClientPoint?.(ev.clientX, ev.clientY) ?? target;
    if (!isMoveTarget(ref, hit)) return; // dropped on its own line or outside a cell: nothing changes
    handler.cursor.moveOutOfSelectedPicture?.();
    handler.pictureObjectRenderer?.clear?.();
    handler.eventBus.emit('picture-object-selection-changed', false);
    try {
      // A snapshot operation restores the whole document if any step fails.
      handler.executeOperation({ kind: 'snapshot', operationType: 'moveCellPicture', operation: (wasm: WasmBridge) => moveCellPicture(wasm, ref, hit) ?? handler.cursor.getPosition() });
      requestLayoutRefresh(handler);
    } catch (error) {
      console.warn('[jongwon] 사진 옮기기 실패:', error);
    }
    handler.focus?.();
  };
  e.preventDefault();
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('mouseup', onUp, true);
  doc.addEventListener('keydown', onKey, true);
  win.addEventListener('blur', cancel);
  return true;
}
