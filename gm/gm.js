// The executives who run the computer clubs (12_gm_data.py: gms, K.gm). Each club opens with its
// real lead executive; three leanings are his own, fitted and shrunk toward his background
// (code/_gm_layer.py): how often he trades, whether he sends more men than he takes back, and what
// he pays a free agent per point of mPM. Everything else about how a club values men is the same
// for every GM, but for how far his read strays from the model's: an analytics hire's strays half
// as far (an assumption, not a fit). Each summer a GM may lose his job, by the fitted exit model
// (code/_gm_firing.py) on his season; the out-of-work come back by the fitted re-entry model, and a
// seat no one returns to goes to a first-timer, drawn by background as recent first hires were.
// The user's club keeps a computer GM of its own too, for what the club would do with no one at the
// controls; a fired user's old club hires a new one. Clubs change hands at the league's rate, unrelated
// to how they have played (code/_gm_owners.py); a new owner, in the season of the sale or the next,
// raises his GM's odds of losing the job by the exit model's estimate.
import * as M from './value.js';
import { Phi } from './season.js';
import { hashNoise } from './dev.js';

export const NOISE = 0.225, ACT = 6, CONS = 0.36;   // ACT, CONS tuned so a GM-season's trades, and players sent less got per trade, rise one for one with his leanings (slopes 0.88 se 0.12, 0.76-1.03; 63 simulated league-seasons)
const lgt = (z) => 1 / (1 + Math.exp(-z));

// a GM's working fields from his record: activity (a deal he is in ranks this many times higher when
// a window has room for only so many), the value of a man shed in a trade (x cap), the mPM pay slope (% of cap)
function person(x, K) {
  return { id: x.id, n: x.n, b: x.b, trades: x.trades, consolidate: x.consolidate, sign_rate: x.sign_rate,
    noise: NOISE * (x.b.includes('analytics') ? 0.5 : 1), taxTol: x.taxTol, ten: x.ten ?? 0, rec: [] };
}
export const activity = (g, K) => Math.exp(ACT * g.trades / K.gm.tradesMean);
export const shed = (g) => CONS * g.consolidate;
// what he adds to a free agent's worth for the season, $, for the man's mPM against the signings' mean
export const signPremium = (g, p, cap, K) => g.sign_rate / 100 * cap * (p.rate - K.gm.traits.sign_rate.rate_mean);

// The user is new in the job: the real executive he replaces is out of work from the start, his
// spell as the re-entry model reads it, and the club's own computer GM is a first-timer.
export function init(G, L, r) {
  for (const [ab, x] of Object.entries(L.gms.clubs)) { G.teams[ab].gm = person({ ...x, taxTol: r() }, G.K); G.teams[ab].sold = x.sold; }
  G.gmPool = L.gms.pool.map((x) => ({ ...x }));
  const x = L.gms.clubs[G.user];
  G.gmPool.push({ ...x, ...x.spell, out: 0, from: G.user });
  G.teams[G.user].gm = person({ ...firstTimer(G, r), taxTol: r() }, G.K);
  G.lastPct = Object.fromEntries(Object.entries(L.gms.clubs).map(([ab, x]) => [ab, x.prior]));
}

// A first-timer: a background as recent first hires had them, each leaning at that background's
// mean plus his own draw at the leaning's spread among executives
function firstTimer(G, r) {
  const F = G.K.gm.first, u = r(); let a = 0, b = F.at(-1)[0];
  for (const [l, w] of F) if ((a += w) >= u) { b = l; break; }
  const T = G.K.gm.traits, lean = (t) => b.reduce((s, k) => s + T[t].bg[k].b, 0) - T[t].centre + T[t].tau * r.normal();
  return { id: `x${G.season}-${Math.floor(r() * 1e9)}`, n: `${r.pick(G.names.first)} ${r.pick(G.names.last)}`, b,
    trades: lean('trades'), consolidate: lean('consolidate'), sign_rate: lean('sign_rate') };
}

