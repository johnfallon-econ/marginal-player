import * as Pk from './picks.js';
// The 2023 NBA CBA as code, for the GM simulator. Pure functions, dollars as integers.
//
// Every amount is DERIVED from the season's cap by the CBA's own formula (Art. VII §2, §5,
// §6; Art. II §7), so a dynasty in 2034 runs on the same rules as 2026-27. The derivations
// are checked against the league's published 2026-27 figures in cba.test.mjs, and
// published figures win where they exist (OFFICIAL). Sources and the article for each rule:
// CBA_REFERENCE.md beside this file.

export const CAP_2023 = 136_021_000;             // index denominator: "x cap / 2023-24 cap"
const APRON1_2023 = 172_346_000, APRON2_2023 = 182_794_000;

// NBA PR, June 30 2026 (CBA_REFERENCE §1-2). Everything else for 2026-27 is formula.
const OFFICIAL = {
  2026: { cap: 164_961_000, tax: 200_428_000, apron1: 209_015_000, apron2: 221_686_000,
          minTeam: 148_465_000, ntmle: 15_044_000, tpmle: 6_064_000, roomMle: 9_366_000 },
};
const k = (x) => Math.round(x / 1000) * 1000;    // the league publishes to the thousand

export function figures(season, cap) {
  const o = OFFICIAL[season] || {};
  cap = o.cap ?? cap;
  const ix = cap / CAP_2023;
  return {
    season, cap,
    tax: o.tax ?? k(0.215 * cap + cap),          // 121.5% of cap (§2(a)(4)(ii))
    apron1: o.apron1 ?? k(APRON1_2023 * ix),
    // the published 2026-27 figure is the first apron plus the indexed 2023-24 gap, each
    // rounded: indexing the second apron directly lands $1,000 short of it
    apron2: o.apron2 ?? k(APRON1_2023 * ix) + k((APRON2_2023 - APRON1_2023) * ix),
    minTeam: o.minTeam ?? k(0.9 * cap),
    ntmle: o.ntmle ?? k(0.0912 * cap),
    tpmle: o.tpmle ?? k(5_000_000 * ix),
    roomMle: o.roomMle ?? k(0.05678 * cap),
    bae: k(0.0332 * cap),
    max: [0.25, 0.30, 0.35].map((p) => Math.round(p * cap)),
    bracket: k(5_000_000 * ix),                  // tax bracket width (§2(d)(1)(ii))
    tpeIndexed: k(7_500_000 * ix),               // the indexed middle tier of the expanded TPE
    cash: k(0.0515 * cap),              // per direction, per season (§8(a))
    stretchCap: Math.round(0.15 * cap),
  };
}

// Minimum scale, 2026-27, by years of service 0..10+ (CBA_REFERENCE §5). Later seasons:
// indexed to cap growth, the CBA's own rule (Art. I §1(jj)).
const MIN_2026 = [1_357_763, 2_185_116, 2_449_421, 2_537_526, 2_625_627, 2_845_883,
                  3_066_143, 3_286_399, 3_506_659, 3_524_115, 3_876_529];
export const minSalary = (yos, cap) => Math.round(MIN_2026[Math.min(yos, 10)] * cap / OFFICIAL[2026].cap);
export const twoWaySalary = (cap) => Math.round(minSalary(0, cap) / 2);
// One-year minimum deals for 3+ YOS count at the 2-YOS minimum (Art. VII §4(d)(4)).
export const vetMinCharge = (yos, cap) => (yos >= 3 ? minSalary(2, cap) : minSalary(yos, cap));

// Rookie scale, 2026 draft, at 120% of scale: the published table (CBA_REFERENCE §6, HRrook),
// years 1-4 by pick. The year-to-year steps are not a constant ratio, so the table is kept
// whole and later classes are indexed to the cap (Art. I §1(iii)).
const RS120 = [[
  14_748_000, 13_195_320, 11_849_760, 10_683_720, 9_674_760, 8_787_000, 8_021_640, 7_348_680, 6_754_800, 6_417_360, 6_096_240, 5_791_680, 5_502_000, 5_227_200, 4_965_480, 4_717_320, 4_481_280, 4_257_480, 4_065_720, 3_902_760, 3_746_760, 3_597_120, 3_453_360, 3_315_360, 3_182_280, 3_076_920, 2_988_120, 2_969_520, 2_948_280, 2_926_800],
  [
  15_485_760, 13_855_320, 12_441_840, 11_217_960, 10_158_240, 9_226_440, 8_422_920, 7_716_120, 7_093_080, 6_738_000, 6_401_280, 6_081_480, 5_777_280, 5_488_560, 5_213_760, 4_953_240, 4_705_440, 4_470_000, 4_268_880, 4_097_880, 3_934_320, 3_776_760, 3_626_160, 3_481_080, 3_341_280, 3_230_520, 3_137_640, 3_118_560, 3_095_640, 3_073_080],
  [
  16_223_040, 14_515_320, 13_034_880, 11_752_320, 10_641_960, 9_666_000, 8_823_600, 8_083_680, 7_430_640, 7_058_520, 6_706_200, 6_371_160, 6_052_200, 5_750_160, 5_461_920, 5_189_400, 4_929_360, 4_683_120, 4_472_640, 4_292_880, 4_121_760, 3_956_760, 3_798_360, 3_646_800, 3_500_880, 3_384_480, 3_287_400, 3_266_880, 3_243_120, 3_219_840],
  [
  20_457_253, 18_318_334, 16_476_088, 14_866_685, 13_483_363, 12_256_488, 11_205_972, 10_282_441, 9_466_635, 8_999_613, 8_899_127, 8_779_458, 8_648_594, 8_515_987, 8_373_123, 7_960_540, 7_571_497, 7_202_639, 6_887_866, 6_619_621, 6_565_964, 6_508_870, 6_445_817, 6_378_253, 6_305_085, 6_102_217, 5_930_470, 5_896_718, 5_853_832, 5_811_811]];
