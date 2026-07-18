// Builds project/wcData.js from openfootball's public-domain 2026 World Cup data.
//   node scripts/build-wcdata.mjs
// No API key required. Run on a schedule (GitHub Action) for a near-live site.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026";
// ESPN's public (unofficial, key-less) scoreboard enriches the openfootball base
// two ways:
//   1. penalty-shootout takers (openfootball never carries them);
//   2. a full-time RESULT FALLBACK — openfootball's auto-gen only refreshes every
//      ~3-6h, so a finished match can sit "unplayed" in the base for hours. Any
//      completed ESPN event whose openfootball match is still unplayed gets its
//      score/pens/goals baked in as a provisional result BEFORE build() runs, so
//      standings, bracket propagation, champion and featured path all cascade.
//      openfootball stays authoritative: every run rebuilds from the feed, so its
//      own data replaces the provisional result as soon as it catches up.
// Best-effort: if the ESPN fetch fails, the build still produces a complete file.
// limit=200: the scoreboard silently caps at 100 events by default and the
// tournament has 104 — without it the last four matches (incl. the final) vanish.
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200";
// per-match summary carries the FULL shootout (every kick, incl. misses, in order),
// which the scoreboard's play list does not — fetched only for ties that went to pens.
const ESPN_SUMMARY = id => "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=" + id;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "project", "wcData.js");

// ---- editorial / cosmetic reference data (not in the source feed) -----------
const GROUP_COLORS = { A:"#2bb673", B:"#2f6fde", C:"#e0453f", D:"#e0a32a", E:"#9b5de5",
  F:"#f15a29", G:"#17b890", H:"#3b82f6", I:"#1d4ed8", J:"#56b6e8", K:"#7c5cff", L:"#ff7a45" };
// Nicer display names (source uses a few short forms)
const DISPLAY = { "USA":"United States", "South Korea":"Korea Republic", "Turkey":"Türkiye",
  "Ivory Coast":"Côte d'Ivoire", "Cape Verde":"Cabo Verde", "Iran":"IR Iran", "Czech Republic":"Czechia" };
// flagcdn wants subdivision codes for the home nations; source gives a plain GB flag
const ISO_OVERRIDE = { ENG:"gb-eng", SCO:"gb-sct", WAL:"gb-wls", NIR:"gb-nir" };
const ABBR = { "-7":"PDT", "-6":"CST", "-5":"CDT", "-4":"EDT" };
const FEATURED = "ARG"; // "[X]'s Road" highlight path; editorial, decide later

const KO_ROUND = { "Round of 32":"R32", "Round of 16":"R16", "Quarter-final":"QF",
  "Semi-final":"SF", "Match for third place":"TP", "Final":"F" };

// Static feeder tree (openfootball match numbers). The bracket structure never
// changes during the tournament, but the feed REPLACES a "W73" slot with the
// resolved team name once that match is played — so we can't read feeders from
// the live labels. Keyed by match num; values are [homeFeederNum, awayFeederNum].
const FEEDERS_NUM = {
  89:[74,77], 90:[73,75], 91:[76,78], 92:[79,80],
  93:[83,84], 94:[81,82], 95:[86,88], 96:[85,87],
  97:[89,90], 98:[93,94], 99:[91,92], 100:[95,96],
  101:[97,98], 102:[99,100], 104:[101,102],
};

async function getJSON(name){
  const r = await fetch(`${BASE}/${name}`);
  if(!r.ok) throw new Error(`fetch ${name} -> ${r.status}`);
  return r.json();
}
const slug = s => s.toLowerCase().replace(/\(.*?\)/g,"").trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const cleanCity = s => s.replace(/\s*\(.*?\)\s*/g,"").trim();
const isoFromUnicode = u => (u.match(/1F1[0-9A-F]{2}/g)||[]).map(c=>String.fromCharCode(parseInt(c,16)-0x1F1E6+97)).join("");
// base minute (before "+") for sorting; raw label ("90+4") for display
const minNum = m => parseInt(String(m).split("+")[0].match(/\d+/)?.[0] ?? "0", 10);
const minLabel = m => String(m).replace(/\s+/g,"");
const isPlayed = m => !!(m.score && Array.isArray(m.score.ft) && m.score.ft.length===2);

// ---- ESPN scoreboard (single fetch feeds shootouts + result fallback) -------
async function getScoreboard(){
  try{ const r = await fetch(ESPN); if(!r.ok) return []; return (await r.json()).events || []; }
  catch{ return []; }
}

