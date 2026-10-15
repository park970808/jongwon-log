import * as Y from 'yjs';
/*
 * 변경 기록 한 건은 Firestore에 압축 후 최대 4 MiB(128 KiB × 32조각)까지 저장됩니다.
 * 사진은 JPEG라 더 압축되지 않으므로, 여러 장을 한 기록으로 묶으면 한도를 넘습니다.
 * - packUpdates: 보낼 변경들을 원본 크기 기준 RECORD_TARGET 이하 묶음으로 나눔
 * - splitUpdate: 그래도 큰 변경 하나(사진 여러 장이 한 번에 들어간 경우, 복구용 전체 변경)를 문서 구조 단위로 쪼갬
 * 사진 한 장 자체가 한도를 넘는 경우는 쪼갤 수 없으므로 넣을 때 줄입니다(image-prepare.js).
 */
export const RECORD_TARGET = 2 * 1024 * 1024;
/** 이보다 큰 변경(대개 사진)은 묶어도 기록 수가 줄지 않으므로 기다리지 않고 바로 보냅니다. */
export const LARGE_UPDATE = 256 * 1024;

/** Rough encoded size of one Yjs struct, enough to keep parts under RECORD_TARGET. */
function structSize(struct) {
  const content = struct.content;
  if (!content) return 8; // GC / Skip
  if (content.content instanceof Uint8Array) return content.content.length + 16; // ContentBinary
  if (typeof content.str === 'string') return content.str.length * 3 + 16; // ContentString (UTF-8 worst case)
  if (Array.isArray(content.arr)) {
    let n = 16;
    for (const v of content.arr) n += v instanceof Uint8Array ? v.length : (JSON.stringify(v) ?? '').length;
    return n;
  }
  return 32;
}

/**
 * Split an update that `doc` already contains into consecutive updates of roughly `target` bytes each.
 * Cuts are made between structs, per client, in clock order; deletions travel with the last part.
 * Parts may depend on later parts across clients; Yjs keeps such structs pending until the rest arrives.
 * Requires doc to keep history (gc: false), like the app's documents.
 */
export function splitUpdate(doc, update, target = RECORD_TARGET) {
  const { from, to } = Y.parseUpdateMeta(update);
  const cuts = [];
  let current = new Map(from), size = 0;
  for (const [client, start] of from) {
    const end = to.get(client) ?? start;
    const structs = doc.store.clients.get(client) || [];
    for (const struct of structs) {
      const clock = struct.id.clock;
      if (clock + struct.length <= start || clock >= end) continue;
      const bytes = structSize(struct);
      if (size > 0 && size + bytes > target && clock > (current.get(client) ?? 0)) {
        current.set(client, clock);
        cuts.push(new Map(current));
        size = 0;
      }
      size += bytes;
    }
    current.set(client, end);
  }
  if (!cuts.length) return [update];
  const parts = [];
  let previous = from;
  for (const cut of cuts) {
    const mid = Y.createDocFromSnapshot(doc, Y.createSnapshot(Y.createDeleteSet(), cut), new Y.Doc({ gc: false }));
    try {
      const part = Y.encodeStateAsUpdate(mid, Y.encodeStateVector(previous));
      if (part.length > 2) parts.push(part);
    } finally { mid.destroy(); }
    previous = cut;
  }
  parts.push(Y.diffUpdate(update, Y.encodeStateVector(previous))); // remaining structs + all deletions
  return parts;
}

/**
 * Turn buffered updates into the updates to store: small ones merged up to `target`, large ones on their own,
 * oversized ones split with the help of `doc`.
 */
export function packUpdates(updates, doc, target = RECORD_TARGET) {
  const packed = [];
  let group = [], size = 0;
  const close = () => { if (group.length) packed.push(group.length === 1 ? group[0] : Y.mergeUpdates(group)); group = []; size = 0; };
  for (const update of updates) {
    if (update.length > target) {
      close();
      packed.push(...(doc ? splitUpdate(doc, update, target) : [update]));
      continue;
    }
    if (size + update.length > target) close();
    group.push(update); size += update.length;
  }
  close();
  return packed;
}
