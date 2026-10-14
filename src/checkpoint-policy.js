/*
 * 클라이언트 체크포인트(압축본). Spark 요금제에서는 Cloud Functions를 쓸 수 없으므로,
 * 전체 기록을 받아 온 브라우저가 기록이 everyRecords개 쌓일 때마다 "지금까지의 문서 상태"를 한 번 저장합니다.
 * 새 기기는 전체 기록 대신 [압축본 + 그 이후 기록]만 읽습니다. 원본 기록은 절대 지우지 않습니다.
 *
 * 안전 조건 (SyncProvider.maybeCheckpoint):
 * - 이 세션이 전체 기록(또는 기존 압축본 + 이후 기록)을 직접 받은 경우만. 로컬 캐시로 증분 연 세션은 만들지 않음
 * - 온라인 상태이고 첫 로딩이 끝난 뒤
 * - 압축본이 덮는 범위는 lagMs 전까지: 그보다 최근 기록은 새 기기가 항상 다시 읽음
 * - 문서의 압축본 포인터는 앞으로만 이동(트랜잭션 + 보안 규칙)
 */
export const CHECKPOINT = Object.freeze({
  everyRecords: 300,
  lagMs: 5 * 60 * 1000,
  jitterMs: [2000, 20000], // 여러 명이 동시에 조건을 만족해도 대개 한 명만 만들도록 흩어 둠
  minAdvanceMs: 60 * 1000, // 이미 이만큼 최근의 압축본이 있으면 만들지 않음
});

/**
 * The coverage a new checkpoint should get, or null when none should be made now.
 * current   the stored pointer's coverage (ms) or null · cutoff  the normal choice (newest applied − lagMs)
 * repair    ?fullload=1: the stored checkpoint is distrusted, so replace it even if recent, covering at most
 *           maxCutoff (the newest record applied from a complete server snapshot). The pointer only moves forward.
 */
export function chooseCheckpointCutoff({ current, cutoff, minAdvanceMs = 0, repair = false, maxCutoff = cutoff }) {
  if (repair) {
    const next = current !== null && current >= cutoff ? Math.floor(current) + 1 : cutoff;
    return next <= maxCutoff ? next : null;
  }
  return current !== null && current >= cutoff - minAdvanceMs ? null : cutoff;
}
