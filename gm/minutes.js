// Minutes, night by night: a man's role for the season and the night around it (K.minutes,
// code/_gm_minutes_role.py, fit on 2018-19 to 2025-26's man-nights from minutes_mle's panel).
//
//   role         alpha, his share's level for the season: last season's realised role carried 0.65,
//                with his rating, age and a change of club, falling back near the ceiling (past a
//                knot in each), fit within clubs, and its surprise a real club's by rank (dev); a rookie's by draft slot; a man
//                with no season behind him by his rating. A coach leans on it (staff.js coachPull:
//                toward the club's own minutes handed out in order of true talent, or away),
//                and a rebuilding club plays its young as if K.tankYouth a point better a year under 26.
//   tonight      fit (av: his health, season.js injuries), he gets on the floor -- the coach's
//                choice -- with P = Phi(c'[1, alpha, z]) -- z: back from a long absence and
//                how far into it, the run of games just missed, the absent men's minutes he stands
//                to inherit (simout: their shares by resemblance, minutes_mle's metric), the hole
//                and the crowd -- and among those who do his share goes as
//                exp(alpha + b'x + sd(alpha) e), onto the simplex with none past 48 of 240.
//
// The role is persistent within a season, as the real one is: the site's minutes model (trailing
// shares, no role) flattened rotations when run in closed loop. Each season's realised role (his
// share against the night's, net of the night's terms) is what the next season's grows from.
import { Phi } from './season.js';
import { hashNoise } from './dev.js';

const fold = (a) => a.reduce((x, y) => x + y, 0);
// a box line (per 100 possessions, K.box.line order) to the characteristics the metric reads
const IDX = { ast: 2, stl: 3, blk: 4, reb: 1, fga: 6, fg3m: 7, fta: 9, tov: 12 };
const P36 = 36 / 48;                                   // 100 possessions is about 48 minutes
// usage: his plays over the club's while he is on (about 110 plays per 100 possessions)
const usgOf = (l) => (l[IDX.fga] + 0.44 * l[IDX.fta] + l[IDX.tov]) / 110;
const lastLine = (p) => p.log?.findLast((l) => l.p100 && l.gp >= 5)?.p100 ?? null;
const inches = (ht) => { const m = /^(\d+)-(\d+)$/.exec(ht || ''); return m ? 12 * +m[1] + +m[2] : null; };
function rawChars(p) {
  const l = lastLine(p), pos = (p.pos || '')[0];
  return [inches(p.ht), p.wt ?? null, l && l[IDX.ast] * P36, l && l[IDX.reb] * P36, l && l[IDX.blk] * P36, l && l[IDX.stl] * P36,
    l && usgOf(l), l && (l[IDX.fga] > 0 ? l[IDX.fg3m] / l[IDX.fga] : 0), +(pos === 'G'), +(pos === 'F'), +(pos === 'C')];
}
// standardised within the league this season, as the metric's were within each real one
export function charScale(players) {
  const R = players.map(rawChars), out = [];
  for (let j = 0; j < 11; j++) {
    const v = R.map((x) => x[j]).filter((x) => x != null).sort((a, b) => a - b), mu = fold(v) / (v.length || 1);
    out.push({ mu, sd: Math.sqrt(fold(v.map((x) => (x - mu) ** 2)) / Math.max(v.length - 1, 1)) || 1, med: v[Math.floor(v.length / 2)] ?? 0 });
  }
  return out;
}
const chars = (p, sc) => rawChars(p).map((x, j) => ((x ?? sc[j].med) - sc[j].mu) / sc[j].sd);

// the league's minutes curve by rating (K.roles.curve, log minutes)
const curve = (K, x) => { const c = K.roles.curve; if (x <= c[0][0]) return c[0][1]; for (let i = 1; i < c.length; i++) if (x <= c[i][0]) return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * (x - c[i - 1][0]) / (c[i][0] - c[i - 1][0]); return c.at(-1)[1]; };

