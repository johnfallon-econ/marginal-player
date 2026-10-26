// Computer GMs trade. Each club knows what it is -- contending, rebuilding or in between, by its
// projected wins -- and values players and picks accordingly; a trade happens when both clubs come
// out ahead by their own lights and the rules engine passes it.
import * as C from './cba.js';
import * as M from './value.js';
import { teamValue, projWins, capAt, cutdown, fillRosters, winWorth } from './league.js';
import * as P from './picks.js';
import * as D from './draft.js';
import * as S from './season.js';
import * as GM from './gm.js';
import * as PL from './plan.js';

export const RESIGN_H = 20;   // seasons out a man's worth runs, his deal and the re-signings after it (the board's horizon)
export const ENDOW = 0, MAX_PICKS = 4, MIN_GAIN = 0.01, GAIN_SHARE = 0.06, PER_CLUB = 3, THREE = 60, ROOMY = 2;   // tuned so trades a year and players moving match the real league (_gm_targets.json)
export const mode = (w) => (w >= 47 ? 'contend' : w <= 35 ? 'rebuild' : 'middle');

// A player's worth to club `ab`, $: each season left on his deal, his value to this GM less his
// salary (his value to it counting what his wins do for its chance of a title), discounted. In the season, only what is left of it: a
// man traded at the deadline plays a third of it for his new club, who pays a third of his salary.
// A season the club need not keep is worth only what keeping it would be (season): on a team option
// it is picked up only if he is worth it, a year not guaranteed can be cut for what is guaranteed, and
// on a player option he leaves if he is worth more than it pays -- each over how unsure his worth is
// that far out (M.uncertainty, his market value's change over that many rating points), so a young
// man who has not come on costs his club little past what it must pay him. Past his deal, the club's
// right to re-sign him counts too (below).
// one season of a deal to club ab: his value less his salary, or what the club or he may make of it
const phi = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function season(G, ab, p, i, y) {
  const mu = teamValue(G, ab, p, i) - y.sal, gtd = y.gtd ?? y.sal;
  if (i === 0 || (!y.opt && gtd >= y.sal)) return mu;
  const u = M.uncertainty(p, i, G.K), cap = capAt(G, G.season + 1 + i);
  const sd = (M.marketValue({ ...p, rate: p.rate + u }, i, cap, G.K) - M.marketValue({ ...p, rate: p.rate - u }, i, cap, G.K)) / 2;
  const up = (x) => (sd > 0 ? x * S.Phi(x / sd) + sd * phi(x / sd) : Math.max(x, 0));   // E[max(X, 0)], X ~ N(x, sd)
  if (y.opt === 'pl') return mu - up(mu);                                                  // E[min(X, 0)]
  if (y.opt === 'tm') return up(mu);
  return up(mu + gtd) - gtd;                                                               // cut for what is guaranteed
}
export function playerWorth(G, ab, p, m) {
  const key = `${ab}|${p.id}|${m}`, c = G._worth;
  if (c && key in c) return c[key];
  const s = taxSeason(G), left = G.cur ? 1 - G.cur.d / G.cur.days.length : 1;
  // a man whose draft rights it holds, unsigned: the deal his slot brings, which his club need not offer
  const deal = p.contract || D.rookieContract(p.draft.pick, s - 1, capAt(G, s));
  const yrs = deal.years.filter((y) => y.s >= s);
  let v = yrs.reduce((a, y, i) => a + (i === 0 ? left : 1) * season(G, ab, p, i, y) / M.DISC ** i, 0);
  // past his deal, his Bird rights: re-signed in four-season deals at the board's odds, compounding,
  // each season his value less his expected pay (the Trade Lab's resignChain), to RESIGN_H seasons out
  let surv = 1;
  for (let e = yrs.length; e < RESIGN_H && p.age + e < 40; e += 4) {
    const w = M.war(p, e - 1, G.K), first = e === yrs.length && !!deal.rookie, age = p.age + e;
    surv *= M.keepP(G.K, first, w, age);
    const { mx, pmax, nm } = M.redeal(G.K, first, w, p.yos + e, age), share = pmax * mx + (1 - pmax) * nm;
    for (let k = e; k < Math.min(e + 4, RESIGN_H); k++) v += surv * (teamValue(G, ab, p, k) - share * capAt(G, G.season + 1 + k)) / M.DISC ** k;
  }
  const w = p.contract ? v : Math.max(v, 0);
  if (c) c[key] = w;
  return w;
}

