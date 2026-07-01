// Builds project/wcData.js from openfootball's public-domain 2026 World Cup data.
//   node scripts/build-wcdata.mjs
// No API key required. Run on a schedule (GitHub Action) for a near-live site.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026";
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
  "Semi-final":"SF", "Final":"F" };

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

function build(teamsRaw, groupsRaw, stadiumsRaw, squadsRaw, wc){
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
  // 73..102 -> 1..30, Final(104) -> 31, third-place play-off(103) -> skipped
  const idOf = num => num === 104 ? 31 : num === 103 ? null : num - 72;
  // feeders in bracket-id space (1..31), from the static structure above
  const feedersOf = num => { const f = FEEDERS_NUM[num]; return f ? [idOf(f[0]), idOf(f[1])] : null; };
  const knockout = [];
  for(const m of koSrc){
    const id = idOf(m.num);
    if(id === null) continue;                     // skip the third-place play-off (no slot in this bracket)
    const round = KO_ROUND[m.round];
    const feeders = feedersOf(m.num);             // [homeFeederId, awayFeederId] or null (R32)
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
    knockout.push({
      id, num:m.num, round, feeders,
      hsLabel: home ? (teams[home]?.name||home) : (feeders ? "W"+feeders[0] : (m.team1||"")),
      asLabel: away ? (teams[away]?.name||away) : (feeders ? "W"+feeders[1] : (m.team2||"")),
      homeCode: home, awayCode: away,
      venue: venueOf(m.ground), date: m.date, time: (m.time||"").split(" ")[0],
      score: finalScore, ht: played ? (m.score.ht || null) : null, pens, aet: !!et, winner, played,
      scorers: played ? [...scorers(m.goals1, home), ...scorers(m.goals2, away)].sort((a,b)=>a.min-b.min) : [],
    });
  }
  knockout.sort((a,b)=>a.id-b.id);
  const koById = {}; knockout.forEach(k => koById[k.id] = k);

  // featured path: matches (in round order) the featured team actually appears in
  const pathFor = c => knockout.filter(k => k.homeCode===c || k.awayCode===c).map(k => k.id);
  const champion = koById[31]?.winner || null;

  return { generatedAt: new Date().toISOString(), source: "openfootball/worldcup.json",
    champion, venues, teams, groupDef, groupColors: GROUP_COLORS,
    groupMatches, standings, thirds, knockout,
    featured: FEATURED, featuredPath: pathFor(FEATURED) };
}

const [teamsRaw, groupsRaw, stadiumsRaw, squadsRaw, wc] = await Promise.all([
  getJSON("worldcup.teams.json"), getJSON("worldcup.groups.json"), getJSON("worldcup.stadiums.json"),
  getJSON("worldcup.squads.json"), getJSON("worldcup.json"),
]);
const data = build(teamsRaw, groupsRaw, stadiumsRaw, squadsRaw, wc);
writeFileSync(OUT, "window.WC_DATA = " + JSON.stringify(data) + ";\n", "utf-8");
const played = data.groupMatches.filter(m=>m.played).length + data.knockout.filter(k=>k.played).length;
console.log(`wrote ${OUT}`);
console.log(`teams=${Object.keys(data.teams).length} groupMatches=${data.groupMatches.length} knockout=${data.knockout.length} played=${played} champion=${data.champion||"(undecided)"}`);
