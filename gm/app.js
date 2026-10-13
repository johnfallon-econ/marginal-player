// The GM game page (site/gm.html): one club in the simulated league, the rest run by computer GMs.
// The whole game is one plain object, saved to the browser (IndexedDB) after every step.
import * as L from './league.js';
import * as S from './season.js';
import * as C from './cba.js';
import * as M from './value.js';
import * as X from './trades.js';

let G = null, r = null, view = 'home', ui = {};
const $ = (s) => document.querySelector(s), root = () => $('#gm');
const P = (id) => G.players[id], me = () => G.teams[G.user], F = () => G.f[G.season];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $M = (x) => `$${(x / 1e6).toFixed(1)}M`, sg = (x) => { x = Math.round(x * 10) / 10 || 0; return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1); };
const std = (T) => T.roster.filter((id) => !P(id).contract?.twoWay);
const NAME = (ab) => G.teams[ab].name;
const SEASON = (s) => `${s}-${String((s + 1) % 100).padStart(2, '0')}`;

// ---- saving ------------------------------------------------------------------------------------
const db = () => new Promise((ok, no) => {
  const q = indexedDB.open('marginal-gm', 1);
  q.onupgradeneeded = () => q.result.createObjectStore('s');
  q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error);
});
const idb = async (mode, f) => { const d = await db(); return new Promise((ok, no) => {
  const t = d.transaction('s', mode), q = f(t.objectStore('s')); t.oncomplete = () => ok(q.result); t.onerror = () => no(t.error); }); };
const save = () => { G.rngState = r.state(); return idb('readwrite', (s) => s.put(G, 'game')); };
const adopt = (g) => { G = g; r = S.rng(0, G.rngState); };

// Long steps: paint the busy note first, then run, save and redraw.
function step(label, f) {
  root().insertAdjacentHTML('beforeend', `<div class="busy" role="status">${esc(label)}…</div>`);
  setTimeout(async () => { try { f(); await save(); } catch (e) { console.error(e); alert(e.message); } render(); }, 30);
}

// ---- what happens next -------------------------------------------------------------------------
const NEXT = {
  preseason: () => {
    const T = me(), n = std(T).length, tw = T.roster.length - n;
    const ok = n >= 14 && n <= 15 && tw <= 3;
    return [ok ? 'Opening night is next.' : n < 14 ? `Clubs open the season with at least 14 standard contracts: you carry ${n}.`
      : `Cut to 15 standard contracts and 3 two-ways first: you carry ${n} and ${tw}.`,
      ok ? btn('start', 'Start the season') + (tw < 3 ? btn('autofill', 'Fill the two-way spots') : '') : n < 14 ? btn('autofill', 'Sign the best left at the minimum') : btn('autocut', 'Make the cuts for me'),
      !ok && btn('go', n < 14 ? 'Choose free agents' : 'Choose the cuts', n < 14 ? 'fa' : 'roster')];
  },
  season: () => {
    const w = G.cur.win, to = ['Sim to Dec 15', 'Sim to the trade deadline', 'Sim the rest of the season'][w];
    const rec = G.cur.record[G.user], n = std(me()).length;
    if (n > 15) return [`You carry ${n} standard contracts after the trade: waive down to 15 before the next game.`, btn('autocut', 'Make the cuts for me'), btn('go', 'Choose the cuts', 'roster')];
    return [`${rec.w}-${rec.l} after ${rec.w + rec.l} games. ${w < 2 ? 'Clubs can trade until the deadline.' : 'The deadline has passed.'}`, btn('sim', to)];
  },
  playoffs: () => {
    const po = G.po, x = mySeries();
    if (po.champion) return [`The ${NAME(po.champion)} are champions.`, btn('poend', 'On to the offseason')];
    const live = x && !S.seriesDone(x);
    const say = live ? `${seriesLine(x)}. ${nextGameLine(x)}` : x ? `${seriesLine(x)}.` : made() ? 'Your season is over.' : 'You missed the playoffs.';
    return [say, live && btn('pgame', `Play game ${x.w + x.l + 1}`), live && btn('pseries', 'Sim the series'),
      S.roundDone(po) ? btn('pround', ['Start the second round', 'Start the conference finals', 'Start the Finals', 'Crown the champion'][po.round]) : btn('pround', 'Sim the round'),
      btn('go', 'Bracket', 'playoffs')];
  },
  offseason: () => G.step === 'decisions' ? ['Options and qualifying offers are due before the new league year.', btn('newyear', 'Start the new league year')]
    : [summary(G.history.at(-1)), btn('todraft', 'On to the draft')],
  draft: () => { const c = L.draftNext(G, r); return c ? [`You are on the clock with pick ${c.slot}.`, btn('go', 'Pick a player', 'draft')] : ['The draft is done.', btn('enddraft', 'Finish the draft')]; },
  freeagency: () => G.fa_ ? [`Free agency, day ${G.fa_.day}.${Object.keys(G.fa_.sheets).length ? ' A rival has signed one of your restricted free agents to an offer sheet: match or let him go.' : ''}`,
    btn('faday', 'Next day'), btn('farest', 'Sim to the end of free agency'), btn('go', 'Free agents', 'fa')]
    : ['Your own free agents first: choose whom to re-sign.', btn('go', 'Re-sign', 'resign')],
};
// the rest of the round keeps up: every other series plays as many games as the user's has
const keepPace = (x) => { for (const y of G.po.series) while (y !== x && y.w + y.l < x.w + x.l && S.seriesGame(y, G.po.nets, G.K, r)); };
// the user's series this round, how it stands, and the next game's odds
const mySeries = () => G.po?.series.find((x) => x.hi === G.user || x.lo === G.user);
const made = () => G.po.seeds.East.includes(G.user) || G.po.seeds.West.includes(G.user);
const ROUND = ['First round', 'Conference semifinals', 'Conference finals', 'Finals'];
const seriesLine = (x) => { const me_ = x.hi === G.user ? x.w : x.l, them = x.hi === G.user ? x.l : x.w, opp = x.hi === G.user ? x.lo : x.hi;
  return `${ROUND[G.po.round]} against ${NAME(opp)}: ${me_ > them ? `you lead ${me_}-${them}` : me_ < them ? `you trail ${me_}-${them}` : `tied ${me_}-${them}`}${S.seriesDone(x) ? (me_ === 4 ? ' — you won the series' : ' — you lost the series') : ''}`; };
