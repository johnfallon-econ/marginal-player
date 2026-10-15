// The draft board's drawings, from its viewer (viewer_template.html: violin, fan, qhz, odsplit,
// arc and the season-by-season market bars), fed the game's own fans (league.js fans): the same
// eight levels, the same grammar, so the game's draft reads like the board.
const QL = [5, 10, 25, 50, 75, 90, 95, 99], Q10 = 1, Q25 = 2, Q50 = 3, Q75 = 4, Q90 = 5, QLO = 0, QHI = 7;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const px = (v, dom, W) => clamp((v - dom[0]) / (dom[1] - dom[0]), 0, 1) * W;
export const $M = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v) >= 100 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)}M`;

// the value violin: a smooth density from the quantiles, over the whole fan (p5..p99)
export function violin(q, VD) {
  const L = q.length, cum = QL.map((v) => v / 100), W = 260, H = 34, mid = H / 2, maxH = 12, N = 88;
  const xq = q.map((v) => px(v, VD, W)), x0 = xq[0], x1 = xq[L - 1], seg = [];
  for (let i = 0; i < L - 1; i++) seg.push([xq[i], xq[i + 1], (cum[i + 1] - cum[i]) / Math.max(xq[i + 1] - xq[i], 0.5)]);
  const densAt = (x) => { for (const s of seg) if (x >= s[0] && x <= s[1]) return s[2]; return 0; };
  const span = Math.max(x1 - x0, 1), raw = [];
  for (let i = 0; i <= N; i++) { const x = x0 + span * i / N; raw.push([x, i === 0 || i === N ? 0 : densAt(x)]); }
  const sm = raw.map((p, i) => { let a = 0, c = 0; for (let k = -4; k <= 4; k++) { const j = i + k; if (j >= 0 && j < raw.length) { a += raw[j][1]; c++; } } return [p[0], a / c]; });
  sm[0][1] = 0; sm[sm.length - 1][1] = 0;
  const mx = Math.max(...sm.map((p) => p[1])) || 1, hy = (p) => maxH * p[1] / mx;
  const path = 'M' + sm.map((p) => `${p[0].toFixed(1)},${(mid - hy(p)).toFixed(1)}`).concat(sm.slice().reverse().map((p) => `${p[0].toFixed(1)},${(mid + hy(p)).toFixed(1)}`)).join('L') + 'Z';
  const p50 = xq[Q50].toFixed(1);
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="vio" aria-hidden="true"><defs><linearGradient id="vg" x1="0" x2="1"><stop offset="0" stop-color="var(--span)"/><stop offset="1" stop-color="var(--violin)"/></linearGradient></defs>
<line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="var(--track)" stroke-width="2"/><path d="${path}" fill="url(#vg)" stroke="var(--violin)" stroke-width="1" opacity=".92"/>
<line x1="${p50}" y1="${mid - 11}" x2="${p50}" y2="${mid + 11}" stroke="var(--amber)" stroke-width="2.4"/></svg>`;
}

// stacked mini-fans on a shared quality scale: rookie / 4-year / peak, then offense / defense
const mini = (rows, f, QD, cls = '') => `<div class="qhz ${cls}">${rows.map(([lab, k, c = '', rc = '']) => {
  const q = f[k], x = (v) => px(v, QD, 120);
  return `<div class="ln ${rc}"><span class="t">${lab}</span><span class="mf ${c}" style="width:120px"><span class="tk"></span>`
    + `<span class="s" style="left:${x(q[Q10]).toFixed(1)}px;width:${Math.max(2, x(q[Q90]) - x(q[Q10])).toFixed(1)}px"></span>`
    + `<span class="i" style="left:${x(q[Q25]).toFixed(1)}px;width:${Math.max(2, x(q[Q75]) - x(q[Q25])).toFixed(1)}px"></span>`
    + `<span class="m" style="left:${x(q[Q50]).toFixed(1)}px"></span></span><span class="vv">${q[Q50].toFixed(1)}</span></div>`; }).join('')}</div>`;
export const qhz = (f, QD) => mini([['R', 'r'], ['4', 'q'], ['P', 'k']], f, QD) + mini([['O', 'o', 'mo', 'o'], ['D', 'd', 'md', 'd']], f, QD, 'ods');

