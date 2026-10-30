// Front-office staffs, with hidden talent: every club's scouts and analysts (G.teams[ab].staff), the
// user's hired by name. A hire's read of a man's talent misses by his own error, made of a part every
// staff in the league shares (RHO_L: the same games, the same public numbers), a part his club's staff
// shares (RHO_C: they talk to each other), more his club's hires of his kind share (RHO_IN) and a part
// his alone; none of it shared with the league's read. Precision
// is in units of the league's read of the man: a hire of quality q reads a man with LAMBDA x q x SPEC of
// its precision, SPEC 1 on his own kind of man (scouts prospects, analysts NBA players) and a third on
// the other. A club sees the league's read and its staff's, weighted by precision (GLS), and values men
// from it (league.js teamValue); the draft stays on the draft model's reads (gm.js), which order talent
// no better than the board, as real drafts do.
// Clubs: analysts about 4.4 a club (132 in the league in 2023: Wang, Sarker and Hosoi, J. Sports Econ.
// 2025), scouts about 6 (the game's; no count found). What staff are worth, against rivals with staffs
// of their own (staff_cal.mjs: a club with nine analysts against none, eight seasons, paired seeds): about
// 5 wins a season at LAMBDA 0.091 (+5.1, se 2.4, six seeds) and much the same at 0.9 (+6.3, se 2.7, four),
// since a sharper read sharpens every club's; about 0.6 wins an analyst, against the paper's 1.25, an
// estimate within a club over time that a club hiring as it wins would also give. LAMBDA stays at 0.091,
// what one analyst adds were the paper right and wins linear in the error removed. The correlations, SPEC, the spread of quality and
// the rate staff leave are the game's. Pay as reported (job listings, thin): scouts $30k-100k, analysts
// $60k-250k, rising with quality.
import { hashNoise } from './dev.js';
import { Phi } from './season.js';

export let LAMBDA = 0.091;
export const RHO_IN = 0.5, RHO_C = 0.25, RHO_L = 0.05, QSD = 0.5, MEAN = { scout: 6, analytics: 4.4 };
export const tune = (o) => ({ LAMBDA = LAMBDA } = o);     // for calibration runs
export const KINDS = { scout: { label: 'Scout', pay: [30e3, 100e3], spec: [1, 1 / 3] }, analytics: { label: 'Analyst', pay: [60e3, 250e3], spec: [1 / 3, 1] } };
const prospect = (G, p) => !!G.draft?.avail?.includes(p.id) && !p.tm;
const lam = (h, k) => LAMBDA * h.q * KINDS[h.t].spec[k];   // what a hire reads of a man of kind k (0 a prospect, 1 an NBA player), in league reads
export const of = (G, ab = G.user) => G.teams[ab].staff || [];

// a hire: quality lognormal about 1, pay up his kind's range with it
export function make(G, t, r) {
  const z = r.normal(), [lo, hi] = KINDS[t].pay;
  return { id: `st${(G.staffN = (G.staffN || 0) + 1)}`, nm: `${r.pick(G.names.first)} ${r.pick(G.names.last)}`, t, q: Math.exp(QSD * z - QSD * QSD / 2), sal: Math.round((lo + (hi - lo) * Phi(z)) / 1e3) * 1e3 };
}
// every club's staff at the start: of each kind about its mean (sd 2, at least one)
export function init(G, r) {
  for (const T of Object.values(G.teams)) T.staff = Object.entries(MEAN).flatMap(([t, m]) => Array.from({ length: Math.max(1, Math.round(m + 2 * r.normal())) }, () => make(G, t, r)));
  market(G, r);
}
// the summer's market for the user: six of each kind
export const market = (G, r) => { G.staffPool = ['scout', 'analytics'].flatMap((t) => Array.from({ length: 6 }, () => make(G, t, r))); };
export const cost = (G) => of(G).reduce((a, h) => a + h.sal, 0);
// the summer: a hire leaves for another club at 10%, 5% more for each playoff series his club won; a
// computer club fills the seat with a new hire of the kind (the user's club is the user's to fill)
export function summer(G, h, r) {
  const won = (ab) => Object.values(Object.assign({}, ...h.rounds)).filter((v) => v.winner === ab).length, gone = [];
  for (const [ab, T] of Object.entries(G.teams)) {
    const p = 0.1 + 0.05 * won(ab), mine = ab === G.user && !G.fired;
    T.staff = (T.staff || []).map((x) => (r() < p ? (mine && gone.push(x), mine ? null : make(G, x.t, r)) : x)).filter(Boolean);
  }
  market(G, r);
  return gone;
}

// GLS weights on a club's hires' reads, a = S^-1 1, S their errors' covariance over the league read's variance
const W = new WeakMap();
function weights(G, ab, k) {
  const st = of(G, ab), key = `${k}|${st.map((h) => h.id).join()}`;
  let c = W.get(G); if (!c) W.set(G, (c = new Map()));
  if (c.get(`${ab}|${k}`)?.key === key) return c.get(`${ab}|${k}`);
  const S = st.map((h, i) => st.map((g, j) => (i === j ? 1 : h.t === g.t ? RHO_IN : RHO_C) / Math.sqrt(lam(h, k) * lam(g, k))));
  const a = solve(S, st.map(() => 1)), w = { key, a, A: a.reduce((x, y) => x + y, 0) };
  c.set(`${ab}|${k}`, w);
  return w;
}
function solve(A, b) {                                // Gaussian elimination (S is positive definite)
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}
// how far the league's read misses a man: a prospect by the class's board miss; an NBA player by the
// league's miss over men watched as long (under 500 minutes on the record, or more), this season
const SD = new WeakMap();
function sdL(G, p) {
  if (prospect(G, p)) return G.draft.hold;
  const key = `${G.season}|${G.phase}`;
  let c = SD.get(G);
  if (c?.key !== key) {
    const ps = Object.values(G.players).filter((q) => q.tm), rms = (a) => Math.sqrt(a.reduce((s, q) => s + (q.talent - q.rate) ** 2, 0) / a.length);
    SD.set(G, (c = { key, v: [rms(ps.filter((q) => q.seen < 500)), rms(ps.filter((q) => q.seen >= 500))] }));
  }
  return c.v[+(p.seen >= 500)];
}
// his rating as club ab's front office reads it: the league's read and its staff's, by precision
export function read(G, p, ab = G.user) {
  if (!G.hidden || !of(G, ab).length) return p.rate;
  const k = +!prospect(G, p), { a, A } = weights(G, ab, k), sd = sdL(G, p), key = `${p.id}|${G.season}`, z0 = hashNoise(`${key}|all`), zc = hashNoise(`${key}|${ab}`);
  const zt = { scout: hashNoise(`${key}|${ab}|scout`), analytics: hashNoise(`${key}|${ab}|analytics`) };
  let s = 0;
  of(G, ab).forEach((h, i) => { s += a[i] * (p.talent + sd * (Math.sqrt(RHO_L) * z0 + Math.sqrt(RHO_C - RHO_L) * zc + Math.sqrt(RHO_IN - RHO_C) * zt[h.t] + Math.sqrt(1 - RHO_IN) * hashNoise(`${key}|${h.id}`)) / Math.sqrt(lam(h, k))); });
  return (p.rate + s) / (1 + A);
}
// the share of the league's miss club ab's read still has (1 with no staff): kind 0 prospects, 1 NBA players
export const miss = (G, k, ab = G.user) => (of(G, ab).length ? 1 / Math.sqrt(1 + weights(G, ab, k).A) : 1);
