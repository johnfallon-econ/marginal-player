// A league that runs itself, year after year: the season, then the offseason in the order the
// calendar runs it. Every decision a club makes goes through one function, so the page can put
// the user's club's decisions to the user and give everyone else's to their GMs.
import * as C from './cba.js';
import * as S from './season.js';
import * as V from './dev.js';
import * as D from './draft.js';
import * as M from './value.js';
import * as X from './trades.js';
import * as A from './awards.js';
import * as GM from './gm.js';
import * as PL from './plan.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
// a window's ceiling on deals, near the real league's count in it (2015-16 to 2024-25: the draft and
// the first two weeks of free agency 26 a year, 7 of them on draft night itself, made during the
// draft with no ceiling (tradeUp), the rest of the summer 5, the season to the week before the deadline 6, the
// deadline week 15); value decides how many happen under it
export const TRADES = { draft: 19, summer: 6, dec15: 7, deadline: 18 };

// ---- a new game ----------------------------------------------------------------------------
// L: data/gm_league.json; cal: data/gm_calibration.json; opts: { team, hidden, seed }
export function newGame(L, cal, opts) {
  const r = S.rng(opts.seed ?? Date.now() % 2 ** 31);
  const K = { ...L.const, ...cal };
  const G = { season: L.season, phase: 'preseason', date: L.date, user: opts.team, hidden: !!opts.hidden,
    K, caps: { [L.season]: C.figures(L.season, 0).cap }, f: {}, teams: {}, players: {}, fa: [], picks: clone(L.picks), swaps: clone(L.swaps),
    history: [], log: [], lotteryHist: {}, seed: opts.seed };
  G.f[L.season] = C.figures(L.season, G.caps[L.season]);
  for (const [ab, t] of Object.entries(L.teams)) {
    G.teams[ab] = { ...t, roster: [], dead: [], holds: [], tpes: [], hardCap: null, cashSent: 0, cashRecv: 0, exc: null };
    G.teams[ab].exc = C.freshExceptions(G.teams[ab], G.f[L.season]);
  }
  for (const p0 of [...L.players, ...L.freeAgents]) {
    const p = { ...clone(p0) };
    V.initTalent(p, K, r, G.hidden);
    G.players[p.id] = p;
    if (p.tm) G.teams[p.tm].roster.push(p.id); else G.fa.push(p.id);
  }
  // Plus-minus is against the average man on the floor, so the league's rating, weighted by the minutes
  // its clubs will play their men (the Trade Lab's, the opening season's roles), is 0: the site's recent
  // ratings drift above it (their box-score prior is not centred), and the replacement level, wins above
  // it and the market's prices all assume an average man is 0. Every man moves by the same amount.
  { let a = 0, w = 0;
    for (const T of Object.values(G.teams)) for (const id of T.roster) { const p = G.players[id]; if (!p.contract?.twoWay) { a += p.rate * p.mpg; w += p.mpg; } }
    G.centred = a / w;
    for (const p of Object.values(G.players)) { p.rate -= G.centred; p.talent -= G.centred; } }
  G.scoutSd = D.solveScoutSd(L, r);
  G.names = L.names; G.draftData = L.draft;
  GM.init(G, L, r);                               // each club's real lead executive (gm.js)
  setLeagueNet(G);                                // projected wins average 41 from the start
  G.rngState = r.state();
  return G;
}

// What club `ab` thinks a player is worth h seasons past next, $: his market value as its GM reads
// him. Every club sees how good he is now; where he is heading is another matter. His own club knows
// his trend (dev.js: what each season adds to his talent beyond the league's aging, keeping rho of
// itself a season), so it sees trend x (1 - rho^h) / (1 - rho) more by season h. Another club expects
// the trend of a man like him (a recent draftee's from the draft model, tp; else none) and, knowing
// his club knows better and would part with him at the market only if it reads his trend below that,
// takes it at the expectation given that: less 0.8 x edge, the mean of a normal cut at its centre, edge
// the spread of trends about their expectation (lemons). A free agent has no club that knows better.
// A read strays by its GM's noise, more the less certain he is (M.uncertainty), and an outsider leans
// on the expectation by as much (weight 1 / (1 + u^2)); his own club's read strays half as far (an
// assumption).
const _edge = new WeakMap();
function edge(G) {                                          // the spread of trends about their expectation, by season
  const e = _edge.get(G);
  if (e?.s === G.season) return e.v;
  const d = Object.values(G.teams).flatMap((T) => T.roster).map((id) => G.players[id]).map((p) => p.trend - (p.tp ?? 0));
  const m = d.reduce((a, x) => a + x, 0) / d.length, v = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
  _edge.set(G, { s: G.season, v });
  return v;
}
export function teamValue(G, ab, p, h = 0) {
  const g = G.teams[ab].gm, cap = capAt(G, G.season + 1 + h), u = M.uncertainty(p, h, G.K), z = g.noise * hashNoise(`${ab}|${p.id}|${G.season}`);
  const ahead = (1 - G.K.dev.rho ** h) / (1 - G.K.dev.rho);
  if (p.tm === ab || G.teams[ab].rights?.includes(p.id)) return M.marketValue({ ...p, rate: p.talent + p.trend * ahead }, h, cap, G.K) * (1 + z * u / 2);
  const held = p.tm || Object.values(G.teams).some((T) => T.rights?.includes(p.id));
  return M.marketValue({ ...p, rate: p.talent + ((p.tp ?? 0) - (held ? 0.8 * edge(G) : 0)) * ahead }, h, cap, G.K) * (1 + z * u / (1 + u * u));
}
const hashNoise = V.hashNoise;
// How much a club makes of a man's coming season when it pays him, by what it is trying to do, as its
// trade GM weighs it (X.WEIGHT): a contender pays to keep and add, into the tax, a rebuilder holds back.
const nowWeight = (G, ab) => X.WEIGHT[X.mode(projWins(G, ab))].now;
// A player's ask this summer, with his max-or-not draw fixed for the summer (hashed, so asking twice
// gives the same answer)
export const askOf = (G, p, F, ext = 0) => M.ask(p, F, G.K, S.Phi(hashNoise(`ask|${p.id}|${G.season}`)), ext);
// A club's net for the coming season: each man at his projection, in the role he is in line for, at
// his availability, over the nights each man is out as well as in (S.expNet: a club built on stars who
// miss games loses more to their nights out than a deep one). adj: a man as he stands now, or null
export const teamNet = (G, ab, adj = (p) => p) => S.expNet(G.teams[ab].roster.map((id) => G.players[id]).filter((p) => !p.contract?.twoWay)
  .map(adj).filter(Boolean).map((p) => ({ ...p, play: p.rate })), G.K.maxMpg);
// Wins at net n against the league (its clubs' nets, G.nets): each game's chance as the season engine
// plays it, half of them at home, so projections are what the games produce
export function winsAt(G, n, self) {
  const K = G.K, o = Object.entries(G.nets).filter(([ab]) => ab !== self).map(([, v]) => v);
  return 82 * o.reduce((a, v) => a + (S.Phi((K.netScale * (n - v) + K.hca) / K.sigma) + S.Phi((K.netScale * (n - v) - K.hca) / K.sigma)) / 2, 0) / o.length;
}
// the net that wins w games (winsAt rises with n)
export function netAt(G, w, self) {
  let lo = Math.min(...Object.values(G.nets)) - 40, hi = Math.max(...Object.values(G.nets)) + 40;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (winsAt(G, m, self) < w) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
// A club's projected wins for the coming season
export function projWins(G, ab) {
  if (!G.nets) setLeagueNet(G);
  return winsAt(G, teamNet(G, ab), ab);
}
// Each club's chance of the title: what is left of the season and the playoffs, n times over, each
// club at its strength as its projection and its record so far put it, give or take what remains
// unknown of it; in the playoffs, the series from where they stand. Fixed draws, so the odds hold
// still between looks.
export function titleOdds(G, n = 200) {
  const T = G.teams, K = G.K, r = S.rng(13), cur = G.phase === 'season' ? G.cur : null, po = G.phase === 'playoffs' ? G.po : null;
  const days = po ? [] : cur ? cur.days.slice(cur.d) : S.schedule(T, G.season, r);
  // a man out hurt now is out for the games his injury still costs him (the report's timeline); the
  // rest at their usual availability
  const avail = (ab, p) => { const h = cur?.hurt[p.id], g = cur?.played[ab]; if (!h?.[g]) return p;
    const a = h.slice(g).filter((x) => !x).length / (82 - g); return a ? { ...p, av: a, mpg: p.mpg * a / (p.av ?? 1) } : null; };
  if (!G.nets) setLeagueNet(G);
  const base = Object.fromEntries(Object.keys(T).map((ab) => [ab, teamNet(G, ab, (p) => avail(ab, p))]));
  // a club's true strength, a share of games won: its projection (prior, missing a season by
  // K.pickSim.miss wins) updated by its record so far (each game a coin with that chance), then as a
  // net (netAt), its spread through the slope of wins at that net
  const post = Object.fromEntries(Object.entries(base).map(([ab, v]) => {
    const g = cur ? cur.record[ab].w + cur.record[ab].l : 0, v0 = (K.pickSim.miss / 82) ** 2, q = winsAt(G, v, ab) / 82;
    const w = g ? v0 * g / (v0 * g + q * (1 - q)) : 0, th = q + w * (cur?.record[ab].w / g - q || 0), m = netAt(G, 82 * th, ab);
    const slope = (winsAt(G, m + 0.05, ab) - winsAt(G, m - 0.05, ab)) / 0.1 / 82;
    return [ab, [m, Math.sqrt(v0 * (1 - w)) / slope]];
  }));
  const out = Object.fromEntries(Object.keys(T).map((ab) => [ab, 0]));
  for (let k = 0; k < n; k++) {
    if (po) { const p = structuredClone(po); while (!p.champion) { for (const x of p.series) while (S.seriesGame(x, p.nets, K, r)); S.nextRound(p, r); } out[p.champion] += 1 / n; continue; }
    const nets = Object.fromEntries(Object.entries(post).map(([ab, [m, sd]]) => [ab, m + sd * r.normal()]));
    const rec = cur ? structuredClone(cur.record) : Object.fromEntries(Object.keys(T).map((ab) => [ab, { w: 0, l: 0, h2h: {}, confW: 0, confL: 0, divW: 0, divL: 0 }]));
    for (const day of days) for (const [h, a] of day) S.tally(T, rec, h, a, r() < S.winP(h, a, nets, K));
    out[S.postseason(T, rec, S.standings(T, rec, r), nets, K, r).champion] += 1 / n;
  }
  return out;
}
export function setLeagueNet(G) {
  G.nets = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, teamNet(G, ab)]));
}
// The cap for a future season: the draws already made, else the expected path.
export function capAt(G, s) {
  if (G.caps[s]) return G.caps[s];
  const last = Math.max(...Object.keys(G.caps).map(Number));
  return G.caps[last] * (1 + G.K.capGrowth.mean) ** (s - last);
}
const fig = (G, s) => (G.f[s] ??= C.figures(s, capAt(G, s)));