// ---- the season's record --------------------------------------------------------------------
// A trade on each side's GM's books for the season: its process value, % of the cap (the model's
// surplus of what the club takes in less what it sends, picks at their board worth), and the
// trade and the players it sent out less those it took in
export function tradeProc(G, tr, cap, surplusOf, pickOf) {
  const d = {}, n = {};
  for (const m of tr.moves) { const v = surplusOf(G.players[m.pid]); d[m.to] = (d[m.to] || 0) + v; d[m.from] = (d[m.from] || 0) - v; n[m.from] = (n[m.from] || 0) + 1; n[m.to] = (n[m.to] || 0) - 1; }
  for (const p of tr.picks || []) { const v = pickOf(p.id); d[p.to] = (d[p.to] || 0) + v; d[p.from] = (d[p.from] || 0) - v; }
  for (const [ab, v] of Object.entries(d)) {
    const g = G.teams[ab].gm; g.proc = (g.proc || 0) + 100 * v / cap; g.nt = (g.nt || 0) + 1; g.net = (g.net || 0) + (n[ab] || 0);
  }
}
// a pick's value left on the table, % of the cap: the model's worth of the man taken less that of
// the best on the board (both on the same scale deal, so only market value counts)
export function draftLeft(G, ab, p, avail, cap) {
  const mv = (q) => [0, 1, 2, 3].reduce((a, h) => a + M.marketValue({ ...q, rate: q.rate, mpg: undefined }, h, cap, G.K), 0);
  const g = G.teams[ab].gm; g.left = (g.left || 0) + 100 * (mv(p) - Math.max(...avail.map(mv))) / cap;
}

// The season just played, for every club's GM: what the exit model reads (g.pre: the share of games
// his club was projected to win at the opener; pay: each club's payroll)
export function closeSeason(G, h, pay) {
  const v = Object.values(pay).sort((a, b) => a - b), med = (v[14] + v[15]) / 2;
  const won = {};
  for (const rd of h.rounds) for (const [k, v] of Object.entries(rd)) {
    const [w, l] = v.games.split('-').map(Number), [a, b] = k.split('-'), lo = v.winner === a ? b : a;
    won[v.winner] = (won[v.winner] || 0) + w; won[lo] = (won[lo] || 0) + l;
  }
  for (const [ab, T] of Object.entries(G.teams)) {
    const g = T.gm, [w, l] = h.record[ab], pct = w / (w + l);
    g.ten += 1;
    g.rec.push({ s: h.season, pct, vs_exp: pct - g.pre, d_pct: pct - G.lastPct[ab], new_owner: +[h.season, h.season - 1].includes(T.sold), playoffs: +(ab in won), po_w: won[ab] || 0,
      champ: +(h.champion === ab), pay_rel: pay[ab] / med, trade_proc: g.proc || 0, draft_left: g.left || 0, trades: g.nt || 0, sent_less_got: g.net || 0 });
    delete g.proc; delete g.left; delete g.pre; delete g.nt; delete g.net;
  }
  G.lastPct = Object.fromEntries(Object.entries(h.record).map(([ab, [w, l]]) => [ab, w / (w + l)]));
}
// P(he is out after the season just closed), the fitted exit model's point estimates
export function pExit(G, g) {
  const c = G.K.gm.hazard, x = g.rec.at(-1), t = Math.min(g.ten, 6);
  return lgt(c.Intercept + (t > 1 ? c[`C(ten)[T.${t === 6 ? '6+' : t}]`] : 0) + c.pct * x.pct + c.vs_exp * x.vs_exp + c.d_pct * x.d_pct
    + c.playoffs * x.playoffs + c.po_w * x.po_w + c.pay_rel * x.pay_rel + c.trade_proc * x.trade_proc + c.draft_left * x.draft_left + c.new_owner * x.new_owner
    + c.champ * x.champ + c.title_recent * +g.rec.slice(-5, -1).some((r) => r.champ));
}
// what the re-entry model reads off a spell
export function spellOf(g) {
  const R = g.rec, n = R.length || 1, m = (k) => R.reduce((a, x) => a + x[k], 0) / n, last = R.at(-1) || {};
  return { m_vs_exp: m('vs_exp'), m_pct: m('pct'), po_w: m('po_w'), titles: R.reduce((a, x) => a + x.champ, 0), length: R.length,
    m_trade: m('trade_proc'), m_draft: m('draft_left'), last_vs_exp: last.vs_exp ?? 0, losing_exit: +((last.pct ?? 0.5) < 0.5) };
}
// P(back in a lead job this summer), out years out, the fitted re-entry model's point estimates
export function pBack(G, x, out) {
  const c = G.K.gm.rehire, o = out >= 4 ? '4+' : String(out);
  return lgt(c.Intercept + (out > 1 ? c[`C(out)[T.${o}]`] : 0) + c.m_vs_exp * x.m_vs_exp + c.m_pct * x.m_pct + c.po_w * x.po_w + c.titles * x.titles
    + c.length * x.length + c.m_trade * x.m_trade + c.m_draft * x.m_draft + c.last_vs_exp * x.last_vs_exp + c.losing_exit * x.losing_exit);
}