const nextGameLine = (x) => { const n = x.w + x.l, h = [0, 0, 1, 1, 0, 1, 0][n] ? x.lo : x.hi, a = h === x.hi ? x.lo : x.hi, p = S.winP(h, a, G.po.nets, G.K);
  return `Game ${n + 1} ${h === G.user ? 'at home' : 'on the road'}: your chance of winning it ${Math.round(100 * (h === G.user ? p : 1 - p))}%; of winning the series ${Math.round(100 * seriesP(x))}%`; };
// the user's chance of taking the series from here: every way the remaining games can fall
const seriesP = (x) => { const hi = x.hi === G.user, ph = S.winP(x.hi, x.lo, G.po.nets, G.K), pa = 1 - S.winP(x.lo, x.hi, G.po.nets, G.K);
  const f = (w, l) => (w === 4 ? 1 : l === 4 ? 0 : (([0, 0, 1, 1, 0, 1, 0][w + l] ? pa : ph) * f(w + 1, l) + (1 - ([0, 0, 1, 1, 0, 1, 0][w + l] ? pa : ph)) * f(w, l + 1)));
  const p = f(x.w, x.l); return hi ? p : 1 - p; };
const btn = (act, label, arg = '', cls = '') => `<button class="b ${cls}" data-act="${act}" data-arg="${esc(arg)}">${esc(label)}</button>`;
const summary = (h) => `${SEASON(h.season)}: ${h.record[G.user].join('-')}. ${playoffs(h)} Champion: ${NAME(h.champion)}.`;
function playoffs(h) {
  const made = h.seeds.East.includes(G.user) || h.seeds.West.includes(G.user);
  const rounds = h.rounds.map((rd, i) => Object.entries(rd).filter(([k]) => k.split('-').includes(G.user)).map(([k, v]) => `${['First round', 'Conference semifinals', 'Conference finals', 'Finals'][i]}: ${v.winner === G.user ? 'won' : 'lost'} ${v.games.split('-').sort().reverse().join('-')} vs ${k.split('-').find((x) => x !== G.user)}`)).flat();
  return made ? rounds.join('; ') + '.' : 'Missed the playoffs.';
}

