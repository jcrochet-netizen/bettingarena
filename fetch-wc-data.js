#!/usr/bin/env node
/**
 * World Cup 2026 — group standings refresher
 * ------------------------------------------
 * Pulls /standings/seasons/26618 from Sportmonks v3, groups by Group A-L,
 * writes a flat wc-data.json the widget reads from /bettingarena/wc-data.json.
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
const GROUPS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

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

async function main() {
  const url =
    `${BASE}/standings/seasons/${SEASON_ID}` +
    `?api_token=${API_TOKEN}&include=participant;group;details.type`;
  const json = await getJSON(url);
  const rows = json.data || [];
  if (!rows.length) throw new Error("Empty standings response.");

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
        team: p.name || p.short_code || "",
        played: det(details, "overall-matches-played"),
        points: Number(entry.points) || det(details, "overall-points") || 0,
        gf: det(details, "overall-goals-for"),
        ga: det(details, "overall-goals-against"),
        logo: p.image_path || "",
      });
    }
  }

  const out = {
    updated: new Date().toISOString(),
    source: `Sportmonks v3 /standings/seasons/${SEASON_ID}`,
    season: 2026,
    groups,
  };

  const filePath = path.join(__dirname, "wc-data.json");
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + "\n");

  const filledGroups = GROUPS.filter((g) => groups[g].length > 0).length;
  const totalTeams = GROUPS.reduce((s, g) => s + groups[g].length, 0);
  console.log(`✓ wc-data.json written — ${filledGroups}/12 groups, ${totalTeams} teams.`);
}

main().catch((e) => {
  console.error("✗", e.message || e);
  process.exit(1);
});