// ---- the summer's moves ---------------------------------------------------------------------
// Who loses his job, and who takes his seat (endSeason). Each computer club's GM goes by the exit
// model (the user's club is the owner's call, owner.js); everyone out of work comes back with his
// chance this year, those who do take the open seats in a random order, and seats left go to
// first-timers. G.openSeats: the clubs that changed GMs this summer, where a fired user is wanted.
export function summer(G, r) {
  G.openSeats = [];
  for (const [ab, T] of Object.entries(G.teams)) {
    if (ab === G.user || r() >= pExit(G, T.gm)) continue;
    G.gmPool.push({ ...T.gm, ...spellOf(T.gm), out: 0, from: ab });
    G.log.push({ type: 'gm', date: G.date, team: ab, out: T.gm.n });
    G.openSeats.push(ab);
  }
  for (const x of G.gmPool) x.out += 1;
  const back = G.gmPool.filter((x) => r() < pBack(G, x, x.out)).sort(() => r() - 0.5);
  for (const ab of G.openSeats) hire(G, ab, r, back.shift());
  // clubs sold this summer, for the coming season (the user's: owner.js review)
  for (const [ab, T] of Object.entries(G.teams)) if (r() < G.K.gm.saleRate) { T.sold = G.season + 1; G.log.push({ type: 'owner', date: G.date, team: ab }); }
}
// a seat filled: by x, out of work, else a first-timer
export function hire(G, ab, r, x = firstTimer(G, r)) {
  G.gmPool = G.gmPool.filter((y) => y !== x);
  G.teams[ab].gm = person({ ...x, taxTol: r(), ten: 0 }, G.K);
  G.log.push({ type: 'gm', date: G.date, team: ab, in: x.n, back: x.out > 0 });
}
// The user, out of work: each club that changed GMs this summer calls with the chance that makes his
// odds of a job this year what the re-entry model gives a spell like his (his career as one spell)
// What a fired GM does while out of work, and which clubs it puts him in front of: television in
// front of the big markets, a front-office job in front of the rest, a podcast in front of all. The
// lifts are the game's, not measured: big markets are the ten clubs with the most revenue (K.fin).
export const PATHS = {
  tv: { label: 'Television analyst', say: 'a studio chair on national television', big: 25, rest: 0.8 },
  podcast: { label: 'Start a podcast', say: 'a podcast with a following among front offices', big: 15, rest: 15 },
  agm: { label: 'Assistant GM', say: 'an assistant GM\'s job, learning another front office', big: 0.8, rest: 25 },
  away: { label: 'Step away', say: 'time away from the game', big: 1, rest: 1 },
};
export const bigMarket = (G, ab) => Object.entries(G.K.fin.revenue).sort((a, b) => b[1] - a[1]).slice(0, 10).some(([x]) => x === ab);
// the model's chance he is back this summer (h), spread evenly over the open seats, each lifted by his path
export function offers(G, r, out = 1, path = 'away') {
  const R = (G.career || []).map((x) => ({ pct: x.w / (x.w + x.l), vs_exp: x.vs_exp, po_w: x.po_w, champ: +x.champ, trade_proc: x.proc, draft_left: x.left }));
  const h = pBack(G, spellOf({ rec: R }), out), seats = G.openSeats.filter((ab) => ab !== G.user), q = 1 - (1 - h) ** (1 / seats.length);
  const P = PATHS[path], lift = (ab) => Math.min(1 / q, bigMarket(G, ab) ? P.big : P.rest);   // a seat's chance is at most certain
  return { h: 1 - seats.reduce((a, ab) => a * (1 - q * lift(ab)), 1), clubs: seats.filter((ab) => r() < q * lift(ab)) };
}