// ---- actions -----------------------------------------------------------------------------------
const ACT = {
  go: (a) => { view = a; ui = {}; render(); },
  autocut: () => step('Cutting', () => L.cutdown(G, r, G.user)),
  autofill: () => step('Signing', () => L.fillRosters(G, [G.user])),
  start: () => step('Opening night', () => {
    const ai = Object.keys(G.teams).filter((ab) => ab !== G.user);
    L.fillRosters(G, ai); for (const ab of ai) L.cutdown(G, r, ab);
    L.seasonStart(G, r); G.cur.win = 0; G.offers = [];
  }),
  sim: () => step('Simulating', () => {
    const w = G.cur.win++, d = C.seasonDates(G.season);
    if (w < 2) { L.seasonTo(G, r, L.WINDOWS[w].frac); G.date = d[L.WINDOWS[w].date]; X.tradeWindow(G, r, G.date, L.TRADES); L.assignRoles(G); G.offers = X.offersFor(G); }
    else { L.seasonTo(G, r, 1); L.postseasonStart(G, r); G.offers = []; view = 'home'; }
  }),
  pgame: () => { const x = mySeries(); S.seriesGame(x, G.po.nets, G.K, r); keepPace(x); save(); render(); },
  pseries: () => { const x = mySeries(); while (S.seriesGame(x, G.po.nets, G.K, r)); keepPace(x); save(); render(); },
  pround: () => step('Playoffs', () => { if (S.roundDone(G.po)) S.nextRound(G.po, r); else L.playRound(G, r); }),
  poend: () => step('Wrapping up the season', () => { L.postseasonEnd(G); view = 'home'; }),
  todraft: () => step('The lottery', () => {
    const before = Object.fromEntries(me().roster.map((id) => [id, P(id).rate]));
    L.endSeason(G, r);
    G.dev = Object.entries(before).map(([id, b]) => [id, b, P(id).rate]).sort((a, b) => (b[2] - b[1]) - (a[2] - a[1]));
    X.tradeWindow(G, r, `${G.season + 1}-06-20`, L.TRADES);
    G.offers = X.offersFor(G);
    L.draftStart(G, r); L.draftNext(G, r); view = 'draft';
  }),
  pick: (id) => step('The draft', () => { L.draftNext(G, r, id); }),
  autopick: () => step('The draft', () => { const c = L.draftNext(G, r); if (c) L.draftNext(G, r, G.draft.avail.map(P).sort((a, b) => b.rate - a.rate)[0].id); }),
  enddraft: () => step('Wrapping up', () => { L.draftEnd(G); G.step = 'decisions'; G.choices = {}; view = 'decisions'; }),
  toggle: (k) => { G.choices[k] = !G.choices[k]; render(); },
  newyear: () => step('The new league year', () => {
    const c = G.choices || {};
    L.newLeagueYear(G, r, { teamOption: (p) => !!c[`opt|${p.id}`], qo: (p) => !!c[`qo|${p.id}`] });
    delete G.step; G.choices = {}; G.offers = []; view = 'resign';
  }),
  market: () => step('Free agency opens', () => {
    L.faStart(G, r, { resign: (p) => !!G.choices[`re|${p.id}`] }); G.myOffers = []; G.matchAns = {}; view = 'fa';
  }),
  faday: () => step('Free agency', faDay),
  farest: () => step('Free agency', () => { while (G.phase === 'freeagency' && !Object.keys(G.fa_.sheets).length) faDay(); }),
  match: (a) => { const [pid, v] = a.split('|'); G.matchAns[pid] = v === '1'; render(); },
  offer: () => {
    const p = P(ui.pid), how = $('#how').value, o = { pid: p.id, ab: G.user, how, sal: how === 'min' ? C.minSalary(p.yos, F().cap) : how === 'twoWay' ? C.twoWaySalary(F().cap) : Math.round(+$('#sal').value * 1e6), years: ['min', 'twoWay', 'bae', 'tpmle'].includes(how) ? Math.min(+$('#yrs').value, 2) : +$('#yrs').value };
    const v = C.validateSigning(G, { team: G.user, pid: p.id, how: o.how, date: G.date, years: L.years5(o.sal, o.years, 0.05), prior: (p.prior || 0) * 1e6 });
    if (!v.ok) { ui.err = v.errors.join('; '); return render(); }
    if (G.phase !== 'freeagency') {
      if (o.how !== 'twoWay' && o.sal < 0.5 * L.askOf(G, p, F()).sal) { ui.err = `He wants at least ${$M(0.5 * L.askOf(G, p, F()).sal)}.`; return render(); }
      return step('Signing', () => { L.sign(G, G.user, p, o.how, o.sal, o.years, G.date, 0.05); if (G.phase === 'season') L.assignRoles(G); ui = {}; });
    }
    G.myOffers = G.myOffers.filter((x) => x.pid !== p.id).concat(o); ui = {}; save(); render();
  },
  unoffer: (pid) => { G.myOffers = G.myOffers.filter((x) => x.pid !== pid); save(); render(); },
  sel: (pid) => { ui.pid = ui.pid === pid ? null : pid; ui.err = null; render(); },
  waive: (pid) => {
    if (!confirm(`Waive ${P(pid).nm}? His guaranteed money stays on your books.`)) return;
    step('Waiving', () => { L.release(G, G.user, pid, G.date, $('#stretch')?.checked); ui = {}; });
  },
  extend: (pid) => {
    const p = P(pid), sal = Math.round(+$('#xsal').value * 1e6), n = +$('#xyrs').value, { t, a } = extInfo(p);
    // the form shows $0.1M steps
    if (sal + 50_000 < Math.min(a.sal, t.maxY1)) { ui.err = `He turns it down: he wants ${$M(a.sal)}.`; return render(); }
    const e = L.extend(G, G.user, p, Math.min(sal, t.maxY1), n, G.date);
    if (e.length) { ui.err = e.join('; '); return render(); }
    ui = {}; save(); render();
  },
  partner: () => { ui.partner = $('#partner').value; ui.give = {}; ui.get = {}; ui.verdict = null; render(); },
  tk: (k) => { const [side, id] = k.split('#'); ui[side][id] = !ui[side][id]; ui.verdict = null; render(); },
  take: (i) => { const j = X.judge(G, G.offers[+i].trade ?? G.offers[+i]);
    if (!j.ok) { alert(`No longer allowed: ${j.errors.join('; ')}`); G.offers.splice(+i, 1); return render(); }
    step('Trade', () => { X.complete(G, j); if (G.phase === 'season') L.assignRoles(G); if (G.draft) L.draftNext(G, r);
      // the other offers stand unless they share a player or a pick with this one
      const used = new Set([...j.trade.moves.map((m) => m.pid), ...j.trade.picks.map((k) => k.id)]);
      G.offers = G.offers.filter((o, k) => k !== +i && ![...o.moves.map((m) => m.pid), ...o.picks.map((x) => x.id)].some((x) => used.has(x))); }); },
  pass: (i) => { G.offers.splice(+i, 1); save(); render(); },
  propose: () => { ui.verdict = judgeTrade(tradeOf()); render(); },
  accept: () => step('Trade', () => { const t = tradeOf(); if (!judgeTrade(t).accept) throw new Error('The deal fell through.'); X.complete(G, judgeTrade(t, G)); if (G.phase === 'season') L.assignRoles(G); if (G.draft) L.draftNext(G, r); ui = { partner: ui.partner, give: {}, get: {}, done: true }; }),
  export: () => { G.rngState = r.state(); const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(G)], { type: 'application/json' }));
    a.download = `gm-${G.user}-${SEASON(G.season)}.json`; a.click(); },
  import: () => $('#importf').click(),
  newgame: () => { if (!G || confirm('Start over? The current game is replaced.')) { G = null; view = 'new'; render(); } },
  renounce: (pid) => { const T = me(); T.holds = T.holds.filter((h) => h.pid !== pid); T.rfa = (T.rfa || []).filter((x) => x !== pid); ui = {}; save(); render(); },
};
function faDay() {
  const ok = G.myOffers.filter((o) => G.fa.includes(o.pid));
  const done = L.faDay(G, r, { offers: ok, match: G.matchAns });
  G.myOffers = G.myOffers.filter((o) => G.fa.includes(o.pid)); G.matchAns = {};
  if (done) { L.faEnd(G, r); X.tradeWindow(G, r, `${G.season}-09-20`, L.TRADES); G.phase = 'preseason'; G.offers = X.offersFor(G); view = 'home'; }
}
const slotOf = (k) => { const [o, y, rd] = k.split('|'); return G.draft?.year === +y ? G.draft.order.find((e) => e.origin === o && (e.slot <= 30) === (rd === '1'))?.slot : null; };
const pickName = (k) => { const [o, y, rd] = k.split('|'), n = slotOf(k); return `${y} ${rd === '1' ? '1st' : '2nd'} (${o}${n ? `, no. ${n}` : ''})`; };
const tradeText = (t) => { const side = (to) => [...t.moves.filter((m) => m.to === to).map((m) => { const p = P(m.pid); return `${esc(p.nm)} <small>${Math.floor(p.age)} · ${sg(p.rate)} · ${$M(C.yearOf(p.contract, G.season)?.sal || 0)} × ${yrs(p).length}</small>`; }),
  ...t.picks.filter((k) => k.to === to).map((k) => pickName(k.id))].join('<br>') || 'nothing';
  return `<div class="two"><div><small>You get</small><br>${side(G.user)}</div><div><small>You send</small><br>${side(t.moves[0].to === G.user ? t.moves[0].from : t.moves[0].to)}</div></div>`; };
const tradeOf = () => {
  const moves = [], picks = [], sat = [], B = ui.partner;
  const add = (k, from, to) => k.includes('|') ? picks.push({ id: k, from, to })
    : k.startsWith('sat:') ? (sat.push([from, k.slice(4)]), moves.push({ pid: k.slice(4), from, to })) : moves.push({ pid: k, from, to });
  for (const [k, on] of Object.entries(ui.give)) if (on) add(k, G.user, B);
  for (const [k, on] of Object.entries(ui.get)) if (on) add(k, B, G.user);
  return { moves, picks, sat };
};
// Judge a trade; any sign-and-trade is signed first, on a copy unless the trade is being made.
const judgeTrade = (t, g = structuredClone(G)) => { for (const [ab, pid] of t.sat) L.satSign(g, ab, g.players[pid]); return X.judge(g, { moves: t.moves, picks: t.picks }); };