// A pick's worth, $: the board's surplus for the slots it brings over simulated drafts (picks.js
// worth: the lottery, every protection and swap), at that draft's cap, weighted by what the club
// is after and discounted. prot: a protection the sender adds.
// (what the men a pick brings win counts toward a title as a season far off does for any club: winWorth)
const scale = (G, y, m, v) => (1 + winWorth(G) / (G.K.price.b * capAt(G, y - 1))) * v * capAt(G, y - 1) / (G.K.slotCap * 1e6) * 1e6 / M.DISC ** (y - (G.season + 1));
export const pickWorth = (G, ab, pick, m, prot) => scale(G, pick.year, m, P.worth(G, pick, prot, ab));
// a new swap right (picks.js after), $, to the club given it
export const swapWorth = (G, s, m) => scale(G, s.y, m, P.swapWorth(G, s));
// the same, to club ab as market x stands, kept on x: the market is drawn afresh after each deal
const once = (x, key, f) => ((x.memo ||= new Map()).has(key) ? x.memo.get(key) : x.memo.set(key, f()).get(key));
const pickW = (G, x, ab, k, prot) => once(x, `${ab}|${k.id}|${prot ?? ''}`, () => pickWorth(G, ab, k, x.modes[ab], prot));
const swapW = (G, x, ab, w) => once(x, `${ab}|${w.y}|${w.from}|${w.to}`, () => swapWorth(G, w, x.modes[ab]));
// Every pick and claim in play, in the shape the rules engine reads.
export const picksView = (G) => P.assets(G);