// ---- the draft as a common-value auction ------------------------------------------------------
// A prospect's talent is one value every club would like to know. The board misses it by the
// scouts' error, G.scoutSd; the league's read (his rate) is what the board predicts of it, missing
// by G.draft.hold over the class. Each GM starts from his own prior: that read plus a lean of his
// own (sd LEAN, no news of the talent), held with the read's own spread; and he has his own
// read of the talent, private, missing it by READ x his noise (both fixed for the draft). His
// estimate is Bayesian: prior and read weighted by their precision, and what the draft has shown --
// a club that passed on a prospect preferred the man it took, which caps what its estimate of the
// one passed over could have been; every such pass is on the record for every prospect still there
// (G.draft.ll, over a grid of talents), so a man sliding past where the board had him is marked down
// by all. READ and LEAN are set so the game's draft orders talent no better than its board (as
// the real draft orders careers no better than the consensus board), strays from the board by the
// real reach, and has the real number of draft-night trades (data/_gm_draft_accuracy.json,
// _gm_trade_shape.json). With the projections as the truth, every club knows the talent, and leans as ever.
// set on 10 drafts from one league's snapshot over a grid (READ 18-1000, LEAN 0-0.5). With the board
// as uncertain as the real one, a club's own read adds next to nothing (READ 1000), and clubs differ by
// their leans: LEAN 0.17 gives reach 14 picks against the public worth order (real 14 against ESPN's)
// with draft order ranking early careers as the board does (gap about 0, real +0.005) -- they disagree,
// as real clubs do, without knowing more -- and the odds the draft room shows (league.there/takenNow)
// draw each rival's pick with that spread. (READ 250 with no lean also reached 14, but every club then
// saw the same thing, so the room's odds were all 0% or 100%.) Draft-night trades: about 1 a draft
// (real 6.6) at every setting
export let READ = 1000, LEAN = 0.17;
export const tune = (o) => ({ READ = READ, LEAN = LEAN } = o);   // for calibration runs
export const GRID = 41;
export const readSd = (g) => READ * g.noise;
const grid = (G, q, i) => q.rate + (G.draft.hold + LEAN) * (-4 + 8 * i / (GRID - 1));
const onPrior = (G, sd) => (1 / G.draft.hold ** 2) / (1 / G.draft.hold ** 2 + 1 / sd ** 2);   // the weight on the prior, against the read
// a pick on the record: club d took p; for every prospect q left, the chance d's estimate of q fell
// below its estimate of p -- tau, the rating at which q would be worth what p is on the board, give
// or take how d's estimate of p strays from the board (worth weighs age and growth as well as the
// rating: worthAt)
export function learn(G, d, p, left, worthAt) {
  if (!G.hidden) return;
  // the spread: d's own lean and read of q, and -- unseen -- of p, which strays from the board as any
  // of d's estimates does from outside (pickSd)
  const sd = readSd(G.teams[d].gm), l = onPrior(G, sd), s = Math.sqrt((l * LEAN) ** 2 + ((1 - l) * sd) ** 2 + pickSd(G, G.teams[d].gm) ** 2), ll = (G.draft.ll ||= {}), target = worthAt(p, p.rate);
  for (const q of left) {
    let lo = q.rate - 10, hi = q.rate + 10;                      // the rating, by bisection, over a span past any class's
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (worthAt(q, m) < target) lo = m; else hi = m; }
    const tau = (lo + hi) / 2, L = (ll[q.id] ||= Array(GRID).fill(0));
    for (let i = 0; i < GRID; i++) L[i] += Math.log(Phi((tau - l * q.rate - (1 - l) * grid(G, q, i)) / s));
  }
}
// club c's estimate of q's talent: its prior, its read, the draft so far
// (with the projections as the truth, every club knows the talent: exactly, or each with its lean, G.clubs)
export function estimate(G, c, q) {
  if (!G.hidden) return q.talent + (G.clubs === 'exact' ? 0 : LEAN * hashNoise(`${c}|${q.id}|lean`));
  const sd = readSd(G.teams[c].gm), m = q.rate + LEAN * hashNoise(`${c}|${q.id}|lean`), r = q.talent + sd * hashNoise(`${c}|${q.id}|read`), L = G.draft?.ll?.[q.id];
  let a = 0, b = 0;
  for (let i = 0; i < GRID; i++) {
    const t = grid(G, q, i), z = Math.exp(-0.5 * ((m - t) / G.draft.hold) ** 2 - 0.5 * ((r - t) / sd) ** 2 + (L ? L[i] : 0));
    a += z * t; b += z;
  }
  return a / b;
}
// how far, to another club, c's estimate of a man strays from the board: what c's choices look like
// from outside (D.aiPick's spread when a club plays the draft out in its head)
export const pickSd = (G, g) => { if (!G.hidden) return G.clubs === 'exact' ? 0 : LEAN; const sd = readSd(g), l = onPrior(G, sd); return Math.sqrt((l * LEAN) ** 2 + (1 - l) ** 2 * (G.draft.hold ** 2 + sd * sd)); };