// ---- views -------------------------------------------------------------------------------------
const TABS = [['home', 'Home'], ['roster', 'Roster'], ['league', 'League'], ['trade', 'Trade'], ['log', 'Moves'], ['menu', 'Game']];
function render() {
  if (!G) { root().innerHTML = newGame(); return; }
  const phase = { preseason: 'Preseason', season: 'Season', playoffs: 'Playoffs', offseason: 'Offseason', draft: 'Draft', freeagency: 'Free agency' }[G.phase];
  const extra = G.phase === 'draft' ? [['draft', 'Draft']] : G.phase === 'playoffs' ? [['playoffs', 'Playoffs']] : ['freeagency', 'preseason', 'season'].includes(G.phase) ? [['fa', 'Free agents']] : G.step === 'decisions' ? [['decisions', 'Decisions']] : [];
  root().innerHTML = `<div class="top"><strong>${esc(NAME(G.user))}</strong> <span>${SEASON(G.season)} · ${phase} · ${G.date}</span></div>
${capStrip()}
<div class="tabs" role="navigation">${[...TABS.slice(0, 1), ...extra, ...TABS.slice(1)].map(([k, n]) => `<button data-act="go" data-arg="${k}"${view === k ? ' aria-current="page"' : ''}>${n}</button>`).join('')}</div>
<section>${(VIEWS[view] || VIEWS.home)()}</section>`;
}
// The season whose books matter now: after the season ends, next season's commitments against its
// projected cap (the cap is drawn July 1).
const books = (ab = G.user) => {
  const s = G.season + (['offseason', 'draft'].includes(G.phase) ? 1 : 0), f = G.f[s] || C.figures(s, L.capAt(G, s));
  const Lg = { ...G, f: { ...G.f, [s]: f } }, T = G.teams[ab];
  return { s, f, pay: C.teamSalary(T, Lg, s), capPay: C.teamSalary(T, Lg, s, { holds: true, offseason: G.phase !== 'season' }) };
};
const capStrip = (ab = G.user) => {
  const { s, f, pay, capPay } = books(ab), d = (x) => `${$M(Math.abs(x))} ${x >= 0 ? 'under' : 'over'}`;
  return `<div class="cap" role="status"><b>${ab === G.user ? '' : `${esc(NAME(ab))}: `}${SEASON(s)} payroll ${$M(pay)}</b><span>${capPay <= f.cap ? `${$M(f.cap - capPay)} cap room` : `${$M(capPay - f.cap)} over the cap`}</span>
<span>${d(f.tax - pay)} the tax</span><span>${d(f.apron1 - pay)} the first apron</span><span>${d(f.apron2 - pay)} the second</span>${s > G.season ? '<span>(projected cap)</span>' : ''}</div>`;
};
const payroll = (ab = G.user) => {
  const T = G.teams[ab], { s, f, pay, capPay } = books(ab);
  const line = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  return `<div class="pay">${line(`${SEASON(s)} payroll`, $M(pay))}${line('Cap', $M(f.cap))}${line('Tax line', $M(f.tax))}${line('First apron', $M(f.apron1))}${line('Second apron', $M(f.apron2))}
${line('Cap room', $M(Math.max(f.cap - capPay, 0)))}${T.hardCap ? line('Hard cap', T.hardCap === 'apron1' ? 'first apron' : 'second apron') : ''}
${['ntmle', 'tpmle', 'roomMle', 'bae'].filter((k) => T.exc?.[k] > 0 && (k === 'tpmle' ? pay <= f.apron2 : k === 'roomMle' ? capPay <= f.cap : pay <= f.apron1)).map((k) => line({ ntmle: 'Mid-level', tpmle: 'Taxpayer MLE', roomMle: 'Room MLE', bae: 'Bi-annual' }[k], $M(T.exc[k]))).join('')}
${T.tpes.filter((e) => !e.dpe).length ? line('Trade exceptions', T.tpes.filter((e) => !e.dpe).map((e) => $M(e.amt)).join(', ')) : ''}${T.tpes.filter((e) => e.dpe && e.expires >= G.date).map((e) => line(`Disabled player exception (${esc(P(e.from).nm)})`, $M(e.amt))).join('')}${T.dead.filter((x) => x.s === s).length ? line('Dead money', $M(T.dead.filter((x) => x.s === s).reduce((a, x) => a + x.amt, 0))) : ''}</div>`;
};
const yrs = (p) => (p.contract?.years || []).filter((y) => y.s >= G.season);
const contract = (p) => yrs(p).map((y) => `${SEASON(y.s)} ${$M(y.sal)}${y.opt ? (y.opt === 'tm' ? ' (team option)' : ' (player option)') : ''}${y.gtd < y.sal ? ` (${$M(y.gtd)} guaranteed)` : ''}`).join('<br>');
// games and minutes: this season's so far, else his last season's
const usage = (p) => { const gp = G.cur?.gp[p.id], l = p.log?.at(-1);
  return G.cur ? `${gp || 0} gp, ${gp ? (G.cur.mins[p.id] / gp).toFixed(1) : '0.0'} mpg` : l ? `${SEASON(l.s)}: ${l.gp} gp, ${l.mpg} mpg` : ''; };
const playerRow = (p, extra = '') => `<tr data-act="sel" data-arg="${p.id}" class="${ui.pid === p.id ? 'on' : ''}"><td><b>${esc(p.nm)}</b><small>${[p.pos, p.ht, Math.floor(p.age), p.contract?.twoWay && 'two-way', !p.pre && usage(p)].filter(Boolean).join(' · ')}</small>${p.pre ? pre(p) : ''}</td>
<td class="n">${sg(p.rate)}</td><td class="n">${M.war(p, 0, G.K).toFixed(1)}</td>${extra}</tr>`;
// a prospect's last season before the draft, per game
const pre = (p) => { const [pts, trb, ast, stl, blk, fg, fg3, ft, g, mp] = p.pre.line, pc = (x) => (x == null ? '–' : (100 * x).toFixed(0));
  return `<small>${p.pre.lvl}${p.wt ? ` · ${p.wt} lb` : ''}: ${pts} pts, ${trb} reb, ${ast} ast, ${stl} stl, ${blk} blk; ${pc(fg)}/${pc(fg3)}/${pc(ft)} shooting; ${mp} mpg in ${g} g</small>`; };
