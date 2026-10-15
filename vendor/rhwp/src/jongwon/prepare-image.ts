// 공동 활동일지: 넣는 사진을 줄이고 회전 정보를 반영합니다. 정책은 저장소의 src/image-policy.js에 있습니다.
// @ts-ignore -- plain JS module shared with the Node tests
import { IMAGE, planImage, jpegOrientation } from '../../../../src/image-policy.js';

export interface PreparedImage { data: Uint8Array; ext: string; naturalWidth: number; naturalHeight: number; fileName: string; }

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp' };

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('사진을 변환하지 못했습니다.'))), type, quality));
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* fall back to <img> (e.g. old Safari) */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) throw new Error('이미지 크기를 확인할 수 없습니다.');
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw new Error('브라우저가 이 이미지 파일을 읽지 못했습니다.');
  }
}

export async function prepareImageFile(file: File): Promise<PreparedImage> {
  const original = new Uint8Array(await file.arrayBuffer());
  const type = file.type || 'image/png';
  const image = await decode(file);
  try {
    const orientation = type === 'image/jpeg' ? jpegOrientation(original) : 1;
    const plan = planImage({ type, size: original.length, width: image.width, height: image.height, orientation });
    const baseName = (file.name || '사진').replace(/\.[^.]+$/, '');
    if (!plan.reencode) {
      return { data: original, ext: EXT[type] || (file.name.split('.').pop() || 'png').toLowerCase(), naturalWidth: image.width, naturalHeight: image.height, fileName: file.name || `${baseName}.png` };
    }
    let { width, height } = plan;
    let outType: string = plan.type, blob: Blob | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('사진을 변환하지 못했습니다.');
      if (outType === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, width, height); } // transparent areas → white
      g.imageSmoothingQuality = 'high';
      g.drawImage(image.source, 0, 0, width, height);
      const quality = outType === 'image/jpeg' ? Math.max(IMAGE.minQuality, IMAGE.jpegQuality - attempt * 0.08) : undefined;
      blob = await toBlob(canvas, outType, quality);
      if (blob.size <= IMAGE.targetBytes || attempt === 5) break; // the last try is kept as is (its size matches)
      if (outType === 'image/png') { outType = 'image/jpeg'; continue; } // a large PNG is a photo: JPEG is far smaller
      if (quality !== undefined && quality <= IMAGE.minQuality) { width = Math.round(width * 0.8); height = Math.round(height * 0.8); }
    }
    const data = new Uint8Array(await blob!.arrayBuffer());
    const ext = EXT[outType];
    return { data, ext, naturalWidth: width, naturalHeight: height, fileName: `${baseName}.${ext}` };
  } finally {
    image.close();
  }
}