// ---- preseason: cut to 15 standard contracts and 3 two-way ---------------------------------
// The rule the cutdown predictor uses: keep = value next season less non-guaranteed salary (a
// draftee's, between the draft and the new league year, is his first season's).
export function cutdown(G, r, ab, choose) {
  const T = G.teams[ab], P = G.players, s = G.season;
  const std = () => T.roster.filter((id) => !P[id].contract?.twoWay);
  while (std().length > 15) {
    const ranked = std().map((id) => { const y = C.yearOf(P[id].contract, s) || C.yearOf(P[id].contract, s + 1); return [id, M.marketValue(P[id], 0, fig(G, s).cap, G.K) - (y.sal - y.gtd)]; })
      .sort((a, b) => a[1] - b[1]);
    const id = choose ? choose(ranked.map((x) => x[0])) : ranked[0][0];
    release(G, ab, id, G.date, false);
  }
  const tw = T.roster.filter((id) => P[id].contract?.twoWay);
  for (const id of tw.slice(3)) release(G, ab, id, G.date, false);
}
export function release(G, ab, id, date, stretch) {
  const T = G.teams[ab], p = G.players[id];
  for (const x of C.waive(p, date, stretch)) T.dead.push({ ...x, pid: id });
  T.roster = T.roster.filter((x) => x !== id);
  p.waived = { s: G.season, sal: C.yearOf(p.contract, G.season)?.sal || 0, team: ab };
  p.contract = null; p.tm = null; G.fa.push(id);
  G.log.push({ date, type: 'waive', team: ab, pid: id });
}

// ---- the season ----------------------------------------------------------------------------
// Roles: each club's coach sets every man's minutes when he plays (rotation, below).
export function assignRoles(G) {
  for (const ab of Object.keys(G.teams)) for (const [p, m] of rotation(G, ab, true)) p.mpg = m * (p.av ?? 0.9);
  G.rolesSet = true;
}
const interp = V.interp;
// A club's rotation as its coach sees it: [player, minutes per game when he plays], most first. Until
// the coaches first set roles, the real 2026-27 roles stand (minutes per game played: mpg / av).
// After that (K.roles, _gm_roles.py) a man's minutes are what his rating earns on the league's curve,
// plus how far above or below it he played last season (carried over in part), moved by age, a
// change of club and where his minutes rank among his club-mates', times the coach's own read of him
// (the fit's residual, drawn once a season, steadier the more he played); a rookie's go by his draft slot. The fit's intercept
// gives way to K.roleShift, set in calibrate.js to the league's mean minutes: the curve is everyone's
// mean, and each night's 240 go down this order among the healthy (season.minutes).
export function rotation(G, ab, coach = G.rolesSet) {
  const P = G.players, { curve, vet: V_, rookie: Rk } = G.K.roles;
  const ps = G.teams[ab].roster.map((id) => P[id]);
  if (!coach) return ps.map((p) => [p, p.mpg / (p.av ?? 0.9)]).sort((a, b) => b[1] - a[1]);
  const lc = (x) => interp(curve, x);
  // a rebuilding club plays its young (K.tankYouth rating points per year under 26, set in balancing)
  const tank = X.mode(projWins(G, ab)) === 'rebuild';
  // last season's minutes per game played, and whether that was with another club (a man arriving
  // mid-season with 10 games: this season's, with his old club)
  const prior = new Map(ps.map((p) => {
    const gp = G.cur?.gp[p.id] || 0, last = p.log?.findLast((l) => l.gp >= 10);
    return [p, gp >= 10 ? [G.cur.mins[p.id] / gp, 1] : last ? [last.mpg, +(last.tm !== ab)] : null];
  }));
  // teammates: each man's minutes rank among the men who have a prior
  const vets = ps.filter((p) => prior.get(p));
  const rank = (p) => { const m = prior.get(p)[0], above = vets.filter((q) => prior.get(q)[0] > m).length, tied = vets.filter((q) => prior.get(q)[0] === m).length; return above + (tied + 1) / 2; };
  const mpg = (p) => {
    const pr = prior.get(p), rating = p.rate + (tank ? (G.K.tankYouth || 0) * (26 - p.age) : 0);
    const x = pr ? lc(rating) + (G.K.roleShift || 0) + V_.dev * (Math.log(pr[0]) - lc(p.rate)) + V_.age_27 * (p.age - 27) + V_.age_over_30 * Math.max(p.age - 30, 0) + V_.moved * pr[1]
      + (V_.log_rank + V_.moved_log_rank * pr[1]) * Math.log(rank(p))
      : Rk.a + Rk.log_pick * Math.log(p.draft?.pick || 61);
    return Math.min(Math.exp(x + (pr ? interp(V_.sd_by_mpg, pr[0]) : Rk.sd) * hashNoise(`coach|${p.id}|${G.season}`)), G.K.roleCap);
  };
  // a role is set once a season with a club, and kept through the season's later reshuffles
  const role = (p) => (p.role?.s === G.season && p.role.tm === ab ? p.role.m : (p.role = { s: G.season, tm: ab, m: mpg(p) }).m);
  return ps.map((p) => [p, role(p)]).sort((a, b) => b[1] - a[1]);
}
// The season in steps, so the page can stop at the trade windows and a save can fall anywhere:
// seasonStart, seasonTo(frac) as often as wanted, then postseason.
export function seasonStart(G, r) {
  // the first season keeps every club's real 2026-27 roles (the Trade Lab's minutes); after
  // that, coaches assign them
  if (G.history.length || G.log.some((x) => x.type === 'trade')) assignRoles(G);
  V.seasonForm(G.teams, G.players, G.K, r);
  setLeagueNet(G);
  for (const [ab, T] of Object.entries(G.teams)) T.gm.pre = projWins(G, ab) / 82;   // what each GM's season is judged against
  G.cur = S.startSeason(lg(G), G.season, r); G.seasonOver = false;
  grantDPE(G);
  G.phase = 'season'; G.date = C.seasonDates(G.season).opening;
}
// a week at a time, so clubs short of bodies can sign help between weeks (shorthanded)
export const seasonTo = (G, r, frac) => {
  const to = Math.floor(G.cur.days.length * frac);
  while (G.cur.d < to) { S.simDays(lg(G), G.cur, r, Math.min(G.cur.d + 7, to)); shorthanded(G, r); }
  if (frac <= WINDOWS[0].frac) grantDPE(G);                         // applications close Jan 15: by the Dec 15 stop
};
// In-season help, as real clubs sign it: a club down to fewer than 13 healthy men on standard deals
// signs the best young free agent it can (under three seasons in, as real 10-day men mostly come up
// from the G League) on a 10-day contract (about five games, the minimum prorated),
// past 15 under the hardship exception once four or more are out. A 10-day runs out and the man
// is a free agent again; a club still short signs again, him or another. The fringe players this
// brings in for a handful of games are a sixth of a real league's player-seasons. The user's
// staff does it for him unless he turns it off (G.staffSigns).
const TEN = 5;
export function shorthanded(G, r) {
  const st = G.cur, s = G.season, F = fig(G, s), P = G.players;
  for (const [ab, T] of Object.entries(G.teams)) {
    const g = st.played[ab];
    for (const id of T.roster.slice()) if (P[id].contract?.tenDay && g >= P[id].contract.tenDay) {
      T.roster = T.roster.filter((x) => x !== id); P[id].contract = null; P[id].tm = null; G.fa.push(id);
    }
    if (ab === G.user && !G.autoUser && G.staffSigns === false) continue;
    const std = () => T.roster.filter((id) => !P[id].contract?.twoWay), out = std().filter((id) => st.hurt[id]?.[g]).length;
    while (std().length - out < 13 && std().length < 15 + (out >= 4)) {
      const young = G.fa.filter((x) => P[x].yos < 3), id = (young.length ? young : G.fa).slice().sort((a, b) => v3(G, P[b]) - v3(G, P[a]))[0]; if (!id) break;
      const p = P[id], sal = Math.round(C.minSalary(p.yos, F.cap) * TEN / 82);
      p.play = p.talent;                                  // his form, for the games he plays
      sign(G, ab, p, 'min', sal, 1, G.date, 0);
      p.contract.tenDay = g + TEN; p.contract.how = 'tenDay';
    }
  }
}
// A disabled player exception (CBA_REFERENCE.md): a man out for the rest of the season, as the league's
// physician would rule by Jan 15, gives his club the lesser of half his salary or the mid-level for a
// one-season signing until March 10 (trades into one are not modelled). One per man.
function grantDPE(G) {
  const s = G.season, F = fig(G, s), st = G.cur;
  for (const [ab, T] of Object.entries(G.teams)) for (const id of T.roster) {
    const p = G.players[id], g = st.played[ab], h = st.hurt[id], sal = C.yearOf(p.contract, s)?.sal || 0;
    if (!h || p.dpe === s || !sal || p.contract.twoWay || g >= 82 || !h.slice(g).every(Boolean)) continue;
    p.dpe = s;
    T.tpes.push({ dpe: true, amt: Math.round(Math.min(sal / 2, F.ntmle)), season: s, expires: `${s + 1}-03-10`, from: id });
  }
}
const lg = (G) => ({ teams: G.teams, players: G.players, const: G.K });
// trade windows in the season: Dec 15, when summer signings become tradable (56 of 173 days in),
// and the deadline (114 of 173)
export const WINDOWS = [{ frac: 56 / 173, date: 'dec15' }, { frac: 114 / 173, date: 'deadline' }];
// The postseason in steps for the page: postseasonStart, then games (S.seriesGame on G.po.series)
// and S.nextRound until there is a champion, then postseasonEnd.
export function postseasonStart(G, r) {
  const K = G.K, res = G.cur;
  const stand = S.standings(G.teams, res.record, r);
  const nets = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab,
    S.net(G.teams[ab].roster.map((id) => G.players[id]).filter((p) => !p.contract?.twoWay), K.maxMpg)]));
  G.po = S.postseasonStart(G.teams, res.record, stand, nets, K, r);
  G.po.stand = stand;
  G.phase = 'playoffs'; G.date = `${G.season + 1}-04-18`;
}
// Play every game left in the round, then move to the next.
export function playRound(G, r) { for (const x of G.po.series) while (S.seriesGame(x, G.po.nets, G.K, r)); S.nextRound(G.po, r); }
export function postseasonEnd(G) {
  const s = G.season, res = G.cur, po = G.po;
  G.history.push({ season: s, record: Object.fromEntries(Object.entries(res.record).map(([k, v]) => [k, [v.w, v.l]])),
    standings: po.stand, playin: po.playin, seeds: po.seeds, rounds: po.rounds.map((rd) => Object.fromEntries(Object.entries(rd).map(([k, v]) => [k, { winner: v.winner, games: v.games }]))), champion: po.champion });
  G.lastMins = res.mins; G.lastGp = res.gp; G.lastRecord = res.record; G.lastPlayin = po.playin; G.lastStand = po.stand;
  // the season's leaders and awards, on its lines and the regular season's record
  Object.assign(G.history.at(-1), { leaders: A.leaders(G, s), awards: A.awards(G, s) });
  delete G.cur; delete G.po;
  G.seasonOver = true;                              // trades reopen after the Finals
  G.phase = 'offseason'; G.date = `${s + 1}-06-15`;
  return G.history.at(-1);
}
export function postseason(G, r) { postseasonStart(G, r); while (!G.po.champion) playRound(G, r); return postseasonEnd(G); }
export function playSeason(G, r, window = (date, k) => X.tradeWindow(G, r, date, TRADES[k], null)) {
  seasonStart(G, r);
  const d = C.seasonDates(G.season);
  for (const w of WINDOWS) { seasonTo(G, r, w.frac); G.date = d[w.date]; window(G.date, w.date); assignRoles(G); }
  seasonTo(G, r, 1);
  return postseason(G, r);
}

