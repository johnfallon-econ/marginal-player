// The draft: who picks where (lottery, protections, swaps), who is in the class, who goes where.
import { rookieScale, minSalary, twoWaySalary } from './cba.js';

// ---- the class ---------------------------------------------------------------------------------
// Each prospect's talent comes from a real player drafted near the same slot (L.draft.donors:
// [pick, age at draft, entry talent, height, weight, position, level, pre-draft line, lean, expected availability], 12_gm_data.py), so the class has the real spread of
// stars, role players and washouts by slot. Scouts see talent through noise (scoutSd), set so
// the order the league drafts in ranks talent as well as real drafts have (L.draft.sp).
export function generateClass(L, season, r, scoutSd) {
  const names = L.names, real = new Set(names.real), donors = L.draft.donors, pool = [];
  const name = () => { for (;;) { const n = `${r.pick(names.first)} ${r.pick(names.last)}`; if (!real.has(n)) return n; } };
  for (let slot = 1; slot <= 60 + L.draft.undrafted; slot++) {   // 60 picks plus the undrafted market
    const near = slot > 60 ? L.draft.udonors : donors.filter(([k]) => Math.abs(k - slot) <= 2);   // the undrafted: real undrafted entrants
    const [, age, talent, ht, wt, pos, lvl, line, lean, av, from] = r.pick(near);
    pool.push({ id: `d${season}-${slot}`, nm: name(), age: Math.round(age), talent, board: talent + scoutSd * r.normal(), yos: 0, draftYear: season + 1, lean, av, undrafted: slot > 60 || undefined,
      pos, ht: ht && `${Math.floor(ht / 12)}-${ht % 12}`, wt, from, pre: lvl && { lvl, line } });
  }
  return pool;
}

// Scouting noise for a target rank correlation between the board and talent: solved by
// simulation once per game (a few dozen classes are enough for the second decimal).
export function solveScoutSd(L, r, target = L.draft.sp) {
  const spearman = (a, b) => {
    const rank = (x) => { const o = x.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]), rk = []; o.forEach(([, i], j) => (rk[i] = j)); return rk; };
    const ra = rank(a), rb = rank(b), n = a.length;
    return 1 - 6 * ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0) / (n * (n * n - 1));
  };
  let lo = 0, hi = 6;
  for (let it = 0; it < 18; it++) {
    const sd = (lo + hi) / 2;
    let rho = 0;
    for (let k = 0; k < 30; k++) {
      const c = generateClass(L, 2026, r, sd).filter((p) => !p.undrafted).sort((a, b) => b.board - a.board).slice(0, 60);
      rho += spearman(c.map((p) => p.board), c.map((p) => p.talent)) / 30;
    }
    (rho > target ? (lo = sd) : (hi = sd));
  }
  return (lo + hi) / 2;
}

// A first frozen for good by the second apron goes to the end of the first round (Art. VII §2(f)):
// the round's order, origins, with those picks moved last in the order they held.
export const frozenLast = (first, year, picks) => {
  const end = (o) => !!picks[`${o}|${year}|1`]?.end;
  return [...first.filter((o) => !end(o)), ...first.filter(end)];
};

// ---- the lottery (3-2-1, approved for the 2027-29 drafts; kept after that) -----------------
// teams: the 16 lottery teams, worst record first, each { ab, balls } from the play-in results:
// 2 for the three worst (relegated), 3 for the rest who missed the play-in, 2 for the 9/10
// play-in teams, 1 for the 7/8 game losers. The relegated fall no lower than 12th. A team's
// own pick cannot win No. 1 two drafts running or the top five three running (hist).
export function lottery(teams, r, hist = {}) {
  const left = teams.slice(), order = [], relegated = new Set(teams.slice(0, 3).map((t) => t.ab));
  for (let slot = 1; slot <= teams.length; slot++) {
    const relLeft = left.filter((t) => relegated.has(t.ab));
    let elig = 12 - slot + 1 <= relLeft.length ? relLeft : left;          // the 12th-pick floor
    elig = elig.filter((t) => !(slot === 1 && hist[t.ab]?.no1) && !(slot <= 5 && hist[t.ab]?.top5x2));
    if (!elig.length) elig = left;
    const tot = elig.reduce((a, t) => a + t.balls, 0);
    let x = r() * tot, pick = elig[elig.length - 1];
    for (const t of elig) { if ((x -= t.balls) < 0) { pick = t; break; } }
    order.push(pick.ab); left.splice(left.indexOf(pick), 1);
  }
  return order;
}

