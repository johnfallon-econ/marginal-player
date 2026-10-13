// A league that runs itself, year after year: the season, then the offseason in the order the
// calendar runs it. Every decision a club makes goes through one function, so the page can put
// the user's club's decisions to the user and give everyone else's to their GMs.
import * as C from './cba.js';
import * as S from './season.js';
import * as V from './dev.js';
import * as D from './draft.js';
import * as M from './value.js';
import * as X from './trades.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
export const TRADES = 30;                               // a window's ceiling on deals; value decides how many happen

// ---- a new game ----------------------------------------------------------------------------
// L: data/gm_league.json; cal: data/gm_calibration.json; opts: { team, hidden, seed }
export function newGame(L, cal, opts) {
  const r = S.rng(opts.seed ?? Date.now() % 2 ** 31);
  const K = { ...L.const, ...cal };
  const G = { season: L.season, phase: 'preseason', date: L.date, user: opts.team, hidden: !!opts.hidden,
    K, caps: { [L.season]: C.figures(L.season, 0).cap }, f: {}, teams: {}, players: {}, fa: [], picks: clone(L.picks),
    history: [], log: [], lotteryHist: {}, seed: opts.seed };
  G.f[L.season] = C.figures(L.season, G.caps[L.season]);
  for (const [ab, t] of Object.entries(L.teams)) {
    G.teams[ab] = { ...t, roster: [], dead: [], holds: [], tpes: [], hardCap: null, cashSent: 0, cashRecv: 0,
      gm: gmPersonality(r), exc: null };
    G.teams[ab].exc = C.freshExceptions(G.teams[ab], G.f[L.season]);
  }
  for (const p0 of [...L.players, ...L.freeAgents]) {
    const p = { ...clone(p0) };
    V.initTalent(p, K, r, G.hidden);
    G.players[p.id] = p;
    if (p.tm) G.teams[p.tm].roster.push(p.id); else G.fa.push(p.id);
  }
  G.scoutSd = D.solveScoutSd(L, r);
  G.names = L.names; G.draftData = L.draft;
  setLeagueNet(G);                                // projected wins average 41 from the start
  G.rngState = r.state();
  return G;
}