// ---- ESPN penalty-shootout takers (best-effort enrichment) ------------------
// ESPN abbreviations are the same FIFA 3-letter codes openfootball uses, so we
// key an event by its sorted pair of codes (a pairing is unique in the bracket).
async function getShootouts(events){
  // find every tie that went to a shootout; keep its ESPN event id + team-id -> code map
  const ties = [];
  for(const ev of events||[]){
    const c = ev.competitions && ev.competitions[0]; if(!c || !c.competitors) continue;
    const hasSO = c.competitors.some(t => t.shootoutScore != null) || (c.details||[]).some(d => d.shootout);
    if(!hasSO) continue;
    const codeOf = {}; c.competitors.forEach(t => { codeOf[t.team.id] = t.team.abbreviation; });
    ties.push({ event: ev, id: ev.id, codeOf, pair: c.competitors.map(t => t.team.abbreviation).sort().join("|") });
  }
  const byPair = {};
  await Promise.all(ties.map(async t => {
    // primary: the summary endpoint has the complete shootout (misses included, in order)
    let takers = await summaryTakers(t.id, t.codeOf);
    // fallback: the scoreboard event only lists the SCORED kicks
    if(!takers) takers = scoreboardTakers(t.event, t.codeOf);
    if(takers && takers.length) byPair[t.pair] = takers;
  }));
  return byPair;
}
// full shootout from ESPN's match summary: every kick with taker + scored/missed, in order
async function summaryTakers(eventId, codeOf){
  let sum;
  try{ const r = await fetch(ESPN_SUMMARY(eventId)); if(!r.ok) return null; sum = await r.json(); }
  catch{ return null; }
  if(!Array.isArray(sum.shootout) || !sum.shootout.length) return null;
  const rows = [];
  for(const team of sum.shootout){
    const code = codeOf[team.id] || null;
    for(const s of team.shots || []) rows.push({ code, player: s.player, scored: !!s.didScore, order: s.shotNumber });
  }
  rows.sort((a, b) => a.order - b.order);   // interleave both teams into shootout order
  const out = rows.filter(r => r.code && r.player).map(r => ({ code: r.code, player: r.player, scored: r.scored }));
  return out.length ? out : null;
}
// scored-only fallback: the scoreboard play list (used if a summary fetch fails)
function scoreboardTakers(ev, codeOf){
  const c = ev.competitions && ev.competitions[0]; if(!c) return null;
  const out = (c.details||[]).filter(d => d.shootout).map(d => ({
    code: codeOf[d.team && d.team.id] || null,
    player: (d.athletesInvolved && d.athletesInvolved[0] && d.athletesInvolved[0].displayName) || "",
    scored: d.scoreValue === 1 || /scored/i.test((d.type && d.type.text) || ""),
  })).filter(t => t.code && t.player);
  return out.length ? out : null;
}

