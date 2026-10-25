// Players change: talent ages and drifts, seasons surprise, and the projection everyone sees
// learns from what happened.
//
// Three numbers per player:
//   rate    -- the projection the site would publish, the only rating anyone sees;
//   talent  -- what he really is this season (hidden); in "projections are truth" mode it is
//              the projection exactly, otherwise the projection plus a persistent error;
//   play    -- how he actually plays this season: talent plus form plus a club-wide shock.
// A season's surprises keep team_proj's decomposition of real projection error (persistent
// player factor, transitory form, a factor shared by teammates: PERSIST .16, TRANS .30, COMMON
// .13), scaled by K.devScale so a season with known rosters misses its preseason projection by as
// much as real ones did (_gm_miss_decomp.json B). Across years talent moves by a personal trend
// that keeps K.dev.rho of itself each year (sd K.dev.trend, stationary) plus a random walk, both
// fit on the site's ratings over ten years (12_gm_data.py): the spread of rating changes grows
// fast at first and flattens, as a fading trend makes it. When talent is hidden the projection
// learns it late, so the trend is scaled (K.trendHidden, calibrate.js) for the PROJECTION to
// spread as the site's ratings do.

export const agingStep = (K, age) => {
  const a = (x) => K.aging[String(Math.min(Math.max(Math.round(x), 18), 40))];
  return age >= 40 ? a(40) - a(39) : a(age + 1) - a(age);    // past the table, its last year's decline
};

// At game start (and for every player who enters the league later).
export function initTalent(p, K, r, hidden) {
  p.talent = p.rate + (hidden ? K.devScale * K.dev.persist * r.normal() : 0);
  p.trend = (p.tp ?? 0) + trendSd(K, hidden, p) * r.normal();     // tp: the draft model's expected trend
  initSeen(p, K);
}
// How much play a rating stands on, in minutes (hidden talent), as a Kalman filter keeps it: a season
// of m minutes moves the rating by m / (m + seen) and adds m to what it stands on, and talent moving
// on over the year takes some back (seen -> 1 / (1 / (seen + m) + 1 / K.learnMinutes)) -- a man the
// league has watched for years moves about m / (m + K.learnMinutes), one it has barely seen far more.
// A veteran starts where his own minutes would hold it; a draftee, at what the scouts' board is worth
// (K.priorMinutes, league.js draftStart).
export const initSeen = (p, K) => { const m = (p.mpg ?? 0) * 82 * (p.av ?? 0.9); p.seen ??= (Math.sqrt(m * m + 4 * m * K.learnMinutes) - m) / 2; };
// A draftee's growth (K.grow, 12_gm_data.py): from his rookie season to his third a real one grew
// past the league's aging by a + b x his rookie level, give or take sd, by his pick's range. As the
// game's trend: tp, the mean it starts at (two seasons of a trend that keeps rho of itself carry
// 1 + rho of it), and dsd, his trend's spread over the league's (two seasons of it spread
// sqrt((1 + rho)^2 + 1 - rho^2) of one season's; with hidden talent the league's trend is
// K.trendHidden, larger so ratings that learn late spread as real ones do, and this scales it alike).
export function growth(K, slot, x) {
  const [, , a, b, sd] = K.grow.find(([lo, hi]) => slot >= lo && slot <= hi), rho = K.dev.rho;
  return { tp: (a + b * x) / (1 + rho), dsd: sd / (Math.sqrt((1 + rho) ** 2 + 1 - rho * rho) * K.dev.trend) };
}
// dsd: a recent draftee's own spread, from the draft model's range for him (12_gm_data.py)
const trendSd = (K, hidden, p) => (hidden ? K.trendHidden : K.dev.trend) * (p.dsd ?? 1);
// a year of the fading trend: keeps rho of itself, refreshed so its spread stays put
function stepTrend(p, K, r, hidden) {
  const rho = K.dev.rho;
  p.trend = rho * p.trend + Math.sqrt(1 - rho * rho) * trendSd(K, hidden, p) * r.normal();
}

// Before a season: each player's play rating for the year.
export function seasonForm(teams, players, K, r) {
  for (const ab in teams) {
    const c = K.devScale * K.dev.common * r.normal();
    for (const id of teams[ab].roster) {
      const p = players[id];
      p.play = p.talent + K.devScale * K.dev.trans * r.normal() + c;
    }
  }
}

// After a season: the projection learns from his season (weight by minutes played, so a
// bench season moves it little), then everyone ages a year and talent drifts.
// a stable N(0,1) for any key (club, player, season...): the same draw every time it is asked
export function hashNoise(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const u = ((h >>> 0) + 0.5) / 4294967296, v = ((Math.imul(h, 2654435761) >>> 0) + 0.5) / 4294967296;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// linear through a table of [x, y] points, flat past either end
export const interp = (t, x) => { const i = t.findIndex((c) => c[0] >= x);
  return i < 0 ? t.at(-1)[1] : i === 0 ? t[0][1] : t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); };
