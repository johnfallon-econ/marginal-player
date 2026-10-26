// Draft picks as assets: what each one is (its protection, the swaps and cascades it is part of),
// what it is worth, and whether a club is sure of a first. Worth is read off simulated drafts: each
// club's wins drawn around its projection (a preseason projection misses by K.pickSim.miss; a season
// carries K.pickSim.carry of itself into the next around a spread of K.pickSim.sd), the lottery run
// as the draft runs it, and every protection and swap resolved (draft.js resolvePicks).
import * as D from './draft.js';
import * as S from './season.js';
import { projWins } from './league.js';

const N = 200, ORD = ['', 'best', '2nd best', '3rd best', '4th best'];
const rg = ([a, b]) => (a === b ? `no. ${a}` : `${a}-${b}`);

// the drafts whose picks can change hands: from the next one not yet held, to seven out
export function years(G) {
  const y0 = Math.max(G.season + 1, (G.lastDraft || 0) + 1), out = [];
  for (let y = y0; y <= G.season + 8; y++) out.push(y);
  return out;
}
const opsOf = (G, y, r) => G.swaps?.[`${y}|${r}`]?.ops || [];
// who an op benefits, when that is a club and not whoever holds a pick: it can be traded
const owner = (op) => (op.k === 'give' ? op.to : op.k === 'nth' ? op.by : op.by);
const picksIn = (op) => (op.k === 'give' ? [op.pick] : op.k === 'nth' ? op.of : [...op.give, ...op.take]);

// Every asset in play: picks (ORIGIN|YEAR|ROUND) and claims (op|YEAR|ROUND|i: a club's place in a
// cascade, its to trade). terms: what the asset is, in words.
export function assets(G) {
  const out = {}, D_ = G.draft, used = new Set(D_ ? D_.order.slice(0, D_.picks.length).map((e) => `${e.origin}|${D_.year}|${e.slot <= 30 ? 1 : 2}`) : []);
  for (const y of years(G)) for (const r of [1, 2]) {
    const ops = opsOf(G, y, r);
    for (const o of Object.keys(G.teams)) {
      const id = `${o}|${y}|${r}`, e = G.picks[id];
      if ((e?.t === 'gone' && !e.h) || used.has(id)) continue;
      const terms = [];
      if (e?.frozen) terms.push(e.end ? 'frozen by the second apron for good: it goes last in the first round' : 'frozen by the second apron');
      if (e?.p) terms.push(`${e.p[0] === 1 + 30 * (r - 1) ? `top-${e.p[1] - 30 * (r - 1)}` : rg(e.p)} protected${e.k && e.k !== o ? ` (to ${e.k})` : ''}`);
      for (const op of ops) {
        if (op.k === 'swap' && op.take.includes(o)) terms.push(`${op.by ?? op.give.map((g) => G.picks[`${g}|${y}|${r}`]?.h || g)[0]} may swap for it${op.ex?.[o] ? ` (unless ${rg(op.ex[o])})` : ''}`);
        if (op.k === 'swap' && op.give[0] === o && !op.by) terms.push(`its holder may swap it for ${op.take.join('/')}'s`);
        if (op.k === 'nth' && op.of.includes(o)) terms.push(`${op.by} gets the ${op.n > 0 ? ORD[op.n] : op.n === -1 ? 'worst' : `${ORD[-op.n]} worst`} of ${op.of.join('/')}`);
        if (op.k === 'give' && op.pick === o) terms.push(`goes to ${op.to}${op.pr ? ` unless ${rg(op.pr)}` : ''}`);
      }
      out[id] = { id, kind: 'pick', origin: o, year: y, round: r, holder: e?.h || o, prot: e?.p || null, frozen: !!e?.frozen, terms };
    }
    ops.forEach((op, i) => {
      if (op.k === 'swap' && !op.by) return;
      const id = `op|${y}|${r}|${i}`, w = owner(op);
      const what = op.k === 'give' ? `${op.pick}'s pick${op.pr ? ` unless ${rg(op.pr)}` : ''}`
        : op.k === 'nth' ? `the ${op.n > 0 ? ORD[op.n] : op.n === -1 ? 'worst' : `${ORD[-op.n]} worst`} of ${op.of.join('/')}`
        : `a swap of ${op.give.join('/')} for ${op.take.join('/')}`;
      out[id] = { id, kind: 'claim', origin: picksIn(op)[0], year: y, round: r, holder: w, prot: null, frozen: false, terms: [what], op: i };
    });
  }
  return out;
}

