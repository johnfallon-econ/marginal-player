// Computer GMs trade. Each club knows what it is -- contending, rebuilding or in between, by its
// projected wins -- and values players and picks accordingly; a trade happens when both clubs come
// out ahead by their own lights and the rules engine passes it.
import * as C from './cba.js';
import * as M from './value.js';
import { teamValue, projWins, capAt, cutdown, fillRosters } from './league.js';
import * as P from './picks.js';
import * as D from './draft.js';

export const ENDOW = 1, MAX_PICKS = 4, MIN_GAIN = 0.05, PER_CLUB = 3;   // tuned so trades a year and players moving match the real league (_gm_targets.json)
export const mode = (w) => (w >= 47 ? 'contend' : w <= 35 ? 'rebuild' : 'middle');
// how a club weighs a season h ahead, and a pick, by what it is trying to do
export const WEIGHT = { contend: { now: 1.5, later: 0.8, pick: 0.7 }, middle: { now: 1, later: 1, pick: 1 }, rebuild: { now: 0.5, later: 1.1, pick: 1.4 } };

// A player's worth to club `ab`, $: each season left on his deal, his value to this GM less his
// salary, weighted by what the club is after, discounted.
export function playerWorth(G, ab, p, m) {
  const key = `${ab}|${p.id}|${m}`, c = G._worth;
  if (c && key in c) return c[key];
  const W = WEIGHT[m], s = taxSeason(G);
  // a man whose draft rights it holds, unsigned: the deal his slot brings, which his club need not offer
  const deal = p.contract || D.rookieContract(p.draft.pick, s - 1, capAt(G, s));
  const v = deal.years.filter((y) => y.s >= s).reduce((a, y, i) =>
    a + (i === 0 ? W.now : W.later) * (teamValue(G, ab, p, i) - y.sal) / 1.1 ** i, 0);
  const w = p.contract ? v : Math.max(v, 0);
  if (c) c[key] = w;
  return w;
}

// A pick's worth, $: the board's surplus for the slots it brings over simulated drafts (picks.js
// worth: the lottery, every protection and swap), at that draft's cap, weighted by what the club
// is after and discounted. prot: a protection the sender adds.
const scale = (G, y, m, v) => WEIGHT[m].pick * v * capAt(G, y - 1) / (G.K.slotCap * 1e6) * 1e6 / 1.1 ** (y - (G.season + 1));
export const pickWorth = (G, ab, pick, m, prot) => scale(G, pick.year, m, P.worth(G, pick, prot, ab));
// a new swap right (picks.js after), $, to the club given it
export const swapWorth = (G, s, m) => scale(G, s.y, m, P.swapWorth(G, s));
// Every pick and claim in play, in the shape the rules engine reads.
export const picksView = (G) => P.assets(G);