const logTable = (p) => !p.log?.length ? '' : `<div class="scroll"><table class="t log2"><thead><tr><th>Season</th><th>Club</th><th class="n">GP</th><th class="n">MPG</th><th class="n">Rtg</th><th class="n">Pts/Reb/Ast per 100</th></tr></thead><tbody>
${p.log.map((l) => `<tr><td>${SEASON(l.s)}</td><td>${l.tm || ''}</td><td class="n">${l.gp}</td><td class="n">${l.mpg}</td><td class="n">${l.rate == null ? '–' : sg(l.rate)}</td><td class="n">${l.p100 ? l.p100.join(' / ') : ''}</td></tr>`).join('')}</tbody></table></div>`;
const detail = (p, actions = '') => `<tr class="det"><td colspan="9">${p.draft ? `Drafted ${p.draft.year}, round ${p.draft.round}, pick ${p.draft.pick}. ` : ''}${p.yos} years of service.
Projected to be available for ${Math.round(100 * (p.av ?? 0.9))}% of games.${p.contract ? `<br>${contract(p)}` : ''}${logTable(p)}${actions}</td></tr>`;
const extInfo = (p) => { const start = p.contract.years.at(-1).s + 1;
  return { start, t: C.extensionTerms(p, G.date, G.f[start] || C.figures(start, L.capAt(G, start))), a: L.extensionAsk(G, p) }; };
