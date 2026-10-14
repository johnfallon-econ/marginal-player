// One NBA season, straight to results: schedule, games, standings, play-in, playoffs.
//
// Team strength is the site's own team projection (team_proj.py): net rating is each
// available player's rating times his share of the 240 minutes (his demand scaled to 240,
// at most MAX_MPG). A game's margin is netScale x the difference in nets plus the home edge,
// with the game-to-game spread measured from our games around it (12_gm_data.py); netScale
// makes a point of net worth team_proj's fitted wins over a season.

export function rng(seed, state) {               // mulberry32: small, fast, reproducible
  let a = (state ?? seed) >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.normal = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  r.pick = (a) => a[Math.floor(r() * a.length)];
  r.state = () => a;                            // saved with the game, so a load resumes the stream
  r.shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  return r;
}
export const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) {                                 // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// ---- schedule -------------------------------------------------------------------------------
// The NBA formula: 4 games against each division rival (16); against the other ten conference
// teams, 4 games with six and 3 with four (36), the four rotating by season; 2 against every
// team in the other conference (30). Each team plays 2 of its four 3-game series at home, so
// every team has 41 home games.
export function schedule(teams, season, r) {
  const conf = {};
  for (const t of Object.values(teams)) ((conf[t.conf] ??= {})[t.div] ??= []).push(t.abbr);
  const games = [];
  const add = (h, a, n) => { for (let i = 0; i < n; i++) games.push(i % 2 ? [a, h] : [h, a]); };
  const three = new Set();
  for (const divs of Object.values(conf)) {
    const D = Object.values(divs).map((d) => d.slice().sort());
    for (const d of D) for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) add(d[i], d[j], 4);
    for (const [x, y] of [[0, 1], [0, 2], [1, 2]]) {
      const s = (season + 2 * x + y) % 5;                      // rotates the 3-game pairs by season
      for (let i = 0; i < 5; i++) {
        const b1 = D[y][(i + s) % 5], b2 = D[y][(i + s + 1) % 5];
        three.add(D[x][i] + b1); three.add(b1 + D[x][i]); three.add(D[x][i] + b2); three.add(b2 + D[x][i]);
        games.push([D[x][i], b1], [b1, D[x][i]], [D[x][i], b1]);   // the extra home game to x
        games.push([D[x][i], b2], [b2, D[x][i]], [b2, D[x][i]]);   // ... and to y
      }
      for (const a of D[x]) for (const b of D[y]) if (!three.has(a + b)) add(a, b, 4);
    }
  }
  const [E, W] = Object.values(conf).map((c) => Object.values(c).flat());
  for (const a of E) for (const b of W) add(a, b, 2);
  // pack into dates, opening night to the last day: at most one game per team per day
  r.shuffle(games);
  const days = [], left = games.slice();
  while (left.length) {
    const busy = new Set(), today = [];
    for (let i = 0; i < left.length && today.length < 15; i++) {
      const [h, a] = left[i];
      if (!busy.has(h) && !busy.has(a)) { busy.add(h); busy.add(a); today.push(left.splice(i--, 1)[0]); }
    }
    days.push(today);
  }
  return days;                                   // days[i] = [[home, away], ...]
}

// ---- team strength -------------------------------------------------------------------------
// Minutes: each available player's demand (the minutes his role gives him when he plays), handed
// out down the rotation until the night's 240 are gone -- the end of the bench gets a coach's DNP --
// at most maxMpg each; if injuries leave the demands short of 240, everyone's are scaled up to fill
// it. The Trade Lab's mpg is per TEAM game, availability already netted out; a man who is suiting
// up plays mpg / av, or injuries would be charged twice.
// A box score's minutes: the night's allocation (who plays is the rotation's), each man's varied by
// a mean-one lognormal draw with real game minutes' spread around a season's average at his role
// (K.nightCv, _gm_minutes.py), then scaled so the club's still sum to 240; none past 48.
export function boxMinutes(m, r, cv) {
  const v = m.map((x) => { if (!x) return 0; const s = Math.sqrt(Math.log(1 + cvAt(cv, x) ** 2)); return x * Math.exp(s * r.normal() - s * s / 2); });
  const k = 240 / v.reduce((a, x) => a + x, 0);
  return v.map((x) => Math.min(x * k, 48));
}
const cvAt = (t, x) => { const i = t.findIndex((c) => c[0] >= x);
  return i < 0 ? t.at(-1)[1] : i === 0 ? t[0][1] : t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); };