// ---- end of season: the tax, service and Bird years, development, retirements --------------
export function endSeason(G, r) {
  const s = G.season, f = fig(G, s), P = G.players, pays = {};
  for (const [ab, T] of Object.entries(G.teams)) {
    const pay = pays[ab] = C.teamSalary(T, G, s), rep = [1, 2, 3, 4].filter((k) => T.taxpaid?.[s - k]).length >= 3;
    T.tax = T.tax || {}; T.tax[s] = C.taxBill(pay, f, rep);
    (T.taxpaid ||= {})[s] = pay > f.tax;
    (T.short ||= {})[s] = Math.max(0, f.minTeam - pay);   // below the floor, a club pays its players the shortfall (Art. VII §2(b))
    (T.over2 ||= {})[s] = pay > f.apron2;
    if (pay > f.apron2) freezePick(G, ab, s);
    settleFrozen(G, ab, s);
    for (const id of T.roster) { P[id].yos += 1; if (P[id].bird?.team === ab) P[id].bird.n += 1; else P[id].bird = { team: ab, n: 1 }; }
  }
  // each man's line for the season just played, kept for the page: club, games, minutes, and the
  // rating the season showed (the board's read pulled toward how he played, by his minutes, as a
  // real season's rating is estimated from that season)
  for (const [ab, T] of Object.entries(G.teams)) for (const id of T.roster) {
    const p = P[id], gp = G.lastGp?.[id] || 0, m = G.lastMins?.[id] || 0;
    const rate = V.seasonRate(p, m, G.K, G.hidden);
    (p.log ||= []).push({ s, tm: ab, tw: p.contract?.twoWay ? 1 : undefined, gp, mpg: gp ? +(m / gp).toFixed(1) : 0, rate: +rate.toFixed(2), lean: +(p.lean ?? 0).toFixed(2), p100: V.boxLine(p, gp && m / gp, G.K, s, gp) ?? undefined });
  }
  V.endSeason(P, G.lastMins || {}, G.K, r, G.hidden);
  // Ratings are relative -- points per 100 against an average player -- so the league's
  // minutes-weighted average stays where it began; entries, aging and exits would otherwise let
  // the whole league drift.
  const rostered = Object.values(G.teams).flatMap((t) => t.roster.map((id) => P[id]));
  const wmean = (k) => { let a = 0, w = 0; for (const p of rostered) { const m = G.lastMins?.[p.id] || 0; a += m * p[k]; w += m; } return a / w; };
  G.leagueLevel ??= wmean('talent');
  const shift = wmean('talent') - G.leagueLevel;
  for (const p of Object.values(P)) { p.talent -= shift; p.rate -= shift; }

  for (const p of Object.values(P)) if (p.contract === null && G.lastMins?.[p.id] === undefined) p.idle = (p.idle || 0) + 1;
  // each GM's season on the books; the computer clubs' GMs who lose their jobs, and who replaces them (gm.js)
  GM.closeSeason(G, G.history.at(-1), pays);
  GM.summer(G, r);
}
// a second-apron team's first-round pick seven drafts out is frozen (Art. VII §2(f))
function freezePick(G, ab, s) { const k = `${ab}|${s + 8}|1`; G.picks[k] = { ...(G.picks[k] || { t: 'clear' }), frozen: true }; }
// over the four seasons after the freeze, three below the second apron thaw the pick; two above it
// freeze it for good and send it to the end of the first round
export function settleFrozen(G, ab, s) {
  const T = G.teams[ab];
  for (let fs = s - 4; fs < s; fs++) {
    const k = `${ab}|${fs + 8}|1`, e = G.picks[k];
    if (!e?.frozen || e.end) continue;
    const after = [1, 2, 3, 4].map((j) => fs + j).filter((t) => t <= s && t in (T.over2 || {})), over = after.filter((t) => T.over2[t]).length;
    if (over >= 2) e.end = true;
    else if (after.length - over >= 3) { delete e.frozen; if (e.t === 'clear' && Object.keys(e).length === 1) delete G.picks[k]; }
  }
}