// An extension, when the rules allow one now: his ask, and the most the rules let you offer.
const extForm = (p) => {
  if (!p.contract || p.contract.twoWay || !['preseason', 'season', 'freeagency'].includes(G.phase)) return '';
  const { start, t, a } = extInfo(p);
  if (t.errors.length) return '';
  const sal = Math.min(a.sal, t.maxY1);
  return `<div class="form"><p class="note">Eligible for an extension: he asks ${$M(a.sal)} a year from ${SEASON(start)}; the rules allow up to ${$M(t.maxY1)} for up to ${t.maxNew} more seasons.</p>
<label>Year one ($M) <input id="xsal" type="number" step="0.1" value="${(sal / 1e6).toFixed(1)}"></label>
<label>Seasons <input id="xyrs" type="number" min="1" max="${t.maxNew}" value="${Math.min(a.years, t.maxNew)}"></label>${btn('extend', 'Offer the extension', p.id)}${ui.err ? `<p class="bad">${esc(ui.err)}</p>` : ''}</div>`;
};
// The coach's rotation: his order, the role it makes, the minutes he'd give a man when he plays,
// and who is out hurt right now.
const ROLE = (i, p) => p.contract?.twoWay ? 'two-way' : i < 5 ? 'starter' : i < 9 ? 'rotation' : i < 12 ? 'spot minutes' : 'end of bench';
const rotationCard = () => {
  const out = (p) => G.cur && G.cur.hurt[p.id]?.[G.cur.played[G.user]];
  return `<div class="card"><h3>The coach's rotation</h3><p class="note">The coach sets it${G.rolesSet ? ': mostly last season\'s roles, nudged by each man\'s rating, age and a change of club, with his own read on top (fit to real seasons). Rookies by draft slot' : ' (for now, this season\'s real roles)'}.
Minutes are per game when he plays: each night 240 go down the rotation among whoever is healthy, no one over 36, so the end of the bench plays when others are hurt.</p><ol class="rot">
${L.rotation(G, G.user).map(([p, m], i) => `<li><b>${esc(p.nm)}</b> <small>${ROLE(i, p)} · ${m.toFixed(0)} min${out(p) ? ' · <span class="bad">out injured</span>' : ''}</small></li>`).join('')}</ol></div>`;
};
const VIEWS = {
  home: () => {
    const [say, ...b] = NEXT[G.phase]();
    const T = me(), rec = G.cur?.record[G.user], last = G.history.at(-1);
    return `<div class="card"><p>${say}</p><div class="row">${b.filter(Boolean).join('')}</div></div>
${(G.offers || []).map((t, i) => `<div class="card"><h3>Offer from ${esc(NAME(t.moves[0].to))}</h3>${tradeText(t)}<div class="row">${btn('take', 'Accept', i)}${btn('pass', 'Decline', i, 'warn')}</div></div>`).join('')}
<div class="card"><h3>${esc(NAME(G.user))}</h3><p>${rec ? `Record ${rec.w}-${rec.l}. ` : ''}Projected wins ${L.projWins(G, G.user).toFixed(1)}; ${std(T).length} standard contracts, ${T.roster.length - std(T).length} two-way.
${last ? `<br>Last season: ${summary(last)}` : ''}</p>${payroll()}</div>
${(() => { const gone = G.log.filter((x) => x.type === 'retire' && x.team === G.user && x.date >= `${G.season}-06-01`); return gone.length && G.phase === 'freeagency' ? `<div class="card"><p>Retired this summer: ${gone.map((x) => esc(P(x.pid).nm)).join(', ')}.</p></div>` : ''; })()}
${G.dev?.length && ['draft', 'offseason'].includes(G.phase) ? `<div class="card"><h3>How your players developed</h3><p class="note">Rating at the end of the season against the start${G.hidden ? ', as the league now sees it' : ''}.</p>
${G.dev.map(([id, b, a]) => `<div>${esc(P(id).nm)} <small>${Math.floor(P(id).age)}</small>: ${sg(b)} → ${sg(a)} <b class="${a >= b ? 'good' : 'bad'}">(${sg(a - b)})</b></div>`).join('')}</div>` : ''}
<p class="note">${G.hidden ? 'Ratings are what the league can see: each player\'s true talent is hidden and shows itself as he plays.' : 'Ratings are the truth: each player is exactly as good as his projection.'}
Ratings are points per 100 possessions against an average player; WAR is wins above a replacement player this season.</p>`;
  },
  roster: () => {
    const T = me(), ps = T.roster.map(P).sort((a, b) => !!a.contract?.twoWay - !!b.contract?.twoWay || b.rate - a.rate);
    const canWaive = G.phase !== 'draft';
    return `${rotationCard()}<table class="t"><thead><tr><th>Player</th><th class="n">Rtg</th><th class="n">WAR</th><th class="n">Salary</th><th class="n">Yrs</th></tr></thead><tbody>
${ps.map((p) => playerRow(p, `<td class="n">${$M(C.yearOf(p.contract, G.season)?.sal || 0)}</td><td class="n">${yrs(p).length}</td>`)
      + (ui.pid === p.id ? detail(p, extForm(p) + (canWaive ? `<div class="row"><label><input type="checkbox" id="stretch"> stretch</label>${btn('waive', 'Waive', p.id, 'warn')}</div>` : '')) : '')).join('')}</tbody></table>${payroll()}`;
  },
  league: () => {
    const rec = G.cur?.record || (G.lastRecord && G.phase !== 'preseason' ? G.lastRecord : null);
    const conf = (c) => {
      const T = Object.keys(G.teams).filter((ab) => G.teams[ab].conf === c);
      const rows = rec ? T.sort((a, b) => rec[b].w - rec[a].w || rec[a].l - rec[b].l).map((ab) => [ab, rec[ab].w, rec[ab].l])
        : T.map((ab) => [ab, L.projWins(G, ab)]).sort((a, b) => b[1] - a[1]).map(([ab, w]) => [ab, w.toFixed(1), '']);
      return `<h3>${c}</h3><table class="t"><thead><tr><th>Team</th><th class="n">${rec ? 'W' : 'Proj. W'}</th><th class="n">${rec ? 'L' : ''}</th></tr></thead><tbody>
${rows.map(([ab, w, l], i) => `<tr class="${ab === G.user ? 'me' : ''}${i === 5 || i === 9 ? ' cut' : ''}"><td>${i + 1}. ${esc(NAME(ab))}</td><td class="n">${w}</td><td class="n">${l}</td></tr>`).join('')}</tbody></table>`;
    };
    const hist = G.history.slice().reverse().map((h) => `<tr><td>${SEASON(h.season)}</td><td class="n">${h.record[G.user].join('-')}</td><td>${esc(playoffs(h))}</td><td>${h.champion}</td></tr>`).join('');
    return `${conf('East')}${conf('West')}${hist ? `<h3>Your seasons</h3><table class="t"><thead><tr><th>Season</th><th class="n">W-L</th><th>Playoffs</th><th>Champion</th></tr></thead><tbody>${hist}</tbody></table>` : ''}`;
  },
  trade: () => {
    const others = Object.keys(G.teams).filter((ab) => ab !== G.user).sort();
    ui.partner ||= others[0]; ui.give ||= {}; ui.get ||= {};
    const B = ui.partner, pv = X.picksView(G);
    const assets = (ab, side) => {
      const ps = G.teams[ab].roster.map(P).sort((a, b) => b.rate - a.rate);
      const pk = Object.values(pv).filter((k) => k.holder === ab && k.year > G.season).sort((a, b) => a.year - b.year || a.round - b.round);
      const ck = (k, label) => `<label class="ck"><input type="checkbox" data-act="tk" data-arg="${side}#${k}"${ui[side][k] ? ' checked' : ''}> ${label}</label>`;
      const sat = G.phase === 'freeagency' ? G.teams[ab].holds.map((h) => P(h.pid)).filter((p) => G.fa.includes(p.id) && !G.teams[ab].rfa?.includes(p.id)) : [];
      return sat.map((p) => { const o = L.satTerms(G, ab, p); return ck(`sat:${p.id}`, `<b>${esc(p.nm)}</b> <small>sign-and-trade · ${Math.floor(p.age)} · ${sg(p.rate)} · ${$M(o.sal)} × ${o.years}</small>`); }).join('')
        + ps.map((p) => ck(p.id, `<b>${esc(p.nm)}</b> <small>${Math.floor(p.age)} · ${sg(p.rate)} · ${$M(C.yearOf(p.contract, G.season)?.sal || 0)} × ${yrs(p).length}</small>`)).join('')
        + pk.map((k) => ck(k.id, `${k.year} ${k.round === 1 ? '1st' : '2nd'} <small>(${k.origin}${slotOf(k.id) ? `, no. ${slotOf(k.id)}` : ''}${k.protect ? ', protected' : ''})</small>`)).join('');
    };
    const v = ui.verdict, md = { contend: 'contending', middle: 'in the middle', rebuild: 'rebuilding' }[X.mode(L.projWins(G, B))];
    const say = !v ? '' : !v.ok ? `<p class="bad">Not allowed: ${esc(v.errors.join('; '))}.</p>`
      : v.accept ? `<p class="good">${esc(NAME(B))} accept.</p>${Object.entries(v.res.waive || {}).map(([ab, n]) => `<p class="note">${ab === G.user ? `You will have to waive ${n}` : `${esc(NAME(ab))} will waive ${n}`} to get back to the roster limit.</p>`).join('')}${btn('accept', 'Make the trade')}`
      : `<p class="bad">${esc(NAME(B))} decline: they would want about ${$M(Math.max(F().cap * X.MIN_GAIN - v.gains[B], 0))} more in value.</p>`;
    const open = G.phase !== 'season' || G.date <= C.seasonDates(G.season).deadline;
    return `<div class="card"><label>Trade with <select id="partner" data-chg="partner">${others.map((ab) => `<option value="${ab}"${ab === B ? ' selected' : ''}>${esc(NAME(ab))}</option>`).join('')}</select></label>
${capStrip(B)}<details><summary>Their cap sheet</summary>${payroll(B)}</details><p class="note">${esc(NAME(B))} are ${md}.${open ? '' : ' The deadline has passed.'}${ui.done ? ' Trade done.' : ''}</p></div>
<div class="two"><div><h3>You send</h3>${assets(G.user, 'give')}</div><div><h3>You get</h3>${assets(B, 'get')}</div></div>
<div class="card sticky">${(() => { const t = tradeOf(), sal = (to) => t.moves.filter((m) => m.to === to).reduce((a, m) => a + (C.yearOf(P(m.pid).contract, G.season)?.sal || (t.sat.some(([, id]) => id === m.pid) ? L.satTerms(G, m.from, P(m.pid)).sal : 0)), 0);
  return `<p class="note">Salary out ${$M(sal(B))}, in ${$M(sal(G.user))}.</p>`; })()}${btn('propose', 'Propose')}${say}</div>`;
  },
  playoffs: () => {
    const po = G.po;
    if (!po) return '<p>No playoffs under way.</p>';
    const pin = ['East', 'West'].map((c) => { const p = po.playin[c]; return `<p class="note">${c} play-in: ${p.w78} take the 7 seed; ${p.eighth} take the 8 seed; ${p.out.join(' and ')} are out.</p>`; }).join('');
    const games = (x) => x.g.map((g, i) => `<li>Game ${i + 1} at ${g.h}: <b class="${g.win === G.user ? 'good' : (x.hi === G.user || x.lo === G.user) ? 'bad' : ''}">${g.win}</b> by ${g.by}</li>`).join('');
    const card = (x, done) => { const mine = x.hi === G.user || x.lo === G.user;
      return `<div class="card${mine ? ' mine' : ''}"><b>${esc(NAME(x.hi))} ${x.w}, ${esc(NAME(x.lo))} ${x.l}</b>${done || S.seriesDone(x) ? ` <small>${(x.w === 4 ? x.hi : x.lo)} win</small>` : ''}${mine ? `<ol class="games">${games(x)}</ol>` : ''}</div>`; };
    const past = po.rounds.map((rd, i) => `<h3>${ROUND[i]}</h3>${Object.values(rd).map((v, j) => { const [hi, lo] = Object.keys(rd)[j].split('-'); const [w, l] = v.games.split('-').map(Number); return card({ hi, lo, w, l, g: v.g }, true); }).join('')}`).reverse().join('');
    return `${po.champion ? '' : `<h3>${ROUND[po.round]}</h3>${po.series.map((x) => card(x)).join('')}`}${past}${pin}`;
  },
  draft: () => {
    if (!G.draft) return '<p>No draft under way.</p>';
    const c = L.draftNext(G, r), made = G.draft.picks.slice(-8).reverse();
    const pool = G.draft.avail.map(P).sort((a, b) => b.rate - a.rate);
    const next = G.draft.order.slice(G.draft.picks.length, G.draft.picks.length + 8);
    const mine = me().roster.map(P).filter((p) => !p.contract?.twoWay), byPos = (k) => mine.filter((p) => (p.pos || '').startsWith(k)).length;
    return `<div class="card">${c ? `<p>Pick ${c.slot} is yours.</p>${btn('autopick', 'Best available')}` : `<p>The draft is done.</p>${btn('enddraft', 'Finish the draft')}`}
<p class="note">On the clock next: ${next.map((e) => `${e.slot}. ${e.holder}`).join(', ')}. You can trade picks and players until your pick is in.</p>
<p class="note">Your roster: ${byPos('G')} guards, ${byPos('F')} forwards, ${byPos('C')} centers.</p></div>
<table class="t"><thead><tr><th>Prospect</th><th class="n">Rtg</th><th class="n">WAR</th><th></th></tr></thead><tbody>
${pool.slice(0, 60).map((p) => playerRow(p, `<td>${c ? btn('pick', 'Pick', p.id) : ''}</td>`)).join('')}</tbody></table>
<p class="note">Rtg is the league's read of each prospect from the scouts' board; his line is his last season before the draft, per game.</p>
<h3>Latest picks</h3><ul>${made.map((x) => `<li>${x.slot}. ${x.team}: ${esc(P(x.pid).nm)}</li>`).join('')}</ul>`;
  },
  decisions: () => {
    const T = me(), s = G.season + 1, c = G.choices ||= {};
    const opts = T.roster.map(P).filter((p) => C.yearOf(p.contract, s)?.opt === 'tm');
    const qos = T.roster.map(P).filter((p) => p.contract?.rookie && p.draft?.round === 1 && !C.yearOf(p.contract, s));
    const row = (k, p, what) => `<label class="ck"><input type="checkbox" data-act="toggle" data-arg="${k}|${p.id}"${c[`${k}|${p.id}`] ? ' checked' : ''}> <b>${esc(p.nm)}</b> <small>${Math.floor(p.age)} · ${sg(p.rate)} · ${what}</small></label>`;
    return `<div class="card"><h3>Team options for ${SEASON(s)}</h3>${opts.map((p) => row('opt', p, `pick up ${$M(C.yearOf(p.contract, s).sal)}`)).join('') || '<p>None.</p>'}
<h3>Qualifying offers</h3><p class="note">Tendering one makes the player a restricted free agent: you may match any offer sheet.</p>
${qos.map((p) => row('qo', p, 'tender')).join('') || '<p>None.</p>'}${btn('newyear', 'Start the new league year')}</div>`;
  },
  resign: () => {
    if (G.fa_) return VIEWS.fa();
    const T = me(), c = G.choices ||= {};
    const mine = T.holds.map((h) => P(h.pid)).filter((p) => G.fa.includes(p.id));
    return `<div class="card"><h3>Your free agents</h3><p class="note">Each one's terms: his ask, as far as his Bird rights let you pay it.</p>
${mine.map((p) => { const o = L.resignTerms(G, G.user, p); return `<label class="ck"><input type="checkbox" data-act="toggle" data-arg="re|${p.id}"${c[`re|${p.id}`] ? ' checked' : ''}> <b>${esc(p.nm)}</b> <small>${Math.floor(p.age)} · ${sg(p.rate)} · ${$M(o.sal)} × ${o.years} (${o.how})${T.rfa?.includes(p.id) ? ' · restricted' : ''}</small></label>`; }).join('') || '<p>None.</p>'}
${btn('market', 'Open the market')}</div>`;
  },
  fa: () => {
    const open = G.phase !== 'freeagency';                      // after the summer market: sign on the spot
    if (!G.fa_ && !open) return VIEWS.resign();
    const f = F(), sheets = open ? [] : Object.entries(G.fa_.sheets);
    const pool = G.fa.map(P).filter((p) => !p.retired).sort((a, b) => b.rate - a.rate).slice(0, 80);
    const ask = (p) => L.askOf(G, p, f);
    const lvl = (p) => me().holds.some((h) => h.pid === p.id) && C.birdLevel(p, G.user);
    const hows = (p) => [...(lvl(p) ? [{ full: 'bird', early: 'earlyBird' }[lvl(p)] || 'nonBird'] : []), 'room', 'ntmle', 'tpmle', 'roomMle', 'bae', 'min', ...(p.yos < 4 ? ['twoWay'] : []), ...(me().tpes.some((x) => x.dpe && x.expires >= G.date) ? ['dpe'] : [])];
    const valid = (p, how) => C.validateSigning(G, { team: G.user, pid: p.id, how, date: G.date, prior: (p.prior || 0) * 1e6,
      years: L.years5(how === 'min' ? C.minSalary(p.yos, f.cap) : ask(p).sal, how === 'min' ? 1 : Math.min(ask(p).years, 2), 0.05) }).ok;
    const form = (p) => { const h0 = hows(p).find((h) => valid(p, h)) || 'min'; return `<div class="form"><label>Using <select id="how">${hows(p).map((h) => `<option${h === h0 ? ' selected' : ''}>${h}</option>`).join('')}</select></label>
<label>Salary ($M) <input id="sal" type="number" step="0.1" value="${(ask(p).sal / 1e6).toFixed(1)}"></label>
<label>Years <input id="yrs" type="number" min="1" max="5" value="${ask(p).years}"></label>${btn('offer', 'Make the offer')}${lvl(p) ? btn('renounce', 'Renounce his rights', p.id, 'warn') : ''}${ui.err ? `<p class="bad">${esc(ui.err)}</p>` : ''}</div>`; };
    return `${sheets.map(([pid, o]) => `<div class="card"><p>${esc(NAME(o.ab))} offer ${esc(P(pid).nm)} ${$M(o.sal)} × ${o.years}.</p>${btn('match', 'Match', `${pid}|1`)}${btn('match', 'Let him go', `${pid}|0`)}${pid in G.matchAns ? ` <small>${G.matchAns[pid] ? 'matching' : 'declining'}</small>` : ''}</div>`).join('')}
${open ? `<div class="card"><p class="note">The market has closed: whoever is left signs on the spot for an offer at half his summer ask or better.</p></div>` : `<div class="card"><h3>Your offers</h3>${G.myOffers.map((o) => `<div>${esc(P(o.pid).nm)}: ${$M(o.sal)} × ${o.years} (${o.how}) ${btn('unoffer', 'Withdraw', o.pid)}</div>`).join('') || '<p>None out.</p>'}
<p class="note">A player signs with the richest offer that meets his ask; asks fall as the summer goes on.</p><div class="row">${btn('faday', 'Next day')}${btn('farest', 'Sim to the end')}</div></div>`}
<table class="t"><thead><tr><th>Free agent</th><th class="n">Rtg</th><th class="n">WAR</th><th class="n">Ask</th></tr></thead><tbody>
${pool.map((p) => playerRow(p, `<td class="n">${$M(ask(p).sal)} × ${ask(p).years}</td>`) + (ui.pid === p.id ? detail(p, form(p)) : '')).join('')}</tbody></table>${payroll()}`;
  },
  log: () => {
    const mine = ui.all ? G.log : G.log.filter((x) => (x.teams || [x.team]).includes(G.user));
    const line = (x) => x.type === 'trade' ? `${x.teams.join(' / ')}: ${x.moves ? x.moves.map((m) => `${esc(P(m.pid).nm)} to ${m.to}`).join(', ') : x.players.map((id) => esc(P(id).nm)).join(', ')}${x.picks.length ? `; picks ${x.picks.map((k, i) => `${k.split('|').slice(0, 2).join(' ')} ${k.endsWith('|1') ? '1st' : '2nd'} to ${x.pickTo?.[i] ?? ''}`).join(', ')}` : ''}`
      : x.type === 'sign' ? `${x.team} sign ${esc(P(x.pid).nm)}, ${$M(x.sal)} × ${x.years}` : x.type === 'extend' ? `${x.team} extend ${esc(P(x.pid).nm)}, ${$M(x.sal)} × ${x.years} more` : x.type === 'retire' ? `${esc(P(x.pid).nm)} retires${x.team ? ` (${x.team})` : ''}` : `${x.team} waive ${esc(P(x.pid).nm)}`;
    return `<div class="row">${btn('logall', ui.all ? 'Your club only' : 'Every club')}</div><ul class="log">${mine.slice(-150).reverse().map((x) => `<li><small>${x.date}</small> ${line(x)}</li>`).join('')}</ul>`;
  },
  menu: () => `<div class="card"><h3>This game</h3><p>${esc(NAME(G.user))}, ${G.hidden ? 'hidden talent' : 'projections as the truth'}, started ${SEASON(G.history[0]?.season ?? G.season)}. Saved in this browser after every step.</p>
<div class="row">${btn('export', 'Export the save')}${btn('import', 'Import a save')}${btn('newgame', 'New game', '', 'warn')}</div></div>`,
};
ACT.logall = () => { ui.all = !ui.all; render(); };