// Exhibit B: QO percentage over year 4, by pick.
const RS_QO = [40.0, 40.5, 41.2, 41.9, 42.6, 43.4, 44.1, 44.8, 45.5, 46.2, 46.9, 47.6, 48.3, 49.1,
  49.8, 50.5, 51.2, 51.9, 52.6, 53.3, 54.1, 54.8, 55.5, 56.2, 56.9, 57.6, 58.3, 59.0, 60.0, 60.0];

// The four scale salaries for `pick` in a class drafted into a season with cap `cap`, at
// `pct` of scale (120% is what nearly every first-rounder signs for).
export const rookieScale = (pick, cap, pct = 1.2) =>
  RS120.map((y) => Math.round(y[pick - 1] * cap / OFFICIAL[2026].cap * pct / 1.2));
// Qualifying offer for a rookie-scale first-rounder (Art. XI §4), from his own class's scale.
export function rookieQO(pick, classCap, starter) {
  const qo = (p, pct) => Math.round(rookieScale(p, classCap, pct)[3] * (1 + RS_QO[p - 1] / 100));
  if (starter && pick >= 10) return Math.max(qo(pick, 1.2), qo(9, 1.2));
  if (!starter && pick <= 14) return Math.min(qo(pick, 1.2), qo(15, 1.2));
  return qo(pick, 1.2);
}
// Every other RFA: 135% of prior salary or minimum + $200K, whichever is larger.
export const otherQO = (prior, yos, cap) => Math.max(Math.round(prior * 1.35), minSalary(yos, cap) + 200_000);

// Maximum first-year salary by years of service (Art. II §7(a)), never below 105% of prior.
export function maxSalary(yos, f, prior = 0, supermax = false) {
  const m = supermax ? f.max[2] : f.max[yos >= 10 ? 2 : yos >= 7 ? 1 : 0];
  return Math.max(m, Math.round(prior * 1.05));
}

// Luxury tax (Art. VII §2(d)), rates from 2025-26 on: $1.00/1.25/3.50/4.75 then +0.50 a
// bracket; repeaters +$2.00 on every bracket.
export function taxBill(taxSalary, f, repeater = false) {
  let over = taxSalary - f.tax, bill = 0, i = 0;
  while (over > 0) {
    const rate = [1, 1.25, 3.5, 4.75][i] ?? 4.75 + 0.5 * (i - 3);
    bill += Math.min(over, f.bracket) * (rate + (repeater ? 2 : 0));
    over -= f.bracket; i++;
  }
  return Math.round(bill);
}
// Half the tax a season brings in goes in equal shares to the clubs that paid none (Art. VII
// §2(d)): a club's share in season s, by what season s-1 brought in.
export function taxShare(league, s) {
  const ts = Object.values(league.teams);
  return 0.5 * ts.reduce((a, T) => a + (T.tax?.[s - 1] || 0), 0) / ts.filter((T) => !T.taxpaid?.[s - 1]).length;
}
// What d more salary on a payroll of pay costs club T in season s: the tax it adds (a repeater's
// if it paid in three of the four seasons before) and the share it gives up by crossing the line.
export function taxCost(T, pay, d, f, s, share) {
  const rep = [1, 2, 3, 4].filter((k) => T.taxpaid?.[s - k]).length >= 3;
  return taxBill(pay + d, f, rep) - taxBill(pay, f, rep) + share * ((pay + d > f.tax) - (pay > f.tax));
}