// ---- the draft ---------------------------------------------------------------------------------
// Lottery balls from the play-in: 2 for the three worst, 3 for the rest who missed it, 2 for the
// 9/10 teams, 1 for the 7/8 losers who then lost again. Then 17-30 by record, round 2 by record.
// In steps for the page: draftStart (lottery, order, the class), draftNext (picks until the user's
// club is on the clock, or with `choice` makes its pick and goes on), draftEnd.
export function draftStart(G, r) {
  const s = G.season, year = s + 1, rec = G.lastRecord, pin = G.lastPlayin;
  const playoff = new Set([...G.history.at(-1).seeds.East, ...G.history.at(-1).seeds.West]);
  const byRec = Object.keys(G.teams).sort((a, b) => rec[a].w - rec[b].w || r() - 0.5);
  const lotteryTeams = byRec.filter((ab) => !playoff.has(ab));
  // balls: 1 for a 7/8 loser who then lost the 8th-seed game, 2 for the 9/10 teams, 2 for the
  // three worst records, 3 for everyone else out of the playoffs
  const one = new Set(), two = new Set();
  for (const c of ['East', 'West']) {
    const p = pin[c];
    if (p.eighth !== p.l78) one.add(p.l78);
    two.add(p.l910); if (p.eighth !== p.w910) two.add(p.w910);
  }
  const balls = lotteryTeams.map((ab, i) => ({ ab, balls: one.has(ab) ? 1 : i < 3 || two.has(ab) ? 2 : 3 }));
  const lot = D.lottery(balls, r, G.lotteryHist);
  for (const ab of Object.keys(G.teams)) {
    const h = G.lotteryHist[ab] ||= { top5: [] };
    const slot = lot.indexOf(ab);
    h.no1 = slot === 0; h.top5.push(slot >= 0 && slot < 5); h.top5 = h.top5.slice(-2); h.top5x2 = h.top5.length === 2 && h.top5.every(Boolean);
  }
  const first = [...lot, ...byRec.filter((ab) => playoff.has(ab))];
  const { order, created } = D.resolvePicks([D.frozenLast(first, year, G.picks), byRec], year, G.picks, G.swaps);
  Object.assign(G.picks, created);
  const cls = D.generateClass({ names: G.names, draft: G.draftData }, s, r, G.scoutSd), pool = cls.filter((p) => !p.undrafted);
  // the rest of the class, journeymen from the G League and abroad the draft usually passes over: on the
  // board too, and whoever goes unpicked joins the summer's market (draftEnd)
  const rest = cls.filter((q) => q.undrafted);
  for (const p of rest) { p.rate = G.hidden ? p.board : p.talent; p.se = 1.0; p.prior = 0; p.trend = (G.hidden ? G.K.trendHidden : G.K.dev.trend) * r.normal(); p.mpg = M.mpgFor(p.rate, G.K) * p.av; G.players[p.id] = p; }
  for (const p of pool) {
    // hidden talent: the league sees the scouts' board, shrunk to what it predicts; else the truth
    p.rate = G.hidden ? shrinkBoard(p, pool) : p.talent;
    // his growth by where the class had him (the slot his talent was drawn for) and his talent
    Object.assign(p, V.growth(G.K, +p.id.split('-')[1], p.talent));
    p.se = 1.0; p.prior = 0; p.trend = p.tp + (G.hidden ? G.K.trendHidden : G.K.dev.trend) * p.dsd * r.normal();
    p.mpg = M.mpgFor(p.rate, G.K) * p.av;
    G.players[p.id] = p;
  }
  // what the board misses: each prospect's talent less the league's read of him, over the class
  const resid = G.hidden ? pool.map((p) => +(p.talent - p.rate).toFixed(3)) : [0];
  G.draft = { year, order, avail: [...pool, ...rest].map((p) => p.id), picks: [], lottery: lot, resid };
  settleDraft(G);
  G.phase = 'draft'; G.date = `${year}-06-24`;
}
// The draft settles its picks: the ledger shows who holds each slot, protections and swaps spent,
// so a pick trades from the club the order says holds it. Idempotent (trades keep the two in step).
export function settleDraft(G) {
  const y = G.draft.year;
  for (const e of G.draft.order) {
    const id = `${e.origin}|${y}|${e.slot <= 30 ? 1 : 2}`, fr = G.picks[id]?.frozen;
    if (e.holder === e.origin && !fr) delete G.picks[id]; else G.picks[id] = { t: 'gone', h: e.holder, ...(fr ? { frozen: true } : {}) };
  }
  if (G.swaps) { delete G.swaps[`${y}|1`]; delete G.swaps[`${y}|2`]; }
}
// A prospect as the draft board draws him (9_board.py), from the game's own development: n careers
// of 20 seasons, his talent the league's read plus a miss drawn from this class's (busts and all),
// then each year the age curve, his fading personal trend and a random walk, and his offense-minus-
// defense lean drifting as the league's do. A season's quality is his wins at full health in the
// minutes the game gives a man of that rating, its value his wins at his availability. The board's
// fans, at its eight levels: value over his first four seasons; quality as a rookie, over four
// seasons and at his peak (seasons 1-7); offense and defense over four; each season's value. His
// worth to the club that drafts him, at the draft's cap as the board prices a class, on the board's
// contract model (K.boardMkt, its viewer's clubPath): the rookie deal at market while the club holds
// him (four seasons from the first round, two from the second, by where the league's read would have
// him go), then at each deal's end it keeps him or not and pays him the max or a non-max share of
// the cap, value less pay. And his chance of being in the league in
// seasons 1-6, as the game's own leagues have kept such men (K.stick).
export const QL = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];
const FANS = new Map();
export function fans(G, p, n = 400) {
  const key = `${G.draft.year}|${p.id}`;
  if (FANS.has(key)) return FANS.get(key);
  const K = G.K, sd = G.hidden ? K.trendHidden : K.dev.trend, rho = K.dev.rho, res = G.draft.resid, cap = capAt(G, G.draft.year);
  const r = S.rng([...p.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7));
  const mins = (x) => K.beta * 82 * M.mpgFor(x, K) / 48;
  // the board's contract model at a season's wins w (its keepP, holdP, dealMax)
  const B = K.boardMkt, lg = (z) => 1 / (1 + Math.exp(-z)), sw = (w) => Math.sqrt(Math.max(w, 0));
  G.draft.proj ??= Object.fromEntries(G.draft.avail.map((id) => G.players[id]).sort((a, b) => b.rate - a.rate).map((q, i) => [q.id, i + 1]));
  const pick = G.draft.proj[p.id] ?? 61, Lr = pick <= 30 ? 4 : 2;
  const holdP = (w, k) => { const c = B.rookie, r2 = +(pick > 30); return lg(c.a + c.war * w + c.sqrt_war * sw(w) + c.round2 * r2 + c.ln_pick * Math.log(Math.min(pick, 61)) + c.k3 * (k === 3) + c.k4 * (k === 4) + c.r2_k3 * r2 * (k === 3) + c.r2_k4 * r2 * (k === 4)); };
  const keepP = (first, w, age) => M.keepP(K, first, w, age), deal = (first, w, svc, age) => M.redeal(K, first, w, svc, age);
  const fan = (a) => { a.sort((x, y) => x - y); return QL.map((u) => +a[Math.floor(u * (a.length - 1))].toFixed(2)); };
  const A_ = { v: [], r: [], q: [], k: [], o: [], d: [], V: [], vs: Array.from({ length: 20 }, () => []), kept: Array(20).fill(0), mkt: Array(20).fill(0) };
  let star = 0;
  for (let t = 0; t < n; t++) {
    let x = p.rate + res[Math.floor(r() * res.length)], gr = V.growth(K, Math.min(pick, 60), x), tr = gr.tp + sd * gr.dsd * r.normal(), lean = p.lean ?? 0, sum = 0, sq = 0, so = 0, sdf = 0, pk = -Infinity, val = 0, st = false;
    let surv = 1, wp = 0, mx = 0, pmax = 0, nm = 0;
    for (let k = 1; k <= 20; k++) {
      const age = p.age + k - 1, m = mins(x), q = m * (x - K.repl), w = q * p.av, pr = M.price(w, cap, K) / 1e6;
      if (k <= 4) { sum += w; sq += q; so += m * ((x + lean) / 2 - K.repl / 2); sdf += m * ((x - lean) / 2 - K.repl / 2); }
      if (k === 1) A_.r.push(q);
      if (k <= 7) { pk = Math.max(pk, q); st ||= x >= 3; }
      A_.vs[k - 1].push(w);
      // the club's season: held through the rookie deal, then kept or not at each deal's end
      if (k <= Lr) { if (k >= 2) surv *= holdP(wp, k); }
      else if ((k - 1 - Lr) % 4 === 0) { const first = k - 1 === Lr; surv *= keepP(first, wp, age - 0.4); ({ mx, pmax, nm } = deal(first, wp, k - 1, age - 0.4)); }
      const keep = surv * (k <= Lr ? pr : pmax * (pr - mx * cap / 1e6) + (1 - pmax) * (pr - nm * cap / 1e6));
      val += keep; A_.kept[k - 1] += keep / n; A_.mkt[k - 1] += pr / n; wp = w;
      x += V.agingStep(K, age) + tr + K.dev.walk * r.normal();
      tr = rho * tr + Math.sqrt(1 - rho * rho) * sd * gr.dsd * r.normal();
      lean += V.interp(K.od.drift, age) + K.od.rho * lean + K.od.sd * r.normal();
    }
    A_.v.push(sum / 4); A_.q.push(sq / 4); A_.k.push(pk); A_.o.push(so / 4); A_.d.push(sdf / 4); A_.V.push(val); star += st / n;
  }
  const stay = Object.values(K.stick).map((c) => 1 / (1 + Math.exp(-(c.const + c.rate * p.rate + c.av * p.av + c.age * p.age))));
  const Vs = A_.V.slice().sort((a, b) => a - b), out = { v: fan(A_.v), r: fan(A_.r), q: fan(A_.q), k: fan(A_.k), o: fan(A_.o), d: fan(A_.d), vs: A_.vs.map(fan),
    EV: A_.V.reduce((a, b) => a + b) / n, V10: Vs[Math.floor(0.1 * n)], V90: Vs[Math.floor(0.9 * n)], kept: A_.kept, mkt: A_.mkt, star, stay, pp: stay[0] };
  FANS.set(key, out);
  return out;
}
// The pick on the clock, or null when the draft is done.
export const onClock = (G) => G.draft.order[G.draft.picks.length] || null;
// Make picks: the user's (choice) when he is on the clock, then the computer clubs', stopping at
// the user's next pick or after n of theirs (so the user can trade between picks).
export function draftNext(G, r, choice, human = G.user, n = Infinity) {
  const D_ = G.draft, s = G.season, year = D_.year;
  let made = 0;
  while (D_.picks.length < D_.order.length) {
    if (D_.order[D_.picks.length].holder !== human) tradeUp(G, D_.picks.length, human);
    const { slot, holder } = D_.order[D_.picks.length];
    if (holder === human && choice == null) return { slot, holder };          // on the clock
    if (holder !== human && made++ >= n) return { slot, holder };
    const avail = D_.avail.map((id) => G.players[id]);
    // a computer club takes the man worth most on its estimate (gm.js: the board, its own read, the draft so far)
    const cap = capAt(G, year), p = holder === human ? G.players[choice] : avail.reduce((a, q) => (prospectWorth(G, holder, q, cap) > prospectWorth(G, holder, a, cap) ? q : a));
    choice = null;
    GM.draftLeft(G, holder, p, avail, capAt(G, year));
    D_.avail = D_.avail.filter((id) => id !== p.id);
    GM.learn(G, holder, p, D_.avail.map((id) => G.players[id]), (q, rate) => worthAt(G, q, rate, cap));   // every club sees the pick
    p.draft = { year, round: slot <= 30 ? 1 : 2, pick: slot, team: holder };
    // a first-rounder signs his scale deal; a second-rounder's club holds his rights, to sign him
    // when the league year opens or leave him abroad (newLeagueYear)
    if (slot > 30) (G.teams[holder].rights ||= []).push(p.id);
    else {
      p.tm = holder; p.contract = { ...D.rookieContract(slot, s, capAt(G, year)), signed: `${year}-07-07` };
      p.bird = { team: holder, n: 0 };
      G.teams[holder].roster.push(p.id);
    }
    D_.picks.push({ slot, team: holder, pid: p.id });
  }
  return null;
}
// A prospect's worth at a rating, $: his market value over four seasons; to club c, at its estimate
// of him (gm.js)
export const worthAt = (G, q, rate, cap) => [0, 1, 2, 3].reduce((a, h) => a + M.marketValue({ ...q, rate, mpg: undefined }, h, cap, G.K) / M.DISC ** h, 0);
export const prospectWorth = (G, c, q, cap) => worthAt(G, q, GM.estimate(G, c, q), cap);
// The league's view of a class: each prospect's worth on the board, and how fast it rises with his
// rating -- so another club's pick, its estimate straying from the board by GM.pickSd, can be drawn
// in worth (simPick)
function publicView(G, pool, cap) {
  const v = {}, s = {};
  for (const q of pool) { v[q.id] = worthAt(G, q, q.board, cap); s[q.id] = (worthAt(G, q, q.board + 0.1, cap) - v[q.id]) / 0.1; }
  return { v, s };
}
const simPick = (pool, r, sd, view) => { let b = null, bv = -Infinity; for (const q of pool) { const x = view.v[q.id] + view.s[q.id] * sd * r.normal(); if (x > bv) { bv = x; b = q; } } return b; };
// Draft night: before a computer club picks, a club with a later pick may trade up for it. The
// climber gets the man it values most now, on its estimate (gm.js: the board, its private read, and
// what the picks so far have shown); staying put it gets the best of those left at its own pick,
// which it weighs over the draft played out NIGHT times from here, each club picking on the board's
// worth with the spread its estimates have from outside (GM.pickSd, simPick) -- the man it wants, or one as good, may well fall to
// it. The club moving down gets the best of those left at the later pick instead of the best now.
// Each side must come out ahead by what it needs (X.need), the climber adding picks as needed
// (X.payIn): the price of moving up, the chance of not needing to, and how far each club trusts its
// own read set how often it happens. A man's worth less his scale salary is weighted as the club
// weighs picks (X.WEIGHT). The user's club trades on draft night through the trade page.
const NIGHT = 20;
function tradeUp(G, k, human) {
  const D_ = G.draft, e = D_.order[k], H = e.holder;
  const x = X.market(G), cap = capAt(G, D_.year), league = { ...G, picks: x.pv, ledger: G.picks };
  const avail = D_.avail.map((id) => G.players[id]), memo = new Map();
  const mv = (c, q) => { const key = `${c}|${q.id}`; if (!memo.has(key)) memo.set(key, prospectWorth(G, c, q, cap)); return memo.get(key); };
  const scale = (slot) => D.rookieContract(slot, G.season, cap).years.reduce((a, y, i) => a + y.sal / M.DISC ** i, 0);
  const W = (c, v, i) => X.WEIGHT[x.modes[c]].pick * (v - scale(D_.order[i].slot));
  // the draft played out from here: in each run, the pick at which each man goes
  const rr = S.rng(D_.year * 100 + k), runs = [], view = publicView(G, avail, cap);
  for (let n = 0; n < NIGHT; n++) {
    let pool = avail.slice(); const at = new Map();
    for (let i = k; i < D_.order.length && pool.length; i++) {
      const q = simPick(pool, rr, GM.pickSd(G, G.teams[D_.order[i].holder].gm), view); at.set(q.id, i); pool = pool.filter((y) => y !== q);
    }
    runs.push(at);
  }
  const sorted = {}, by = (c) => (sorted[c] ||= avail.slice().sort((a, b) => mv(c, b) - mv(c, a)));
  // what club c expects at pick i: the best man, on its estimate, still there in each run (left: who
  // is there, by the run; none left, nothing)
  const expect = (c, i, left = (q, at) => (at.get(q.id) ?? Infinity) >= i) => runs.reduce((a, at) => { const q = by(c).find((y) => left(y, at)); return a + (q ? mv(c, q) : 0); }, 0) / runs.length;
  const id = (o) => `${o.origin}|${D_.year}|${o.slot <= 30 ? 1 : 2}`;
  let top = null;
  for (const B of Object.keys(G.teams)) {
    const j = D_.order.findIndex((o, i) => i > k && o.holder === B);
    if (B === H || B === human || j < 0) continue;
    const want = by(B)[0], mine = by(H)[0];
    // moving down, H finds at j those the run leaves there, and the man it would have taken at k, but not want, B's now
    const eB = expect(B, j), eH = expect(H, j, (q, at) => q !== want && ((at.get(q.id) ?? Infinity) >= j || at.get(q.id) === k));
    const slots = { [B]: W(B, mv(B, want), k) - W(B, eB, j), [H]: W(H, eH, j) - W(H, mv(H, mine), k) };
    const size = { [B]: Math.abs(W(B, mv(B, want), k)) + Math.abs(W(B, eB, j)), [H]: Math.abs(W(H, eH, j)) + Math.abs(W(H, mv(H, mine), k)) };
    const trade = { date: G.date, moves: [], picks: [{ id: id(e), from: H, to: B }, { id: id(D_.order[j]), from: B, to: H }], swaps: [], cash: [] };
    const g = (c) => X.gain(G, x, c, { ...trade, picks: trade.picks.slice(2) }) + (slots[c] ?? 0);
    const need = (c) => X.need(G, x, c, { ...trade, picks: trade.picks.slice(2) }, size[c]);   // the slots sized by what the club makes of them
    if (g(B) <= need(B)) continue;
    X.payIn(G, x, trade, g, league, B, H, () => need(H));
    const res = C.validateTrade(league, trade);
    const score = Math.min(g(B) / need(B), g(H) / need(H));
    if (res.ok && score > 1 && (!top || score > top.score)) top = { trade, res, score };
  }
  if (!top) return;
  X.complete(G, top);
}
// The chance each prospect is still on the board at the user's next pick: the clubs ahead pick
// by the same rule as draftNext, n times over (a fixed seed, so the page doesn't flicker).
export function there(G, n = 400) {
  const D_ = G.draft, k = D_.order.findIndex((e, i) => i >= D_.picks.length && e.holder === G.user), r = S.rng(D_.year), c = {};
  if (k < 0) return null;
  const view = publicView(G, D_.avail.map((id) => G.players[id]), capAt(G, D_.year));
  for (let t = 0; t < n; t++) {
    let pool = D_.avail.map((id) => G.players[id]);
    for (let i = D_.picks.length; i < k; i++) { const p = simPick(pool, r, GM.pickSd(G, G.teams[D_.order[i].holder].gm), view); pool = pool.filter((x) => x !== p); }
    for (const p of pool) c[p.id] = (c[p.id] || 0) + 1 / n;
  }
  return { slot: D_.order[k].slot, p: c };
}
// The chance each prospect goes with the pick on the clock: the club on it picks by its own rule,
// n times over (a fixed seed per pick, so the page doesn't flicker).
export function takenNow(G, n = 400) {
  const D_ = G.draft, c = onClock(G), r = S.rng(D_.year * 100 + D_.picks.length), pool = D_.avail.map((id) => G.players[id]), out = {};
  const view = publicView(G, pool, capAt(G, D_.year));
  for (let t = 0; t < n; t++) { const p = simPick(pool, r, GM.pickSd(G, G.teams[c.holder].gm), view); out[p.id] = (out[p.id] || 0) + 1 / n; }
  return out;
}
// Draft and stash: a club leaves a first-round pick abroad before his rookie deal begins, keeping his
// rights; he signs the scale for his slot whenever it brings him over (newLeagueYear's rights).
export function stash(G, ab, id) {
  const T = G.teams[ab], p = G.players[id];
  T.roster = T.roster.filter((x) => x !== id); p.contract = null; p.tm = null; p.abroad = G.season + 1;
  (T.rights ||= []).push(id);
}
export function draftEnd(G) {
  for (const id of G.draft.avail) { const p = G.players[id]; p.tm = null; p.contract = null; G.fa.push(id); }
  G.history.at(-1).draft = G.draft.picks; G.lastDraft = G.draft.year;
  delete G.draft;
  G.phase = 'offseason';
}
export function runDraft(G, r) { draftStart(G, r); draftNext(G, r, null, null); const p = G.draft.picks; draftEnd(G); return p; }
function shrinkBoard(p, pool) {
  const t = pool.map((x) => x.talent), b = pool.map((x) => x.board);
  const mean = (a) => a.reduce((x, y) => x + y) / a.length, mt = mean(t), mb = mean(b);
  const cov = t.reduce((a, x, i) => a + (x - mt) * (b[i] - mb), 0) / t.length, vb = b.reduce((a, x) => a + (x - mb) ** 2, 0) / b.length;
  return mt + cov / vb * (p.board - mb);
}