function newGame() {
  return `<div class="card"><h2>Run a club</h2><p>Take over any team on the eve of the 2026-27 season, with its real roster, contracts and picks.
Every rule of the collective bargaining agreement applies; the other 29 clubs are run by computer GMs who value players the way this site does, each with his own leanings.</p>
<label>Club <select id="team">${Object.entries(TEAMS).sort((a, b) => a[1].localeCompare(b[1])).map(([ab, n]) => `<option value="${ab}">${esc(n)}</option>`).join('')}</select></label>
<fieldset><legend>Talent</legend><label class="ck"><input type="radio" name="mode" value="hidden" checked> Hidden: ratings are estimates, and players turn out better or worse</label>
<label class="ck"><input type="radio" name="mode" value="truth"> The truth: every player is exactly his projection</label></fieldset>
<div class="row"><button class="b" id="create">Start</button>${btn('import', 'Import a save')}</div></div>`;
}
let TEAMS = {};

// ---- wiring ------------------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && root().contains(b) && b.tagName !== 'SELECT') { if (b.tagName === 'TR' && e.target.closest('button,input,label,select')) return; ACT[b.dataset.act](b.dataset.arg); }
  if (e.target.id === 'create') create();
});
document.addEventListener('change', (e) => { if (e.target.dataset.chg) ACT[e.target.dataset.chg](); });
async function data() { return (await fetch('gm/league.json')).json(); }
async function create() {
  const team = $('#team').value, hidden = document.querySelector('input[name=mode]:checked').value === 'hidden';
  root().insertAdjacentHTML('beforeend', '<div class="busy" role="status">Building the league…</div>');
  const d = await data(), seed = Math.floor(Math.random() * 2 ** 31);
  adopt(L.newGame(d.league, d.cal, { team, hidden, seed }));
  view = 'home'; await save(); render();
}
async function boot() {
  $('#importf').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    adopt(JSON.parse(await f.text())); view = 'home'; await save(); render();
  });
  const g = await idb('readonly', (s) => s.get('game')).catch(() => null);
  TEAMS = JSON.parse(root().dataset.teams);         // the start screen needs only the names; the league loads on Start
  if (g) adopt(g);
  render();
}
boot();