// the career arc: projected value (wins) per season, bands p5-99 / p10-90 / p25-75, the median
export function arc(vs, rend) {
  const n = vs.length, W = 600, H = 196, mL = 34, mR = 14, mT = 16, mB = 30, pw = W - mL - mR, ph = H - mT - mB;
  let lo = -1.5, hi = 3; for (const f of vs) { lo = Math.min(lo, f[QLO]); hi = Math.max(hi, f[QHI]); }
  const dom = [Math.floor(lo) - 0.3, Math.ceil(hi) + 0.3], rng = dom[1] - dom[0];
  const xAt = (i) => mL + pw * i / (n - 1), yAt = (v) => mT + ph * (1 - clamp((v - dom[0]) / rng, 0, 1));
  const band = (up, dn) => 'M' + vs.map((f, i) => `${xAt(i).toFixed(1)},${yAt(f[up]).toFixed(1)}`).concat(vs.map((f, i) => [f, i]).reverse().map(([f, i]) => `${xAt(i).toFixed(1)},${yAt(f[dn]).toFixed(1)}`)).join('L') + 'Z';
  const step = rng > 9 ? 3 : rng > 5 ? 2 : 1;
  let grid = '';
  for (let v = Math.ceil(dom[0] / step) * step; v <= dom[1]; v += step) { const y = yAt(v).toFixed(1), z = v === 0;
    grid += `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" stroke="var(${z ? '--line' : '--track'})" stroke-width="${z ? 1.3 : 1}"/><text x="${mL - 5}" y="${y}" text-anchor="end" dominant-baseline="middle" class="axl">${v > 0 ? '+' : ''}${v}</text>`; }
  const xr = ((xAt(rend - 1) + xAt(rend)) / 2).toFixed(1);
  grid += `<line x1="${xr}" y1="${mT}" x2="${xr}" y2="${H - mB}" stroke="var(--amber)" stroke-dasharray="3 3" opacity=".7"/><text x="${+xr + 4}" y="${mT + 8}" class="axl" fill="var(--amber)">rookie deal ends</text>`;
  const dots = vs.map((f, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(f[Q50]).toFixed(1)}" r="3" fill="var(--amber)" stroke="var(--ground)" stroke-width="1.3"/>`).join('');
  const xl = vs.map((_, i) => `<text x="${xAt(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" class="axl stg">Y${i + 1}</text>`).join('');
  return `<div class="arc-wrap"><div class="arc-hd"><span class="arc-t">Career trajectory<small>projected value · wins per season</small></span>
<span class="arc-lg"><i class="sw out"></i>p5–99<i class="sw span"></i>p10–90<i class="sw iqr"></i>p25–75<i class="dsh"></i>median</span></div>
<svg width="100%" viewBox="0 0 ${W} ${H}" class="arc" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Projected value per season">${grid}
<path d="${band(QHI, QLO)}" fill="var(--span)" opacity=".22"/><path d="${band(Q90, Q10)}" fill="var(--span)" opacity=".5"/><path d="${band(Q75, Q25)}" fill="var(--iqr)" opacity=".55"/>
<path d="${'M' + vs.map((f, i) => `${xAt(i).toFixed(1)},${yAt(f[Q50]).toFixed(1)}`).join('L')}" fill="none" stroke="var(--amber)" stroke-width="2.2"/>${dots}${xl}</svg></div>`;
}

// what his club keeps, season by season: the full bar his open-market value, the dark part the club's
export function bars(mkt, kept) {
  const n = mkt.length, W = 600, H = 170, mL = 46, mB = 22, mT = 8, pw = W - mL - 8, ph = H - mT - mB, top = Math.max(...mkt, 1);
  const step = top > 120 ? 50 : top > 60 ? 25 : 10, bw = pw / n * 0.72, xAt = (i) => mL + pw * (i + 0.5) / n, yAt = (v) => mT + ph * (1 - Math.max(v, 0) / (Math.ceil(top / step) * step));
  let g = '';
  for (let v = 0; v <= Math.ceil(top / step) * step; v += step) g += `<line x1="${mL}" y1="${yAt(v).toFixed(1)}" x2="${W - 8}" y2="${yAt(v).toFixed(1)}" stroke="var(--track)"/><text x="${mL - 5}" y="${yAt(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" class="axl">$${v}M</text>`;
  const b = mkt.map((m, i) => `<rect x="${(xAt(i) - bw / 2).toFixed(1)}" y="${yAt(m).toFixed(1)}" width="${bw.toFixed(1)}" height="${(yAt(0) - yAt(m)).toFixed(1)}" fill="var(--paid)"/>`
    + `<rect x="${(xAt(i) - bw / 2).toFixed(1)}" y="${yAt(kept[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(yAt(0) - yAt(kept[i])).toFixed(1)}" fill="var(--kept)"/>`
    + (i % 2 ? '' : `<text x="${xAt(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axl stg">Y${i + 1}</text>`)).join('');
  return `<div class="arc-wrap"><div class="arc-hd"><span class="arc-t">What his club keeps<small>expected, at the draft's cap · the full bar is his open-market value; the club keeps all of it on the rookie deal while it holds him, then value less his pay</small></span>
<span class="arc-lg"><i class="sw kept"></i>his club keeps<i class="sw paid"></i>paid to him, or lost when he leaves</span></div><svg width="100%" viewBox="0 0 ${W} ${H}" class="arc" role="img" aria-label="Value to his club by season">${g}${b}</svg></div>`;
}
