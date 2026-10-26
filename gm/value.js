// What a player is worth, on the site's own scale: projected wins above replacement priced on
// the fitted market curve (11_trade_tool.py: war = beta x minutes/48 x (rate - repl);
// price = (a + b w + c w^2) x cap), so the game's market agrees with the Value Board.
import { agingStep } from './dev.js';
import { minSalary, maxSalary } from './cba.js';

// minutes per team game a man of this rating gets (the league's own curve, 12_gm_data.py)
export function mpgFor(rate, K) {
  const c = K.mpgCurve;
  if (rate <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++)
    if (rate <= c[i][0]) return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * (rate - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
  return c[c.length - 1][1];
}
export const projRate = (p, h, K) => { let r = p.rate; for (let j = 0; j < h; j++) r += agingStep(K, p.age + j); return r; };
// season WAR h seasons ahead; minutes from his own history this year, the curve after that
export const war = (p, h, K) => warAt(p, projRate(p, h, K), h, K);
const warAt = (p, r, h, K) => K.beta * 82 * (h === 0 && p.mpg ? p.mpg : mpgFor(r, K) * (p.av ?? 0.9)) / 48 * (r - K.repl);
export const price = (w, cap, K) => Math.max(K.price.a + K.price.b * w + K.price.c * w * w, 0) * cap;
// A recent draftee whose range the draft model draws wider than most (p.dsd, 12_gm_data.py) is worth
// more than his median path, as the price is convex and a star's season pays more than a bust's
// costs: his value adds what his own spread is worth over the league's usual one, each priced as
// the average over the game's development spread h seasons out (Gauss-Hermite, five nodes).
// Everyone else is priced on the median, as the curve was fitted.
const GH = [[0, 0.53333], [1.35563, 0.22208], [-1.35563, 0.22208], [2.85697, 0.01126], [-2.85697, 0.01126]];
export const devSd = (K, h) => { const { walk, trend, rho } = K.dev; let v = 0; for (let i = 0; i < h; i++) for (let j = 0; j < h; j++) v += rho ** Math.abs(i - j); return Math.sqrt(walk * walk * h + trend * trend * v); };
export function marketValue(p, h, cap, K) {
  const r = projRate(p, h, K), v = price(warAt(p, r, h, K), cap, K);
  if (!p.dsd || !h) return v;
  const E = (sd) => GH.reduce((a, [z, w]) => a + w * price(warAt(p, r + sd * z, h, K), cap, K), 0);
  return v + E(p.dsd * devSd(K, h)) - E(devSd(K, h));
}

// How uncertain a man's rating is for the season h ahead, in rating points: his rating's own standard
// error and the development the game's spread gives that far out (a recent draftee's own wider, p.dsd)
export const uncertainty = (p, h, K) => Math.sqrt((p.se ?? 1) ** 2 + (devSd(K, h) * (p.dsd ?? 1)) ** 2);

// The computer GMs' discount: a season ahead is worth 1/DISC of one now -- the 15.9% chance a season
// that the GM is gone before it comes (lead executives changed after 100 of 630 club seasons, 2005-06
// on, data/_gm_tenure.json), what comes after counting AFTER (half) as much to him as before, since
// what he leaves behind follows him to his next job; less the cap's growth (K.capGrowth): every value
// is priced at its own season's cap, so a growing cap already makes later seasons bigger, and owners'
// money costs them next to nothing against what their clubs gain in worth. Set when a league is made
// or loaded.
export const EXIT = 0.159, AFTER = 0.5;
export let DISC;
export const setDisc = (K) => { DISC = 1 + (1 - AFTER) * EXIT - K.capGrowth.mean; };

// The surplus of a contract to whoever holds it: market value less salary, each future
// season at that season's projected cap, discounted.
export function surplus(p, capOf, K, disc = 0.1) {
  return (p.contract?.years || []).reduce((a, y, i) => a + (marketValue(p, i, capOf(y.s), K) - y.sal) / (1 + disc) ** i, 0);
}

// What a man asks (K.pay, _gm_pay.py, fit on every real new deal 2015-24 and extension 2015-25; ext = 1
// for an extension): the max with
// P(max | rating, minutes, age), else a share of the cap from his rating, last season's minutes per
// game played and games, age and whether he is coming off his first contract -- never under his
// minimum. `u` is his draw, fixed for the summer, that decides whether he is a max man; the term is
// by age. A man with no NBA season yet is taken at the minutes his rating usually earns.
export function ask(p, f, K, u = 0.5, ext = 0) {
  const l = p.log?.findLast((x) => x.gp > 0), mpg = l ? l.mpg : mpgFor(p.rate, K) / (p.av ?? 0.9), gp = l ? l.gp : 82 * (p.av ?? 0.9);
  const x = { const: 1, rating: p.rate, rating_pos2: Math.max(p.rate, 0) ** 2, log_mpg: Math.log(Math.max(mpg, 1)), gp_82: gp / 82,
    age_28: p.age - 28, age_over_32: Math.max(p.age - 32, 0), first: p.yos <= 4 ? 1 : 0, ext };
  const lin = (c) => Object.entries(c).reduce((a, [k, v]) => a + v * x[k], 0);
  const mx = maxSalary(p.yos, f, p.prior * 1e6 || 0), pMax = 1 / (1 + Math.exp(-lin(K.pay.maxdeal)));
  const sal = u < pMax ? mx : Math.min(Math.max(lin(K.pay.nonmax) * f.cap, minSalary(p.yos, f.cap)), mx);
  const years = p.age <= 27 ? 4 : p.age <= 30 ? 3 : p.age <= 32 ? 2 : 1;
  return { sal: Math.round(sal), years, max: u < pMax };
}

// P(re-signs with the club holding him), the site's fitted model (_resign_model.py)
export function pResign(p, K) {
  // logit P = a + war w + sqrt_war sqrt(max(w,0)) + age_28 (age-28) + age_over_32 max(age-32,0)
  //           + first (1 + first_sqrt_war sqrt(max(w,0))), first = 1 at the end of a first contract
  const c = K.resign, w = war(p, 0, K), sw = Math.sqrt(Math.max(w, 0)), first = p.yos <= 4 ? 1 : 0;
  const z = c.a + c.war * w + c.sqrt_war * sw + c.age_28 * (p.age - 28) + c.age_over_32 * Math.max(p.age - 32, 0)
    + first * (c.first + c.first_sqrt_war * sw);
  return 1 / (1 + Math.exp(-z));
}

// The board's contract model (K.boardMkt, the Trade Lab's resignChain): at a deal's end, the chance
// his club keeps him (first: coming off his first contract), and the deal he signs -- the max for his
// service (mx) with chance pmax, else the share of the cap men like him re-sign for (nm)
const lg = (z) => 1 / (1 + Math.exp(-z)), sw = (w) => Math.sqrt(Math.max(w, 0));
export function keepP(K, first, w, age) {
  const c = first ? K.boardMkt.first : K.boardMkt.later;
  return lg(first ? c.a + c.war * w + c.sqrt_war * sw(w) + c.age_25 * (age - 25) : c.a + c.war * w + c.sqrt_war * sw(w) + c.age_28 * (age - 28) + c.age_over_32 * Math.max(age - 32, 0));
}
export function redeal(K, first, w, svc, age) {
  const B = K.boardMkt, mx = Math.max(...Object.entries(B.max_pct).filter(([y]) => svc >= +y).map(([, v]) => v)) / 100;
  const z = (c) => c.a + c.war * w + c.sqrt_war * sw(w) + c.first * first + c.age_28 * (age - 28) + c.age_over_32 * Math.max(age - 32, 0);
  return { mx, pmax: lg(z(B.max_deal)), nm: Math.min(Math.max(z(B.nonmax), B.nonmax.min_share), mx) };
}