// The roles of club ab's men for season s, any not yet set (kept on each: p.alpha). A man back from a
// season in the panel's sense (10+ nights) grows from it (dev); a rookie goes by draft slot, anyone
// else by his rating. Surprises are real ones: the returning men, ranked by their predicted roles,
// take a whole real club-season's by rank (dev.blocks: a leader's barely moves, and a reserve's rise
// comes out of the others'); rookies and new men each take one of their own equation's. Each is
// hashed on the club, man and season, so a role does not depend on when it is asked for.
const pick = (a, key) => a[Math.min(Math.floor(Phi(hashNoise(key)) * a.length), a.length - 1)];
export function roles(K, ps, s, ab) {
  const M = K.minutes, D = M.dev, need = ps.filter((p) => p.alpha?.s !== s);
  if (!need.length) return;
  const pre = need.map((p) => {
    const a0 = p.alphaReal?.[s - 1], l0 = p.log?.findLast((l) => l.s === s - 1 && l.gp > 0);
    if (a0 != null && l0) { const [c, r, br, ba, bm, bah, brh] = D.b, rt = l0.rate ?? p.rate;
      return { p, k: 'dev', v: c + r * a0 + br * rt + ba * (p.age - D.age.mean) / D.age.sd + bm * +(l0.tm !== ab) + bah * Math.max(a0 - D.knot_a0, 0) + brh * Math.max(rt - D.knot_rate, 0) }; }
    if ((p.yos ?? 1) === 0) return { p, k: 'rookie', v: M.rookie.b[0] + M.rookie.b[1] * Math.log(p.draft?.pick || 61) };
    return { p, k: 'new', v: M.new.b[0] + M.new.b[1] * p.rate };
  });
  const blk = pick(D.blocks, `block|${ab}|${s}`);
  pre.filter((x) => x.k === 'dev').sort((x, y) => y.v - x.v).forEach((x, i) => { x.u = blk[Math.min(i, blk.length - 1)]; });
  for (const x of pre) x.p.alpha = { s, v: x.v + (x.k === 'dev' ? x.u : pick(M[x.k].resid, `alpha|${x.p.id}|${s}`)) };
}
// A club's state for one man this season: the run of games he has just missed and the games since
// a long absence ended (minutes_mle.build), and his realised role so far (sum, nights). Keyed by
// man and club, as a man traded starts his runs afresh.
export const blank = () => ({ outrun: 0, since: 0 });
const nightTerms = (M, s) => ({ ret: +(s.since > 0), ret_prog: s.since > 0 ? 1 - (s.since - 1) / M.ramp : 0, outrun_c: Math.min(s.outrun, 40) / 10 });

