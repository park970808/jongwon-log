// 공동 활동일지: 표 칸 사진 자르기. 사진 원본을 보여 주고 남길 영역을 끌어서 고르면, 그 부분만 잘라 낸
// 새 사진으로 같은 자리의 사진을 바꿉니다(화면 배율은 그대로라 남긴 부분은 같은 크기로 보입니다).
// 편집기의 "그림 자르기" 속성은 저장·공유 과정에서 값이 바뀌어 쓰지 않고, 이미지 자체를 자릅니다.
// 되돌리려면 실행 취소(Ctrl+Z)를 씁니다.
import type { WasmBridge } from '@/core/wasm-bridge';
import { isCellInlinePicture, replaceCellPicture, requestLayoutRefresh } from './cell-picture';

type Rect = { left: number; top: number; right: number; bottom: number };

const STYLE_ID = 'jongwon-crop-style';
const KEEP = ['brightness', 'contrast', 'effect', 'transparency', 'horzFlip', 'vertFlip', 'description'];
const CSS = `
.jw-crop{position:fixed;inset:0;z-index:10000;background:rgba(20,28,38,.72);display:flex;align-items:center;justify-content:center;font:13px Pretendard,system-ui,sans-serif}
.jw-crop-panel{background:#fff;border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:12px;max-width:94vw;max-height:94vh;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.jw-crop-head{display:flex;justify-content:space-between;align-items:center;gap:20px;color:#25303e}
.jw-crop-head strong{font-size:15px}.jw-crop-head span{color:#6b7886;font-size:12px}
.jw-crop-stage{position:relative;align-self:center;user-select:none;touch-action:none;background:#e9edf1}
.jw-crop-stage img{display:block;max-width:min(86vw,1100px);max-height:calc(94vh - 140px);pointer-events:none}
.jw-crop-box{position:absolute;outline:2px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.5);cursor:move}
.jw-crop-box::before,.jw-crop-box::after{content:"";position:absolute;inset:0;pointer-events:none;border:1px dashed rgba(255,255,255,.55)}
.jw-crop-box::before{left:33.3%;right:33.3%;border-top:0;border-bottom:0}.jw-crop-box::after{top:33.3%;bottom:33.3%;border-left:0;border-right:0}
.jw-crop-h{position:absolute;width:14px;height:14px;background:#fff;border:2px solid #245583;border-radius:2px;margin:-7px 0 0 -7px}
.jw-crop-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center}
.jw-crop-foot small{margin-right:auto;color:#7a8794}
.jw-crop-foot button{border:1px solid #ccd3dc;background:#fff;color:#263b51;padding:8px 14px;border-radius:5px;cursor:pointer;font:inherit}
.jw-crop-foot .jw-primary{background:#245583;border-color:#245583;color:#fff}`;
const HANDLES: [string, number, number, string][] = [
  ['nw', 0, 0, 'nwse-resize'], ['n', .5, 0, 'ns-resize'], ['ne', 1, 0, 'nesw-resize'], ['e', 1, .5, 'ew-resize'],
  ['se', 1, 1, 'nwse-resize'], ['s', .5, 1, 'ns-resize'], ['sw', 0, 1, 'nesw-resize'], ['w', 0, .5, 'ew-resize'],
];
const mimeOf = (b: Uint8Array) => b[0] === 0x89 ? 'image/png' : b[0] === 0x47 ? 'image/gif' : b[0] === 0x42 ? 'image/bmp' : b[0] === 0x52 ? 'image/webp' : 'image/jpeg';

/** Whether the current selection is a photo this dialog can crop (an inline photo in a table cell). */
export function canCropSelection(handler: any): boolean {
  if (handler?.cursor?.isMultiPictureSelection?.()) return false;
  return isCellInlinePicture(handler, handler?.getSelectedPictureRef?.());
}