// ---- ESPN full-time results (fallback for a lagging openfootball feed) ------
// Completed scoreboard events, in a shape ready to merge into raw feed matches.
function getFinals(events){
  const finals = [];
  for(const ev of events||[]){
    const st = (ev.status && ev.status.type) || {};
    if(st.state !== "post" || st.completed === false) continue;
    const c = ev.competitions && ev.competitions[0];
    if(!c || !c.competitors || c.competitors.length !== 2) continue;
    const score = {}, so = {}, codeOf = {};
    let ok = true;
    for(const t of c.competitors){
      const code = t.team && t.team.abbreviation;
      if(!code || t.score == null || Number.isNaN(+t.score)){ ok = false; break; }
      codeOf[t.team.id] = code; score[code] = +t.score;
      if(t.shootoutScore != null) so[code] = +t.shootoutScore;
    }
    const dateMs = Date.parse(ev.date);
    if(!ok || !dateMs) continue;
    const pens = Object.keys(so).length === 2;
    // ESPN's score is the aggregate incl. extra time; pens imply the tie went 120'
    const aet = pens || /AET/i.test([st.name, st.detail, st.shortDetail].join(" "));
    // goal details in openfootball's shape (listed under the team that BENEFITS,
    // own goals included — same convention both sources use). The scoreboard's
    // details can lag its score, so these are cosmetic; the score drives the site.
    const goals = {};
    for(const d of c.details || []){
      if(!d.scoringPlay || d.shootout) continue;
      const code = codeOf[d.team && d.team.id];
      const name = d.athletesInvolved && d.athletesInvolved[0] && d.athletesInvolved[0].displayName;
      if(!code || !name) continue;
      (goals[code] = goals[code] || []).push({ name, minute: ((d.clock && d.clock.displayValue) || "").replace(/'/g, ""), penalty: !!d.penaltyKick, owngoal: !!d.ownGoal });
    }
    finals.push({ pair: Object.keys(score).sort().join("|"), dateMs, score, so: pens ? so : null, aet, goals });
  }
  return finals;
}

// Bake ESPN finals into raw feed matches that are still unplayed. Runs BEFORE
// build(), so everything derived (standings, thirds, knockout propagation,
// champion, featured path) cascades from the provisional result automatically.
function applyEspnFinals(wc, teamsRaw, stadiumsRaw, finals){
  if(!finals.length) return 0;
  const codeOfName = {}; for(const t of teamsRaw) codeOfName[t.name] = t.fifa_code;
  const tzOfCity = {}; for(const s of stadiumsRaw.stadiums) tzOfCity[s.city] = parseInt(s.timezone.replace("UTC",""),10);
  const kickoff = m => {
    const dp = m.date.split("-").map(Number);
    const tp = ((m.time||"12:00").split(" ")[0]).split(":").map(Number);
    return Date.UTC(dp[0], dp[1]-1, dp[2], tp[0], tp[1]) - (tzOfCity[m.ground] ?? -5)*3600000;
  };
  let applied = 0;
  for(const f of finals){
    // a pairing can occur twice (group meeting + knockout rematch): pick the
    // unplayed candidate nearest the event's kickoff, and never merge across
    // more than 6h of drift (protects against a mis-keyed event)
    const cands = wc.matches.filter(m => {
      if(isPlayed(m)) return false;
      const a = codeOfName[m.team1], b = codeOfName[m.team2];
      return a && b && [a, b].sort().join("|") === f.pair;
    });
    if(!cands.length) continue;
    const m = cands.reduce((x, y) => Math.abs(kickoff(x)-f.dateMs) <= Math.abs(kickoff(y)-f.dateMs) ? x : y);
    if(Math.abs(kickoff(m) - f.dateMs) > 6*3600000) continue;
    const hc = codeOfName[m.team1], ac = codeOfName[m.team2];
    m.score = { ft: [f.score[hc], f.score[ac]] };
    if(f.aet) m.score.et = [f.score[hc], f.score[ac]];
    if(f.so) m.score.p = [f.so[hc], f.so[ac]];
    m.goals1 = f.goals[hc] || []; m.goals2 = f.goals[ac] || [];
    applied++;
  }
  return applied;
}

function build(teamsRaw, groupsRaw, stadiumsRaw, squadsRaw, wc, shootouts){
  // ---- teams -------------------------------------------------------------
  const nameToCode = {}, teams = {};
  for(const t of teamsRaw){
    const code = t.fifa_code;
    nameToCode[t.name] = code;
    teams[code] = {
      name: DISPLAY[t.name] || t.name,
      iso: ISO_OVERRIDE[code] || isoFromUnicode(t.flag_unicode),
    };
  }
  for(const sq of squadsRaw){
    const code = sq.fifa_code; if(!teams[code]) continue;
    teams[code].players = (sq.players||[]).filter(p=>p.pos!=="GK").slice(0,4).map(p=>p.name);
  }
  const code = name => nameToCode[name] || null;

  // ---- venues ------------------------------------------------------------
  const venues = {}, cityToVenue = {};
  for(const s of stadiumsRaw.stadiums){
    const tz = parseInt(s.timezone.replace("UTC",""),10);
    const key = slug(s.name);
    venues[key] = { city: cleanCity(s.city), stadium: s.name, tz, abbr: ABBR[String(tz)] || `UTC${tz}` };
    cityToVenue[s.city] = key;
  }
  const venueOf = ground => cityToVenue[ground] ?? slug(ground);

  // ---- groups ------------------------------------------------------------
  const groupDef = {};
  for(const g of groupsRaw.groups){
    const letter = g.name.replace("Group ","").trim();
    groupDef[letter] = g.teams.map(code);
  }

  // ---- group matches -----------------------------------------------------
  // Goals are listed under the team that BENEFITS (own goals included), so the
  // count is correct; we just carry pen/og flags so the UI can tag them.
  const scorers = (goals, c) => (goals||[]).map(g => ({ code:c, player:g.name, min:minNum(g.minute), minLabel:minLabel(g.minute), pen:!!g.penalty, og:!!g.owngoal }));
  const groupMatches = [];
  let gi = 0;
  for(const m of wc.matches){
    const md = /^Matchday (\d+)$/.exec(m.round);
    if(!md) continue;
    const home = code(m.team1), away = code(m.team2);
    const played = isPlayed(m);
    const ft = played ? m.score.ft : [null, null];
    groupMatches.push({
      id: "G"+(++gi), group: (m.group||"").replace("Group ","").trim(), md: +md[1],
      homeCode: home, awayCode: away, venue: venueOf(m.ground),
      date: m.date, time: (m.time||"").split(" ")[0],
      score: ft, ht: played ? (m.score.ht || null) : null, played,
      scorers: played ? [...scorers(m.goals1, home), ...scorers(m.goals2, away)].sort((a,b)=>a.min-b.min) : [],
    });
  }
  // openfootball numbers matchdays globally (1..17); remap to per-group MD 1..3
  for(const letter of Object.keys(groupDef)){
    const ms = groupMatches.filter(m => m.group === letter);
    const order = [...new Set(ms.map(m => m.md))].sort((a,b)=>a-b);
    ms.forEach(m => { m.md = order.indexOf(m.md) + 1; });
  }

  // ---- standings + thirds (computed from played group matches) -----------
  const standings = {};
  for(const [letter, codes] of Object.entries(groupDef)){
    const row = {}; codes.forEach(c => row[c] = { code:c, p:0,w:0,d:0,l:0,gf:0,ga:0,gd:0,pts:0 });
    for(const m of groupMatches){
      if(m.group!==letter || !m.played) continue;
      const [hg, ag] = m.score, H = row[m.homeCode], A = row[m.awayCode];
      H.p++; A.p++; H.gf+=hg; H.ga+=ag; A.gf+=ag; A.ga+=hg;
      if(hg>ag){ H.w++; A.l++; H.pts+=3; } else if(hg<ag){ A.w++; H.l++; A.pts+=3; } else { H.d++; A.d++; H.pts++; A.pts++; }
    }
    Object.values(row).forEach(r => r.gd = r.gf - r.ga);
    standings[letter] = Object.values(row).sort((a,b)=> b.pts-a.pts || b.gd-a.gd || b.gf-a.gf);
  }
  const thirds = Object.entries(standings).map(([g, rows]) => ({ ...rows[2], group:g }))
    .sort((a,b)=> b.pts-a.pts || b.gd-a.gd || b.gf-a.gf).slice(0,8)
    .map(t => ({ code:t.code, group:t.group, pts:t.pts, gd:t.gd, gf:t.gf }));

  // ---- knockout (real feeder tree from "W<num>" labels) ------------------
  const koSrc = wc.matches.filter(m => KO_ROUND[m.round]);
  // 73..102 -> 1..30, Final(104) -> 31, third-place play-off(103) -> 32
  const idOf = num => num === 104 ? 31 : num === 103 ? 32 : num - 72;
  // feeders in bracket-id space (1..31), from the static structure above
  const feedersOf = num => { const f = FEEDERS_NUM[num]; return f ? [idOf(f[0]), idOf(f[1])] : null; };
  // the feed's "L101"/"L102" (semi-final losers -> third place) remapped to bracket ids
  const slotLabel = raw => { const l = /^L(\d+)$/.exec(raw || ""); return l ? "L" + idOf(+l[1]) : (raw || ""); };
  const knockout = [];
  for(const m of koSrc){
    const id = idOf(m.num);
    const round = KO_ROUND[m.round];
    const feeders = feedersOf(m.num);             // [homeFeederId, awayFeederId] or null (R32, third place)
    const home = code(m.team1), away = code(m.team2);  // null while a slot is still "W##"/"L##"
    const played = isPlayed(m);
    // openfootball keeps ft = score after 90', et = aggregate after extra time,
    // p = penalty-shootout tally. Show the post-ET score when a tie went the
    // distance so the box/modal reflect the actual result, not the 90' draw.
    const et = played && Array.isArray(m.score.et) && m.score.et.length === 2 ? m.score.et : null;
    const pens = (m.score && m.score.p) ? m.score.p : null;
    const finalScore = played ? (et || m.score.ft) : [null, null];
    let winner = null;
    if(played){ winner = finalScore[0]>finalScore[1] ? home : finalScore[0]<finalScore[1] ? away : pens ? (pens[0]>pens[1]?home:away) : null; }
    // penalty-shootout takers from ESPN, keyed by the sorted code pair (only when this tie went to pens)
    const shootout = (pens && home && away) ? (shootouts[[home,away].sort().join("|")] || null) : null;
    knockout.push({
      id, num:m.num, round, feeders,
      hsLabel: home ? (teams[home]?.name||home) : (feeders ? "W"+feeders[0] : slotLabel(m.team1)),
      asLabel: away ? (teams[away]?.name||away) : (feeders ? "W"+feeders[1] : slotLabel(m.team2)),
      homeCode: home, awayCode: away,
      venue: venueOf(m.ground), date: m.date, time: (m.time||"").split(" ")[0],
      score: finalScore, ht: played ? (m.score.ht || null) : null, pens, shootout, aet: !!et, winner, played,
      scorers: played ? [...scorers(m.goals1, home), ...scorers(m.goals2, away)].sort((a,b)=>a.min-b.min) : [],
    });
  }
  knockout.sort((a,b)=>a.id-b.id);
  const koById = {}; knockout.forEach(k => koById[k.id] = k);

  // Propagate decided results into still-unresolved slots. The feed only fills
  // a "W23"/"L29" slot on its own ~3-6h auto-gen cycle, so between a tie ending
  // and the next feed refresh the winner has no next match in the data (which
  // read as "tournament is complete"). Ascending id order cascades round by
  // round; a code already set by the feed is left untouched.
  const loserOf = k => (k && k.played && k.winner && k.homeCode && k.awayCode)
    ? (k.winner === k.homeCode ? k.awayCode : k.homeCode) : null;
  for(const k of knockout){
    const fill = (side, label) => {
      if(k[side]) return;
      let c = null;
      const l = /^L(\d+)$/.exec(k[label]);
      if(l) c = loserOf(koById[+l[1]]);                    // third place: SF losers
      else if(k.feeders){
        const f = koById[k.feeders[side === "homeCode" ? 0 : 1]];
        if(f && f.played) c = f.winner;
      }
      if(c){ k[side] = c; k[label] = teams[c]?.name || c; }
    };
    fill("homeCode", "hsLabel");
    fill("awayCode", "asLabel");
  }

  // featured path: matches (in round order) the featured team actually appears in
  const pathFor = c => knockout.filter(k => k.homeCode===c || k.awayCode===c).map(k => k.id);
  const champion = koById[31]?.winner || null;

  return { generatedAt: new Date().toISOString(), source: "openfootball/worldcup.json",
    champion, venues, teams, groupDef, groupColors: GROUP_COLORS,
    groupMatches, standings, thirds, knockout,
    featured: FEATURED, featuredPath: pathFor(FEATURED) };
}

const [teamsRaw, groupsRaw, stadiumsRaw, squadsRaw, wc, events] = await Promise.all([
  getJSON("worldcup.teams.json"), getJSON("worldcup.groups.json"), getJSON("worldcup.stadiums.json"),
  getJSON("worldcup.squads.json"), getJSON("worldcup.json"), getScoreboard(),
]);
// dev rehearsal: WC_SIM_STALE="101,102" strips those openfootball match numbers'
// results before the ESPN merge, simulating the feed lagging a finished match —
// the ESPN fallback should then rebuild them as provisional results.
for(const n of (process.env.WC_SIM_STALE || "").split(",").filter(Boolean)){
  const m = wc.matches.find(x => x.num === +n);
  if(m){ delete m.score; delete m.goals1; delete m.goals2; console.log(`sim-stale: stripped result of match ${n}`); }
}
const provisional = applyEspnFinals(wc, teamsRaw, stadiumsRaw, getFinals(events));
const shootouts = await getShootouts(events);
const data = build(teamsRaw, groupsRaw, stadiumsRaw, squadsRaw, wc, shootouts);
writeFileSync(OUT, "window.WC_DATA = " + JSON.stringify(data) + ";\n", "utf-8");
const played = data.groupMatches.filter(m=>m.played).length + data.knockout.filter(k=>k.played).length;
const withTakers = data.knockout.filter(k=>k.shootout && k.shootout.length).length;
console.log(`wrote ${OUT}`);
console.log(`teams=${Object.keys(data.teams).length} groupMatches=${data.groupMatches.length} knockout=${data.knockout.length} played=${played} espnProvisional=${provisional} shootoutTakers=${withTakers} champion=${data.champion||"(undecided)"}`);
