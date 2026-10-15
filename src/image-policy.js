/*
 * 사진은 넣을 때 줄입니다. 활동일지의 사진 칸 폭은 약 155 mm라 긴 변 2000 px이면 인쇄해도 충분하고,
 * 휴대폰 원본(3~8 MB)을 그대로 넣으면 공동 문서 기록 한 건의 한도(4 MB)와 무료 사용량을 넘기 쉽습니다.
 * 휴대폰 사진의 회전 정보(EXIF)도 이때 실제 픽셀에 반영합니다. 한글은 회전 정보를 무시하기 때문입니다.
 */
export const IMAGE = Object.freeze({ maxEdge: 2000, keepBytes: 1_200_000, targetBytes: 1_500_000, jpegQuality: 0.85, minQuality: 0.6 });

/**
 * What to do with a picked image file.
 * returns { reencode:false } to keep the original bytes, or { reencode:true, width, height, type } for the output.
 */
export function planImage({ type, size, width, height, orientation = 1 }, policy = IMAGE) {
  const scale = Math.min(1, policy.maxEdge / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
  const native = type === 'image/jpeg' || type === 'image/png';
  const keep = native && scale === 1 && size <= policy.keepBytes && orientation === 1;
  if (keep) return { reencode: false };
  // PNG stays PNG (screenshots, diagrams with text) unless it is still too large; photos become JPEG.
  return { reencode: true, width: outWidth, height: outHeight, type: type === 'image/png' ? 'image/png' : 'image/jpeg' };
}

/** EXIF orientation (1-8) of a JPEG, or 1 when absent/unreadable. Reads only the APP1 header. */
export function jpegOrientation(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= v.byteLength) {
    const marker = v.getUint16(offset), length = v.getUint16(offset + 2);
    if (marker === 0xffe1 && offset + 10 <= v.byteLength && v.getUint32(offset + 4) === 0x45786966) { // "Exif"
      const tiff = offset + 10;
      if (tiff + 8 > v.byteLength) return 1;
      const little = v.getUint16(tiff) === 0x4949;
      const u16 = o => v.getUint16(o, little), u32 = o => v.getUint32(o, little);
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > v.byteLength) return 1;
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > v.byteLength) return 1;
        if (u16(entry) === 0x0112) { const o = u16(entry + 8); return o >= 1 && o <= 8 ? o : 1; }
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1; // start of scan: no EXIF before image data
    offset += 2 + length;
  }
  return 1;
}