// ---- dates ------------------------------------------------------------------------------
// Season `s` runs from July 1 of year s. Key dates follow the CBA's fixed rules and the
// league's usual calendar (CBA_REFERENCE §10); the deadline is the Thursday of Feb 6-12.
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const _dates = new Map(), _months = new Map();         // memoized: trade searches ask millions of times
export function seasonDates(s) {
  if (_dates.has(s)) return _dates.get(s);
  const thursday = [...Array(7)].map((_, i) => 6 + i).find((d) => new Date(Date.UTC(s + 1, 1, d)).getUTCDay() === 4);
  const tuesday = [...Array(7)].map((_, i) => 18 + i).find((d) => new Date(Date.UTC(s, 9, d)).getUTCDay() === 2);
  const out = { start: iso(s, 7, 1), moratoriumEnd: iso(s, 7, 6), opening: iso(s, 10, tuesday), dec15: iso(s, 12, 15),
           jan8: iso(s + 1, 1, 8), jan10: iso(s + 1, 1, 10), jan15: iso(s + 1, 1, 15),
           deadline: iso(s + 1, 2, thursday), mar1: iso(s + 1, 3, 1), mar4: iso(s + 1, 3, 4),
           seasonEnd: iso(s + 1, 4, 11), draft: iso(s + 1, 6, 24), end: iso(s + 1, 6, 30) };
  _dates.set(s, out);
  return out;
}
export const seasonOf = (date) => +date.slice(0, 4) - (+date.slice(5, 7) < 7);
const addMonths = (date, n) => {
  const k = date + n;
  if (!_months.has(k)) { const d = new Date(date + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); _months.set(k, d.toISOString().slice(0, 10)); }
  return _months.get(k);
};
const later = (a, b) => (a > b ? a : b);

// ---- contracts ----------------------------------------------------------------------------
// A contract: { years: [{ s, sal, gtd, opt }], signed, how, oneYearMin, rookie, twoWay, raise120 }
//   s: season; sal: salary; gtd: guaranteed part; opt: null | 'tm' | 'pl'
//   how: 'room' | 'bird' | 'earlyBird' | 'nonBird' | 'ntmle' | 'tpmle' | 'roomMle' | 'bae'
//        | 'min' | 'rookie' | 'second' | 'twoWay' | 'ext' | 'ext_dv' | 'ext_big' | 'claim' | 'trade'
export const yearOf = (c, s) => c?.years.find((y) => y.s === s);

// What a contract counts for cap, tax and apron in season s (two-ways count for none).
export function charge(p, s, cap) {
  const y = yearOf(p.contract, s);
  if (!y || p.contract.twoWay) return 0;
  return p.contract.oneYearMin ? Math.min(y.sal, vetMinCharge(p.yos, cap)) : y.sal;
}

// Salary that counts as OUTGOING in a trade on `date` (Art. VII §6(j)(5)-(6)).
export function outgoingSalary(p, date) {
  const s = seasonOf(date), d = seasonDates(s), y = yearOf(p.contract, s);
  if (!y) return 0;
  const sal = y.sal;
  if (date > d.seasonEnd) {                            // after the season: lesser of now and next
    const nx = yearOf(p.contract, s + 1);
    return Math.min(sal, nx ? nx.gtd : 0);
  }
  return date >= d.jan8 ? sal : Math.min(sal, y.gtd);
}

// Bird level with the team he played for: seasons under contract without changing teams as
// a free agent (trades keep the count; a waiver claim counts only in the first of three).
export const birdLevel = (p, team) =>
  p.bird?.team !== team ? 'none' : p.bird.n >= 3 ? 'full' : p.bird.n >= 2 ? 'early' : 'non';

// Cap hold for a free agent his prior team still holds (Art. VII §4(d)-(e)).
export function capHold(p, prior, avgSal, f) {
  const lvl = birdLevel(p, p.bird?.team), minFloor = minSalary(Math.min(p.yos, 2), f.cap);
  let h;
  if (prior <= minSalary(p.yos, f.cap)) h = minFloor;
  else if (lvl === 'full') {
    const offRookie = !!p.contract?.rookie;
    h = prior * (offRookie ? (prior >= avgSal ? 2.5 : 3.0) : prior >= avgSal ? 1.5 : 1.9);
  } else h = prior * (lvl === 'early' ? 1.3 : 1.2);
  return Math.round(Math.max(minFloor, Math.min(h, maxSalary(p.yos, f, prior))));
}

// ---- team salary --------------------------------------------------------------------------
// team: { abbr, roster: [pid], dead: [{ s, amt }], holds: [{ pid, amt }], hardCap, tpes: [...] }
// The apron/tax figure has no cap holds; the cap figure adds them and, July 1 to opening
// night, a minimum-salary charge for each roster spot below 12 (§4(f)).
export function teamSalary(team, league, s, { holds = false, offseason = false } = {}) {
  const cap = league.f[s].cap, P = league.players;
  const std = team.roster.filter((id) => !P[id].contract?.twoWay);
  let t = std.reduce((a, id) => a + charge(P[id], s, cap), 0);
  t += team.dead.filter((x) => x.s === s).reduce((a, x) => a + x.amt, 0);
  if (holds) {
    t += team.holds.reduce((a, h) => a + h.amt, 0);
    if (offseason) t += Math.max(0, 12 - std.length - team.holds.length) * minSalary(0, cap);
  }
  return t;
}