// A computer GM's leanings, fixed for the game: how far his valuations stray from the model
// (noise), whether he leans young or old, how much he pays to win now, how much tax he stands.
function gmPersonality(r) {
  return { noise: 0.15 + 0.15 * r(), youth: 0.1 * r.normal(), winNow: 0.1 * r.normal(), taxTol: r() };
}
// What club `ab` thinks a player is worth next season, $: the market value seen through his GM.
export function teamValue(G, ab, p, h = 0) {
  const g = G.teams[ab].gm, base = M.marketValue(p, h, capAt(G, G.season + 1 + h), G.K);
  const lean = 1 + g.youth * (27 - p.age) / 5 + g.winNow * (p.age > 28 ? 1 : 0);
  return base * lean * (1 + g.noise * hashNoise(`${ab}|${p.id}|${G.season}`));
}
// a stable N(0,1) per (club, player, season): the same GM thinks the same thing all summer
function hashNoise(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const u = ((h >>> 0) + 0.5) / 4294967296, v = ((Math.imul(h, 2654435761) >>> 0) + 0.5) / 4294967296;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// A player's ask this summer, with his max-or-not draw fixed for the summer (hashed, so asking twice
// gives the same answer)
export const askOf = (G, p, F) => M.ask(p, F, G.K, S.Phi(hashNoise(`ask|${p.id}|${G.season}`)));
// A club's projected wins for the coming season: the site's identity, 41 + wins-per-net x net,
// with each man at his projection and the role he is in line for.
export function projWins(G, ab) {
  const ps = G.teams[ab].roster.map((id) => G.players[id]).filter((p) => !p.contract?.twoWay);
  return 41 + G.K.winsPerNet * (S.net(ps.map((p) => ({ ...p, play: p.rate })), G.K.maxMpg) - (G.leagueNet ?? 0));
}
export function setLeagueNet(G) {
  G.leagueNet = 0;
  const n = Object.keys(G.teams).map((ab) => projWins(G, ab));
  G.leagueNet = (n.reduce((a, b) => a + b, 0) / n.length - 41) / G.K.winsPerNet;
}
// The cap for a future season: the draws already made, else the expected path.
export function capAt(G, s) {
  if (G.caps[s]) return G.caps[s];
  const last = Math.max(...Object.keys(G.caps).map(Number));
  return G.caps[last] * (1 + G.K.capGrowth.mean) ** (s - last);
}
const fig = (G, s) => (G.f[s] ??= C.figures(s, capAt(G, s)));

// ---- preseason: cut to 15 standard contracts and 3 two-way ---------------------------------
// The rule the cutdown predictor uses: keep = value next season less non-guaranteed salary.
export function cutdown(G, r, ab, choose) {
  const T = G.teams[ab], P = G.players, s = G.season;
  const std = () => T.roster.filter((id) => !P[id].contract?.twoWay);
  while (std().length > 15) {
    const ranked = std().map((id) => { const y = C.yearOf(P[id].contract, s); return [id, M.marketValue(P[id], 0, fig(G, s).cap, G.K) - (y.sal - y.gtd)]; })
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
// linear through a table of [x, y] points, flat past either end
const interp = (t, x) => { const i = t.findIndex((c) => c[0] >= x);
  return i < 0 ? t.at(-1)[1] : i === 0 ? t[0][1] : t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); };
// A club's rotation as its coach sees it: [player, minutes per game when he plays], most first. Until
// the coaches first set roles, the real 2026-27 roles stand (minutes per game played: mpg / av).
// After that (K.roles, _gm_roles.py) a man's minutes are what his rating earns on the league's curve,
// plus how far above or below it he played last season (carried over in part), moved by age, a
// change of club and where his minutes rank among his club-mates', times the coach's own read of him
// (the fit's residual, drawn once a season, steadier the more he played); a rookie's go by his draft slot. The fit's intercept,
// how far men with 40+ games sit above the all-player curve, is left out: the curve is everyone's
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
    return Math.min(Math.exp(x + (pr ? interp(V_.sd_by_mpg, pr[0]) : Rk.sd) * hashNoise(`coach|${p.id}|${G.season}`)), G.K.maxMpg);
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
  G.cur = S.startSeason(lg(G), G.season, r); G.seasonOver = false;
  G.phase = 'season'; G.date = C.seasonDates(G.season).opening;
}
export const seasonTo = (G, r, frac) => S.simDays(lg(G), G.cur, r, Math.floor(G.cur.days.length * frac));
const lg = (G) => ({ teams: G.teams, players: G.players, const: G.K });
// trade windows in the season: Dec 15, when summer signings become tradable (56 of 173 days in),
// and the deadline (114 of 173)
export const WINDOWS = [{ frac: 56 / 173, date: 'dec15' }, { frac: 114 / 173, date: 'deadline' }];
export function postseason(G, r) {
  const s = G.season, K = G.K, res = G.cur;
  const stand = S.standings(G.teams, res.record, r);
  const nets = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab,
    S.net(G.teams[ab].roster.map((id) => G.players[id]).filter((p) => !p.contract?.twoWay), K.maxMpg)]));
  const po = S.postseason(G.teams, res.record, stand, nets, K, r);
  G.history.push({ season: s, record: Object.fromEntries(Object.entries(res.record).map(([k, v]) => [k, [v.w, v.l]])),
    standings: stand, playin: po.playin, seeds: po.seeds, rounds: po.rounds, champion: po.champion });
  G.lastMins = res.mins; G.lastGp = res.gp; G.lastRecord = res.record; G.lastPlayin = po.playin; G.lastStand = stand;
  delete G.cur;
  G.seasonOver = true;                              // trades reopen after the Finals
  G.phase = 'offseason'; G.date = `${s + 1}-06-15`;
  return G.history.at(-1);
}
export function playSeason(G, r, window = (date) => X.tradeWindow(G, r, date, TRADES, null)) {
  seasonStart(G, r);
  const d = C.seasonDates(G.season);
  for (const w of WINDOWS) { seasonTo(G, r, w.frac); G.date = d[w.date]; window(G.date); assignRoles(G); }
  seasonTo(G, r, 1);
  return postseason(G, r);
}