export function minutes(players, maxMpg = 36) {
  const dem = players.map((p) => Math.min(Math.max((p.mpg || 0) / (p.av ?? 1), 1), maxMpg));
  if (dem.reduce((a, x) => a + x, 0) >= 240) {
    const m = dem.map(() => 0);
    let left = 240;
    for (const i of dem.map((x, i) => i).sort((a, b) => dem[b] - dem[a])) { m[i] = Math.min(dem[i], left); left -= m[i]; }
    return m;
  }
  let m = dem.slice();
  for (let k = 0; k < 6; k++) {                  // scale, cap, rescale the uncapped
    const open = m.map((x, i) => (x < maxMpg ? i : -1)).filter((i) => i >= 0);
    const fixed = m.reduce((a, x) => a + (x >= maxMpg ? maxMpg : 0), 0);
    const s = (240 - fixed) / open.reduce((a, i) => a + dem[i], 0);
    m = m.map((x, i) => (x >= maxMpg ? maxMpg : Math.min(dem[i] * s, maxMpg)));
  }
  return m;
}
// A club's expected strength over its nights: each man plays on a night with his availability, and
// the night's 240 go down the rotation among those who do (minutes above), so a man's expected
// minutes are his availability times what the healthy men ahead of him leave, the distribution of
// their minutes built up a man at a time, a minute at a time. (The nights so short-handed that
// everyone is scaled up are left out: they are rare.) Projections use this; a night uses `net`.
export function expNet(players, maxMpg = 36) {
  const ps = players.map((p) => ({ p, d: Math.min(Math.max((p.mpg || 0) / (p.av ?? 1), 1), maxMpg), a: p.av ?? 1 }))
    .sort((x, y) => y.d - x.d);
  let dist = new Float64Array(241); dist[0] = 1;                   // P(the healthy men ahead have taken k minutes), k capped at 240
  let out = 0;
  for (const { p, d, a } of ps) {
    let em = 0;
    for (let k = 0; k <= 240; k++) if (dist[k]) em += dist[k] * Math.min(d, 240 - k);
    out += p.play * a * em / 48;
    const next = new Float64Array(241), dk = Math.round(d);
    for (let k = 0; k <= 240; k++) if (dist[k]) { next[k] += dist[k] * (1 - a); next[Math.min(k + dk, 240)] += dist[k] * a; }
    dist = next;
  }
  return out;
}
export const net = (players, maxMpg) => {
  const m = minutes(players, maxMpg);
  return players.reduce((a, p, i) => a + p.play * m[i] / 48, 0);
};

// Injury: a two-state chain of short spells averaging SPELL games, and now and then (K.longInj a
// season, calibrate.js) one long injury of 20-82 games from a random night, so a season's games
// missed have real seasons' long tail; the short spells make up the rest, so the share of games
// missed is 1 - av (the Trade Lab's availability) on average either way.
const SPELL = 8, LONG = [20, 82];
const LONG_SHARE = (() => { let a = 0, n = 0; for (let st = 0; st < 82; st++) for (let l = LONG[0]; l <= LONG[1]; l++) { a += Math.min(l, 82 - st); n++; } return a / n / 82; })();
function injuries(p, n, r, q = 0) {
  const out = new Array(n).fill(false), miss = Math.min(Math.max(1 - (p.av ?? 0.9), 0), 0.95);
  if (r() < q) { const st = Math.floor(r() * n), l = LONG[0] + Math.floor(r() * (LONG[1] - LONG[0] + 1)); for (let g = st; g < Math.min(st + l, n); g++) out[g] = true; }
  const ms = Math.max((miss - q * LONG_SHARE) / (1 - q * LONG_SHARE), 0);
  const toHurt = ms / ((1 - ms) * SPELL), heal = 1 / SPELL;
  let hurt = r() < ms;
  for (let g = 0; g < n; g++) { out[g] ||= hurt; hurt = hurt ? r() >= heal : r() < toHurt; }
  return out;
}