// One trade window. Every pairing of clubs is in play: a player goes where he is worth more than
// where he is (a veteran to a contender, a prospect to a rebuilder, a GM's favorite anywhere), a
// taxpayer pays a club with room to take money off its books. The buyer sends back what it values
// least to make salaries legal, then picks change hands -- either way -- until both clubs are
// ahead by their own lights, the tax counted as far as each owner minds it. The best such deal goes
// through; repeat up to maxTrades. The offers each round needs are drawn up by the driver: here, one
// after another (tradeWindow); in the browser, spread over workers that hold the league (tradeWindowWith, worker.js).
export function tradeWindow(G, r, date, maxTrades = 6, userAb = G.user) {
  const it = windowSteps(G, date, maxTrades, userAb);
  let s = it.next();
  while (!s.done) s = it.next(s.value.need?.map(([S, p, B, V]) => buildOffer(G, s.value.x, B, S, p, date, false, V)));
  return s.value;
}
// pool: { start(G), offers(date, need, x), done(trade, res, wins) } -- a round's offers, and each deal
// as it goes through (with the wins it moved), so workers holding the league can keep it as it is here
export async function tradeWindowWith(pool, G, r, date, maxTrades = 6, userAb = G.user) {
  const it = windowSteps(G, date, maxTrades, userAb);
  let s = it.next(), k = 0;
  while (!s.done) {
    const v = s.value;
    if (v.done) { await pool.done(...v.done); s = it.next(); continue; }
    if (!k++) await pool.start(G);
    s = it.next(await pool.offers(date, v.need, v.x));
  }
  return s.value;
}
function* windowSteps(G, date, maxTrades, userAb) {
  const done = [], seen = new Map(), moved = {};
  G._worth = {};                                                // a player's worth to a club holds all window
  G._wins = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, projWins(G, ab)]));
  for (let k = 0; k < maxTrades; k++) {
    const x = market(G), { s, F, modes, tax } = x, P = G.players, clubs = Object.keys(G.teams).filter((ab) => ab !== userAb);
    // the shortlist: (seller, player, buyer) by how much more the buyer makes of him, tax included
    const cands = clubs.flatMap((S) => { const L = G.teams[S].roster.map((id) => P[id])
      .filter((p) => !p.contract?.twoWay && !p.contract?.tenDay && C.yearOf(p.contract, s))
      .concat((G.teams[S].rights ?? []).map((id) => P[id]))       // and the unsigned men whose draft rights it holds
      .flatMap((p) => { const sal = salPath(p, s, F.cap), own = playerWorth(G, S, p, modes[S]) + tax(S, sal.map((v) => -v));
        return clubs.filter((B) => B !== S).map((B) => [S, p, B, playerWorth(G, B, p, modes[B]) - tax(B, sal) - own, own]); })
      .sort((a, b) => b[3] - a[3]);
      const worst = L.reduce((a, c) => (c[4] < a[4] ? c : a), L[0]);  // its worst contract, to the club minding it least
      return [...L.slice(0, G.lite ? 1 : PER_CLUB), worst].filter(Boolean); });   // each club's few likeliest deals (one, in a season simmed lightly)
    // a deal may go through a third club with room to take salary in, in the seller's place: the ROOMY
    // clubs with the most room (cap space or an exception), tried for the THREE likeliest deals (tuned
    // so three-club deals are about the real share of trades, _gm_trade_shape.json)
    const room = Object.fromEntries(clubs.map((ab) => [ab, Math.max(F.cap - C.teamSalary(G.teams[ab], { ...G, f: { ...G.f, [s]: F } }, s),
      ...G.teams[ab].tpes.filter((e) => !e.dpe && e.expires >= date).map((e) => e.amt), 0)]));
    const want = new Map();
    let tried = 0;
    for (const [S, p, B] of cands) {
      want.set(`${S}|${p.id}|${B}|${S}`, [S, p, B, S]);
      if (tried++ >= (G.lite ? THREE / 3 : THREE)) continue;
      for (const V of clubs.filter((ab) => ab !== S && ab !== B && room[ab] > 0).sort((a, b) => room[b] - room[a]).slice(0, ROOMY)) want.set(`${S}|${p.id}|${B}|${V}`, [S, p, B, V]);
    }
    // a deal tried earlier in the window, among clubs no deal has touched since, is not tried again:
    // its standing is kept, and it is drawn up afresh only if it comes out on top
    const entry = (key, [S, p, B, V], o) => {
      // the windows hold only so many deals: those between GMs who trade more come first (gm.js)
      const act = o && [S, B, V].filter((ab, i, a) => a.indexOf(ab) === i).reduce((a, ab) => a * GM.activity(G.teams[ab].gm, G.K), o.score);
      const e = { o: o && o.score > 1 ? o : null, act, key, w: [S, p, B, V], k };
      seen.set(key, e);
      return e;
    };
    const need = [...want].filter(([key, [S, , B, V]]) => { const c = seen.get(key); return !c || [S, B, V].some((ab) => (moved[ab] ?? -1) >= c.k); });
    const got = yield { x, need: need.map(([, w]) => w) };
    need.forEach(([key, w], i) => entry(key, w, got[i]));
    let best = null;
    for (const q = [...want.keys()].map((key) => seen.get(key)).filter((e) => e.o); q.length;) {
      const i = q.reduce((j, e, n) => (e.act > q[j].act ? n : j), 0), e = q[i], [S, p, B, V] = e.w;
      if (e.k === k) { best = { ...e.o, S, B, V }; break; }
      const f = entry(e.key, e.w, buildOffer(G, x, B, S, p, date, false, V));
      if (f.o) q[i] = f; else q.splice(i, 1);
    }
    if (!best) break;
    execute(G, best.trade, best.res);
    const wins = {};
    for (const ab of new Set([best.S, best.B, best.V, ...best.trade.picks.flatMap((q) => [q.from, q.to])])) { wins[ab] = G._wins[ab] = projWins(G, ab); moved[ab] = k; }
    done.push(logEntry(best.trade));
    yield { done: [best.trade, best.res, wins] };
  }
  delete G._worth; delete G._wins;
  G.log.push(...done);
  return done;
}
const logEntry = (tr) => ({ type: 'trade', date: tr.date, swaps: tr.swaps?.length ? tr.swaps : undefined, prot: tr.picks.some((p) => p.prot) ? tr.picks.filter((p) => p.prot).map((p) => [p.id, p.prot]) : undefined, teams: [...new Set(tr.moves.flatMap((m) => [m.from, m.to]).concat(tr.picks.flatMap((p) => [p.from, p.to])))],
  players: tr.moves.map((m) => m.pid), moves: tr.moves, picks: tr.picks.map((p) => p.id), pickTo: tr.picks.map((p) => p.to), pickFrom: tr.picks.map((p) => p.from) });