// ---- trades -------------------------------------------------------------------------------
// When a player may next be traded (Art. VII §8(d), §8(f)).
export function tradableFrom(p) {
  const c = p.contract;
  if (!c?.signed) return null;
  const d = seasonDates(seasonOf(c.signed));
  switch (c.how) {
    case 'rookie': case 'second': case 'twoWay': return addMonths(c.signed, 1);
    case 'ext_dv': return addMonths(c.signed, 12);
    case 'ext_big': return addMonths(c.signed, 6);
    case 'ext': case 'trade': case 'sat': return null;
    case 'bird': if (c.raise120) return later(addMonths(c.signed, 3), d.jan15);
    // falls through: any other free-agent signing
    default: return later(addMonths(c.signed, 3), d.dec15);
  }
}

// The salary a team may take back for `out` sent, by where its apron salary lands (§6(j)).
export function maxIncoming(out, nOut, post, f) {
  if (post > f.apron1) return { amt: out, rule: 'match100' };                  // $250K gone (§6(j)(3))
  const std = out + 250_000;
  if (nOut === 0) return { amt: 0, rule: 'none' };
  const exp = Math.max(Math.min(2 * out + 250_000, out + f.tpeIndexed), 1.25 * out + 250_000);
  return exp > std ? { amt: exp, rule: 'expanded' } : { amt: std, rule: 'standard' };
}