export function openPictureCrop(wasm: WasmBridge, handler: any): void {
  if (!canCropSelection(handler)) { alert('표 칸 안의 사진만 자를 수 있습니다.'); return; }
  const ref = handler.getSelectedPictureRef();
  const props = wasm.getCellPicturePropertiesByPath(ref.sec, ref.ppi, ref.cellPath, ref.ci) as any;
  const bytes = wasm.getControlImageData(ref.sec, ref.ppi, ref.ci, JSON.stringify(ref.cellPath));
  if (!bytes?.length) { alert('사진 원본을 읽지 못했습니다.'); return; }
  const mime = mimeOf(bytes);

  const doc: Document = handler.container?.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  if (!doc.getElementById(STYLE_ID)) { const s = doc.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; doc.head.appendChild(s); }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const root = doc.createElement('div'); root.className = 'jw-crop'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '사진 자르기');
  root.innerHTML = `<div class="jw-crop-panel"><div class="jw-crop-head"><strong>사진 자르기</strong><span>흰 테두리의 모서리·변을 끌어 남길 부분을 고르세요</span></div>
    <div class="jw-crop-stage"><img alt=""><div class="jw-crop-box"></div></div>
    <div class="jw-crop-foot"><small>되돌리기: Ctrl+Z</small><button type="button" class="jw-cancel">취소</button><button type="button" class="jw-primary">자르기</button></div></div>`;
  const stage = root.querySelector('.jw-crop-stage') as HTMLDivElement, img = stage.querySelector('img') as HTMLImageElement, box = stage.querySelector('.jw-crop-box') as HTMLDivElement;
  for (const [name, x, y, cursor] of HANDLES) { const h = doc.createElement('div'); h.className = 'jw-crop-h'; h.dataset.h = name; h.style.left = `${x * 100}%`; h.style.top = `${y * 100}%`; h.style.cursor = cursor; box.appendChild(h); }
  // Kept area in the image's own pixels.
  let nw = 1, nh = 1, rect: Rect = { left: 0, top: 0, right: 1, bottom: 1 };
  const draw = () => {
    const w = img.clientWidth, h = img.clientHeight;
    Object.assign(box.style, { left: `${rect.left / nw * w}px`, top: `${rect.top / nh * h}px`, width: `${(rect.right - rect.left) / nw * w}px`, height: `${(rect.bottom - rect.top) / nh * h}px` });
  };
  img.onload = () => { nw = img.naturalWidth; nh = img.naturalHeight; rect = { left: 0, top: 0, right: nw, bottom: nh }; draw(); };
  img.onerror = () => { close(); alert('이 사진 형식은 자를 수 없습니다.'); };
  img.src = url;

  let drag: { kind: string; x: number; y: number; from: Rect } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement, kind = t.dataset.h ?? (t === box ? 'move' : null);
    if (!kind) return;
    e.preventDefault(); stage.setPointerCapture(e.pointerId);
    drag = { kind, x: e.clientX, y: e.clientY, from: { ...rect } };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const kx = nw / img.clientWidth, ky = nh / img.clientHeight, dx = (e.clientX - drag.x) * kx, dy = (e.clientY - drag.y) * ky;
    const f = drag.from, minW = Math.max(8, 24 * kx), minH = Math.max(8, 24 * ky), r = { ...f };
    if (drag.kind === 'move') {
      const w = f.right - f.left, h = f.bottom - f.top;
      r.left = Math.min(Math.max(0, f.left + dx), nw - w); r.top = Math.min(Math.max(0, f.top + dy), nh - h);
      r.right = r.left + w; r.bottom = r.top + h;
    } else {
      if (drag.kind.includes('w')) r.left = Math.min(Math.max(0, f.left + dx), f.right - minW);
      if (drag.kind.includes('e')) r.right = Math.max(Math.min(nw, f.right + dx), f.left + minW);
      if (drag.kind.includes('n')) r.top = Math.min(Math.max(0, f.top + dy), f.bottom - minH);
      if (drag.kind.includes('s')) r.bottom = Math.max(Math.min(nh, f.bottom + dy), f.top + minH);
    }
    rect = r; draw();
  });
  const end = () => { drag = null; };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);

  let busy = false;
  const close = () => { handler.isCropDialogOpen = false; URL.revokeObjectURL(url); root.remove(); win.removeEventListener('resize', draw); doc.removeEventListener('keydown', onKey, true); try { handler.focus?.(); } catch { /* ignore */ } };
  const apply = async () => {
    if (busy) return;
    const x = Math.round(rect.left), y = Math.round(rect.top), w = Math.round(rect.right - rect.left), h = Math.round(rect.bottom - rect.top);
    if (x === 0 && y === 0 && w === nw && h === nh) { close(); return; }
    busy = true;
    try {
      const canvas = doc.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      const png = mime === 'image/png' || mime === 'image/gif';
      if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.9));
      if (!blob) throw new Error('사진을 자르지 못했습니다.');
      const data = new Uint8Array(await blob.arrayBuffer());
      // Same display scale as before: the kept part keeps its on-page size.
      const next: Record<string, any> = { width: Math.max(75, Math.round(props.width * w / nw)), height: Math.max(75, Math.round(props.height * h / nh)), originalWidth: w * 75, originalHeight: h * 75 };
      for (const key of KEEP) if (props[key] !== undefined) next[key] = props[key];
      handler.executeOperation({ kind: 'snapshot', operationType: 'insertPicture', operation: () => replaceCellPicture(wasm, ref, data, png ? 'png' : 'jpg', next) });
      close();
      requestLayoutRefresh(handler);
    } catch (error) {
      close();
      alert(error instanceof Error ? error.message : String(error));
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) close(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void apply(); }
  };
  (root.querySelector('.jw-cancel') as HTMLElement).onclick = () => { if (!busy) close(); };
  (root.querySelector('.jw-primary') as HTMLElement).onclick = () => void apply();
  root.addEventListener('pointerdown', (e) => { if (e.target === root && !busy) close(); });
  doc.addEventListener('keydown', onKey, true); win.addEventListener('resize', draw);
  // While open, a teammate's change must not reload the document under it (the photo's indexes could change).
  handler.isCropDialogOpen = true;
  doc.body.appendChild(root);
}