// One trade window. Every pairing of clubs is in play: a player goes where he is worth more than
// where he is (a veteran to a contender, a prospect to a rebuilder, a GM's favorite anywhere), a
// taxpayer pays a club with room to take money off its books. The buyer sends back what it values
// least to make salaries legal, then picks change hands -- either way -- until both clubs are
// ahead by their own lights, the tax counted as far as each owner minds it. The best such deal goes
// through; repeat up to maxTrades.
export function tradeWindow(G, r, date, maxTrades = 6, userAb = G.user) {
  const done = [];
  G._worth = {};                                                // a player's worth to a club holds all window
  G._wins = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, projWins(G, ab)]));
  for (let k = 0; k < maxTrades; k++) {
    const x = market(G), { s, F, modes, tax } = x, P = G.players, clubs = Object.keys(G.teams).filter((ab) => ab !== userAb);
    // the shortlist: (seller, player, buyer) by how much more the buyer makes of him, tax included
    const cands = clubs.flatMap((S) => { const L = G.teams[S].roster.map((id) => P[id])
      .filter((p) => !p.contract?.twoWay && !p.contract?.tenDay && C.yearOf(p.contract, s))
      .concat((G.teams[S].rights ?? []).map((id) => P[id]))       // and the unsigned men whose draft rights it holds
      .flatMap((p) => { const sal = C.charge(p, s, F.cap), own = playerWorth(G, S, p, modes[S]) + tax(S, -sal);
        return clubs.filter((B) => B !== S).map((B) => [S, p, B, playerWorth(G, B, p, modes[B]) - tax(B, sal) - own, own]); })
      .sort((a, b) => b[3] - a[3]);
      const worst = L.reduce((a, c) => (c[4] < a[4] ? c : a), L[0]);  // its worst contract, to the club minding it least
      return [...L.slice(0, PER_CLUB), worst].filter(Boolean); });                 // each club's few likeliest deals
    let best = null;
    for (const [S, p, B] of cands) {
      const o = buildOffer(G, x, B, S, p, date);
      if (o && o.score > F.cap * MIN_GAIN && (!best || o.score > best.score)) best = { ...o, S, B };
    }
    if (!best) break;
    execute(G, best.trade, best.res);
    for (const ab of [best.S, best.B]) G._wins[ab] = projWins(G, ab);
    done.push(logEntry(best.trade));
  }
  delete G._worth; delete G._wins;
  G.log.push(...done);
  return done;
}
const logEntry = (tr) => ({ type: 'trade', date: tr.date, swaps: tr.swaps?.length ? tr.swaps : undefined, prot: tr.picks.some((p) => p.prot) ? tr.picks.filter((p) => p.prot).map((p) => [p.id, p.prot]) : undefined, teams: [...new Set(tr.moves.flatMap((m) => [m.from, m.to]).concat(tr.picks.flatMap((p) => [p.from, p.to])))],
  players: tr.moves.map((m) => m.pid), moves: tr.moves, picks: tr.picks.map((p) => p.id), pickTo: tr.picks.map((p) => p.to) });
// the season whose salaries a deal moves: after the season ends, next season's
const taxSeason = (G) => G.season + (G.phase === 'offseason' || G.phase === 'draft' ? 1 : 0);