// trade: { date, moves: [{ pid, from, to }], picks: [{ id, from, to, prot? }], swaps: [{ y, r, from, to }], cash: [{ from, to, amt }],
//          tpe: { [team]: [{ pid, tpeIndex }] } }   -- absorb an incoming player into a TPE
// league: the game, its picks the assets in play (picks.js assets) and its ledger the pick ledger.
// Returns { ok, errors: [...], hardCaps: { team: 'apron1'|'apron2' }, newTpes: { team: [...] }, waive: { team: n } }
// (waive: men a club must let go to get back under the roster limit)
export function validateTrade(league, tr) {
  const s = seasonOf(tr.date), f = league.f[s], d = seasonDates(s), P = league.players;
  const errors = [], hardCaps = {}, newTpes = {}, waive = {};
  if (tr.date > d.deadline && tr.date <= d.end && !league.seasonOver)
    errors.push('the trade deadline has passed');
  const teams = [...new Set([...tr.moves.flatMap((m) => [m.from, m.to]),
    ...(tr.picks || []).flatMap((m) => [m.from, m.to]), ...(tr.swaps || []).flatMap((m) => [m.from, m.to]), ...(tr.cash || []).flatMap((m) => [m.from, m.to])])];
  for (const ab of teams) {
    const T = league.teams[ab], out = tr.moves.filter((m) => m.from === ab), inn = tr.moves.filter((m) => m.to === ab);
    for (const m of out) {
      if (!T.roster.includes(m.pid)) errors.push(`${ab} does not hold ${P[m.pid].nm}`);
      const t = tradableFrom(P[m.pid]);
      // before signing, draft rights trade freely
      if (t && tr.date < t && tr.date >= P[m.pid].contract.signed) errors.push(`${P[m.pid].nm} cannot be traded until ${t}`);
    }
    const absorbed = new Set((tr.tpe?.[ab] || []).map((x) => x.pid));
    const outSal = out.reduce((a, m) => a + outgoingSalary(P[m.pid], tr.date), 0);
    const inSal = inn.filter((m) => !absorbed.has(m.pid)).reduce((a, m) => a + charge(P[m.pid], s, f.cap), 0);
    const tpeIn = inn.filter((m) => absorbed.has(m.pid)).reduce((a, m) => a + charge(P[m.pid], s, f.cap), 0);
    const pre = teamSalary(T, league, s), post = pre - out.reduce((a, m) => a + charge(P[m.pid], s, f.cap), 0) + inSal + tpeIn;
    const capPost = teamSalary(T, league, s, { holds: true }) - (pre - post);
    const nOut = out.filter((m) => !P[m.pid].contract.twoWay).length;
    const cap = (lvl, why) => {                               // a transaction that hard-caps
      const lim = f[lvl];
      if (post > lim) errors.push(`${ab}: ${why} is barred above the ${lvl === 'apron1' ? 'first' : 'second'} apron`);
      else if (hardCaps[ab] !== 'apron1') hardCaps[ab] = lvl;
    };
    if (T.hardCap && post > f[T.hardCap]) errors.push(`${ab} is hard-capped at the ${T.hardCap === 'apron1' ? 'first' : 'second'} apron`);
    // TPE absorptions: one player per TPE, within its amount; a prior-season TPE hard-caps (row F)
    for (const x of tr.tpe?.[ab] || []) {
      const e = T.tpes[x.tpeIndex], sal = charge(P[x.pid], s, f.cap);
      if (!e || e.expires < tr.date) errors.push(`${ab} has no live trade exception #${x.tpeIndex}`);
      else if (sal > e.amt) errors.push(`${P[x.pid].nm}'s salary exceeds ${ab}'s trade exception`);
      else if (e.season < s) cap('apron1', 'using a prior-season trade exception');
    }
    if (inSal > outSal) {
      if (capPost <= f.cap + 250_000) { /* fits in cap room (§6(j)(1)(v)) */ }
      else {
        const m = maxIncoming(outSal, nOut, post, f);
        if (inSal > m.amt) errors.push(`${ab} takes back $${(inSal / 1e6).toFixed(2)}M for $${(outSal / 1e6).toFixed(2)}M out; at most $${(m.amt / 1e6).toFixed(2)}M allowed`);
        else if (m.rule === 'expanded' && inSal > outSal + 250_000) cap('apron1', 'expanded salary matching');
      }
    }
    // a sign-and-trade (§8(e)(1)): signed today for 3-4 seasons, before opening night; the club
    // taking him is hard-capped at the first apron (row C)
    for (const m of inn) {
      const c = P[m.pid].contract;
      if (c?.how !== 'sat' || c.signed !== tr.date) continue;
      if (tr.date >= d.opening && tr.date <= d.end) errors.push('sign-and-trades end at opening night');
      if (c.years.length < 3 || c.years.length > 4) errors.push('a sign-and-trade runs 3 or 4 seasons');
      cap('apron1', 'acquiring a player by sign-and-trade');
    }
    if (nOut >= 2 && inSal > 0) {
      if (post > f.apron2) errors.push(`${ab} cannot aggregate salaries above the second apron`);
      else cap('apron2', 'aggregating salaries');
    }
    // roster limits after the trade
    const roster = T.roster.filter((id) => !out.some((m) => m.pid === id)).concat(inn.map((m) => m.pid));
    const std = roster.filter((id) => !P[id].contract.twoWay).length, tw = roster.length - std;
    const inSeason = tr.date >= d.opening && tr.date <= d.seasonEnd;
    // over the limit is not a bar: the club waives men to get back under as the trade completes
    const over = inSeason ? std - 15 : roster.length - 21;
    if (over > 0) waive[ab] = over;
    if (tw > 3) errors.push(`${ab} would carry ${tw} two-way players (3 max)`);
    // a standard TPE: one player out, less back (§6(j)(1)(i)); never for a two-way
    if (nOut === 1 && inSal < outSal && capPost > f.cap)
      newTpes[ab] = [{ amt: outSal + 250_000 - inSal, season: s, expires: addMonths(tr.date, 12), from: out[0].pid }];
  }
  // cash: per-season limits each way; sending hard-caps at the second apron (row I)
  for (const c of tr.cash || []) {
    const A = league.teams[c.from], B = league.teams[c.to];
    if ((A.cashSent || 0) + c.amt > f.cash) errors.push(`${c.from} would exceed the $${(f.cash / 1e6).toFixed(3)}M cash limit`);
    if ((B.cashRecv || 0) + c.amt > f.cash) errors.push(`${c.to} would exceed the cash it may receive`);
    if (teamSalary(A, league, s) > f.apron2) errors.push(`${c.from} cannot send cash above the second apron`);
    else hardCaps[c.from] ||= 'apron2';
  }
  for (const pk of tr.picks || []) errors.push(...pickTradeErrors(league, pk, s));
  for (const sw of tr.swaps || []) errors.push(...swapErrors(league, sw, s));
  if ((tr.picks || []).length) for (const ab of teams) errors.push(...stepien(league, ab, tr, s));
  return { ok: errors.length === 0, errors, hardCaps, newTpes, waive };
}