// ---- options, qualifying offers, free agents -----------------------------------------------------
// Into the new league year: options are decided on value, expiring deals end, qualifying offers go
// to rookie-scale players worth them, and every expiring man's club keeps a cap hold on him.
export function newLeagueYear(G, r, decide = {}) {
  const s = G.season + 1, f = fig(G, s), P = G.players;
  G.caps[s] = G.caps[s] ?? G.caps[G.season] * (1 + Math.min(G.K.capGrowth.max, Math.max(0, G.K.capGrowth.mean + G.K.capGrowth.sd * r.normal())));
  G.f[s] = C.figures(s, G.caps[s]);
  const F = G.f[s];
  for (const [ab, T] of Object.entries(G.teams)) {
    T.holds = []; T.rfa = [];
    for (const id of T.roster.slice()) {
      const p = P[id], c = p.contract, y = C.yearOf(c, s);
      if (y?.opt === 'pl') {                                   // player option: in if the market won't beat it
        const inn = (decide.playerOption || ((pp) => y.sal >= askOf(G, pp, F).sal))(p);
        if (!inn) c.years = c.years.filter((x) => x.s < s);
      } else if (y?.opt === 'tm') {
        const keep = (ab === G.user && decide.teamOption) ? decide.teamOption(p) : teamValue(G, ab, p) >= y.sal;
        if (!keep) c.years = c.years.filter((x) => x.s < s);
        else y.opt = null;
      }
      if (!C.yearOf(c, s)) {                                   // expiring: a free agent
        const prior = (C.yearOf(c, s - 1)?.sal || 0);
        p.prior = prior / 1e6; p.freeFrom = ab;
        if (c.rookie && p.draft?.round === 1) {                // a qualifying offer makes him restricted
          const qo = C.rookieQO(p.draft.pick, capAt(G, p.draft.year), (G.lastMins?.[id] || 0) / 82 >= 2000 / 82);
          const tender = (ab === G.user && decide.qo) ? decide.qo(p, qo) : teamValue(G, ab, p) >= qo;
          if (tender) { p.qo = qo; T.rfa.push(id); }
        }
        if (!c.twoWay) T.holds.push({ pid: id, amt: C.capHold(p, prior, C.avgSalary(capAt(G, s - 1)), F) });
        T.roster = T.roster.filter((x) => x !== id);
        p.contract = null; p.tm = null; G.fa.push(id);
      }
    }
    T.dead = T.dead.filter((x) => x.s >= s);
    T.tpes = T.tpes.filter((e) => e.expires >= `${s}-07-01`);
    T.hardCap = null; T.cashSent = 0; T.cashRecv = 0;
    T.exc = C.freshExceptions(T, F);
  }
  // second-round picks and the men a club keeps abroad, once every club's free agents are on the
  // market: a two-year deal for a man worth more over three seasons than the marginal free agent
  // (the one the league's last open roster spot would go to), else a two-way deal for one worth more
  // than the marginal young man for the open two-way spots, else he plays abroad another season,
  // his club holding his rights, for up to four summers, as he does when the two-way deal he would
  // take finds his club's three two-way spots full (decide.second for the user: 'deal', 'twoWay' or null)
  const R = Object.values(G.teams).flatMap((T) => T.rights ?? []), all = Object.values(G.teams), v = (id) => v3(G, P[id]);
  const std = all.reduce((a, T) => a + 15 - T.roster.filter((x) => !P[x].contract?.twoWay).length, 0), tw = all.reduce((a, T) => a + 3 - T.roster.filter((x) => P[x].contract?.twoWay).length, 0);
  const bar = (ids, n) => ids.map(v).sort((a, b) => b - a)[Math.max(n - 1, 0)] ?? -Infinity;
  const barStd = bar([...G.fa, ...R], std), barTw = bar([...G.fa.filter((x) => P[x].yos < 4), ...R], tw);
  for (const [ab, T] of Object.entries(G.teams)) {
    T.rights = (T.rights ?? []).filter((id) => {
      const p = P[id], want = ab === G.user && decide.second ? decide.second(p) : v(id) > barStd ? 'deal' : v(id) > barTw ? 'twoWay' : null;
      const how = want === 'twoWay' && T.roster.filter((x) => P[x].contract?.twoWay).length >= 3 ? null : want;   // his club's three two-way spots full: abroad
      if (!how) { if (s - p.draft.year >= 3) p.retired = G.season; else p.abroad = s; return !p.retired; }
      delete p.abroad;
      p.contract = { ...(how === 'deal' ? D.rookieContract(p.draft.pick, s - 1, F.cap) : D.twoWayContract(s - 1, F.cap)), signed: `${s}-07-07` };
      p.tm = ab; p.bird = { team: ab, n: 0 }; T.roster.push(id);
      return false;
    });
  }
  G.season = s; G.date = `${s}-07-01`; G.phase = 'freeagency';
  retire(G, r);
}
// Retirements, each summer before free agency: every man draws his chance of walking away from the
// fitted model (K.retire, _gm_retire.py: age, rating, last season's minutes per game played), and a
// man under contract who retires forfeits the rest of it. A free agent who has gone a season unsigned
// is out of the league too: the market passed on him.
function retire(G, r) {
  const K = G.K.retire, P = G.players;
  const pRet = (p) => { const l = p.log?.at(-1); if (!l?.mpg) return 0;
    return 1 / (1 + Math.exp(-(K.const + K.age_27 * (p.age - 27) + K.rating * p.rate + K.log_mpg * Math.log(l.mpg)))); };
  const out = (p, ab) => { p.retired = G.season; delete p.tm; p.contract = null; G.log.push({ date: G.date, type: 'retire', team: ab, pid: p.id }); };
  for (const [ab, T] of Object.entries(G.teams)) T.roster = T.roster.filter((id) => { const p = P[id]; if (r() < pRet(p)) { out(p, ab); return false; } return true; });
  G.fa = G.fa.filter((id) => { const p = P[id]; if ((p.idle || 0) >= 1 || r() < pRet(p)) { out(p, p.freeFrom || null); return false; } return true; });
}

