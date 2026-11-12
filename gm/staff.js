// Front-office staffs, with hidden talent: every club's scouts and analysts (G.teams[ab].staff), the
// user's hired by name. A hire's read of a man's talent misses by his own error, made of a part every
// staff in the league shares (RHO_L: the same games, the same public numbers), a part his club's staff
// shares (RHO_C: they talk to each other), more his club's hires of his kind share (RHO_IN) and a part
// his alone; none of it shared with the league's read. Precision
// is in units of the league's read of the man: a hire of quality q reads a man with LAMBDA x q x SPEC of
// its precision, SPEC 1 on his own kind of man (scouts prospects, analysts NBA players) and a third on
// the other. A club sees the league's read and its staff's, of a man's rating and his trend, weighted by precision (GLS), and values men
// from it (league.js teamValue); the draft stays on the draft model's reads (gm.js), which order talent
// no better than the board, as real drafts do.
// Clubs: analysts about 4.4 a club (132 in the league in 2023: Wang, Sarker and Hosoi, J. Sports Econ.
// 2025), scouts about 6 (the game's; no count found). What staff are worth, against rivals with staffs
// of their own (staff_cal.mjs: a club with nine analysts against none, eight seasons, paired seeds): about
// 5 wins a season at LAMBDA 0.091 (+5.1, se 2.4, six seeds) and much the same at 0.9 (+6.3, se 2.7, four),
// since a sharper read sharpens every club's; with the trend read too, +2.3 (se 2.6, six seeds) at 0.091,
// no detectable change. Over all sixteen, about 4.4 wins: half a win an analyst, against the paper's 1.25, an
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
export const cost = (G) => of(G).reduce((a, h) => a + h.sal, 0) + benchCost(G);
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
// what club ab's front office reads of a man, its prior read (prior, missing truth by sd) and its staff's
// reads of the truth, by precision; tag keeps the staff's errors on his rating and his trend apart
// (a read is asked for many times over, season by season of a man's deal, club by club: kept while what it
// stands on -- the prior read, the truth, the miss and the staff -- is the same)
const POST = new WeakMap();
function post(G, p, ab, prior, truth, sd, tag) {
  const k = +!prospect(G, p), w = weights(G, ab, k);
  let c = POST.get(G); if (c?.s !== G.season) POST.set(G, (c = { s: G.season, m: new Map() }));
  const ck = `${p.id}${tag}|${ab}`, e = c.m.get(ck);
  if (e && e.prior === prior && e.truth === truth && e.sd === sd && e.w === w.key) return e.v;
  const v = post0(G, p, ab, prior, truth, sd, tag, k, w);
  c.m.set(ck, { prior, truth, sd, w: w.key, v });
  return v;
}
function post0(G, p, ab, prior, truth, sd, tag, k, { a, A }) {
  const key = `${p.id}|${G.season}${tag}`, z0 = hashNoise(`${key}|all`), zc = hashNoise(`${key}|${ab}`);
  const zt = { scout: hashNoise(`${key}|${ab}|scout`), analytics: hashNoise(`${key}|${ab}|analytics`) };
  let s = 0;
  of(G, ab).forEach((h, i) => { s += a[i] * (truth + sd * (Math.sqrt(RHO_L) * z0 + Math.sqrt(RHO_C - RHO_L) * zc + Math.sqrt(RHO_IN - RHO_C) * zt[h.t] + Math.sqrt(1 - RHO_IN) * hashNoise(`${key}|${h.id}`)) / Math.sqrt(lam(h, k))); });
  return (prior + s) / (1 + A);
}
// his rating as club ab reads it: the league's read and its staff's
export const read = (G, p, ab = G.user) => (!G.hidden || !of(G, ab).length ? p.rate : post(G, p, ab, p.rate, p.talent, sdL(G, p), ''));
// his trend as club ab reads it: its read before staff (league.js trendRead, missing by sd) and its staff's,
// each hire reading it as well as he reads talent (the same share of the prior read's precision)
export const readTrend = (G, p, ab, t0, sd) => (!G.hidden || !ab || !of(G, ab).length ? t0 : post(G, p, ab, t0, p.trend, sd, '|tr'));
// the share of the league's miss club ab's read still has (1 with no staff): kind 0 prospects, 1 NBA players
export const miss = (G, k, ab = G.user) => (of(G, ab).length ? 1 / Math.sqrt(1 + weights(G, ab, k).A) : 1);