// the season whose salaries a deal moves: after the season ends, next season's
const taxSeason = (G) => G.season + (G.phase === 'offseason' || G.phase === 'draft' ? 1 : 0);

// Where every club stands for a trade: its mode, the picks in play, what more salary costs it in tax
// over the seasons ahead, as far as its owner minds (plan.js: the repeater's clock and the second
// apron counted; a summer's cap not yet drawn is projected), and next summer's market, by which it
// values its cap room then (plan.js).
export function market(G) {
  const s = taxSeason(G), F = G.f[s] || G.f[G.season], pv = picksView(G);
  const wins = G._wins || Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, projWins(G, ab)]));
  const modes = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, mode(wins[ab])]));
  // the tax, forward (plan.js): a season over the second apron freezes a first -- its latest own, to it
  const figs = Array.from({ length: PL.TAX_H }, (_, k) => (k ? G.f[s + k] || C.figures(s + k, capAt(G, s + k)) : F));
  const apron = Object.fromEntries(Object.keys(G.teams).map((ab) => { const k = Object.values(pv).filter((q) => q.kind === 'pick' && q.round === 1 && q.origin === ab && q.holder === ab).sort((a, b) => b.year - a.year)[0];
    return [ab, k ? pickWorth(G, ab, k, modes[ab]) : 0]; }));
  const tp = PL.taxPlan(G, s, figs, C.taxShare(G, s), apron);
  const tax = (ab, dv) => (1 - G.teams[ab].gm.taxTol) * PL.taxChange(tp, G.teams[ab], ab, typeof dv === 'number' ? [dv] : dv);
  const Y = G.season + 1, FY = G.f[Y] || C.figures(Y, capAt(G, Y));
  // the rules' view of the league as it stands, for every deal tried until one goes through
  return { s, F, modes, tax, pv, plan: PL.market(G, Y, FY, (y) => capAt(G, y)), league: { ...G, picks: pv, ledger: G.picks, view: true } };
}
// a man's salary over the tax path from season s: this season's charge, then his deal's
const salPath = (p, s, cap) => Array.from({ length: PL.TAX_H }, (_, k) => (k ? C.yearOf(p.contract, s + k)?.sal ?? 0 : C.charge(p, s, cap)));
// What a trade is worth to club ab, $, by its own lights: what comes in, less what goes out (which
// looms larger, a star most), less the tax it brings, plus what its GM makes of sending more men than
// he takes back (a consolidator) or fewer (gm.js), less the men it must waive to make room, plus what
// it does to the club's room next summer (plan.js).
// How far ahead a deal must leave club ab: GAIN_SHARE of what it moves (its worth of all that comes
// in and goes out), never under MIN_GAIN of the cap -- so a small deal (a fringe man, a second)
// needs a small edge, a big one a big edge.
export function need(G, x, ab, tr, extra = 0) {   // extra: worth moved that tr does not carry (draft-night slots)
  let z = extra;
  for (const m of tr.moves) if (m.to === ab || m.from === ab) z += Math.abs(playerWorth(G, ab, G.players[m.pid], x.modes[ab]));
  for (const p of tr.picks) if (p.to === ab || p.from === ab) z += Math.abs(pickW(G, x, ab, x.pv[p.id], p.prot));
  for (const sw of tr.swaps || []) if (sw.to === ab || sw.from === ab) z += Math.abs(swapW(G, x, ab, sw));
  return Math.max(MIN_GAIN * x.F.cap, GAIN_SHARE * z);
}
export function gain(G, x, ab, tr) {
  const P = G.players, give = (v) => (v > 0 ? v * (1 + ENDOW * v / x.F.cap) : v);
  let v = 0, n = 0, dy = 0;
  const d = Array(PL.TAX_H).fill(0);
  for (const m of tr.moves) {
    const w = playerWorth(G, ab, P[m.pid], x.modes[ab]), sal = salPath(P[m.pid], x.s, x.F.cap), sy = C.yearOf(P[m.pid].contract, x.plan.Y)?.sal ?? 0;
    if (m.to === ab) { v += w; sal.forEach((q, k) => (d[k] += q)); dy += sy; n--; } else if (m.from === ab) { v -= give(w); sal.forEach((q, k) => (d[k] -= q)); dy -= sy; n++; }
  }
  if (dy) v += PL.change(x.plan, ab, dy);
  v += GM.shed(G.teams[ab].gm) * n * x.F.cap;
  // a roster spot: past 15 standard contracts the club waives the men it would least keep (worth to
  // it plus the guaranteed money it owes him either way), so a man more costs it the last it keeps
  const T = G.teams[ab], std = (ids) => ids.filter((id) => P[id].contract && !P[id].contract.twoWay);
  const keep = (id) => once(x, `k|${ab}|${id}`, () => playerWorth(G, ab, P[id], x.modes[ab]) + C.waive(P[id], tr.date).reduce((a, d) => a + d.amt / M.DISC ** (d.s - x.s), 0));
  const cut = (ids) => ids.map(keep).sort((a, b) => a - b).slice(0, Math.max(0, ids.length - 15)).reduce((a, w) => a + w, 0);
  const now = std(T.roster), after = std(now.filter((id) => !tr.moves.some((m) => m.pid === id && m.from === ab)).concat(tr.moves.filter((m) => m.to === ab).map((m) => m.pid)));
  if (now.length > 15 || after.length > 15) v += once(x, `c|${ab}`, () => cut(now)) - once(x, `c|${ab}|${after}`, () => cut(after));
  for (const p of tr.picks) {
    const w = pickW(G, x, ab, x.pv[p.id], p.prot);
    if (p.to === ab) v += w; else if (p.from === ab) v -= give(w);
  }
  for (const sw of tr.swaps || []) {
    const w = swapW(G, x, ab, sw);
    if (sw.to === ab) v += w; else if (sw.from === ab) v -= give(w);
  }
  return v - x.tax(ab, d);
}
// The rules, with trade exceptions: a club whose incoming salary fails to match absorbs its
// costliest incoming man it can into its smallest live exception that holds him (one per exception;
// a disabled player exception takes no trades). Sets tr.tpe; returns the rules' verdict.
export function fit(league, tr) {
  let res = C.validateTrade(league, tr);
  for (const ab of new Set(tr.moves.map((m) => m.to))) {
    if (res.ok || !res.errors.some((e) => e.startsWith(`${ab} takes back`))) continue;
    const T = league.teams[ab], s = C.seasonOf(tr.date), cap = league.f[s].cap;
    for (const [pid, sal] of tr.moves.filter((m) => m.to === ab).map((m) => [m.pid, C.charge(league.players[m.pid], s, cap)]).sort((a, b) => b[1] - a[1])) {
      const i = T.tpes.map((e, j) => [e, j]).filter(([e]) => !e.dpe && e.expires >= tr.date && e.amt >= sal).sort((a, b) => a[0].amt - b[0].amt)[0]?.[1];
      if (i === undefined) continue;
      const t2 = { ...tr, tpe: { ...(tr.tpe || {}), [ab]: [...(tr.tpe?.[ab] || []), { pid, tpeIndex: i }] } }, r2 = C.validateTrade(league, t2);
      if (!r2.errors.some((e) => e.startsWith(`${ab} takes back`))) { tr.tpe = t2.tpe; res = r2; break; }
    }
  }
  return res;
}
// Club payer pays payee in picks, up to MAX_PICKS in the deal: the cheapest one that closes the gap,
// else its best and go on, until payee is ahead by what it needs (need), payer staying ahead of nothing lost.
// What it can pay in: its picks and claims; a first of its own it may protect (top 4, 10 or 14); the
// right to swap firsts with the payee in a year both hold their own; the draft rights of a man it
// holds unsigned; or taking on a contract the payee would rather be rid of (worth less than nothing to it).
// A pick is chosen at what it brings a club with no other stake in its round (a pick tied up in a swap
// is worth a little more or less to a club in the swap); the deal is then judged at its worth to each. g: each club's gain from the deal as it stands.
export function payIn(G, x, trade, g, league, payer, payee, nd = () => need(G, x, payee, trade)) {   // nd: what payee needs
  const P = G.players;
  const own = (ab, k) => k.kind === 'pick' && k.round === 1 && k.origin === ab && k.holder === ab && !k.prot && !k.terms.length;
  const used = new Set([...trade.picks.map((q) => q.id), ...trade.swaps.map((w) => `${w.from}|${w.y}|1`), ...trade.moves.map((m) => m.pid)]);
  const pool = Object.values(x.pv).filter((k) => k.holder === payer && !k.frozen && k.year > G.season && !used.has(k.id)).flatMap((k) => [
    { id: k.id, pk: { id: k.id, from: payer, to: payee }, v: pickW(G, x, '~', k) },
    ...(own(payer, k) ? [[1, 4], [1, 10], [1, 14]].map((p) => ({ id: k.id, pk: { id: k.id, from: payer, to: payee, prot: p }, v: pickW(G, x, '~', k, p) })) : []),
    ...(own(payer, k) && own(payee, x.pv[`${payee}|${k.year}|1`] || {}) ? [{ id: k.id, sw: { y: k.year, r: 1, from: payer, to: payee }, v: swapW(G, x, payee, { y: k.year, r: 1, from: payer, to: payee }) }] : []),
  ]).concat((G.teams[payer].rights ?? []).filter((id) => !used.has(id)).map((id) => ({ id, mv: { pid: id, from: payer, to: payee }, v: playerWorth(G, payee, P[id], x.modes[payee]) })))
    .concat(G.teams[payee].roster.filter((id) => !used.has(id) && !P[id].contract?.twoWay && !P[id].contract?.tenDay)   // or take a contract off its hands
      .map((id) => ({ id, mv: { pid: id, from: payee, to: payer }, v: -playerWorth(G, payee, P[id], x.modes[payee]) })))
    .filter((c) => c.v > 0).sort((a, b) => a.v - b.v);
  while (g(payee) <= nd() && trade.picks.length + trade.swaps.length < MAX_PICKS && pool.length) {
    const i = pool.findIndex((c) => c.v > nd() - g(payee)), c = pool.splice(i < 0 ? pool.length - 1 : i, 1)[0], into = c.pk ? trade.picks : c.sw ? trade.swaps : trade.moves;
    into.push(c.pk || c.sw || c.mv);
    if (g(payer) <= 0 || !C.validateTrade(league, trade).ok) into.pop();
    else for (let j = pool.length - 1; j >= 0; j--) if (pool[j].id === c.id) pool.splice(j, 1);   // one use of each pick
  }
}
// What buyer B sends for p: nothing if the rules allow (cap room or a trade exception), else its contracts worth least to it until
// salaries match; then the side coming out behind is paid in picks while the other stays ahead.
// via: a third club, with cap room or an exception to take salary in, that takes the men B sends in
// S's place, paid by B in picks (as is S, if S is behind) -- the three-club deal of a seller who
// wants no salary back.
export function buildOffer(G, x, B, S, p, date, asked = false, via = S) {
  const P = G.players, mine = G.teams[B].roster
    .filter((id) => id !== p.id && !P[id].contract?.twoWay && !P[id].contract?.tenDay && C.charge(P[id], x.s, x.F.cap) > 0)
    .sort((a, b) => playerWorth(G, B, P[a], x.modes[B]) - playerWorth(G, B, P[b], x.modes[B]));
  const trade = { date, moves: [{ pid: p.id, from: S, to: B }], picks: [], cash: [] }, league = x.league;
  // as few men as match the salaries: one, else two, each time the ones it values least; else
  // its least valued, one after another until the rules allow
  const send = (ids) => { trade.moves = [trade.moves[0], ...ids.map((id) => ({ pid: id, from: B, to: via }))]; delete trade.tpe; return fit(league, trade); };
  const pairs = mine.slice(0, 12).flatMap((a, i, m) => m.slice(i + 1).map((b) => [a, b]))
    .sort(([a, b], [c, d]) => playerWorth(G, B, P[a], x.modes[B]) + playerWorth(G, B, P[b], x.modes[B]) - playerWorth(G, B, P[c], x.modes[B]) - playerWorth(G, B, P[d], x.modes[B]));
  let res = [...(via === S ? [[]] : []), ...mine.map((id) => [id]), ...pairs].reduce((r, ids) => (r?.ok ? r : send(ids)), null);
  for (let k = 3; !res.ok && k <= mine.length; k++) res = send(mine.slice(0, k));
  if (!res.ok) return null;
  const g = (ab) => gain(G, x, ab, trade), nd = (ab) => need(G, x, ab, trade);
  trade.swaps = [];
  // the side behind pays in picks (payIn), paid up to what a deal must leave it ahead by, not merely to even
  const pay = (payer, payee) => payIn(G, x, trade, g, league, payer, payee);
  if (via !== S) { for (const ab of [via, S]) if (g(ab) <= nd(ab)) pay(B, ab); }
  else if (g(S) < 0) pay(B, S); else if (g(B) < 0) pay(S, B);
  // the surplus split: the side further ahead hands the other seconds of its own, the least it values
  // first, one at most, while it stays past the threshold and at least as far ahead
  for (let k = 0; k < (via === S ? 1 : 0); k++) {
    const [rich, poor] = g(S) >= g(B) ? [S, B] : [B, S], used = new Set(trade.picks.map((q) => q.id));
    const sec = Object.values(x.pv).filter((q) => q.holder === rich && q.kind === 'pick' && q.round === 2 && !q.frozen && q.year > G.season && !used.has(q.id))
      .sort((a, b) => pickW(G, x, rich, a) - pickW(G, x, rich, b))[0];
    if (!sec) break;
    trade.picks.push({ id: sec.id, from: rich, to: poor });
    if (g(rich) <= nd(rich) || g(rich) < g(poor) || !C.validateTrade(league, trade).ok) { trade.picks.pop(); break; }
  }
  res = fit(league, trade);
  // asked (the seller shopping him): the buyer's best offer, whether the seller likes it is the seller's call
  // score: how far past its need the club least ahead is (over 1 clears)
  return res.ok && g(B) > 0 && (asked || g(S) > 0) && (via === S || g(via) > 0) ? { trade, res, score: Math.min(...[B, S, via].map((ab) => g(ab) / nd(ab))) } : null;
}