// ---- the regular season ----------------------------------------------------------------------
// league: { teams, players, const }, each player with `play` (his rating this season) and mpg.
// The season is a plain object, so a saved game can stop anywhere in it: startSeason draws the
// schedule and every rostered man's injury spells; simDays plays days up to (not including) `to`,
// reading rosters afresh, so trades and signings between calls take effect.
// record: { team: { w, l, h2h, confW, confL, divW, divL } }; results: [{ d, h, a, m }]
export function startSeason(league, season, r) {
  const { teams, players } = league, days = schedule(teams, season, r), hurt = {}, played = {}, rec = {};
  for (const ab in teams) {
    played[ab] = 0;
    for (const id of teams[ab].roster) hurt[id] = injuries(players[id], 82, r, league.const.longInj);
    rec[ab] = { w: 0, l: 0, h2h: {}, confW: 0, confL: 0, divW: 0, divL: 0 };
  }
  return { season, days, d: 0, hurt, played, record: rec, results: [], gp: {}, mins: {} };
}
export function simDays(league, st, r, to = st.days.length) {
  const { teams, players, const: K } = league;
  const strength = (ab) => {
    const g = st.played[ab]++;
    const avail = teams[ab].roster.map((id) => players[id]).filter((p) => !(st.hurt[p.id] ??= injuries(p, 82, r, K.longInj))[g]), m = minutes(avail, K.maxMpg);
    // the box score's minutes: the rotation up to the busiest real roles (K.roleCap), varied night to
    // night (blowouts, fouls, overtime); the night's strength is the rotation's at the cap the wins
    // model was fit with (maxMpg), as those swings mostly follow the score, not set it
    const box = boxMinutes(minutes(avail, K.roleCap), r, K.nightCv);
    avail.forEach((p, i) => { if (box[i] > 0) { st.gp[p.id] = (st.gp[p.id] || 0) + 1; st.mins[p.id] = (st.mins[p.id] || 0) + box[i]; } });
    return avail.reduce((a, p, i) => a + p.play * m[i] / 48, 0);
  };
  for (; st.d < Math.min(to, st.days.length); st.d++) for (const [h, a] of st.days[st.d]) {
    const rec = st.record, margin = K.netScale * (strength(h) - strength(a)) + K.hca + K.sigma * r.normal();
    const [W, L] = margin > 0 ? [h, a] : [a, h];
    rec[W].w++; rec[L].l++;
    rec[W].h2h[L] = (rec[W].h2h[L] || 0) + 1;
    if (teams[h].conf === teams[a].conf) { rec[W].confW++; rec[L].confL++; }
    if (teams[h].div === teams[a].div) { rec[W].divW++; rec[L].divL++; }
    st.results.push({ d: st.d, h, a, m: Math.round(margin) || (margin > 0 ? 1 : -1) });
  }
  return st;
}
// The whole season at once. hook: { frac, fn } or a list -- fn() runs before the day that share of
// the schedule in (the trade deadline falls about two-thirds through).
export function regularSeason(league, season, r, hook) {
  const st = startSeason(league, season, r);
  for (const hk of [].concat(hook || [])) { simDays(league, st, r, Math.floor(st.days.length * hk.frac)); hk.fn(); }
  return simDays(league, st, r);
}

// ---- standings and tiebreakers ---------------------------------------------------------------
// The NBA's two-team order, simplified to its common branches: head-to-head, division winner,
// division record (same division), conference record, then a draw of lots.
export function standings(teams, rec, r) {
  const out = {};
  for (const conf of ['East', 'West']) {
    const T = Object.keys(teams).filter((ab) => teams[ab].conf === conf);
    const pct = (ab) => rec[ab].w / (rec[ab].w + rec[ab].l);
    const divLead = new Set(Object.values(Object.groupBy(T, (ab) => teams[ab].div))
      .map((d) => d.slice().sort((x, y) => pct(y) - pct(x))[0]));
    const lots = Object.fromEntries(T.map((ab) => [ab, r()]));
    out[conf] = T.sort((x, y) => pct(y) - pct(x)
      || (rec[y].h2h[x] || 0) - (rec[x].h2h[y] || 0)
      || divLead.has(y) - divLead.has(x)
      || (teams[x].div === teams[y].div ? rec[y].divW - rec[x].divW : 0)
      || rec[y].confW - rec[x].confW
      || lots[y] - lots[x]);
  }
  return out;
}