// ---- free agency -------------------------------------------------------------------------------
// Day 0: clubs re-sign their own on Bird rights, as often as the re-signing model says players stay.
// Then rounds: each club bids for the free agent its GM values most above the price, through
// whatever the rules leave it (room, an exception, the minimum); each player takes the best offer
// that meets an ask that falls as the summer goes; restricted players' clubs may match.
// In steps for the page: faStart (re-signings), faDay as often as wanted, faEnd. human is the
// user's club (null: computer GMs run every club). user: { resign(p, ask) } for faStart and
// { offers: [{ pid, ab, how, sal, years }], match: { pid: bool } } for faDay -- an offer sheet to the
// user's restricted free agent waits a day for the user's answer.
const faDate = (s, d) => new Date(Date.UTC(s, 6, 6 + d)).toISOString().slice(0, 10);   // day 0 = July 6
export function faStart(G, r, user = {}, human = G.user) {
  const s = G.season, F = fig(G, s), P = G.players, K = G.K;
  setLeagueNet(G);
  for (const [ab, T] of Object.entries(G.teams)) {
    for (const h of T.holds.slice()) {
      const p = P[h.pid];
      if (!G.fa.includes(p.id)) continue;
      const a = askOf(G, p, F), lvl = C.birdLevel(p, ab);
      // an owner weighs the tax a re-signing brings as far as his tolerance for it lets him
      const pay = C.teamSalary(T, G, s), taxUp = C.taxCost(T, pay, a.sal, F, s, C.taxShare(G, s));
      const wants = ab === human ? user.resign?.(p, a)
        : (nowWeight(G, ab) * teamValue(G, ab, p) >= 0.85 * a.sal + (1 - T.gm.taxTol) * taxUp && r() < M.pResign(p, K));
      if (!wants) continue;
      const o = resignTerms(G, ab, p, a);
      if (C.validateSigning(G, { team: ab, pid: p.id, how: o.how, date: faDate(s, 0), years: years5(o.sal, o.years, o.raise), prior: (p.prior || 0) * 1e6 }).ok)
        sign(G, ab, p, o.how, o.sal, o.years, faDate(s, 0), o.raise);
    }
    // computer GMs renounce the holds they will not use, keeping their restricted free agents
    if (ab !== human) T.holds = T.holds.filter((h) => T.rfa.includes(h.pid));
  }
  G.fa_ = { day: 1, sheets: {}, calls: {}, resp: {} };
  G.phase = 'freeagency'; G.date = faDate(s, 1);
}
// What a club's own free agent takes to stay: his ask, within what his Bird level allows.
export function resignTerms(G, ab, p, a = askOf(G, p, fig(G, G.season))) {
  const F = fig(G, G.season), lvl = C.birdLevel(p, ab), prior = (p.prior || 0) * 1e6;
  const years = Math.max(Math.min(a.years + (lvl === 'full' ? 1 : 0), lvl === 'full' ? 5 : 4), lvl === 'early' ? 2 : 1);
  const how = lvl === 'full' ? 'bird' : lvl === 'early' ? 'earlyBird' : 'nonBird';
  const lim = how === 'bird' ? Infinity : how === 'earlyBird' ? Math.max(1.75 * prior, 1.05 * C.avgSalary(F.cap))
    : Math.max(1.2 * prior, 1.2 * C.minSalary(p.yos, F.cap), p.qo || 0);
  return { how, years, sal: Math.round(Math.min(a.sal, lim)), raise: how === 'nonBird' ? 0.05 : 0.08 };
}
// A sign-and-trade: club ab re-signs its free agent on his Bird rights, 3 or 4 seasons at 5% raises,
// to trade him on the spot (the trade itself goes through trades.judge / complete).
export function satTerms(G, ab, p) { const o = resignTerms(G, ab, p); return { ...o, years: Math.min(Math.max(o.years, 3), 4), raise: 0.05 }; }
export function satSign(G, ab, p) {
  const o = satTerms(G, ab, p);
  sign(G, ab, p, o.how, o.sal, o.years, G.date, o.raise);
  p.contract.how = 'sat';
}
// One day of the market; returns true when the market has gone quiet or the month is out.
export function faDay(G, r, user = {}, human = G.user) {
  const s = G.season, F = fig(G, s), P = G.players, st = G.fa_, day = st.day++;
  G.date = faDate(s, day);
  const rfaClub = (pid) => Object.entries(G.teams).find(([, T]) => T.rfa?.includes(pid))?.[0];
  const matchSign = (ab, p, o) => sign(G, ab, p, C.birdLevel(p, ab) === 'full' ? 'bird' : 'earlyBird', o.sal, o.years, G.date, 0.05);
  for (const [pid, o] of Object.entries(st.sheets)) {                  // the user's answers to yesterday's sheets
    const ab = rfaClub(pid);
    if (user.match?.[pid]) matchSign(ab, P[pid], o); else sign(G, o.ab, P[pid], o.how, o.sal, o.years, G.date, 0.05);
  }
  st.sheets = {};
  const offers = {};
  for (const ab of Object.keys(G.teams)) {
    if (ab === human) continue;
    const best = bestTarget(G, ab, day);
    if (best) (offers[best.pid] ||= []).push({ ab, ...best });
  }
  for (const o of user.offers || []) if (G.fa.includes(o.pid)) (offers[o.pid] ||= []).push(o);
  // a rival's offer that the user was told of yesterday still stands, if the rules still allow it
  st.calls ??= {}; st.resp = {};
  for (const [pid, o] of Object.entries(st.calls))
    if (G.fa.includes(pid) && C.validateSigning(G, { team: o.ab, pid, how: o.how, date: G.date, years: years5(o.sal, o.years, 0.05), prior: (P[pid].prior || 0) * 1e6 }).ok) (offers[pid] ||= []).push(o);
  for (const [pid, os] of Object.entries(offers)) {
    const p = P[pid], need = askOf(G, p, F).sal * (1 - 0.025 * day);
    const top = os.filter((o) => o.sal >= need).sort((a, b) => b.sal * b.years - a.sal * a.years)[0];
    const mine = os.find((o) => o.ab === human);
    // the agent answers the user: short of the ask he counters; topped by a rival, he waits a day
    // for the user to beat it (once), then signs with the best
    if (mine && mine.sal < need) st.resp[pid] = { status: 'short', need: Math.ceil(need / 1e5) * 1e5 };
    if (!top) continue;
    if (mine && top.ab !== human && mine.sal >= need && !st.calls[pid]) { st.calls[pid] = top; st.resp[pid] = { status: 'outbid', top }; continue; }
    delete st.calls[pid];
    if (mine) st.resp[pid] = { status: top.ab === human ? 'signed' : 'lost', top };
    const club = p.qo && rfaClub(pid);
    if (club && club !== top.ab) {                                     // an offer sheet: does the club match?
      if (club === human) { st.sheets[pid] = top; continue; }
      if (teamValue(G, club, p) >= top.sal) { matchSign(club, p, top); continue; }
    }
    sign(G, top.ab, p, top.how, top.sal, top.years, G.date, 0.05);
  }
  const quiet = !Object.keys(offers).length && day > 5;
  return (quiet || day >= 30) && !Object.keys(st.sheets).length;
}
export function faEnd(G, r, human = G.user) {
  const s = G.season, P = G.players;
  // restricted free agents nobody signed take their qualifying offer
  for (const [ab, T] of Object.entries(G.teams)) for (const pid of T.rfa || []) {
    if (G.fa.includes(pid)) sign(G, ab, P[pid], 'rfaQO', P[pid].qo, 1, faDate(s, 30), 0);
  }
  fillRosters(G, Object.keys(G.teams).filter((ab) => ab !== human));
  extensions(G, r, `${s}-09-30`, human);
  delete G.fa_;
  G.phase = 'preseason'; G.date = `${s}-10-13`;
}
export function freeAgency(G, r) { faStart(G, r, {}, null); while (!faDay(G, r, {}, null)); faEnd(G, r, null); }
// The free agent a club's GM most wants, at a salary its rules allow.
// where every club stands as free agency stands today (X.market: the tax forward, next summer's
// market), the same for every club in a day
const _today = new WeakMap();                    // kept off the game, which a save writes out whole
function today(G) {
  if (_today.get(G)?.date !== G.date) _today.set(G, { date: G.date, x: X.market(G) });
  return _today.get(G).x;
}
function bestTarget(G, ab, day) {
  const s = G.season, F = fig(G, s), T = G.teams[ab], P = G.players, K = G.K;
  const std = T.roster.filter((id) => !P[id].contract?.twoWay).length;
  if (std >= 15) return null;
  const pay = C.teamSalary(T, G, s), capPay = C.teamSalary(T, G, s, { holds: true, offseason: true });
  const w = nowWeight(G, ab);
  let best = null;
  for (const id of G.fa) {
    const p = P[id];
    if (p.qo && T.rfa?.includes(id)) continue;
    const a = askOf(G, p, F), v = w * (teamValue(G, ab, p) + GM.signPremium(T.gm, p, F.cap, K));
    if (v < a.sal * (1 - 0.025 * day)) continue;
    // the most this club can offer him, and under which rule
    const room = F.cap - capPay;
    const ways = [['room', room], ['ntmle', T.exc.ntmle], ['bae', T.exc.bae], ['tpmle', T.exc.tpmle], ['roomMle', T.exc.roomMle], ['min', C.minSalary(p.yos, F.cap)]];
    for (const [how, lim] of ways) {
      if (lim <= 0) continue;
      const sal = Math.min(a.sal, v, lim, how === 'min' ? lim : Infinity);
      if (how === 'min' && a.sal > lim * 1.2) continue;
      const o = { pid: id, how, sal: how === 'min' ? C.minSalary(p.yos, F.cap) : Math.round(sal), years: how === 'min' ? 1 : Math.min(a.years, how === 'bae' || how === 'tpmle' ? 2 : how === 'roomMle' ? 3 : 4) };
      // a club this signing takes into the tax uses the taxpayer MLE: the non-taxpayer MLE and the
      // bi-annual would hard-cap it at the first apron, a taxpayer's ceiling it would not choose
      if ((how === 'ntmle' || how === 'bae') && pay + o.sal > F.tax) continue;
      const ok = C.validateSigning(G, { team: ab, pid: id, how, date: `${s}-07-10`, years: years5(o.sal, o.years, 0.05), prior: p.prior * 1e6 }).ok;
      if (!ok) continue;
      // what he is worth to it less his salary, the tax he brings over the seasons ahead, as far as its
      // owner minds, and what his salary the season after does to its room next summer (plan.js)
      const x = today(G), path = Array.from({ length: PL.TAX_H }, (_, k) => (k < o.years ? o.sal * 1.05 ** k : 0));
      const gain = v - o.sal - x.tax(ab, path) + (o.years > 1 ? PL.change(x.plan, ab, o.sal * 1.05) : 0);
      if (gain <= 0) continue;
      if (!best || gain > best.gain) best = { ...o, gain };
      break;
    }
  }
  return best;
}
export const years5 = (sal, n, raise) => Array.from({ length: n }, (_, i) => ({ sal: Math.round(sal * (1 + raise * i)), gtd: Math.round(sal * (1 + raise * i)) }));
export function sign(G, ab, p, how, sal, years, date, raise) {
  const s = G.season, T = G.teams[ab];
  p.contract = { years: years5(sal, years, raise).map((y, i) => ({ ...y, s: s + i, opt: null })), signed: date, how,
    oneYearMin: how === 'min' && years === 1 && p.yos >= 3, raise120: how === 'bird' && sal > 1.2 * (p.prior || 0) * 1e6 };
  if (how === 'twoWay') { p.contract.twoWay = true; p.contract.years.forEach((y) => { y.gtd = 0; y.sal = sal; }); }
  if (how === 'ntmle' || how === 'tpmle' || how === 'bae' || how === 'roomMle') T.exc[how] -= sal;
  if (how === 'bae') T.exc.baeUsed = [...T.exc.baeUsed, s];
  if (how === 'ntmle' || how === 'bae') T.hardCap = 'apron1';
  if (how === 'tpmle') T.hardCap = T.hardCap || 'apron2';
  if (how === 'room') { T.exc.usedRoom = true; T.holds = []; }
  if (how === 'dpe') T.tpes.splice(T.tpes.findIndex((x) => x.dpe && x.expires >= date), 1);
  T.holds = T.holds.filter((h) => h.pid !== p.id);
  T.rfa = (T.rfa || []).filter((x) => x !== p.id);
  G.fa = G.fa.filter((x) => x !== p.id);
  p.tm = ab; delete p.qo; delete p.freeFrom;
  if (p.bird?.team !== ab) p.bird = { team: ab, n: 0 };
  T.roster.push(p.id);
  G.log.push({ date, type: 'sign', team: ab, pid: p.id, how, sal, years });
}
// Extend p's deal with club ab: `years` more seasons from `sal`, 8% raises. Returns the errors, if any.
export function extend(G, ab, p, sal, years, date) {
  const c = p.contract, start = c.years.at(-1).s + 1, t = C.extensionTerms(p, date, fig(G, start)), e = [...t.errors];
  if (years < 1 || years > t.maxNew) e.push(`between 1 and ${t.maxNew} more seasons`);
  if (sal > t.maxY1) e.push(`year one at most $${(t.maxY1 / 1e6).toFixed(1)}M`);
  if (sal < C.minSalary(p.yos, fig(G, start).cap)) e.push('below his minimum salary');
  if (e.length) return e;
  const last = c.years.at(-1).sal, big = years > 4 || sal > 1.2 * Math.max(last, C.avgSalary(fig(G, start).cap));
  c.years.push(...years5(sal, years, 0.08).map((y, i) => ({ ...y, s: start + i, opt: null })));
  Object.assign(c, { signed: date, how: big ? 'ext_big' : 'ext', rookie: false, oneYearMin: false });
  G.log.push({ date, type: 'extend', team: ab, pid: p.id, sal, years });
  return [];
}
// What p asks to extend: the ask in the first new season, as an extension (they pay more than free
// agency at a rating: the club chose him).
export const extensionAsk = (G, p) => askOf(G, p, fig(G, p.contract.years.at(-1).s + 1), 1);
// Computer GMs extend the players they value at their ask (a contender more, a rebuilder less), as
// often as such players re-sign.
export function extensions(G, r, date, human = G.user) {
  for (const [ab, T] of Object.entries(G.teams)) {
    if (ab === human) continue;
    for (const id of T.roster) {
      const p = G.players[id], c = p.contract;
      if (!c || c.twoWay) continue;
      const start = c.years.at(-1).s + 1, t = C.extensionTerms(p, date, fig(G, start));
      if (t.errors.length) continue;
      const a = extensionAsk(G, p), sal = Math.min(a.sal, t.maxY1);
      if (nowWeight(G, ab) * teamValue(G, ab, p, start - G.season) >= sal && r() < M.pResign(p, G.K)) extend(G, ab, p, sal, Math.min(a.years, t.maxNew), date);
    }
  }
}
// Every club reaches 14 standard contracts and 3 two-ways with the best men left -- best over the
// next three seasons, so a club filling its bench takes the 22-year-old with a future over the
// 35-year-old with a past: minimum deals, and two-ways for players with under four years of service.
// a man's value to a club over the next three seasons, in wins
const v3 = (G, p) => [0, 1, 2].reduce((a, h) => a + M.war(p, h, G.K), 0);
export function fillRosters(G, clubs = Object.keys(G.teams), date = G.phase === 'season' ? G.date : `${G.season}-09-25`) {
  const s = G.season, F = fig(G, s), P = G.players, K = G.K;
  const byRate = () => G.fa.slice().sort((a, b) => v3(G, P[b]) - v3(G, P[a]));
  for (const ab of clubs) {
    const T = G.teams[ab];
    while (T.roster.filter((id) => !P[id].contract?.twoWay).length < 14) {
      // the best man a minimum deal can bring in: a hard-capped club can't pass its apron even for him
      const id = byRate().find((x) => C.validateSigning(G, { team: ab, pid: x, how: 'min', date, years: years5(C.minSalary(P[x].yos, F.cap), 1, 0), prior: (P[x].prior || 0) * 1e6 }).ok); if (!id) break;
      sign(G, ab, P[id], 'min', C.minSalary(P[id].yos, F.cap), 1, date, 0);
    }
    // its own two-way men first, whose deals ran out: a two-way qualifying offer keeps them restricted
    // (up to three seasons on two-ways with one club)
    const own = (x) => P[x].freeFrom === ab && P[x].log?.at(-1)?.tw && P[x].log.filter((l) => l.tw && l.tm === ab).length < 3;
    while (T.roster.filter((id) => P[id].contract?.twoWay).length < 3) {
      const young = byRate().filter((x) => P[x].yos < 4), id = young.find(own) ?? young[0]; if (!id) break;
      sign(G, ab, P[id], 'twoWay', C.twoWaySalary(F.cap), 1, date, 0);
    }
  }
}