// Picks: no further than seven drafts out; a second-apron team's frozen first stays put
// (Art. VII §2(f)). Draft year y is the draft held in June of season y-1. league.picks: the
// assets in play (picks.js assets); a pick may take a new protection from the top of its round,
// if it carries no terms already, and not top-12 to top-15 on a first (the 2027 lottery reform).
function pickTradeErrors(league, pk, s) {
  const p = league.picks[pk.id], e = [];
  if (!p) return [`unknown pick ${pk.id}`];
  const name = p.kind === 'claim' ? `the ${p.year} claim to ${p.terms[0]}` : `${p.year} ${p.origin} ${p.round === 1 ? '1st' : '2nd'}`;
  if (p.holder !== pk.from) e.push(`${pk.from} does not hold ${name}`);
  if (p.year > s + 1 + 7) e.push(`the ${p.year} draft is more than seven drafts out`);
  if (p.frozen) e.push(`${p.origin}'s ${p.year} first is frozen by the second apron`);
  if (pk.prot) {
    const [lo, hi] = pk.prot, top = 30 * (p.round - 1);
    if (p.kind !== 'pick' || p.prot || p.terms.length) e.push(`${name} already carries terms: it cannot take a new protection`);
    if (lo !== top + 1 || hi < lo || hi >= top + 30) e.push('a protection runs from the top of the round');
    if (p.round === 1 && hi >= 12 && hi <= 15) e.push('a traded first can no longer be protected top-12 to top-15');
  }
  return e;
}
// A swap right: `from` gives `to` the right to swap `to`'s pick for its own, both their own and
// carrying no terms, within seven drafts.
function swapErrors(league, sw, s) {
  const e = [], clean = (ab) => { const p = league.picks[`${ab}|${sw.y}|${sw.r}`]; return p && p.holder === ab && !p.prot && !p.terms.length; };
  if (sw.y > s + 1 + 7) e.push(`the ${sw.y} draft is more than seven drafts out`);
  for (const ab of [sw.from, sw.to]) if (!clean(ab)) e.push(`${ab} does not hold its own ${sw.y} ${sw.r === 1 ? '1st' : '2nd'} free of terms, so it cannot be in a new swap`);
  return e;
}
// Stepien rule: never without a first-round pick in two consecutive future drafts. A first counts
// when nothing can take it away (picks.js sureFirst: a protection or cascade can, a swap cannot).
// A trade is refused only for a gap it CREATES: real clubs start in tangles the rule allows.
function stepien(league, ab, tr, s) {
  const L0 = { teams: league.teams, picks: league.ledger, swaps: league.swaps || {} }, L1 = Pk.after(L0, tr);
  const y0 = Math.max(s + 1, (league.draft?.year || league.lastDraft || 0) + 1);
  const gaps = (L) => { const g = []; for (let y = y0; y < s + 1 + 7; y++) if (!Pk.sureFirst(L0, L.picks, L.swaps, ab, y) && !Pk.sureFirst(L0, L.picks, L.swaps, ab, y + 1)) g.push(y); return g; };
  const before = gaps(L0), y = gaps(L1).find((x) => !before.includes(x));
  return y ? [`${ab} would have no first-round pick in ${y} and ${y + 1} (Stepien rule)`] : [];
}

// ---- extensions (Art. VII §7; CBA_REFERENCE.md "Extensions") -------------------------------------
// Whether p's contract can be extended on `date`, and how far: maxNew seasons added, year one at most
// maxY1 (f: the figures of the first new season). A rookie-scale extension comes with one season
// left, between the end of the moratorium and the day before opening night, up to the max. A
// veteran's comes from the 2nd anniversary of a 3- or 4-season deal (3rd of a 5- or 6-), never for
// a 1- or 2-season deal, in season only with one season left; up to 5 seasons counting those
// left, year one at most 140% of his last salary or of the average salary.
export function extensionTerms(p, date, f) {
  const c = p.contract, s = seasonOf(date), d = seasonDates(s), errors = [];
  if (!c || c.twoWay) return { errors: ['no contract to extend'], maxNew: 0, maxY1: 0 };
  const left = c.years.filter((y) => y.s >= s), rookie = c.rookie && p.draft?.round === 1;
  let maxNew, maxY1;
  if (rookie) {
    if (left.length !== 1) errors.push('a rookie-scale extension comes with one season left on the deal');
    if (date < d.moratoriumEnd || date >= d.opening) errors.push('rookie-scale extensions close the day before opening night');
    maxNew = 5; maxY1 = maxSalary(p.yos + 1, f);
  } else {
    const n = c.years.length, k = n >= 5 ? 3 : 2;
    if (n < 3) errors.push('one- and two-season contracts cannot be extended');
    else if (addMonths(c.signed, 12 * k) > date) errors.push(`not before the ${k === 3 ? 'third' : 'second'} anniversary of his signing`);
    if (left.length >= 2 && date >= d.opening && date <= d.end) errors.push('with more than one season left, only in the off-season');
    maxNew = Math.max(5 - left.length, 0);
    maxY1 = Math.min(Math.max(1.4 * (left.at(-1)?.sal || 0), 1.4 * avgSalary(f.cap)), maxSalary(p.yos + left.length, f));
  }
  if (!maxNew) errors.push('no seasons left to add');
  return { errors, maxNew, maxY1: Math.round(maxY1), rookie };
}

