export const DEFAULT_TEAM = { id: "jangwon", name: "장원급제" };
export const KNOWN_TEAMS = [DEFAULT_TEAM, { id: "team-2", name: "2팀" }];

export function validTeamId(id) {
  return typeof id === "string" && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id);
}

export function resolveTeam(search) {
  const params = new URLSearchParams(search);
  const id = params.get("team") ?? DEFAULT_TEAM.id;
  if (!validTeamId(id)) return null;
  return KNOWN_TEAMS.find(team => team.id === id) ?? null;
}

export function teamUrl(id, href) {
  if (!validTeamId(id) || !KNOWN_TEAMS.some(team => team.id === id)) {
    throw new Error("등록된 팀만 열 수 있습니다.");
  }
  const url = new URL(href);
  if (id === DEFAULT_TEAM.id) url.searchParams.delete("team");
  else url.searchParams.set("team", id);
  return url.href;
}
