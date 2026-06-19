#!/usr/bin/env node
/**
 * World Cup 2026 — group standings + tiebreak data refresher
 * ---------------------------------------------------------
 * Pulls /standings/seasons/26618 + group-stage fixtures from Sportmonks v3,
 * computes per-team card-based fair-play scores and the list of finished
 * head-to-head matches, then writes a flat wc-data.json the widget reads.
 *
 * The widget applies FIFA art. 12 tiebreaks against this dataset:
 *   1) points
 *   2) head-to-head pts / gd / gf among the teams tied on points
 *   3) overall gd / gf / fair-play across the three group games
 *
 * Card scoring (FIFA art. 13 — one worst penalty per player per match):
 *   1 yellow  = -1
 *   2nd yellow (yellow-red, type 21) = -3 (priority)
 *   Red direct (type 20)             = -4
 *   Yellow + red direct              = -5
 *   2 yellows fallback (no type 21)  = -3
 *
 * Local run: SPORTMONKS_API_TOKEN=... node fetch-wc-data.js
 * CI run:    .github/workflows/refresh-wc-data.yml (cron every 15 min).
 */

const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const API_TOKEN = process.env.SPORTMONKS_API_TOKEN;
if (!API_TOKEN) {
  console.error("✗ SPORTMONKS_API_TOKEN missing (export it or write a .env file).");
  process.exit(1);
}

const BASE = "https://api.sportmonks.com/v3/football";
const SEASON_ID = 26618;
const LEAGUE_ID = 732;                              // FIFA World Cup
const GROUP_WINDOW = ["2026-06-11", "2026-06-27"];  // group-stage fixtures window
const GROUPS = ["A","B","C","D","E","F","G","H","I","J","K","L"];

function det(details, code) {
  if (!Array.isArray(details)) return 0;
  const d = details.find((x) => x && x.type && x.type.code === code);
  return d ? Number(d.value) || 0 : 0;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sportmonks ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Single pass over the group-stage fixtures window. Returns:
 *  - fair    : per-participant_id fair-play score (sum of negative penalties)
 *  - matches : finished matches as [{a, ga, b, gb}] for head-to-head tiebreaks
 */
async function computeFromFixtures(stageId) {
  const [start, end] = GROUP_WINDOW;
  const fair = {};
  const matches = [];
  let page = 1;
  for (;;) {
    const url =
      `${BASE}/fixtures/between/${start}/${end}` +
      `?api_token=${API_TOKEN}&include=participants;scores;events.type` +
      `&filters=fixtureLeagues:${LEAGUE_ID}&per_page=50&page=${page}`;
    const json = await getJSON(url);
    const fixtures = json.data || [];

    for (const fx of fixtures) {
      if (stageId && fx.stage_id !== stageId) continue; // group-stage only

      // Cards → fair-play (one worst per player per match)
      const byPlayer = {};
      for (const ev of fx.events || []) {
        if (ev.rescinded) continue;
        const t = ev.type_id;
        if (t !== 19 && t !== 20 && t !== 21) continue; // yellow / red / yellow-red
        const part = ev.participant_id;
        const who = ev.player_id != null ? "p" + ev.player_id : "c" + ev.coach_id;
        const key = part + ":" + who;
        const o = byPlayer[key] || (byPlayer[key] = { part: part, y: 0, r: 0, yr: 0 });
        if (t === 19) o.y++;
        else if (t === 20) o.r++;
        else o.yr++;
      }
      for (const key in byPlayer) {
        const o = byPlayer[key];
        let p = 0;
        if (o.yr >= 1) p = -3;
        else if (o.r >= 1 && o.y >= 1) p = -5;
        else if (o.r >= 1) p = -4;
        else if (o.y >= 2) p = -3;
        else if (o.y === 1) p = -1;
        fair[o.part] = (fair[o.part] || 0) + p;
      }

      // Finished match results → H2H matches list
      if (fx.state_id === 5) { // Full-Time
        const goals = {};
        for (const s of fx.scores || []) {
          if (s.description === "CURRENT" && s.participant_id != null && s.score) {
            goals[s.participant_id] = s.score.goals;
          }
        }
        const ids = Object.keys(goals);
        if (ids.length === 2) {
          matches.push({ a: +ids[0], ga: goals[ids[0]], b: +ids[1], gb: goals[ids[1]] });
        }
      }
    }

    const pg = json.pagination || {};
    if (!pg.has_more) break;
    page++;
    if (page > 10) break;
  }
  return { fair, matches };
}

async function main() {
  // 1) Standings → 4 teams per group with overall stats
  const standings = await getJSON(
    `${BASE}/standings/seasons/${SEASON_ID}?api_token=${API_TOKEN}&include=participant;group;details.type`
  );
  const rows = standings.data || [];
  if (!rows.length) throw new Error("Empty standings response.");
  const stageId = rows[0].stage_id;

  // 2) Fixtures → fair-play scores + finished H2H matches
  const { fair: fairByTeam, matches } = await computeFromFixtures(stageId);

  // 3) Bucket teams by group letter
  const groups = {};
  GROUPS.forEach((g) => (groups[g] = []));

  for (const entry of rows) {
    const groupName = (entry.group && entry.group.name) || "";
    const m = groupName.match(/group\s+([A-La-l])/i);
    if (!m) continue;
    const letter = m[1].toUpperCase();
    if (!GROUPS.includes(letter)) continue;

    const p = entry.participant || {};
    const details = entry.details;
    if (groups[letter].length < 4) {
      groups[letter].push({
        id: p.id || 0,
        team: p.name || p.short_code || "",
        played: det(details, "overall-matches-played"),
        points: Number(entry.points) || det(details, "overall-points") || 0,
        gf: det(details, "overall-goals-for"),
        ga: det(details, "overall-goals-against"),
        fair: fairByTeam[p.id] || 0,
        logo: p.image_path || "",
      });
    }
  }

  const out = {
    updated: new Date().toISOString(),
    source: `Sportmonks v3 /standings/seasons/${SEASON_ID} + fixtures.between/${GROUP_WINDOW[0]}/${GROUP_WINDOW[1]}`,
    season: 2026,
    groups,
    matches, // [{a, ga, b, gb}] used by the widget for H2H tiebreaks
  };

  const filePath = path.join(__dirname, "wc-data.json");
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + "\n");

  const filledGroups = GROUPS.filter((g) => groups[g].length > 0).length;
  const totalTeams = GROUPS.reduce((s, g) => s + groups[g].length, 0);
  console.log(
    `✓ wc-data.json written — ${filledGroups}/12 groups, ${totalTeams} teams, ${matches.length} H2H match(es), ` +
      `${Object.keys(fairByTeam).length} team(s) with cards.`
  );
}

main().catch((e) => {
  console.error("✗", e.message || e);
  process.exit(1);
});