// ---- signings -----------------------------------------------------------------------------
// League average salary for the Early Bird and extension limits: the 2026-27 figure implied by
// HRcap's Early Bird amount ($15,235,500 = 105% of it), indexed to the cap.
export const avgSalary = (cap) => Math.round(14_510_000 * cap / OFFICIAL[2026].cap);

const LIMITS = {        // [max seasons incl. options, raise % of year 1] (Art. IX §1; Art. VII §5-6)
  bird: [5, 0.08], earlyBird: [4, 0.08], nonBird: [4, 0.05], room: [4, 0.05], ntmle: [4, 0.05],
  tpmle: [2, 0.05], roomMle: [3, 0.05], bae: [2, 0.05], min: [2, 0.05], twoWay: [2, 0],
  rookie: [4, 0.05], second: [4, 0.05], ext: [5, 0.08], ext_dv: [6, 0.08], dpe: [1, 0],
};

// Each season's unspent exceptions: { s, ntmle, tpmle, roomMle, bae, baeUsed: [seasons], room }
export function freshExceptions(team, f) {
  return { s: f.season, ntmle: f.ntmle, tpmle: f.tpmle, roomMle: f.roomMle, bae: f.bae,
           baeUsed: team.exc?.baeUsed || [], usedRoom: false, usedTpmle: false };
}
// From Jan 10 the MLE, BAE and room MLE shrink day by day (Art. VII §6(m)).
export function prorate(amt, date) {
  const d = seasonDates(seasonOf(date));
  if (date < d.jan10) return amt;
  const days = (a, b) => (new Date(b) - new Date(a)) / 864e5;
  return Math.round(amt * Math.max(0, days(date, d.seasonEnd)) / days(d.opening, d.seasonEnd));
}

