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
export function war(p, h, K) {
  const r = projRate(p, h, K), mpg = h === 0 && p.mpg ? p.mpg : mpgFor(r, K) * (p.av ?? 0.9);
  return K.beta * 82 * mpg / 48 * (r - K.repl);
}
export const price = (w, cap, K) => Math.max(K.price.a + K.price.b * w + K.price.c * w * w, 0) * cap;
export const marketValue = (p, h, cap, K) => price(war(p, h, K), cap, K);

// The surplus of a contract to whoever holds it: market value less salary, each future
// season at that season's projected cap, discounted.
export function surplus(p, capOf, K, disc = 0.1) {
  return (p.contract?.years || []).reduce((a, y, i) => a + (marketValue(p, i, capOf(y.s), K) - y.sal) / (1 + disc) ** i, 0);
}

// What a free agent asks: the Trade Lab's deal rule (trade_tool_template.html pMax/nmShare, fit on
// real re-signings in _retention_draft.py) -- the max with P(max | WAR, age, first contract), else
// the share of the cap players like him signed for. `u` is his draw, fixed for the summer, that
// decides whether he is a max man; the term is by age.
export function ask(p, f, K, u = 0.5) {
  const w = war(p, 0, K), first = p.yos <= 4, sw = Math.sqrt(Math.max(w, 0));
  const lin = (c) => c.a + c.war * w + c.sqrt_war * sw + c.first * (first ? 1 : 0) + (c.age_28 || 0) * (p.age - 28) + (c.age_over_32 || 0) * Math.max(p.age - 32, 0);
  const mx = maxSalary(p.yos, f, p.prior * 1e6 || 0), pMax = 1 / (1 + Math.exp(-lin(K.maxdeal)));
  const share = Math.min(Math.max(lin(K.nonmax), K.nonmax.min_share), mx / f.cap);
  const sal = u < pMax ? mx : Math.max(share * f.cap, minSalary(p.yos, f.cap));
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
