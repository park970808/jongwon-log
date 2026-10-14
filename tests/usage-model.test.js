// Spark(무료) 한도 회귀 방지: 묶음 간격·커서 정책·인라인 기록이 바뀌어 사용량이 다시 늘면 실패합니다.
// 규칙 읽기 과금은 공식 문서로 확인되지 않은 부분이 있어, 과금된다고 보는 최악 기준으로 검사합니다.
import test from 'node:test';import assert from 'node:assert/strict';
import {model,day,RULES} from '../scripts/firestore-usage-model.mjs';
import {batchForPeers,DEFAULT_BATCH} from '../src/sync-provider.js';

for(const devices of ['cached','fresh']){
  test(`busy Friday hour on ${devices} devices stays inside the Spark daily quota with headroom (worst-case rules billing)`,()=>{
    const m=model(devices,{rulesPerUpdate:RULES.worst}),best=model(devices,{rulesPerUpdate:RULES.best});
    assert.ok(m.new.writesPct<=15,`writes ${m.new.writesPct}% of the daily free quota`);
    assert.ok(m.new.readsPct<=60,`reads ${m.new.readsPct}% of the daily free quota (worst case)`);
    assert.ok(best.new.readsPct<=40,`reads ${best.new.readsPct}% of the daily free quota (rules reads not billed per update)`);
    assert.ok(m.old.writes/m.new.writes>=10&&m.old.reads/m.new.reads>=20,'large reduction versus the previous transport');
  });
  test(`a whole class day with the document left open on ${devices} devices stays inside the quota (worst case)`,()=>{
    const d=day(devices,{rulesPerUpdate:RULES.worst});
    assert.ok(d.writesPct<=15,`writes ${d.writesPct}%`);assert.ok(d.readsPct<=75,`reads ${d.readsPct}%`);
    assert.ok(d.idlePresenceWritesPerUser<=60,`${d.idlePresenceWritesPerUser} idle heartbeats per person over 7 hours`);
  });
}

test('batching adapts to the number of open sessions and stays bounded',()=>{
  assert.equal(batchForPeers(0),DEFAULT_BATCH);assert.equal(batchForPeers(1),DEFAULT_BATCH);assert.equal(batchForPeers(NaN),DEFAULT_BATCH);
  let previous=DEFAULT_BATCH.maxWaitMs;
  for(let n=2;n<=20;n++){const b=batchForPeers(n);assert.ok(b.maxWaitMs>=previous&&b.maxWaitMs<=9000,`peers ${n}: ${b.maxWaitMs} ms`);previous=b.maxWaitMs;}
});
