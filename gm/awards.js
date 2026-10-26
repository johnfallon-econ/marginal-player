// The season's numbers and its awards: league leaders, and the media's votes (K.awards,
// _gm_awards.py: a rank-ordered logit fit on every real MVP and All-NBA vote, 1999-2025; 100 voters
// each rank the field by its utility plus his own read and score ballots as the real ones are).
import * as V from './dev.js';
import * as S from './season.js';

// every man's season s line: the season under way from its running totals, a finished one from the logs
export function lines(G, s) {
  const team = Object.fromEntries(Object.entries(G.teams).flatMap(([ab, t]) => t.roster.map((id) => [id, ab])));
  const out = [];
  for (const p of Object.values(G.players)) {
    const l = s === G.season && G.cur ? (G.cur.gp[p.id] ? { gp: G.cur.gp[p.id], mpg: G.cur.mins[p.id] / G.cur.gp[p.id], rate: V.seasonRate(p, G.cur.mins[p.id], G.K, G.hidden), lean: p.lean, tm: team[p.id] } : null)
      : p.log?.find((x) => x.s === s);
    if (!l || !l.gp) continue;
    const p100 = l.p100 ?? (s === G.season && G.cur ? V.boxLine(p, l.mpg, G.K, s, l.gp) : null);
    out.push({ p, tm: l.tm, gp: l.gp, mpg: l.mpg, rate: l.rate, off: (l.rate + (l.lean ?? 0)) / 2, def: (l.rate - (l.lean ?? 0)) / 2, pg: perGame(G, p100, l.mpg) });
  }
  return out;
}
// A per-100 line per game (about 100 possessions a 48 minutes), by name (K.box.line), with the
// shooting shares and true shooting (points over two shots, a free throw 0.44 of one)
export function perGame(G, p100, mpg) {
  if (!p100) return null;
  const l = Object.fromEntries(G.K.box.line.map((k, i) => [k, p100[i] * mpg / 48]));
  return { ...l, fg_pct: l.fgm / l.fga, ft_pct: l.ftm / l.fta, ts_pct: l.pts / (2 * (l.fga + 0.44 * l.fta)) };
}
// One man's line, per game: the season under way, else his last; null before his first NBA game
export function line(G, p) {
  const live = G.cur?.gp[p.id], l = live ? { s: G.season, gp: live, mpg: G.cur.mins[p.id] / live } : p.log?.findLast((x) => x.gp);
  if (!l) return null;
  return { s: l.s, gp: l.gp, mpg: l.mpg, pg: perGame(G, live ? V.boxLine(p, l.mpg, G.K, G.season, l.gp) : l.p100, l.mpg) };
}
// The top five in each per-game line, among men in 70% of their club's games, in the season under way
export function leaders(G, s) {
  const L = lines(G, s), rec = G.cur.record;
  const ok = L.filter((x) => x.pg && rec?.[x.tm] && x.gp >= 0.7 * (rec[x.tm].w + rec[x.tm].l));
  const top = (f) => ok.slice().sort((a, b) => f(b) - f(a)).slice(0, 5).map((x) => [x.p.id, f(x)]);
  return { pts: top((x) => x.pg.pts), reb: top((x) => x.pg.reb), ast: top((x) => x.pg.ast), stl: top((x) => x.pg.stl), blk: top((x) => x.pg.blk), rating: top((x) => x.rate) };
}
// 100 voters rank the field; shares of the possible points, best first
function vote(field, rec, M, pts, seed) {
  const u = field.map((x) => M.coef.rating * x.rate + M.coef.ppg * x.pg.pts + M.coef.win_pct * rec[x.tm].w / (rec[x.tm].w + rec[x.tm].l) + M.coef.g_82 * x.gp / 82);
  const r = S.rng(seed), tot = field.map(() => 0);
  for (let v = 0; v < 100; v++) {
    const d = u.map((x, i) => [M.scale * x - Math.log(-Math.log(r() || 1e-12)), i]).sort((a, b) => b[0] - a[0]);
    pts.forEach((k, j) => { if (d[j]) tot[d[j][1]] += k; });
  }
  return field.map((x, i) => [x.p.id, tot[i] / (100 * pts[0])]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
}
// The season's awards, as the Finals end (the season's running totals still there). MVP and All-NBA are the fitted votes; Rookie and Sixth Man of the Year the
// MVP voters' model over rookies and over men outside their club's top five (5-3-1 ballots); there
// is no vote record to fit Defensive Player and Most Improved on, so they go to the best defensive
// rating and the largest rise in rating. MVP, All-NBA, Defensive Player and Most Improved need 65
// games, as under the 2023 CBA.
export function awards(G, s) {
  const K = G.K.awards, rec = G.lastRecord, L = lines(G, s).filter((x) => x.pg && rec[x.tm] && x.gp >= 20);
  const g65 = L.filter((x) => x.gp >= 65), seed = (k) => Math.abs(Math.round(1e6 * V.hashNoise(`award|${k}|${s}`)));
  const mvp = vote(g65, rec, K.mvp, [10, 7, 5, 3, 1], seed('mvp')).slice(0, 5);
  const nba = vote(g65, rec, K.all_nba, [...Array(5).fill(5), ...Array(5).fill(3), ...Array(5).fill(1)], seed('nba')).slice(0, 15).map(([id]) => id);
  const starter = (x) => { const T = G.teams[x.tm], m = (q) => (q.role?.s === s ? q.role.m : 0);
    return T.roster.map((id) => G.players[id]).sort((a, b) => m(b) - m(a)).slice(0, 5).includes(x.p); };
  const best = (xs, f) => xs.slice().sort((a, b) => f(b) - f(a))[0];
  const dp = best(g65.filter((x) => x.mpg >= 20), (x) => x.def);
  const prev = (x) => x.p.log?.find((l) => l.s === s - 1 && l.gp >= 41);
  const mi = best(g65.filter(prev), (x) => x.rate - prev(x).rate);
  return { mvp, allNba: [nba.slice(0, 5), nba.slice(5, 10), nba.slice(10, 15)],
    // a rookie has played no NBA game in an earlier season (years of service miss two-way seasons)
    roy: vote(L.filter((x) => !x.p.log?.some((l) => l.s < s && l.gp > 0)), rec, K.mvp, [5, 3, 1], seed('roy')).slice(0, 3),
    smoy: vote(L.filter((x) => !starter(x)), rec, K.mvp, [5, 3, 1], seed('smoy')).slice(0, 3),
    dpoy: dp && [dp.p.id, +dp.def.toFixed(2)], mip: mi && [mi.p.id, +(mi.rate - prev(mi).rate).toFixed(2)] };
}
