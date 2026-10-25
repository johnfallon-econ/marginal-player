// Planning for next summer (trades.js, league.js). A club values cap room by what it could buy with
// it when free agency opens: the coming class -- every man whose deal ends before season Y, counted
// as far as he is not likely to re-sign where he is (the site's re-signing model, M.pResign) -- at
// what he will ask (M.ask) and the surplus he brings over it, each shared with the other clubs that
// will have room for him. Room buys the best set the club can fit (a knapsack, in STEP dollars), so
// it is lumpy: room for a max man, whom few clubs can afford, is worth far more than the dollars, and
// a club short of it has reason to clear salary. A trade or a signing that changes the club's salary
// for season Y changes what its room is worth; PLAN scales it (1: as estimated; the dump rate in
// the game's trades, _gm_trade_shape_2021_2024.json, does not tell the scales apart).
import * as M from './value.js';
import * as C from './cba.js';

export let PLAN = 1;   // room at what it buys, unscaled: with the GMs' discount, salary dumps (6.5-7.9% of trades at scales 2-4, real 2021-24 5.8%) and payrolls barely move with it
export const tune = (v) => { PLAN = v; };

// Next summer's market as of now: season Y's figures F, cap(s) the cap of season s
export function market(G, Y, F, cap) {
  const K = G.K, fa = [];
  for (const p of Object.values(G.players)) {
    const c = p.contract;
    if (!c || c.twoWay || c.tenDay || !p.tm || c.years.some((y) => y.s >= Y)) continue;
    const a = M.ask(p, F, K), h0 = Y - (G.season + 1);       // h: seasons past next, as marketValue counts them
    let sur = 0;
    for (let i = 0; i < a.years; i++) sur += (M.marketValue(p, h0 + i, cap(Y + i), K) - a.sal) / M.DISC ** i;
    const reach = 1 - M.pResign(p, K);
    if (sur > 0) fa.push({ sal: a.sal, sur: sur * reach });
  }
  const room = Object.fromEntries(Object.entries(G.teams).map(([ab, T]) => [ab, F.cap - C.teamSalary(T, { ...G, f: { ...G.f, [Y]: F } }, Y, { holds: true, offseason: true })]));
  const rooms = Object.values(room);
  for (const f of fa) { f.rivals = rooms.filter((r) => r >= f.sal).length; f.w = Math.ceil(f.sal / STEP); }
  // each club's worth of room, by STEP: the best set it fits, each man shared with his other bidders
  const top = Math.ceil(Math.max(F.cap, ...rooms) / STEP), curve = {};
  for (const ab of Object.keys(room)) {
    const v = new Float64Array(top + 1);
    for (const f of fa) {
      const g = f.sur / (1 + f.rivals - (room[ab] >= f.sal ? 1 : 0));
      for (let k = top; k >= f.w; k--) if (v[k - f.w] + g > v[k]) v[k] = v[k - f.w] + g;
    }
    curve[ab] = v;
  }
  return { Y, room, curve, top };
}
export const STEP = 1e6;
// What room r is worth to club ab, $ (no room, nothing), a season off (M.DISC)
export const worth = (mk, ab, r) => (r < STEP ? 0 : PLAN * mk.curve[ab][Math.min(Math.floor(r / STEP), mk.top)] / M.DISC);
// The change in what club ab's room is worth when its season-Y salary rises by d
export const change = (mk, ab, d) => worth(mk, ab, mk.room[ab] - d) - worth(mk, ab, mk.room[ab]);

// ---- the luxury tax, forward ---------------------------------------------------------------------
// A club weighs a move's tax over the next TAX_H seasons, not this one alone: its committed payroll
// each season (contracts signed: later re-signings are not in it), the tax that brings at that
// season's line, at the repeater's rates once it has paid in three of the four seasons before -- the
// clock running along the path, so getting under the line now lowers the bills after -- the share of
// the tax it gives up by paying (C.taxShare), and, over the second apron, the first-round pick that
// freezes (apron: its worth to the club), each season discounted. s: the season a move's salary
// first counts in.
export const TAX_H = 3;
export function taxPlan(G, s, figs, share, apron) {
  const pay = {};
  for (const [ab, T] of Object.entries(G.teams))
    pay[ab] = figs.map((f, k) => C.teamSalary(T, { ...G, f: { ...G.f, [s + k]: f } }, s + k));
  return { s, figs, pay, share, apron };
}
function path(tp, T, ab, dv) {
  const paid = T.taxpaid || {}, now = [];          // seasons before the path as paid, along it as projected
  let v = 0;
  tp.figs.forEach((f, k) => {
    const t = tp.s + k, p = tp.pay[ab][k] + (dv[k] || 0);
    let n = 0; for (let j = 1; j <= 4; j++) if (j <= k ? now[k - j] : paid[t - j]) n++;
    now[k] = p > f.tax;
    v += (C.taxBill(p, f, n >= 3) + (now[k] ? tp.share : 0) + (p > f.apron2 ? tp.apron[ab] : 0)) / M.DISC ** k;
  });
  return v;
}
// What salary changes dv (by season, from s) do to club ab's tax over the path, $
export const taxChange = (tp, T, ab, dv) => path(tp, T, ab, dv) - ((tp.base ||= {})[ab] ??= path(tp, T, ab, []));   // the path as it stands, once a club
