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
  p.trend = trendSd(K, hidden) * r.normal();
}
const trendSd = (K, hidden) => (hidden ? K.trendHidden : K.dev.trend);
// a year of the fading trend: keeps rho of itself, refreshed so its spread stays put
function stepTrend(p, K, r, hidden) {
  const rho = K.dev.rho;
  p.trend = rho * p.trend + Math.sqrt(1 - rho * rho) * trendSd(K, hidden) * r.normal();
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
export function endSeason(players, minutesPlayed, K, r, hidden) {
  for (const p of Object.values(players)) {
    const m = minutesPlayed[p.id] || 0, step = agingStep(K, p.age);
    if (hidden) {
      const w = m / (m + K.learnMinutes);
      p.rate = p.rate + w * ((p.play ?? p.talent) - p.rate) + step;
      p.talent = p.talent + step + p.trend + K.dev.walk * r.normal();
    } else {
      p.talent = p.talent + step + p.trend + K.dev.walk * r.normal();
      p.rate = p.talent;
    }
    stepTrend(p, K, r, hidden);
    p.age += 1;
  }
}