// ---- head coaches and head trainers (_gm_staff.py), in every game, hidden or not -------------------
// A coach's skill is his lean (K.bench.coach): minutes a game per point of rating, how closely his
// rotation follows his men's ratings. In the game it is how far he moves the league's default rotation
// toward the best one (league.js rotation), PULL of the way for each sd, set so a coach one sd better is
// worth what one is in the data (+0.22 per 100 per minute of lean, _coach_minutes.py); a trainer's, the share of games his men lose
// beyond expected (season.js injuries), lower better. Each opens with his record, shrunk to the league's
// by how many seasons it rests on; a first-timer's skill is drawn from the league's true spread. Each
// summer a computer club replaces its coach as real clubs have (_gm_coach_firing.py: a season below the
// line, a new GM, his years in the job) and its trainer at the league's rate (12%), from the market:
// out-of-work coaches who led a club since 2019-20 and first-timers. Pay as reported (thin): head
// coaches $4M (Sportico's low end) to $17.5M (Kerr's), trainers $120k-$300k (no reliable source), up the
// range with skill.
export const PAYS = 0.22;                   // points per 100 a minute of lean is worth (_coach_minutes.py)
export const PULL = 0.21;                   // how far toward the best rotation a coach 1 sd better moves: calibrate-bench.js, 16 seeds, +0.26 a game (se 0.03; hidden +0.29) against the data's +0.28
// the share of the way from the default rotation to the best one club ab's coach moves (negative: away)
export const coachPull = (G, ab) => (G.teams[ab].coach ? PULL * benchZ(G, G.teams[ab].coach) : 0);
export const BENCH = { coach: { label: 'Head coach', pay: [4e6, 17.5e6], sign: 1 }, trainer: { label: 'Head trainer', pay: [120e3, 300e3], sign: -1 } };
function benchMan(G, t, x, r) {
  const B = G.K.bench[t], q = x?.q ?? B.mean + B.sd * r.normal(), [lo, hi] = BENCH[t].pay;
  return { id: `bn${(G.staffN = (G.staffN || 0) + 1)}`, nm: x?.n ?? `${r.pick(G.names.first)} ${r.pick(G.names.last)}`, t, q, ten: x?.ten ?? 0,
    sal: Math.round((lo + (hi - lo) * Phi(BENCH[t].sign * (q - B.mean) / B.sd)) / 1e4) * 1e4 };
}
// skill against the league's mean, in sds (better positive)
export const benchZ = (G, h) => BENCH[h.t].sign * (h.q - G.K.bench[h.t].mean) / G.K.bench[h.t].sd;
export function initBench(G, L, r) {
  for (const [ab, T] of Object.entries(G.teams)) for (const t of Object.keys(BENCH)) T[t] = benchMan(G, t, L.bench?.clubs?.[ab]?.[t], r);
  G.benchFree = (L.bench?.pool || []).map((x) => benchMan(G, 'coach', x, r));
  benchMarket(G, r);
}
// the user's market: the out-of-work coaches and three first-timers, six trainers
export function benchMarket(G, r) {
  G.benchPool = [...G.benchFree, ...Array.from({ length: 3 }, () => benchMan(G, 'coach', null, r)), ...Array.from({ length: 6 }, () => benchMan(G, 'trainer', null, r))];
}
// P(a coach is out after the season): _gm_coach_firing.py's hazard on his club's season (x: gm.js closeSeason's
// record) and his seasons into the job, higher when the club has a new lead executive (newGm)
export function pCoachOut(G, h, x, newGm) {
  const c = G.K.bench.coach.hazard, t = Math.min(h.ten || 1, 5);
  return 1 / (1 + Math.exp(-(c.Intercept + (t > 1 ? c[`C(ten)[T.${t === 5 ? '5+' : t}]`] : 0) + c.pct * x.pct + c.vs_exp * x.vs_exp + c.d_pct * x.d_pct
    + c.playoffs * x.playoffs + c.po_w * x.po_w + c.new_gm * +newGm + c.champ * x.champ)));
}
// the summer, after the GMs' (league.js): rec[ab] the club's season, newGm[ab] whether its GM changed. A
// computer club's coach goes by the hazard, its trainer at the league's rate; the seat is filled from the
// market (a coach let go joins it)
export function benchSummer(G, r, rec = {}, newGm = {}) {
  for (const [ab, T] of Object.entries(G.teams)) {
    if (T.coach) T.coach.ten = (T.coach.ten || 0) + 1;
    if (ab === G.user && !G.fired) continue;
    for (const t of Object.keys(BENCH)) if (!T[t] || r() < (t === 'coach' ? (rec[ab] ? pCoachOut(G, T.coach, rec[ab], newGm[ab]) : 0) : G.K.bench[t].turnover)) {
      const pool = G.benchPool.filter((h) => h.t === t), h = pool.length ? pool[Math.floor(r() * pool.length)] : benchMan(G, t, null, r);   // a market run dry: a first-timer
      if (t === 'coach' && T.coach) G.benchFree.push(T.coach);
      G.benchPool = G.benchPool.filter((x) => x !== h); G.benchFree = G.benchFree.filter((x) => x !== h); T[t] = { ...h, ten: 0 };
    }
  }
  benchMarket(G, r);
}
export const benchCost = (G, ab = G.user) => Object.keys(BENCH).reduce((a, t) => a + (G.teams[ab][t]?.sal || 0), 0);