// ---- play-in and playoffs ---------------------------------------------------------------------
// In steps, so the page can play the user's series a game at a time: postseasonStart (the play-in,
// then the first round's series), seriesGame, roundDone / nextRound; postseason runs it all.
// nets: each team's full-strength net for the postseason.
export const winP = (h, a, nets, K) => Phi((K.netScale * (nets[h] - nets[a]) + K.hca) / K.sigma);   // home side
function game(h, a, nets, K, r) { return K.netScale * (nets[h] - nets[a]) + K.hca + K.sigma * r.normal() > 0 ? h : a; }
const HOME = [0, 0, 1, 1, 0, 1, 0];                 // 2-2-1-1-1, home court to the higher seed (0)
export const seriesDone = (sr) => sr.w === 4 || sr.l === 4;
export function seriesGame(sr, nets, K, r) {
  if (seriesDone(sr)) return null;
  const n = sr.w + sr.l, h = HOME[n] ? sr.lo : sr.hi, a = h === sr.hi ? sr.lo : sr.hi;
  const m = K.netScale * (nets[h] - nets[a]) + K.hca + K.sigma * r.normal(), win = m > 0 ? h : a;
  (win === sr.hi ? sr.w++ : sr.l++);
  sr.g.push({ h, a, win, by: Math.max(Math.round(Math.abs(m)), 1) });
  return sr.g.at(-1);
}
// Best of seven, all at once.
export function series(hi, lo, nets, K, r) {
  const sr = { hi, lo, w: 0, l: 0, g: [] };
  while (!seriesDone(sr)) seriesGame(sr, nets, K, r);
  return { winner: sr.w === 4 ? hi : lo, games: `${sr.w}-${sr.l}` };
}
export function postseasonStart(teams, rec, stand, nets, K, r) {
  const playin = {}, seeds = {};
  for (const conf of ['East', 'West']) {
    const s = stand[conf];
    const w78 = game(s[6], s[7], nets, K, r), l78 = w78 === s[6] ? s[7] : s[6];
    const w910 = game(s[8], s[9], nets, K, r), l910 = w910 === s[8] ? s[9] : s[8];
    const eighth = game(l78, w910, nets, K, r);
    seeds[conf] = [...s.slice(0, 6), w78, eighth];
    playin[conf] = { w78, l78, w910, l910, eighth, out: [l910, eighth === l78 ? w910 : l78] };
  }
  const sr = (hi, lo, conf) => ({ hi, lo, conf, w: 0, l: 0, g: [] });
  const series = ['East', 'West'].flatMap((c) => { const S = seeds[c]; return [[0, 7], [3, 4], [2, 5], [1, 6]].map(([i, j]) => sr(S[i], S[j], c)); });
  return { playin, seeds, rec, nets, round: 0, series, rounds: [], champion: null };
}
export const roundDone = (po) => po.series.every(seriesDone);
// Record the finished round and pair its winners for the next (home court to the better record).
export function nextRound(po, r) {
  const res = {}, win = (x) => (x.w === 4 ? x.hi : x.lo);
  for (const x of po.series) res[`${x.hi}-${x.lo}`] = { winner: win(x), games: `${x.w}-${x.l}`, g: x.g };
  po.rounds.push(res);
  const better = (x, y) => (po.rec[x].w > po.rec[y].w || (po.rec[x].w === po.rec[y].w && r() < 0.5) ? [x, y] : [y, x]);
  if (po.round === 3) { po.champion = win(po.series[0]); po.series = []; return po; }
  const ws = po.series.map((x) => [win(x), x.conf]);
  po.series = po.round === 2 ? [better(ws[0][0], ws[1][0])].map(([hi, lo]) => ({ hi, lo, conf: 'Finals', w: 0, l: 0, g: [] }))
    : ws.filter((_, i) => i % 2 === 0).map(([x, c], i) => { const [hi, lo] = better(x, ws[2 * i + 1][0]); return { hi, lo, conf: c, w: 0, l: 0, g: [] }; });
  po.round++;
  return po;
}
export function postseason(teams, rec, stand, nets, K, r) {
  const po = postseasonStart(teams, rec, stand, nets, K, r);
  while (!po.champion) { for (const x of po.series) while (seriesGame(x, nets, K, r)); nextRound(po, r); }
  return po;
}