// offer: { team, pid, how, years: [{ sal, gtd, opt }], date, prior, starter }
// Returns { ok, errors, hardCap, uses: { exception: amount } }
export function validateSigning(league, o) {
  const s = seasonOf(o.date), f = league.f[s], d = seasonDates(s), T = league.teams[o.team], p = league.players[o.pid];
  const errors = [], [maxYrs, raise] = LIMITS[o.how] || [0, 0], y1 = o.years[0]?.sal ?? 0;
  let hardCap = null; const uses = {};
  if (!LIMITS[o.how]) return { ok: false, errors: [`unknown signing type ${o.how}`] };
  if (o.date >= d.start && o.date < d.moratoriumEnd) errors.push('free agents cannot sign during the July moratorium');
  if (o.years.length > maxYrs) errors.push(`${o.how} deals run at most ${maxYrs} seasons`);
  if (o.how === 'earlyBird' && o.years.filter((y) => y.opt !== 'tm' && y.opt !== 'pl').length < 2) errors.push('Early Bird deals must run at least two seasons');
  o.years.forEach((y, i) => {
    if (i && Math.abs(y.sal - o.years[i - 1].sal) > raise * y1 + 1) errors.push(`year ${i + 1} changes by more than ${raise * 100}% of year 1`);
    if (i && y.opt && i < o.years.length - 1) errors.push('only the final season can be an option year');
  });
  if (o.how === 'twoWay') {
    if (p.yos >= 4) errors.push('two-way contracts are for players with under four years of service');
    if (y1 !== twoWaySalary(f.cap)) errors.push('two-way salary is fixed at half the rookie minimum');
    if (o.date > d.mar4) errors.push('two-way contracts cannot be signed after March 4');
  } else {
    if (y1 < minSalary(p.yos, f.cap)) errors.push('below his minimum salary');
    if (y1 > maxSalary(p.yos, f, o.prior || 0, o.supermax)) errors.push('above his maximum salary');
  }
  const after = teamSalary(T, league, s) + (o.how === 'twoWay' ? 0 : (o.years.length === 1 && o.how === 'min' ? vetMinCharge(p.yos, f.cap) : y1));
  const capAfter = teamSalary(T, league, s, { holds: true, offseason: o.date < d.opening }) + y1;
  const E = T.exc, amt = (k) => prorate(E[k], o.date);
  const hc = (lvl) => { if (after > f[lvl]) errors.push(`this signing is barred above the ${lvl === 'apron1' ? 'first' : 'second'} apron`); hardCap = hardCap === 'apron1' ? hardCap : lvl; };
  switch (o.how) {
    case 'room': if (capAfter > f.cap) errors.push(`needs $${((capAfter - f.cap) / 1e6).toFixed(2)}M more cap room`); uses.room = true; break;
    case 'bird': if (birdLevel(p, o.team) !== 'full') errors.push('he does not have full Bird rights with this team'); break;
    case 'earlyBird':
      if (birdLevel(p, o.team) !== 'early' && birdLevel(p, o.team) !== 'full') errors.push('no Early Bird rights with this team');
      if (y1 > Math.max(1.75 * (o.prior || 0), 1.05 * avgSalary(f.cap))) errors.push('above the Early Bird limit'); break;
    case 'nonBird':
      if (p.bird?.team !== o.team) errors.push('he was not on this team last season');
      if (y1 > Math.max(1.2 * (o.prior || 0), 1.2 * minSalary(p.yos, f.cap), o.qo || 0)) errors.push('above the non-Bird limit'); break;
    case 'ntmle': if (E.usedRoom) errors.push('the non-taxpayer MLE is gone once cap room is used');
      if (y1 > amt('ntmle')) errors.push('more than the non-taxpayer MLE left'); uses.ntmle = y1; hc('apron1'); break;
    case 'dpe': {                                       // disabled player exception: one season, by March 10
      const e = T.tpes.find((x) => x.dpe && x.expires >= o.date);
      if (!e) errors.push('no live disabled player exception'); else if (y1 > e.amt) errors.push('more than the disabled player exception'); break; }
    case 'tpmle': if (y1 > amt('tpmle')) errors.push('more than the taxpayer MLE left'); uses.tpmle = y1; hc('apron2'); break;
    case 'roomMle': if (!E.usedRoom && capAfter - y1 > f.cap) errors.push('the room MLE is for teams that went under the cap');
      if (y1 > amt('roomMle')) errors.push('more than the room MLE left'); uses.roomMle = y1; break;
    case 'bae': if (E.baeUsed.includes(s - 1)) errors.push('the bi-annual exception was used last season');
      if (E.usedRoom) errors.push('the bi-annual exception is gone once cap room is used');
      if (y1 > amt('bae')) errors.push('more than the bi-annual exception left'); uses.bae = y1; hc('apron1'); break;
    case 'min': if (y1 !== minSalary(p.yos, f.cap)) errors.push('minimum deals pay exactly his minimum'); break;
    case 'rookie': {
      const sc = rookieScale(p.draft.pick, f.cap, 1);
      o.years.forEach((y, i) => { if (y.sal < 0.8 * sc[i] - 1 || y.sal > 1.2 * sc[i] + 1) errors.push(`year ${i + 1} is outside 80-120% of scale`); });
      if (p.draft.team !== o.team) errors.push('only the drafting team signs him to the scale'); break;
    }
    case 'second': if (p.draft?.team !== o.team || p.draft.round !== 2) errors.push('the second-round exception is for the team\'s own second-round pick');
      if (y1 > minSalary(o.years.length >= 4 ? 2 : 1, f.cap)) errors.push('above the second-round exception'); break;
  }
  if (T.hardCap && after > f[T.hardCap]) errors.push(`hard-capped at the ${T.hardCap === 'apron1' ? 'first' : 'second'} apron`);
  if (p.waived?.s === s && p.waived.sal > f.ntmle && o.date >= d.opening) hc('apron1');     // buyout rule (row D)
  const std = T.roster.filter((id) => !league.players[id].contract?.twoWay).length;
  const tw = T.roster.length - std;
  if (o.how === 'twoWay' ? tw >= 3 : (o.date >= d.opening && o.date <= d.seasonEnd ? std >= 15 : T.roster.length >= 21))
    errors.push('no roster spot');
  return { ok: errors.length === 0, errors, hardCap, uses };
}

// ---- waivers, stretch, set-off ---------------------------------------------------------
// Dead money from waiving `p` on `date`: guaranteed salary still owed, by season. Stretch
// spreads the future (and, July 1-Aug 31, the coming season too) over 2n+1 seasons, within
// 15% of the cap in total (Art. VII §7(d)(6)).
export function waive(p, date, stretch = false) {
  const s = seasonOf(date), d = seasonDates(s), c = p.contract;
  const jan10 = date >= d.jan10;
  const owed = c.years.filter((y) => y.s >= s).map((y) => ({ s: y.s, amt: y.s === s && jan10 ? y.sal : y.gtd }))
    .filter((x) => x.amt > 0);
  if (!stretch) return owed;
  const summer = date.slice(5) <= '08-31' && date.slice(5) >= '07-01';
  const keep = summer ? [] : owed.filter((x) => x.s === s);
  const spread = owed.filter((x) => summer || x.s > s), n = spread.length;
  if (!n) return keep;
  const total = spread.reduce((a, x) => a + x.amt, 0), first = summer ? s : s + 1, len = 2 * n + 1;
  return keep.concat([...Array(len)].map((_, i) => ({ s: first + i, amt: Math.round(total / len), stretched: true })));
}
// When a waived player signs elsewhere, his old team's charge drops by half the gap between
// the new salary and the one-year minimum (Art. XXVII §1).
export const setOff = (newSal, yosWhenWaived, cap) =>
  Math.max(0, Math.round((newSal - minSalary(yosWhenWaived === 0 ? 0 : 1, cap)) / 2));