// The rating a season shows after m minutes: the board's read pulled toward how he has played, by
// his minutes against what it already stands on (initSeen), as a real season's rating is estimated from that season (the read itself when
// talent is not hidden)
export const seasonRate = (p, m, K, hidden) => (hidden && m ? p.rate + m / (m + p.seen) * ((p.play ?? p.talent) - p.rate) : p.rate);
// A season's box line per 100 possessions (K.box, _gm_box.py): each count -- two- and three-point
// makes, missed shots, free throws made and missed, rebounds at each end, assists, steals, blocks,
// turnovers, fouls -- is the fit on his offense, defense, position and minutes times his own style
// (drawn once for a man with no real seasons) and season s's noise, both hashed so the line read
// mid-season grows into the one the season ends with. The noise is mostly sampling: its covariance
// is A + B / sqrt(c c), c the counts the fit expects in his gp games so far, so it narrows as he
// plays. Each draw is lognormal about the fit's mean (less half its variance on the log scale).
// Attempts are makes plus misses and points come from makes, so the line adds up:
// [pts, reb, ast, stl, blk, fgm, fga, fg3m, ftm, fta, oreb, dreb, tov, pf] (K.box.line); none for a
// man with no position. A style kept from before the line had these parts is drawn again.
export function boxLine(p, mpg, K, s, gp) {
  const B = K.box, ps = p.pos?.[0];
  if (!ps || !mpg) return null;
  // the counts move together: a draw is the covariance's Cholesky factor times independent normals
  const draw = (L, key) => { const z = B.stats.map((k, i) => hashNoise(`${key}|${i}`)); return L.map((row) => row.reduce((a, c, j) => a + c * z[j], 0)); };
  if (p.box?.length !== B.stats.length) p.box = draw(B.chol_player, `style|${p.id}`).map((y) => +y.toFixed(3));
  const x = { const: 1, off: (p.rate + (p.lean ?? 0)) / 2, def: (p.rate - (p.lean ?? 0)) / 2, F: +(ps === 'F'), C: +(ps === 'C'), log_mpg: Math.log(mpg) };
  const eta = B.stats.map((k) => Object.entries(B.coef[k]).reduce((a, [c, b]) => a + b * x[c], 0));
  const c = eta.map((y) => Math.exp(y) * gp * mpg / 48);            // per 100 times his possessions (100 a 48 minutes) / 100
  const V = B.noise.A.map((row, i) => row.map((a, j) => a + B.noise.B[i][j] / Math.sqrt(c[i] * c[j]))), e = draw(cholesky(V), `box|${p.id}|${s}`);
  const l = Object.fromEntries(B.stats.map((k, i) => [k, +Math.exp(eta[i] + p.box[i] + e[i] - (B.chol_player[i].reduce((a, y) => a + y * y, 0) + V[i][i]) / 2).toFixed(1)]));
  const r1 = (y) => +y.toFixed(1);
  l.fgm = r1(l.fg2m + l.fg3m); l.fga = r1(l.fgm + l.fgx); l.fta = r1(l.ftm + l.ftx);
  l.pts = r1(2 * l.fgm + l.fg3m + l.ftm); l.reb = r1(l.oreb + l.dreb);
  return B.line.map((k) => l[k]);
}
// the lower Cholesky factor of a covariance matrix
function cholesky(V) {
  const L = V.map((row) => row.map(() => 0));
  for (let i = 0; i < V.length; i++)
    for (let j = 0; j <= i; j++) {
      const s = V[i][j] - L[i].slice(0, j).reduce((a, y, k) => a + y * L[j][k], 0);
      L[i][j] = i === j ? Math.sqrt(s) : s / L[j][j];
    }
  return L;
}
export function endSeason(players, minutesPlayed, K, r, hidden) {
  for (const p of Object.values(players)) {
    const m = minutesPlayed[p.id] || 0, step = agingStep(K, p.age);
    if (hidden) {
      const w = m && m / (m + p.seen);                // no minutes, nothing learned
      p.rate = p.rate + w * ((p.play ?? p.talent) - p.rate) + step;
      p.seen = 1 / (1 / (p.seen + m) + 1 / K.learnMinutes);
      p.talent = p.talent + step + p.trend + K.dev.walk * (p.dsd ?? 1) * r.normal();
    } else {
      p.talent = p.talent + step + p.trend + K.dev.walk * (p.dsd ?? 1) * r.normal();
      p.rate = p.talent;
    }
    stepTrend(p, K, r, hidden);
    if (p.tp) p.tp *= K.dev.rho;
    // offense minus defense (_gm_od.py): offense fades from about 27, defense holds to about 31
    p.lean = (p.lean ?? 0) + interp(K.od.drift, p.age) + K.od.rho * (p.lean ?? 0) + K.od.sd * r.normal();
    p.age += 1;
  }
}