// ---- simulated drafts ------------------------------------------------------------------------
// Each draw: the final standings of the season before each draft in play, as orders of origins
// (the lottery's first round, and the whole league by record for the second). Common to every
// valuation in one sitting, so two packages differ by their terms and not by luck.
const SIMS = new WeakMap();
export function draws(G) {
  const key = draws.key(G), c = SIMS.get(G);
  if (c?.key === key) return c.d;
  const K = G.K.pickSim, ab = Object.keys(G.teams), r = S.rng(7), ys = years(G), d = [];
  const proj = Object.fromEntries(ab.map((t) => [t, projWins(G, t)]));
  for (let n = 0; n < N; n++) {
    const w = {}, out = {};
    for (const [j, y] of ys.entries()) {
      for (const t of ab) {
        if (j === 0) {
          // the season deciding the next draft: done, under way, or still to play
          const done = y - 1 === G.season && G.lastRecord && ['offseason', 'draft'].includes(G.phase);
          const cur = y - 1 === G.season && G.cur && !G.seasonOver ? G.cur : null, left = cur ? 1 - cur.played[t] / 82 : 1;
          w[t] = done ? G.lastRecord[t].w : (cur ? cur.record[t].w : 0) + left * proj[t] + K.miss * Math.sqrt(left) * r.normal();
        } else w[t] = 41 + K.carry * (w[t] - 41) + K.sd * Math.sqrt(1 - K.carry ** 2) * r.normal();
      }
      if (G.draft?.year === y) { out[y] = [G.draft.order.filter((e) => e.slot <= 30).map((e) => e.origin), G.draft.order.filter((e) => e.slot > 30).map((e) => e.origin)]; continue; }
      const byRec = ab.slice().sort((a, b) => w[a] - w[b]);
      // the lottery: the 16 worst, 2 balls for the three worst, 3 for the next seven, 2 for the
      // four 9/10 teams and 1 for the two 7/8 losers (the play-in, by record)
      const lot = D.lottery(byRec.slice(0, 16).map((t, i) => ({ ab: t, balls: i < 3 ? 2 : i < 10 ? 3 : i < 14 ? 2 : 1 })), r);
      out[y] = [D.frozenLast([...lot, ...byRec.slice(16)], y, G.picks), byRec];
    }
    out.slot = {};
    d.push(out);
  }
  SIMS.set(G, { key, d });
  return d;
}
// For each draw and draft: who holds each slot, under a ledger and swaps (the league's, or a
// trade's). [{ y: [{ slot, origin, holder }] }]
export function resolved(G, picks = G.picks, swaps = G.swaps || {}) {
  return draws(G).map((dr) => {
    let led = picks; const out = {};
    for (const y of years(G)) {
      const { order, created } = D.resolvePicks(dr[y], +y, led, swaps);
      out[y] = order; led = { ...led, ...created };
    }
    return out;
  });
}
// a club's expected draft surplus by draft year ($M at K.slotCap), under resolved draws R
export function haul(G, R, ab) {
  const v = {}, sv = G.K.slotSurplus;
  for (const out of R) for (const [y, order] of Object.entries(out)) for (const e of order) if (e.holder === ab) v[y] = (v[y] || 0) + Math.max(sv[e.slot - 1], 0) / R.length;
  return v;
}

// ---- a trade's picks -------------------------------------------------------------------------
// The ledger and swaps after a trade's picks move. tr.picks: [{ id, from, to, prot?: [lo, hi] }]
// (prot: a protection the sender adds; within it the sender keeps the pick and owes nothing);
// tr.swaps: [{ y, r, from, to }]: `from` gives `to` the right to swap `to`'s pick for its own.
export function after(G, tr) {
  const picks = { ...G.picks }, swaps = { ...(G.swaps || {}) };
  const ops = (k) => (swaps[k] = { ...(swaps[k] || { hold: {} }), ops: (swaps[k]?.ops || []).slice() }).ops;   // copied as changed
  for (const pk of tr.picks || []) {
    if (pk.id.startsWith('op|')) { const [, y, r, i] = pk.id.split('|'), o = ops(`${y}|${r}`), op = (o[+i] = { ...o[+i] }); op[op.k === 'give' ? 'to' : 'by'] = pk.to; continue; }
    picks[pk.id] = { ...(picks[pk.id] || {}), t: 'gone', h: pk.to, ...(pk.prot ? { p: pk.prot, k: pk.from, f: 'extinguish' } : {}) };
  }
  for (const s of tr.swaps || []) ops(`${s.y}|${s.r}`).push({ k: 'swap', give: [s.to], take: [s.from], made: true });
  return { picks, swaps };
}

// Sure of a first in draft y: holding one no protection or cascade can take away (a swap always
// hands back a first, so it does not count against one).
export function sureFirst(G, picks, swaps, ab, y) {
  const ops = swaps[`${y}|1`]?.ops || [];
  return Object.keys(G.teams).some((o) => {
    const e = picks[`${o}|${y}|1`];
    if ((e?.h || o) !== ab || (e?.p && (e.k || o) !== ab)) return false;
    if (e?.t === 'gone' && !e.h) return false;
    return !ops.some((op) => (op.k === 'give' && op.pick === o && op.to !== ab) || (op.k === 'nth' && op.of.includes(o) && op.by !== ab));
  });
}