// ---- who holds which pick -------------------------------------------------------------------
// picks: the ledger, keyed "ORIGIN|YEAR|ROUND": { t: 'gone'|'encumbered'|'swap', h: holder, p: [lo, hi]
// protected range (overall slots: a second-rounder's are 31-60), k: who keeps it when protected
// (its origin unless a protection was added by a club that held it), f: on protection
// 'extinguish'|'convey_other', fb: [owner, year, round] the fallback owed instead, sch: [[year, lo,
// hi]...] later years' protection }. A pick absent from the ledger belongs to its own team.
// swaps: { "YEAR|ROUND": { ops } }, the swaps and cascades (_gm_swaps.py, and those made in trades),
// applied once the protections are settled (applyOps). Returns [{ slot, origin, holder }] and the
// ledger entries the conveyance creates.
export function resolvePicks(orderByRound, year, picks, swaps = {}) {
  const out = [], created = {}, view = Object.create(picks);
  const owe = (k, e) => { created[k] = e; view[k] = e; };
  orderByRound.forEach((origins, rd) => {
    const slot = Object.fromEntries(origins.map((o, i) => [o, i + 1 + 30 * rd])), h = {};
    for (const o of origins) {
      const e = view[`${o}|${year}|${rd + 1}`];
      h[o] = e?.h || o;
      if (e?.h && e.p && slot[o] >= e.p[0] && slot[o] <= e.p[1]) {
        // protected: its keeper keeps it; something else is owed
        h[o] = e.k || o;
        if (e.f === 'convey_other' && e.fb) owe(`${e.fb[0] || o}|${e.fb[1]}|${e.fb[2]}`, { t: 'gone', h: e.h });
        const nxt = (e.sch || []).find((x) => x[0] > year);
        if (nxt) owe(`${o}|${nxt[0]}|${rd + 1}`, { t: 'encumbered', h: e.h, ...(nxt[1] ? { p: [nxt[1], nxt[2]] } : {}), f: e.f, fb: e.fb, sch: e.sch.filter((x) => x[0] > nxt[0]) });
      }
    }
    const sw = swaps[`${year}|${rd + 1}`];
    if (sw) applyOps(sw.ops, slot, h, (fb, to, p) => owe(`${fb[0]}|${fb[1]}|${fb[2]}`, { t: 'gone', h: to, ...(p ? { p } : {}) }));
    for (const o of origins) out.push({ slot: slot[o], origin: o, holder: h[o] });
  });
  return { order: out.sort((a, b) => a.slot - b.slot), created };
}
// The ops of one round, in order, on h (origin -> holder) given each pick's slot (_gm_swaps.py
// says what each does). A swap is exercised by `by`, else by whoever held its first `give` pick
// when the ops began: a swap right travels with the pick it is written on. owe(fb, to, p) conveys
// a fallback when a protection stops an op.
export function applyOps(ops, slot, h, owe = () => {}) {
  const at = { ...h }, by = (a, b) => slot[a] - slot[b], inR = (o, r) => !!r && slot[o] >= r[0] && slot[o] <= r[1];
  const nth = (xs, n) => (n > 0 ? xs[n - 1] : xs[xs.length + n]);
  for (const op of ops) {
    if (op.when && !op.when.every(([o, lo, hi]) => inR(o, [lo, hi]))) continue;
    let barred = false;
    const ok = (o) => { if (!(o in slot)) return false; if (inR(o, op.ex?.[o])) { barred = true; return false; } return true; };
    if (op.k === 'give') {
      if (!(op.pick in slot)) continue;
      if (inR(op.pick, op.pr)) { if (op.fb) owe(op.fb, op.to, op.fbp); } else h[op.pick] = op.to;
    } else if (op.k === 'nth') {
      const o = nth(op.of.filter(ok).filter((x) => !op.frm || h[x] === op.frm).sort(by), op.n);
      if (!o) continue;
      if (inR(o, op.pr)) { if (op.fb) owe(op.fb, op.by, op.fbp); } else h[o] = op.by;
    } else {
      const who = op.by ?? at[op.give[0]];
      const g = op.give.filter(ok).filter((x) => h[x] === who).sort(by).at(-1);
      const t = nth(op.take.filter(ok).filter((x) => h[x] !== who && (!op.frm || h[x] === op.frm)).sort(by), op.tn ?? 1);
      if (!g || !t) { if (barred && op.fb) owe(op.fb, who, op.fbp); continue; }
      if (slot[t] < slot[g]) [h[g], h[t]] = [h[t], who];
    }
  }
  return h;
}

// ---- picking ----------------------------------------------------------------------------------
// A computer GM takes the best prospect on his own board: the shared scouting board plus his
// own error (gmSd) -- no GM sees talent.
export function aiPick(pool, r, gmSd) {
  let best = null, bv = -Infinity;
  for (const p of pool) { const v = p.board + gmSd * r.normal(); if (v > bv) { bv = v; best = p; } }
  return best;
}

// Rookie deals: first-rounders on the scale at 120% (years 3 and 4 team options); second-rounders
// a two-year minimum through the second-round exception; the rest of the class goes to two-way
// and camp deals in free agency.
export function rookieContract(pick, season, cap) {
  const s = season + 1;                                   // the draft in June of season s-1 signs for s
  if (pick <= 30) {
    const sc = rookieScale(pick, cap, 1.2);
    return { years: sc.map((sal, i) => ({ s: s + i, sal, gtd: i < 2 ? sal : 0, opt: i >= 2 ? 'tm' : null })),
             how: 'rookie', rookie: true };
  }
  return { years: [0, 1].map((i) => ({ s: s + i, sal: minSalary(i, cap), gtd: i ? 0 : minSalary(0, cap), opt: null })), how: 'second' };
}
export const twoWayContract = (season, cap) => ({ years: [{ s: season + 1, sal: twoWaySalary(cap), gtd: 0, opt: null }], twoWay: true, how: 'twoWay' });
