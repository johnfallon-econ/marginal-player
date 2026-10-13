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
// Minutes: each available player's demand, scaled so the rotation fills 240, at most maxMpg.
// The Trade Lab's mpg is per TEAM game, availability already netted out; a man who is
// suiting up plays mpg / av, or injuries would be charged twice.
export function minutes(players, maxMpg = 36) {
  const dem = players.map((p) => Math.max((p.mpg || 0) / (p.av ?? 1), 1));
  let m = dem.slice(), free = 240;
  for (let k = 0; k < 6; k++) {                  // scale, cap, rescale the uncapped
    const open = m.map((x, i) => (x < maxMpg ? i : -1)).filter((i) => i >= 0);
    const fixed = m.reduce((a, x) => a + (x >= maxMpg ? maxMpg : 0), 0);
    const s = (free - fixed) / open.reduce((a, i) => a + dem[i], 0);
    m = m.map((x, i) => (x >= maxMpg ? maxMpg : Math.min(dem[i] * s, maxMpg)));
  }
  return m;
}
export const net = (players, maxMpg) => {
  const m = minutes(players, maxMpg);
  return players.reduce((a, p, i) => a + p.play * m[i] / 48, 0);
};

// Injury spells: a two-state chain per player, spells averaging SPELL games, whose share of
// games missed equals 1 - av (the Trade Lab's availability).
const SPELL = 8;
function injuries(p, n, r) {
  const out = new Array(n).fill(false), miss = Math.min(Math.max(1 - (p.av ?? 0.9), 0), 0.95);
  const toHurt = miss / ((1 - miss) * SPELL), heal = 1 / SPELL;
  let hurt = r() < miss;
  for (let g = 0; g < n; g++) { out[g] = hurt; hurt = hurt ? r() >= heal : r() < toHurt; }
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
    for (const id of teams[ab].roster) hurt[id] = injuries(players[id], 82, r);
    rec[ab] = { w: 0, l: 0, h2h: {}, confW: 0, confL: 0, divW: 0, divL: 0 };
  }
  return { season, days, d: 0, hurt, played, record: rec, results: [], gp: {}, mins: {} };
}
export function simDays(league, st, r, to = st.days.length) {
  const { teams, players, const: K } = league;
  const strength = (ab) => {
    const g = st.played[ab]++;
    const avail = teams[ab].roster.map((id) => players[id]).filter((p) => !(st.hurt[p.id] ??= injuries(p, 82, r))[g]), m = minutes(avail, K.maxMpg);
    avail.forEach((p, i) => { st.gp[p.id] = (st.gp[p.id] || 0) + 1; st.mins[p.id] = (st.mins[p.id] || 0) + m[i]; });
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
function game(h, a, nets, K, r) { return K.netScale * (nets[h] - nets[a]) + K.hca + K.sigma * r.normal() > 0 ? h : a; }
// Best of seven, 2-2-1-1-1, home court to `hi`.
export function series(hi, lo, nets, K, r) {
  let w = 0, l = 0;
  const home = [hi, hi, lo, lo, hi, lo, hi];
  for (let g = 0; w < 4 && l < 4; g++) {
    const h = home[g], a = h === hi ? lo : hi;
    (game(h, a, nets, K, r) === hi ? w++ : l++);
  }
  return { winner: w === 4 ? hi : lo, games: `${w}-${l}` };
}
// nets: each team's full-strength net for the postseason.
export function postseason(teams, rec, stand, nets, K, r) {
  const playin = {}, seeds = {};
  for (const conf of ['East', 'West']) {
    const s = stand[conf];
    const w78 = game(s[6], s[7], nets, K, r), l78 = w78 === s[6] ? s[7] : s[6];
    const w910 = game(s[8], s[9], nets, K, r), l910 = w910 === s[8] ? s[9] : s[8];
    const eighth = game(l78, w910, nets, K, r);
    seeds[conf] = [...s.slice(0, 6), w78, eighth];
    playin[conf] = { w78, l78, w910, l910, eighth, out: [l910, eighth === l78 ? w910 : l78] };
  }
  const rounds = [];
  const better = (x, y) => (rec[x].w > rec[y].w || (rec[x].w === rec[y].w && r() < 0.5) ? [x, y] : [y, x]);
  let alive = {};
  for (const conf of ['East', 'West']) {
    const S = seeds[conf];
    alive[conf] = [[S[0], S[7]], [S[3], S[4]], [S[2], S[5]], [S[1], S[6]]];
  }
  for (let round = 0; round < 3; round++) {
    const res = {};
    for (const conf of ['East', 'West']) {
      const ws = alive[conf].map(([a, b]) => { const x = series(a, b, nets, K, r); res[`${a}-${b}`] = x; return x.winner; });
      alive[conf] = [];
      for (let i = 0; i < ws.length; i += 2) if (ws[i + 1]) alive[conf].push(better(ws[i], ws[i + 1]));
      if (round === 2) alive[conf] = ws;
    }
    rounds.push(res);
  }
  const [hi, lo] = better(alive.East[0], alive.West[0]);
  const finals = series(hi, lo, nets, K, r);
  rounds.push({ [`${hi}-${lo}`]: finals });
  return { playin, seeds, rounds, champion: finals.winner };
}