// the men of a club with their role and lean, for night() and expected(): T.pull and T.tank (set by
// league.js rotation) are the coach's pull and whether the club is rebuilding
export function club(ctx, ab, T, ps, st) {
  const K = ctx.K, M = K.minutes;
  roles(K, ps, ctx.season, ab);
  const men = ps.map((p) => ({ p, s: (st[`${p.id}|${ab}`] ||= blank()), a: p.alpha.v, lean: 0 }));
  if (T.pull || T.tank) {
    const E = expected(M, men);
    // the best rotation: the club's own minutes, the biggest to the most talented
    const desc = E.map((e) => e.m).sort((a, b) => b - a), byT = men.map((x, i) => i).sort((i, j) => (men[j].p.talent ?? men[j].p.rate) - (men[i].p.talent ?? men[i].p.rate)), best = [];
    byT.forEach((i, k) => { best[i] = desc[k]; });
    men.forEach((x, i) => { x.lean = (T.pull || 0) * (Math.log(Math.max(best[i], 1)) - Math.log(Math.max(E[i].m, 1)))
      + (T.tank ? curve(K, x.p.rate + (K.tankYouth || 0) * Math.max(26 - x.p.age, 0)) - curve(K, x.p.rate) : 0); });
  }
  return men;
}
// shares onto the simplex with none past cap: cap the offenders, hand their excess to the rest in
// proportion, repeat (minutes_mle.capped)
export function capped(e, cap) {
  const t = fold(e); let w = e.map((x) => x / (t || 1));
  for (let it = 0; it < 8; it++) {
    const exc = fold(w.map((x) => Math.max(x - cap, 0))); if (exc <= 1e-12) break;
    const free = fold(w.map((x) => (x > cap ? 0 : x)));
    w = w.map((x) => (x > cap ? cap : x + (free > 0 ? x * exc / free : 0)));
  }
  return w;
}
// a table [[x, y], ...] read at x, flat past its ends
const interp = (t, x) => { if (x <= t[0][0]) return t[0][1]; for (let i = 1; i < t.length; i++) if (x <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); return t.at(-1)[1]; };
// the night's swing in his log share, by his role (M.share.sd_by_alpha: a reserve's swings far wider)
const sdAt = (M, a) => interp(M.share.sd_by_alpha, a);
const dot = (cols, coef, f) => cols.reduce((a, c, i) => a + coef[i] * (c === 'const' ? 1 : f[c] ?? 0), 0);