// ---- end of season: the tax, service and Bird years, development, retirements --------------
export function endSeason(G, r) {
  const s = G.season, f = fig(G, s), P = G.players;
  for (const [ab, T] of Object.entries(G.teams)) {
    const pay = C.teamSalary(T, G, s), rep = [1, 2, 3, 4].filter((k) => T.taxpaid?.[s - k]).length >= 3;
    T.tax = T.tax || {}; T.tax[s] = C.taxBill(pay, f, rep);
    (T.taxpaid ||= {})[s] = pay > f.tax;
    if (pay > f.apron2) freezePick(G, ab, s);
    for (const id of T.roster) { P[id].yos += 1; if (P[id].bird?.team === ab) P[id].bird.n += 1; else P[id].bird = { team: ab, n: 1 }; }
  }
  // each man's line for the season just played, kept for the page: club, games, minutes, rating
  for (const [ab, T] of Object.entries(G.teams)) for (const id of T.roster) {
    const gp = G.lastGp?.[id] || 0;
    (P[id].log ||= []).push({ s, tm: ab, gp, mpg: gp ? +(G.lastMins[id] / gp).toFixed(1) : 0, rate: +P[id].rate.toFixed(2) });
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
}
// a second-apron team's first-round pick seven drafts out is frozen (Art. VII §2(f))
function freezePick(G, ab, s) { const k = `${ab}|${s + 8}|1`; G.picks[k] = { ...(G.picks[k] || { t: 'clear' }), frozen: true }; }

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
  const { order, created } = D.resolvePicks([first, byRec], year, G.picks);
  Object.assign(G.picks, created);
  const pool = D.generateClass({ names: G.names, draft: G.draftData }, s, r, G.scoutSd);
  for (const p of pool) {
    // hidden talent: the league sees the scouts' board, shrunk to what it predicts; else the truth
    p.rate = G.hidden ? shrinkBoard(p, pool) : p.talent;
    p.se = 1.0; p.av = 0.9; p.prior = 0; p.trend = (G.hidden ? G.K.trendHidden : G.K.dev.trend) * r.normal();
    p.mpg = M.mpgFor(p.rate, G.K) * p.av;
    G.players[p.id] = p;
  }
  G.draft = { year, order, avail: pool.map((p) => p.id), picks: [], lottery: lot };
  G.phase = 'draft'; G.date = `${year}-06-24`;
}
export function draftNext(G, r, choice, human = G.user) {
  const D_ = G.draft, s = G.season, year = D_.year;
  while (D_.picks.length < D_.order.length) {
    const { slot, holder } = D_.order[D_.picks.length];
    if (holder === human && choice == null) return { slot, holder };          // on the clock
    const avail = D_.avail.map((id) => G.players[id]);
    const p = holder === human ? G.players[choice] : D.aiPick(avail, r, G.teams[holder].gm.noise * 3);
    choice = null;
    D_.avail = D_.avail.filter((id) => id !== p.id);
    p.tm = holder; p.draft = { year, round: slot <= 30 ? 1 : 2, pick: slot, team: holder };
    p.contract = { ...D.rookieContract(slot, s, capAt(G, year)), signed: `${year}-07-07` };
    p.bird = { team: holder, n: 0 };
    G.teams[holder].roster.push(p.id);
    D_.picks.push({ slot, team: holder, pid: p.id });
  }
  return null;
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
  G.season = s; G.date = `${s}-07-01`; G.phase = 'freeagency';
  retire(G, r);
}
// A free agent who hasn't played a season, or is 35 and below replacement, is out of the league;
// so is anyone 40 or older.
function retire(G) {
  G.fa = G.fa.filter((id) => {
    const p = G.players[id];
    const out = p.age >= 40 || (p.idle || 0) >= 1 || (p.age >= 35 && p.rate < G.K.repl);
    if (out) { p.retired = G.season; delete p.tm; }
    return !out;
  });
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
      const pay = C.teamSalary(T, G, s), rep = [1, 2, 3, 4].filter((k) => T.taxpaid?.[s - k]).length >= 3;
      const taxUp = C.taxBill(pay + a.sal, F, rep) - C.taxBill(pay, F, rep);
      const wants = ab === human ? user.resign?.(p, a)
        : (teamValue(G, ab, p) >= 0.85 * a.sal + (1 - T.gm.taxTol) * taxUp && pay + a.sal <= F.apron2 + T.gm.taxTol * 0.1 * F.cap && r() < M.pResign(p, K));
      if (!wants) continue;
      const o = resignTerms(G, ab, p, a);
      if (C.validateSigning(G, { team: ab, pid: p.id, how: o.how, date: faDate(s, 0), years: years5(o.sal, o.years, o.raise), prior: (p.prior || 0) * 1e6 }).ok)
        sign(G, ab, p, o.how, o.sal, o.years, faDate(s, 0), o.raise);
    }
    // computer GMs renounce the holds they will not use, keeping their restricted free agents
    if (ab !== human) T.holds = T.holds.filter((h) => T.rfa.includes(h.pid));
  }
  G.fa_ = { day: 1, sheets: {} };
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
  for (const [pid, os] of Object.entries(offers)) {
    const p = P[pid], need = askOf(G, p, F).sal * Math.max(0.5, 1 - 0.03 * day);
    const top = os.filter((o) => o.sal >= need).sort((a, b) => b.sal * b.years - a.sal * a.years)[0];
    if (!top) continue;
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
function bestTarget(G, ab, day) {
  const s = G.season, F = fig(G, s), T = G.teams[ab], P = G.players, K = G.K;
  const std = T.roster.filter((id) => !P[id].contract?.twoWay).length;
  if (std >= 15) return null;
  const pay = C.teamSalary(T, G, s), capPay = C.teamSalary(T, G, s, { holds: true, offseason: true });
  const ceiling = F.tax + T.gm.taxTol * (F.apron2 - F.tax);         // how far into the tax this owner goes
  let best = null;
  for (const id of G.fa) {
    const p = P[id];
    if (p.qo && T.rfa?.includes(id)) continue;
    const a = askOf(G, p, F), v = teamValue(G, ab, p);
    if (v < a.sal * Math.max(0.5, 1 - 0.03 * day)) continue;
    // the most this club can offer him, and under which rule
    const room = F.cap - capPay;
    const ways = [['room', room], ['ntmle', T.exc.ntmle], ['bae', T.exc.bae], ['tpmle', T.exc.tpmle], ['roomMle', T.exc.roomMle], ['min', C.minSalary(p.yos, F.cap)]];
    for (const [how, lim] of ways) {
      if (lim <= 0) continue;
      const sal = Math.min(a.sal, v, lim, how === 'min' ? lim : Infinity);
      if (how === 'min' && a.sal > lim * 1.2) continue;
      if (pay + sal > Math.max(ceiling, F.tax) && how !== 'min') continue;
      const o = { pid: id, how, sal: how === 'min' ? C.minSalary(p.yos, F.cap) : Math.round(sal), years: how === 'min' ? 1 : Math.min(a.years, how === 'bae' || how === 'tpmle' ? 2 : how === 'roomMle' ? 3 : 4) };
      const ok = C.validateSigning(G, { team: ab, pid: id, how, date: `${s}-07-10`, years: years5(o.sal, o.years, 0.05), prior: p.prior * 1e6 }).ok;
      if (!ok) continue;
      const gain = v - o.sal;
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
// What p asks to extend: his free-agent ask in the first new season.
export const extensionAsk = (G, p) => askOf(G, p, fig(G, p.contract.years.at(-1).s + 1));
// Computer GMs extend the players they value at their ask, as often as such players re-sign.
export function extensions(G, r, date, human = G.user) {
  for (const [ab, T] of Object.entries(G.teams)) {
    if (ab === human) continue;
    for (const id of T.roster) {
      const p = G.players[id], c = p.contract;
      if (!c || c.twoWay) continue;
      const start = c.years.at(-1).s + 1, t = C.extensionTerms(p, date, fig(G, start));
      if (t.errors.length) continue;
      const a = extensionAsk(G, p), sal = Math.min(a.sal, t.maxY1);
      if (teamValue(G, ab, p, start - G.season) >= sal && r() < M.pResign(p, G.K)) extend(G, ab, p, sal, Math.min(a.years, t.maxNew), date);
    }
  }
}
// Every club reaches 14 standard contracts and 3 two-ways with the best men left -- best over the
// next three seasons, so a club filling its bench takes the 22-year-old with a future over the
// 35-year-old with a past: minimum deals, and two-ways for players with under four years of service.
export function fillRosters(G, clubs = Object.keys(G.teams)) {
  const s = G.season, F = fig(G, s), P = G.players, K = G.K;
  const v3 = (id) => [0, 1, 2].reduce((a, h) => a + M.war(P[id], h, K), 0);
  const byRate = () => G.fa.slice().sort((a, b) => v3(b) - v3(a));
  for (const ab of clubs) {
    const T = G.teams[ab];
    while (T.roster.filter((id) => !P[id].contract?.twoWay).length < 14) {
      const id = byRate()[0]; if (!id) break;
      sign(G, ab, P[id], 'min', C.minSalary(P[id].yos, F.cap), 1, `${s}-09-25`, 0);
    }
    while (T.roster.filter((id) => P[id].contract?.twoWay).length < 3) {
      const id = byRate().find((x) => P[x].yos < 4); if (!id) break;
      sign(G, ab, P[id], 'twoWay', C.twoWaySalary(F.cap), 1, `${s}-09-25`, 0);
    }
  }
}

// ---- a whole year, untouched by the user (computer GMs decide for every club) --------------------
export function simYear(G, r) {
  fillRosters(G);                                   // offseason trades can leave a club short
  for (const ab of Object.keys(G.teams)) cutdown(G, r, ab);
  const h = playSeason(G, r);
  endSeason(G, r);
  X.tradeWindow(G, r, `${G.season + 1}-06-20`, TRADES, null);    // around the draft
  runDraft(G, r);
  newLeagueYear(G, r);
  freeAgency(G, r);
  X.tradeWindow(G, r, `${G.season}-09-20`, TRADES, null);
  return h;
}