// ---- a whole year, untouched by the user (computer GMs decide for every club) --------------------
// The user out of work, waiting a year: the league plays on without him, from the draft under way to
// the next one, where the clubs that changed GMs that summer may call (gm.js offers)
export function toNextDraft(G, r) {
  G.autoUser = true;
  draftNext(G, r, null, null); draftEnd(G);
  newLeagueYear(G, r);
  freeAgency(G, r);
  X.tradeWindow(G, r, `${G.season}-09-20`, TRADES.summer, null);
  fillRosters(G);
  for (const ab of Object.keys(G.teams)) cutdown(G, r, ab);
  playSeason(G, r);
  endSeason(G, r);
  X.tradeWindow(G, r, `${G.season + 1}-06-20`, TRADES.draft, null);
  draftStart(G, r);
  delete G.autoUser;
}
export function simYear(G, r) {
  G.autoUser = true;                                // no one at the controls: the user's club is a computer GM's too
  fillRosters(G);                                   // offseason trades can leave a club short
  for (const ab of Object.keys(G.teams)) cutdown(G, r, ab);
  const h = playSeason(G, r);
  endSeason(G, r);
  X.tradeWindow(G, r, `${G.season + 1}-06-20`, TRADES.draft, null);    // around the draft
  runDraft(G, r);
  newLeagueYear(G, r);
  freeAgency(G, r);
  X.tradeWindow(G, r, `${G.season}-09-20`, TRADES.summer, null);
  delete G.autoUser;
  return h;
}