// One night for a club. hurt(p): whether he cannot go. Returns minutes per man (0 if he did not play)
// and the night's expected minutes among those who did (for the club's strength, which the night's
// swings do not set). ar: realised roles by man, { id: [sum, nights] }.
// the night's terms for the men who can go: z (whether he plays) and xb (his share's level)
function rowsFor(M, men, hurt, sc) {
  const avail = men.filter((x) => !hurt(x.p)), out = men.filter((x) => hurt(x.p));
  // the absent men's shares: what each would get with the club whole
  const E = expected(M, men), sh = new Map(men.map((x, i) => [x.p.id, E[i].m / 240]));
  const O = out.map((x) => [chars(x.p, sc), sh.get(x.p.id)]), hole = fold(out.map((x) => sh.get(x.p.id)));
  const crowd = Math.max(avail.length - (M.active_default || 15), 0), w = M.metric.w;
  const rows = avail.map((x) => {
    const ci = O.length ? chars(x.p, sc) : null;
    const simout = O.length ? fold(O.map(([ck, sk]) => sk * Math.exp(-Math.sqrt(ci.reduce((d, v, j) => d + (w[j] * (v - ck[j])) ** 2, 0) + 1e-12)))) : 0;
    const f = { ...nightTerms(M, x.s), simout, hole, crowd, alpha: x.a + x.lean };
    return { x, f, z: dot(M.play.cols, M.play.c, f), xb: x.a + x.lean + dot(M.share.cols, M.share.b, f) };
  });
  return rows;
}
const mean = (M, q) => Math.exp(q.xb + sdAt(M, q.f.alpha) ** 2 / 2);     // a night's share is log-normal about xb
// How many the coach plays is his choice for the club (M.size, _gm_rotation_size.py): drawn from the real
// nights with as many men available (the table's nearest row past its ends), and they are the men highest
// on z plus each one's own N(0, 1), the probit's latent -- the fit's order of who plays, at a real count.
// A projection takes each man's chance as Phi(z - t), t such that the chances add up to the count's mean.
const sizeRow = (M, n) => Math.min(Math.max(n - M.size.n[0], 0), M.size.n.length - 1);
function chances(M, z) {
  const k = Math.min(M.size.mean[sizeRow(M, z.length)], z.length), sum = (t) => fold(z.map((x) => Phi(x - t)));
  let lo = -20, hi = 20;
  for (let i = 0; i < 50; i++) { const t = (lo + hi) / 2; (sum(t) > k ? (lo = t) : (hi = t)); }
  return z.map((x) => Phi(x - (lo + hi) / 2));
}
export function night(M, men, hurt, sc, r, ar) {
  const rows = rowsFor(M, men, hurt, sc);
  // who gets on the floor: the coach's count, the men highest on their latent
  const u = r(), k = Math.min(M.size.k0 + M.size.cum[sizeRow(M, rows.length)].findIndex((c) => u <= c), rows.length), lat = rows.map((q) => q.z + r.normal());
  const idx = rows.map((q, i) => i).sort((a, b) => lat[b] - lat[a]).slice(0, k).sort((a, b) => a - b);
  const ex = capped(idx.map((i) => mean(M, rows[i])), M.cap), re = capped(idx.map((i) => Math.exp(rows[i].xb + sdAt(M, rows[i].f.alpha) * r.normal())), M.cap);
  const m = new Map(men.map((x) => [x.p.id, 0])), e = new Map();
  idx.forEach((i, k) => { m.set(rows[i].x.p.id, 240 * re[k]); e.set(rows[i].x.p.id, 240 * ex[k]); });
  // the realised role: his log share against the night's (net of each man's role and night terms),
  // less his own night terms -- the fit's player-season effect, a night at a time
  if (ar && idx.length) {
    const y = idx.map((i, k) => Math.log(re[k])), bx = idx.map((i) => rows[i].xb - rows[i].x.a - rows[i].x.lean);
    const nt = fold(idx.map((i, k) => y[k] - rows[i].x.a - rows[i].x.lean - bx[k])) / idx.length;
    idx.forEach((i, k) => { const q = (ar[rows[i].x.p.id] ||= [0, 0]); q[0] += y[k] - nt - bx[k]; q[1] += 1; });
  }
  return { m, e };
}
// Expected minutes a club game over its nights, for projections: n nights each man is out with his
// health's chance (av) (hashed, so a projection is stable), each as night() would split it on
// average -- the absent men's minutes to those like them, the hole and the crowd in who plays.
export function project(M, men, sc, n = 32) {
  const tot = new Map(men.map((x) => [x.p.id, 0]));
  for (let k = 0; k < n; k++) {
    const out = new Set(men.filter((x) => Phi(hashNoise(`proj|${x.p.id}|${k}`)) > (x.p.av ?? 0.9)).map((x) => x.p.id)), rows = rowsFor(M, men, (p) => out.has(p.id), sc);
    const c = chances(M, rows.map((q) => q.z)), w = capped(rows.map((q, i) => c[i] * mean(M, q)), M.cap);
    rows.forEach((q, i) => tot.set(q.x.p.id, tot.get(q.x.p.id) + 240 * w[i] / n));
  }
  return tot;
}
// after the night: the runs of games missed and since a long absence
export function record(M, men, m) {
  for (const { s, p } of men) {
    const v = m.get(p.id) || 0;
    if (s.since > 0) s.since = s.since + 1 < M.ramp ? s.since + 1 : 0;
    if (v > 0) { if (s.outrun >= M.long_out) s.since = 1; s.outrun = 0; } else s.outrun += 1;
  }
}
// Expected minutes a game for a healthy roster: each man's chance of getting on the floor times his
// share's mean, onto the capped simplex (as the Trade Lab applies minutes_mle). Returns [{ p, m }].
export function expected(M, men) {
  const crowd = Math.max(men.length - (M.active_default || 15), 0);
  // a night's share is log-normal about his role, so its mean carries half its variance: far more
  // for a reserve, whose nights swing, than a star (exp(sd^2 / 2): +38% against +4%)
  const c = chances(M, men.map((x) => dot(M.play.cols, M.play.c, { alpha: x.a + x.lean, crowd })));
  const e = men.map((x, i) => { const a = x.a + x.lean; return c[i] * Math.exp(a + sdAt(M, a) ** 2 / 2); });
  const w = capped(e, M.cap);
  return men.map((x, i) => ({ p: x.p, m: 240 * w[i] }));
}
