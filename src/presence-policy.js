/*
 * 접속자 커서 표시는 Firestore 쓰기 1회 + (접속자 수만큼 읽기)입니다. Spark 무료 한도에 맞춰:
 * - 다른 문단·칸으로 옮기면 moveMs 안에 알림 (누가 어디서 작업 중인지가 핵심 정보)
 * - 같은 문단 안에서 입력하며 움직이는 커서는 refineMs마다 한 번만 갱신 (문단 단위로는 항상 정확)
 * - 가만히 있으면 heartbeatMs마다 한 번, idleAfterMs 넘게 아무것도 안 하면 idleHeartbeatMs마다 한 번
 *   (화면만 켜 두고 하루 종일 열어 두어도 비용이 거의 들지 않도록)
 * - 각 알림에 "다음 알림까지의 간격"을 함께 보내고, 받는 쪽은 그 간격의 staleFactor배가 지나면 커서를 숨김
 * - 탭을 숨기면 "자리 비움"을 한 번만 알리고 그 뒤로는 보내지 않음
 * 실시간으로 받는 문서마다 규칙 읽기가 과금되는 최악의 경우까지 무료 한도에 들도록 정한 값입니다
 * (scripts/firestore-usage-model.mjs).
 */
export const PRESENCE = Object.freeze({
  checkMs: 1000, moveMs: 3000, refineMs: 60000, heartbeatMs: 60000,
  idleAfterMs: 5 * 60000, idleHeartbeatMs: 10 * 60000, staleFactor: 2.5,
});

/** With the Realtime Database (billed by data, not by operations) the caret follows within a quarter second. */
export const PRESENCE_REALTIME = Object.freeze({
  checkMs: 120, moveMs: 120, refineMs: 250, heartbeatMs: 30000,
  idleAfterMs: 5 * 60000, idleHeartbeatMs: 10 * 60000, staleFactor: 2.5,
});

export function heartbeatFor(idle, policy = PRESENCE) { return idle ? policy.idleHeartbeatMs : policy.heartbeatMs; }

export function shouldSendPresence({ now, lastSent, paragraphChanged = false, offsetChanged = false, hidden, lastHidden, idle = false, lastIdle = false, force = false }, policy = PRESENCE) {
  if (force) return true;
  if (hidden) return !lastHidden;      // announce once that we stepped away, then stay quiet
  if (lastHidden) return true;         // back from a hidden tab
  if (idle && !lastIdle) return true;  // tell peers the next heartbeat will be later, so they keep showing us
  const since = now - lastSent;
  if (paragraphChanged) return since >= policy.moveMs;
  if (offsetChanged) return since >= policy.refineMs;
  return since >= heartbeatFor(idle, policy);
}

/** How long a peer's last presence stays visible: the interval it announced, times staleFactor. */
export function presenceStaleMs(announcedHeartbeatMs, policy = PRESENCE) {
  const hb = Number.isFinite(announcedHeartbeatMs) && announcedHeartbeatMs > 0 ? Math.min(announcedHeartbeatMs, policy.idleHeartbeatMs) : policy.heartbeatMs;
  return hb * policy.staleFactor;
}

/** The paragraph part of an editor anchor; typing inside one paragraph changes only the offset part. */
export function anchorParagraph(anchor) {
  if (!anchor) return '';
  return anchor.key ?? JSON.stringify(anchor.fallback ?? anchor);
}