// The user's offer, put to the other clubs: legal, and does every computer GM in it come out ahead
// by as much as it would ask of a deal among themselves? tr: { moves, picks, cash }, dated today.
export function judge(G, tr, human = G.user) {
  tr = { date: G.date, cash: [], picks: [], swaps: [], ...tr };
  const x = market(G), res = fit({ ...G, picks: x.pv, ledger: G.picks }, tr);
  const clubs = [...new Set(tr.moves.flatMap((m) => [m.from, m.to]).concat([...tr.picks, ...tr.swaps].flatMap((p) => [p.from, p.to])))];
  const gains = Object.fromEntries(clubs.map((ab) => [ab, gain(G, x, ab, tr)]));
  const ok = res.ok && !res.errors.length;
  const needs = Object.fromEntries(clubs.map((ab) => [ab, need(G, x, ab, tr)]));
  return { ok, errors: res.errors, gains, need: needs, accept: ok && clubs.every((ab) => ab === human || gains[ab] > needs[ab]), res, trade: tr };
}
// Offers to the user: for each of the user's players, the clubs that make most more of him build
// an offer as they would for each other (the user's club weighed by its own GM's leanings, so an
// offer is one a fair-minded club might take); the best few, one per club.
// block: the men the user is shopping (the trading block): every club bids for them, one offer a club
export function offersFor(G, human = G.user, n = 3, block = null) {
  const x = market(G), P = G.players, clubs = Object.keys(G.teams).filter((ab) => ab !== human);
  const cands = (block ? block.map((id) => P[id]) : G.teams[human].roster.map((id) => P[id]).filter((p) => !p.contract?.twoWay && C.yearOf(p.contract, x.s)))
    .flatMap((p) => clubs.map((B) => [p, B, playerWorth(G, B, p, x.modes[B]) - playerWorth(G, human, p, x.modes[human])]))
    .sort((a, b) => b[2] - a[2]).slice(0, block ? Infinity : 40);
  const got = new Set(), out = [];                               // one offer per club, and unasked per player
  for (const [p, B] of cands) {
    if (got.has(B) || (!block && got.has(p.id))) continue;
    const o = buildOffer(G, x, B, human, p, G.date, !!block);
    if (o) { out.push(o); got.add(B); got.add(p.id); }
    if (!block && out.length === n) break;
  }
  // shopped: every club's offer, the best for the seller first (by its own lights)
  if (block) out.sort((a, b) => gain(G, x, human, b.trade) - gain(G, x, human, a.trade));
  return out.slice(0, n).map((o) => o.trade);
}
// An accepted offer goes through.
export function complete(G, j) { execute(G, j.trade, j.res); G.log.push(logEntry(j.trade)); }