// Where every club stands for a trade: its mode, the picks in play, and what more salary costs it in
// tax, as far as its owner minds (next summer's cap is not drawn yet: this one stands in).
function market(G) {
  const s = taxSeason(G), F = G.f[s] || G.f[G.season], Lg = { ...G, f: { ...G.f, [s]: F } };
  const wins = G._wins || Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, projWins(G, ab)]));
  const modes = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, mode(wins[ab])]));
  const pay = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, C.teamSalary(G.teams[ab], Lg, s)]));
  const share = C.taxShare(G, s), tax = (ab, d) => (1 - G.teams[ab].gm.taxTol) * C.taxCost(G.teams[ab], pay[ab], d, F, s, share);
  return { s, F, modes, tax, pv: picksView(G) };
}
// What a trade is worth to club ab, $, by its own lights: what comes in, less what goes out (which
// looms larger, a star most), less the tax it brings.
function gain(G, x, ab, tr) {
  const P = G.players, give = (v) => (v > 0 ? v * (1 + ENDOW * v / x.F.cap) : v);
  let v = 0, d = 0;
  for (const m of tr.moves) {
    const w = playerWorth(G, ab, P[m.pid], x.modes[ab]), sal = C.charge(P[m.pid], x.s, x.F.cap);
    if (m.to === ab) { v += w; d += sal; } else if (m.from === ab) { v -= give(w); d -= sal; }
  }
  for (const p of tr.picks) {
    const w = pickWorth(G, ab, x.pv[p.id], x.modes[ab], p.prot);
    if (p.to === ab) v += w; else if (p.from === ab) v -= give(w);
  }
  for (const sw of tr.swaps || []) {
    const w = swapWorth(G, sw, x.modes[ab]);
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
// What buyer B sends for p: nothing if the rules allow (cap room or a trade exception), else its contracts worth least to it until
// salaries match; then the side coming out behind is paid in picks while the other stays ahead.
export function buildOffer(G, x, B, S, p, date) {
  const P = G.players, mine = G.teams[B].roster
    .filter((id) => id !== p.id && !P[id].contract?.twoWay && !P[id].contract?.tenDay && C.charge(P[id], x.s, x.F.cap) > 0)
    .sort((a, b) => playerWorth(G, B, P[a], x.modes[B]) - playerWorth(G, B, P[b], x.modes[B]));
  const trade = { date, moves: [{ pid: p.id, from: S, to: B }], picks: [], cash: [] }, league = { ...G, picks: x.pv, ledger: G.picks };
  // as few men as match the salaries: one, else two, each time the ones it values least; else
  // its least valued, one after another until the rules allow
  const send = (ids) => { trade.moves = [trade.moves[0], ...ids.map((id) => ({ pid: id, from: B, to: S }))]; delete trade.tpe; return fit(league, trade); };
  const pairs = mine.slice(0, 12).flatMap((a, i, m) => m.slice(i + 1).map((b) => [a, b]))
    .sort(([a, b], [c, d]) => playerWorth(G, B, P[a], x.modes[B]) + playerWorth(G, B, P[b], x.modes[B]) - playerWorth(G, B, P[c], x.modes[B]) - playerWorth(G, B, P[d], x.modes[B]));
  let res = [[], ...mine.map((id) => [id]), ...pairs].reduce((r, ids) => (r?.ok ? r : send(ids)), null);
  for (let k = 3; !res.ok && k <= mine.length; k++) res = send(mine.slice(0, k));
  if (!res.ok) return null;
  const g = (ab) => gain(G, x, ab, trade);
  // the side behind pays in picks, up to MAX_PICKS: the cheapest one that closes the gap, else its best and go on
  const [payer, payee] = g(S) < 0 ? [B, S] : g(B) < 0 ? [S, B] : [];
  if (payer) {
    // what it can pay in: its picks and claims; a first of its own it may protect (top 4 or top
    // 10); the right to swap firsts with the payee in a year both hold their own; or the draft
    // rights of a man it holds unsigned
    const own = (ab, k) => k.kind === 'pick' && k.round === 1 && k.origin === ab && k.holder === ab && !k.prot && !k.terms.length;
    const pool = Object.values(x.pv).filter((k) => k.holder === payer && !k.frozen && k.year > G.season).flatMap((k) => [
      { id: k.id, pk: { id: k.id, from: payer, to: payee }, v: pickWorth(G, payee, k, x.modes[payee]) },
      ...(own(payer, k) ? [[1, 4], [1, 10]].map((p) => ({ id: k.id, pk: { id: k.id, from: payer, to: payee, prot: p }, v: pickWorth(G, payee, k, x.modes[payee], p) })) : []),
      ...(own(payer, k) && own(payee, x.pv[`${payee}|${k.year}|1`] || {}) ? [{ id: k.id, sw: { y: k.year, r: 1, from: payer, to: payee }, v: swapWorth(G, { y: k.year, r: 1, from: payer, to: payee }, x.modes[payee]) }] : []),
    ]).concat((G.teams[payer].rights ?? []).map((id) => ({ id, mv: { pid: id, from: payer, to: payee }, v: playerWorth(G, payee, P[id], x.modes[payee]) })))
      .filter((c) => c.v > 0).sort((a, b) => a.v - b.v);
    // paid up to what a deal must leave each side ahead by (MIN_GAIN), not merely to even
    trade.swaps = []; const need = x.F.cap * MIN_GAIN;   // paid up to what a deal must leave it ahead by
    while (g(payee) <= need && trade.picks.length + trade.swaps.length < MAX_PICKS && pool.length) {
      const i = pool.findIndex((c) => c.v > need - g(payee)), c = pool.splice(i < 0 ? pool.length - 1 : i, 1)[0], into = c.pk ? trade.picks : c.sw ? trade.swaps : trade.moves;
      into.push(c.pk || c.sw || c.mv);
      if (g(payer) <= 0 || !C.validateTrade(league, trade).ok) into.pop();
      else for (let j = pool.length - 1; j >= 0; j--) if (pool[j].id === c.id) pool.splice(j, 1);   // one use of each pick
    }
  }
  // the surplus split: the side further ahead hands the other seconds of its own, the least it values
  // first, one at most, while it stays past the threshold and at least as far ahead
  const need = x.F.cap * MIN_GAIN;
  for (let k = 0; k < 1; k++) {
    const [rich, poor] = g(S) >= g(B) ? [S, B] : [B, S], used = new Set(trade.picks.map((q) => q.id));
    const sec = Object.values(x.pv).filter((q) => q.holder === rich && q.kind === 'pick' && q.round === 2 && !q.frozen && q.year > G.season && !used.has(q.id))
      .sort((a, b) => pickWorth(G, rich, a, x.modes[rich]) - pickWorth(G, rich, b, x.modes[rich]))[0];
    if (!sec) break;
    trade.picks.push({ id: sec.id, from: rich, to: poor });
    if (g(rich) <= need || g(rich) < g(poor) || !C.validateTrade(league, trade).ok) { trade.picks.pop(); break; }
  }
  res = fit(league, trade);
  return res.ok && g(B) > 0 && g(S) > 0 ? { trade, res, score: Math.min(g(B), g(S)) } : null;
}

// The user's offer, put to the other clubs: legal, and does every computer GM in it come out ahead
// by as much as it would ask of a deal among themselves? tr: { moves, picks, cash }, dated today.
export function judge(G, tr, human = G.user) {
  tr = { date: G.date, cash: [], picks: [], swaps: [], ...tr };
  const x = market(G), res = fit({ ...G, picks: x.pv, ledger: G.picks }, tr);
  const clubs = [...new Set(tr.moves.flatMap((m) => [m.from, m.to]).concat([...tr.picks, ...tr.swaps].flatMap((p) => [p.from, p.to])))];
  const gains = Object.fromEntries(clubs.map((ab) => [ab, gain(G, x, ab, tr)]));
  const ok = res.ok && !res.errors.length;
  return { ok, errors: res.errors, gains, accept: ok && clubs.every((ab) => ab === human || gains[ab] > x.F.cap * MIN_GAIN), res, trade: tr };
}
// Offers to the user: for each of the user's players, the clubs that make most more of him build
// an offer as they would for each other (the user's club weighed by its own GM's leanings, so an
// offer is one a fair-minded club might take); the best few, one per club.
export function offersFor(G, human = G.user, n = 3) {
  const x = market(G), P = G.players, clubs = Object.keys(G.teams).filter((ab) => ab !== human);
  const cands = G.teams[human].roster.map((id) => P[id]).filter((p) => !p.contract?.twoWay && C.yearOf(p.contract, x.s))
    .flatMap((p) => clubs.map((B) => [p, B, playerWorth(G, B, p, x.modes[B]) - playerWorth(G, human, p, x.modes[human])]))
    .sort((a, b) => b[2] - a[2]).slice(0, 40);
  const got = new Set(), out = [];                               // one offer per club and per player
  for (const [p, B] of cands) {
    if (got.has(B) || got.has(p.id)) continue;
    const o = buildOffer(G, x, B, human, p, G.date);
    if (o) { out.push(o.trade); got.add(B); got.add(p.id); }
    if (out.length === n) break;
  }
  return out;
}
// An accepted offer goes through.
export function complete(G, j) { execute(G, j.trade, j.res); G.log.push(logEntry(j.trade)); }

// Put a passed trade into effect: rosters, picks, hard caps, new trade exceptions, cash.
export function execute(G, trade, res) {
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
