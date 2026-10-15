// The user's owner, and his club's books (K.fin, _gm_fin.py). Revenue is the club's own (Forbes'
// 2024-25, net of revenue sharing), growing with the cap, plus a gate for each home playoff game:
// within a club, regular-season wins move revenue by nothing measurable, a home playoff game by about
// $6M. Other costs are 28% of a club's revenue (the clubs that paid no tax, 2023-25). Profit is
// revenue less payroll, luxury tax and other costs, the operating income Forbes reports.
// An owner has a line, the least profit he will stand for a season, and weighs winning against it:
// he blocks moves that take the projected season below his line, orders payroll cut by the trade
// deadline when the season opens below it, and grades each season; his confidence falls with bad
// ones, he warns below 40 and fires below 20.
import * as C from './cba.js';
import { capAt } from './league.js';

export const OWNERS = {
  cheap: { label: 'Cheap', line: 50, money: 0.7, say: 'wants a profit of at least $50M a season (in 2024-25 dollars) and cares more for money than for winning' },
  average: { label: 'Average', line: 0, money: 0.5, say: 'wants the club to break even and weighs winning and money alike' },
  spender: { label: 'Big spender', line: -100, money: 0.3, say: 'will lose up to $100M a season (in 2024-25 dollars) to win, and cares more for winning than for money' },
};
export function hire(G, type, r) {
  const t = type === 'random' ? Object.keys(OWNERS)[Math.floor(r() * 3)] : type;
  G.owner = { type: t, pick: type, conf: 60, books: [] };
}
const scale = (G, s) => capAt(G, s) / 140.588e6;                     // 2024-25 dollars to season s's
export const line = (G, s) => OWNERS[G.owner.type].line * scale(G, s);
// the club's books for season s ($M): payroll and tax as given, revenue with n home playoff games
export function books(G, s, pay, tax, n = 0) {
  const F = G.K.fin, base = F.revenue[G.user] * scale(G, s), rev = base + F.po_gate * n * scale(G, s), other = F.other_share * base;
  return { s, rev, pay, tax, other, profit: rev - pay - tax - other, n };
}
// the season the club is spending for: the coming one once the old season's books are closed
export const season = (G) => (['offseason', 'draft'].includes(G.phase) ? G.season + 1 : G.season);
// a club's payroll for the season it is spending for
export const payroll = (G, ab) => { const s = season(G); G.f[s] ??= C.figures(s, capAt(G, s)); return C.teamSalary(G.teams[ab], G, s); };
export function projected(G, extra = 0) {
  const s = season(G), T = G.teams[G.user], F = (G.f[s] ??= C.figures(s, capAt(G, s))), rep = [1, 2, 3, 4].filter((k) => T.taxpaid?.[s - k]).length >= 3;
  const pay = C.teamSalary(T, G, s) + extra;
  return books(G, s, pay / 1e6, C.taxBill(pay, F, rep) / 1e6);
}
// null if the owner approves a move adding `extra` to this season's payroll, else his reason
export function veto(G, extra) {
  if (!G.owner || extra <= 0) return null;
  const b = projected(G, extra), l = line(G, b.s);
  return b.profit >= l ? null : `The owner won't approve it: it would take this season to a ${$(b.profit)} profit, below his line of ${$(l)}.`;
}
const $ = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(0)}M`;
// opening night: below his line, he orders payroll cut by the deadline to what gets the club there
export function opening(G) {
  const b = projected(G), l = line(G, b.s);
  if (b.profit >= l) return null;
  const T = G.teams[G.user], F = G.f[b.s], rep = [1, 2, 3, 4].filter((k) => T.taxpaid?.[b.s - k]).length >= 3;
  let target = C.teamSalary(T, G, b.s);
  while (target > 0 && books(G, b.s, target / 1e6, C.taxBill(target, F, rep) / 1e6).profit < l) target -= 1e6;
  G.owner.order = { s: b.s, target };
  return `The owner projects a ${$(b.profit)} season against his line of ${$(l)}: get payroll down to ${$(target / 1e6)} by the trade deadline.`;
}
// the deadline: an order missed costs a fifth of his confidence
export function deadline(G) {
  const o = G.owner.order; if (!o) return null;
  delete G.owner.order;
  const pay = C.teamSalary(G.teams[G.user], G, o.s);
  if (pay <= o.target) return `You met the owner's order: payroll is ${$(pay / 1e6)}.`;
  G.owner.conf -= 20;
  return `You missed the owner's order to get payroll to ${$(o.target / 1e6)} (it is ${$(pay / 1e6)}); his confidence falls 20.`;
}
// the season's review, once its books close (after endSeason): winning, a playoff run, and money
// against his line, weighted by what he cares for
export function review(G, h, r) {
  const s = h.season, T = G.teams[G.user], [w] = h.record[G.user];
  const games = Object.entries(Object.assign({}, ...h.rounds)).filter(([k]) => k.split('-').includes(G.user)).map(([, v]) => v.games.split('-').map(Number).reduce((a, b) => a + b));
  const won = Object.values(Object.assign({}, ...h.rounds)).filter((v) => v.winner === G.user).length;
  const b = books(G, s, C.teamSalary(T, G, s) / 1e6, (T.tax?.[s] || 0) / 1e6, games.reduce((a, n) => a + Math.round(n / 2), 0));
  const O = OWNERS[G.owner.type], win = Math.max(-1, Math.min(1, (w - 41) / 20 + won / 4)), money = Math.max(-1, Math.min(1, (b.profit - line(G, s)) / (50 * scale(G, s))));
  const grade = (1 - O.money) * win + O.money * money;
  G.owner.conf = Math.max(0, Math.min(100, G.owner.conf + 20 * grade));
  G.owner.books.push({ ...b, w, won, grade });
  (G.career ||= []).push({ ab: G.user, s, w, l: h.record[G.user][1], won, champ: h.champion === G.user });
  if (G.owner.conf < 20) G.fired = { s, conf: G.owner.conf, offers: offers(G, r) };
  return b;
}
// Fired, the GM hears from the clubs looking for one: those at the foot of the standings, where jobs
// open; a record that wins (his career win share, and a playoff round counts as much as five wins)
// reaches clubs further up and brings a third offer.
export function offers(G, r) {
  const C_ = G.career, w = C_.reduce((a, x) => a + x.w + 5 * x.won, 0) / C_.reduce((a, x) => a + x.w + x.l, 0);
  const rec = G.history.at(-1).record, pool = Object.keys(G.teams).filter((ab) => ab !== G.user).sort((a, b) => rec[a][0] - rec[b][0]).slice(0, Math.round(6 + 20 * w));
  const out = [];
  for (let k = w >= 0.5 ? 3 : 2; k > 0 && pool.length; k--) out.push(...pool.splice(Math.floor(r() * pool.length), 1));
  return out;
}
// Taking a job: the club is his, with a new owner of the kind he asked for; his career goes with him
export function move(G, ab, r) {
  G.user = ab; hire(G, G.owner.pick, r);
  delete G.fired; G.offers = []; G.choices = {}; G.myOffers = [];
}