// Put a passed trade into effect: rosters, picks, hard caps, new trade exceptions, cash.
export function execute(G, trade, res) {
  // each side's process value, on the books for its GM's season (gm.js), as the deal stood
  const capOf = (y) => capAt(G, y), pv = P.assets(G);
  GM.tradeProc(G, trade, capAt(G, taxSeason(G)), (p) => M.surplus(p, capOf, G.K), (id) => pv[id] ? scale(G, pv[id].year, 'middle', P.worth(G, pv[id], undefined, pv[id].holder)) : 0);
  for (const m of trade.moves) {
    const p = G.players[m.pid];
    const k = p.contract ? 'roster' : 'rights';                // draft rights change hands unsigned
    G.teams[m.from][k] = G.teams[m.from][k].filter((id) => id !== m.pid);
    (G.teams[m.to][k] ||= []).push(m.pid);
    if (p.contract) p.tm = m.to;
    if (p.bird) p.bird.team = m.to;                            // Bird rights travel with a trade
    if (p.contract) p.contract.acquired = trade.date;
  }
  Object.assign(G, P.after(G, trade));
  // an exception a man was absorbed into shrinks by his salary
  for (const [ab, xs] of Object.entries(trade.tpe || {})) for (const t of xs) { const s = C.seasonOf(trade.date); G.teams[ab].tpes[t.tpeIndex].amt -= C.charge(G.players[t.pid], s, G.f[s].cap); }
  for (const ab of Object.keys(trade.tpe || {})) G.teams[ab].tpes = G.teams[ab].tpes.filter((e) => e.amt > 0);
  for (const pk of trade.picks || []) {
    if (pk.id.startsWith('op|')) continue;
    // a pick in the draft under way changes hands in the draft order too
    const [o, y, rd] = pk.id.split('|');
    for (const e of G.draft?.year === +y ? G.draft.order.slice(G.draft.picks.length) : [])
      if (e.origin === o && (e.slot <= 30) === (rd === '1')) e.holder = pk.to;
  }
  for (const [ab, lvl] of Object.entries(res.hardCaps || {})) if (G.teams[ab].hardCap !== 'apron1') G.teams[ab].hardCap = lvl;
  for (const [ab, tp] of Object.entries(res.newTpes || {})) G.teams[ab].tpes.push(...tp);
  // a club over the roster limit waives its least valuable men (the user's club chooses its own cuts)
  for (const ab of Object.keys(res.waive || {})) if (ab !== G.user || G.autoUser) cutdown(G, null, ab);
  // a club left short signs the best men left at the minimum (the user's club signs its own)
  if (G.phase === 'season') fillRosters(G, [...new Set(trade.moves.flatMap((m) => [m.from, m.to]))].filter((ab) => ab !== G.user || G.autoUser));
  for (const c of trade.cash || []) { G.teams[c.from].cashSent += c.amt; G.teams[c.to].cashRecv += c.amt; }
}
