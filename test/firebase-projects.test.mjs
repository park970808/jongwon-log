import test from "node:test";
import assert from "node:assert/strict";
import { firebaseConfigFor } from "../firebase-projects.mjs";
import { resolveTeam } from "../team-routing.mjs";

test("기존 링크는 기존 Firebase 프로젝트를 유지한다", () => {
  assert.equal(firebaseConfigFor(resolveTeam("").id).projectId, "jangwon-287b2");
});

test("2팀 링크는 독립된 Firebase 프로젝트를 사용한다", () => {
  const first=firebaseConfigFor("jangwon");
  const second=firebaseConfigFor(resolveTeam("?team=team-2").id);
  assert.equal(second.projectId, "jongwon-log-team-2");
  assert.notEqual(second.apiKey, first.apiKey);
  assert.notEqual(second.appId, first.appId);
});

test("등록되지 않은 팀은 다른 프로젝트로 연결하지 않는다", () => {
  assert.equal(firebaseConfigFor("team-3"), null);
  assert.equal(firebaseConfigFor("__proto__"), null);
});
