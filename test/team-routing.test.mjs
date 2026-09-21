import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TEAM, resolveTeam, teamUrl, validTeamId } from "../team-routing.mjs";

test("기존 주소는 기존 팀을 그대로 연다", () => {
  assert.deepEqual(resolveTeam(""), DEFAULT_TEAM);
  assert.deepEqual(resolveTeam("?utm_source=bookmark"), DEFAULT_TEAM);
});

test("두 팀의 주소와 이름을 구분한다", () => {
  assert.deepEqual(resolveTeam("?team=jangwon"), DEFAULT_TEAM);
  assert.deepEqual(resolveTeam("?team=team-2"), { id: "team-2", name: "2팀" });
  assert.equal(resolveTeam("?team=another-team"), null);
});

test("허용되지 않은 팀 ID를 데이터 경로로 사용하지 않는다", () => {
  for (const id of ["", "Team-A", "team/a", "a..b", "-team", "team-", "a".repeat(41)]) {
    assert.equal(validTeamId(id), false);
    assert.equal(resolveTeam(`?team=${encodeURIComponent(id)}`), null);
  }
  assert.equal(validTeamId("a"), true);
  assert.equal(validTeamId("team-2"), true);
});

test("GitHub Pages의 경로와 기존 쿼리를 유지한 채 팀을 전환한다", () => {
  const base="https://example.github.io/jongwon-log/?utm_source=bookmark#top";
  assert.equal(teamUrl("team-2",base),
    "https://example.github.io/jongwon-log/?utm_source=bookmark&team=team-2#top");
  assert.equal(teamUrl("jangwon",teamUrl("team-2",base)),base);
  assert.throws(()=>teamUrl("../other",base));
  assert.throws(()=>teamUrl("another-team",base));
});