// ---- worth -----------------------------------------------------------------------------------
// An asset's worth to club ab (its holder unless given), in the board's surplus ($M at
// K.slotCap): the slot it brings over the simulated drafts. A plain pick brings its own slot
// (nothing when its protection keeps it home); one in a swap or cascade brings what ab ends that
// round with holding it, against the same draws with it in no one's hands -- so a swap right is
// worth something only to a club holding the pick it is written on. prot: a protection the sender
// would add.
const VAL = new WeakMap();
const slotIn = (dr, y, r, o) => (dr.slot[y] ||= [1, 2].map((rr) => Object.fromEntries(dr[y][rr - 1].map((x, i) => [x, i + 1 + 30 * (rr - 1)]))))[r - 1][o] ?? null;
// One round of one draw, as the draft resolves it (draft.js resolvePicks: protections, then the
// swaps), with one asset moved to `to`; what club ab ends the round with. ops, ent: the round's swaps
// and cascades (the asset's own claim already given to `to`) and each origin's ledger entry.
function roundFor(G, dr, a, ops, ent, to, ab) {
  slotIn(dr, a.year, a.round, '');
  const slot = dr.slot[a.year][a.round - 1], h = {}, sv = G.K.slotSurplus;
  for (const [o, e] of ent) {
    if (!(o in slot)) continue;                  // a pick forfeited or used: not in this round
    h[o] = a.kind === 'pick' && o === a.origin ? to : e?.h || o;
    if (e?.h && e.p && slot[o] >= e.p[0] && slot[o] <= e.p[1]) h[o] = e.k || o;
  }
  D.applyOps(ops, slot, h);
  let v = 0; for (const o in h) if (h[o] === ab) v += Math.max(sv[slot[o] - 1], 0);
  return v;
}
const claimTo = (ops, a, to) => { if (a.kind !== 'claim') return ops; ops = ops.slice(); const op = { ...ops[a.op] }; op[op.k === 'give' ? 'to' : 'by'] = to; ops[a.op] = op; return ops; };
export function worth(G, a, prot = null, ab = a.holder) {
  const c = VAL.get(G)?.key === draws.key(G) ? VAL.get(G).v : (VAL.set(G, { key: draws.key(G), v: {} }), VAL.get(G).v);
  // a club with no other stake in that round values the asset as anyone would
  const ops0 = opsOf(G, a.year, a.round), pool = new Set(ops0.flatMap(picksIn)), stake = (c) => ops0.some((op) => owner(op) === c && op.k !== 'swap')
    || [...pool].some((o) => (G.picks[`${o}|${a.year}|${a.round}`]?.h || o) === c && !(a.kind === 'pick' && o === a.origin));
  if (a.kind !== 'pick' || pool.has(a.origin)) ab = stake(ab) ? ab : '~';
  const sv = G.K.slotSurplus, R = draws(G), ops = opsOf(G, a.year, a.round);
  const plain = a.kind === 'pick' && !ops.some((op) => picksIn(op).includes(a.origin));
  const k = `${a.id}|${prot || a.prot}|${plain ? '~' : ab}`;                   // a plain pick brings its slot to whoever holds it
  if (k in c) return c[k];
  let v = 0;
  if (plain) {
    const p = prot || a.prot;
    for (const dr of R) { const s = slotIn(dr, a.year, a.round, a.origin); if (s && !(p && s >= p[0] && s <= p[1])) v += Math.max(sv[s - 1], 0) / R.length; }
  } else {
    // the round with the asset in ab's hands, and in no one's
    const ent = Object.keys(G.teams).map((o) => [o, G.picks[`${o}|${a.year}|${a.round}`]]), mine = claimTo(ops, a, ab), none = claimTo(ops, a, '-');
    for (const dr of R) v += (roundFor(G, dr, a, mine, ent, ab, ab) - roundFor(G, dr, a, none, ent, '-', ab)) / R.length;
  }
  return (c[k] = v);
}
draws.key = (G) => `${G.date}|${G.phase}|${G.draft?.picks.length ?? ''}`;
// A new swap right, to the club given it: the better of its pick and the giver's, less its own
export function swapWorth(G, s) {
  const sv = G.K.slotSurplus, R = draws(G);
  return R.reduce((t, dr) => { const a = slotIn(dr, s.y, s.r, s.from), b = slotIn(dr, s.y, s.r, s.to);
    return t + (a && b && a < b ? Math.max(sv[a - 1], 0) - Math.max(sv[b - 1], 0) : 0); }, 0) / R.length;
}
