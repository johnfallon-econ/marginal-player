// The GM game page (site/gm.html): one club in the simulated league, the rest run by computer GMs.
// The whole game is one plain object, saved to the browser (IndexedDB) after every step.
import * as L from './league.js';
import * as S from './season.js';
import * as C from './cba.js';
import * as M from './value.js';
import * as X from './trades.js';
import * as A from './awards.js';
import * as B from './board.js';
import * as O from './owner.js';
import * as P_ from './picks.js';
import * as GM from './gm.js';
import * as V from './dev.js';
import * as ST from './staff.js';

let G = null, r = null, view = 'home', ui = {};
// a trade window's offers spread over workers, one a core but this page's (worker.js): each holds the
// league for the window, given it at the start and every deal after, and draws up its share of each round
const POOL = Array.from({ length: Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1)) }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
let job = 0;
const ask = (w, msg) => new Promise((ok) => { const id = ++job, on = ({ data }) => { if (data.id === id) { w.removeEventListener('message', on); ok(data.out); } };
  w.addEventListener('message', on); w.postMessage({ ...msg, id }); });
const pool = {
  start: (G) => POOL.forEach((w) => w.postMessage({ G })),
  offers: async (date, need) => { const n = Math.ceil(need.length / POOL.length);
    return (await Promise.all(POOL.map((w, i) => need.slice(i * n, (i + 1) * n)).map((part, i) => part.length ? ask(POOL[i], { date, need: part.map(([S, p, B, V]) => [S, p.id, B, V]) }) : []))).flat(); },
  done: (trade, res, wins) => POOL.forEach((w) => w.postMessage({ trade, res, wins })),
};
const tradeWindow = (date, n, userAb) => X.tradeWindowWith(pool, G, r, date, n, userAb);
const $ = (s) => document.querySelector(s), root = () => $('#gm');
const P = (id) => G.players[id], me = () => G.teams[G.user], F = () => G.f[G.season];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// a man's wins above replacement this season, at the minutes and availability he is projected for
// a player as you see him: with the truth shown only to you (G.reveal), his talent, not the league's read
// or, in the hidden game, the league's read and your staff's together (staff.js)
const sp = (p) => (G.reveal ? { ...p, rate: p.talent, se: 0 } : G.hidden ? { ...p, rate: ST.read(G, p) } : p);
const wr = (p) => `${M.war(sp(p), 0, G.K).toFixed(1)} mWAR`;
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
  setTimeout(async () => { try { await f(); await save(); } catch (e) { console.error(e); alert(e.message); } render(); }, 30);
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
    const rec = G.cur.record[G.user], n = std(me()).length, over = std(me()).filter((id) => !P(id).contract.tenDay).length;   // a 10-day man under the hardship exception may be a 16th
    if (over > 15) return [`You carry ${over} standard contracts after the trade: waive down to 15 before the next game.`, btn('autocut', 'Make the cuts for me'), btn('go', 'Choose the cuts', 'roster')];
    if (n < 13) return [`You carry ${n} standard contracts after the trade: sign up to 13 before the next game.`, btn('autofill', 'Sign the best left at the minimum'), btn('go', 'Choose free agents', 'fa')];
    return [`${rec.w}-${rec.l} after ${rec.w + rec.l} games. ${w < 2 ? 'Clubs can trade until the deadline.' : 'The deadline has passed.'}`, btn('sim', to)];
  },
  playoffs: () => {
    const po = G.po, x = mySeries();
    if (po.champion) return [`The ${NAME(po.champion)} are champions.`, btn('poend', 'On to the offseason')];
    const live = x && !S.seriesDone(x);
    const say = live ? `${seriesLine(x)}. ${nextGameLine(x)}` : x ? `${seriesLine(x)}.` : made() ? 'Your season is over.' : 'You missed the playoffs.';
    return [say, live && btn('pgame', `Play game ${x.w + x.l + 1}`), live && btn('pseries', 'Sim the series'),
      S.roundDone(po) ? btn('pround', ['Start the second round', 'Start the conference finals', 'Start the Finals', 'Crown the champion'][po.round]) : btn('pround', 'Sim the round'),
];
  },
  offseason: () => G.step === 'decisions' ? [`Options and qualifying offers are due before the new league year.${G.calls?.length ? ` ${G.calls.length === 1 ? 'A club is' : `${G.calls.length} clubs are`} calling about you: see Decisions.` : ''}`, btn('newyear', 'Start the new league year')]
    : [summary(G.history.at(-1)), btn('todraft', 'On to the draft')],
  draft: () => { const c = L.onClock(G); if (!c) return ['The draft is done.', btn('enddraft', 'Finish the draft')];
    if (c.holder === G.user) return [`You are on the clock with pick ${c.slot}.`, btn('go', 'Pick a player', 'draft')];
    const next = G.draft.order.slice(G.draft.picks.length).find((e) => e.holder === G.user);
    return [`Pick ${c.slot}: the ${NAME(c.holder)} are on the clock. ${next ? `Your next pick is ${next.slot}, ${next.slot - c.slot} away.` : 'You have no more picks.'} Trade for a pick before it is made.`,
      btn('dnext', 'Next pick'), btn('dnext', 'Next 5 picks', 5), btn('dto', next ? 'Sim to my pick' : 'Sim the rest'), btn('go', 'Draft board', 'draft'), btn('tradeclock', `Trade with ${c.holder}`, c.holder)]; },
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
// a button; one that only goes to another tab is drawn in outline, so the step that acts stands out
const btn = (act, label, arg = '', cls = act === 'go' ? 'ghost' : '') => `<button class="b ${cls}" data-act="${act}" data-arg="${esc(arg)}">${esc(label)}</button>`;
const summary = (h) => `${SEASON(h.season)}: ${h.record[G.user].join('-')}. ${playoffs(h)} Champion: ${NAME(h.champion)}.`;
function playoffs(h) {
  const made = h.seeds.East.includes(G.user) || h.seeds.West.includes(G.user);
  const rounds = h.rounds.map((rd, i) => Object.entries(rd).filter(([k]) => k.split('-').includes(G.user)).map(([k, v]) => `${['First round', 'Conference semifinals', 'Conference finals', 'Finals'][i]}: ${v.winner === G.user ? 'won' : 'lost'} ${v.games.split('-').sort().reverse().join('-')} vs ${k.split('-').find((x) => x !== G.user)}`)).flat();
  return made ? rounds.join('; ') + '.' : 'Missed the playoffs.';
}

// ---- actions -----------------------------------------------------------------------------------
const ACT = {
  go: (a) => { view = a; ui = {}; render(); },
  // the draft's trade button: the club on the clock, its pick on the table
  tradeclock: (ab) => { const c = L.onClock(G), k = Object.values(X.picksView(G)).find((x) => x.year === G.draft.year && x.origin === c.origin && x.round === (c.slot <= 30 ? 1 : 2));
    view = 'trade'; ui = { partner: ab, give: {}, get: k ? { [k.id]: true } : {} }; render(); },
  autocut: () => step('Cutting', () => L.cutdown(G, r, G.user)),
  autofill: () => step('Signing', () => L.fillRosters(G, [G.user])),
  start: () => step('Opening night', () => {
    const ai = Object.keys(G.teams).filter((ab) => ab !== G.user);
    L.fillRosters(G, ai); for (const ab of ai) L.cutdown(G, r, ab);
    L.seasonStart(G, r); G.cur.win = 0; G.offers = [];
    G.ownerSay = O.opening(G);
  }),
  sim: () => step('Simulating', async () => {
    const w = G.cur.win++, d = C.seasonDates(G.season), before = { ...G.cur.record[G.user], log: G.log.length };
    if (w < 2) { L.seasonTo(G, r, L.WINDOWS[w].frac); G.date = d[L.WINDOWS[w].date]; await tradeWindow(G.date, L.TRADES[L.WINDOWS[w].date]); L.assignRoles(G); G.offers = X.offersFor(G); if (w === 1) G.ownerSay = O.deadline(G); }
    else L.seasonTo(G, r, 1);
    G.news = news(before);
    if (w >= 2) { L.postseasonStart(G, r); G.offers = []; view = 'home'; }
  }),
  pgame: () => { const x = mySeries(); S.seriesGame(x, G.po.nets, G.K, r); keepPace(x); save(); render(); },
  pseries: () => { const x = mySeries(); while (S.seriesGame(x, G.po.nets, G.K, r)); keepPace(x); save(); render(); },
  pround: () => step('Playoffs', () => { if (S.roundDone(G.po)) S.nextRound(G.po, r); else L.playRound(G, r); }),
  poend: () => step('Wrapping up the season', () => { L.postseasonEnd(G); view = 'home'; }),
  todraft: () => step('The lottery', async () => {
    const before = Object.fromEntries(me().roster.map((id) => [id, sp(P(id)).rate]));
    L.endSeason(G, r);
    G.ownerSay = null; O.review(G, G.history.at(-1), r);
    G.dev = Object.entries(before).map(([id, b]) => [id, b, sp(P(id)).rate]).sort((a, b) => (b[2] - b[1]) - (a[2] - a[1]));
    await tradeWindow(`${G.season + 1}-06-20`, L.TRADES.draft);
    G.offers = X.offersFor(G);
    L.draftStart(G, r); view = 'draft';
  }),
  pick: (id) => step('The draft', () => { L.draftNext(G, r, id, G.user, 0); }),
  autopick: () => step('The draft', () => { if (L.onClock(G)?.holder === G.user) L.draftNext(G, r, G.draft.avail.map(P).sort((a, b) => sp(b).rate - sp(a).rate)[0].id, G.user, 0); }),
  dnext: (n) => step('The draft', () => { L.draftNext(G, r, null, G.user, +n || 1); }),
  dto: () => step('The draft', () => { L.draftNext(G, r); }),
  enddraft: () => step('Wrapping up', () => { L.draftEnd(G); G.step = 'decisions'; G.choices = defaults(); view = 'decisions'; }),
  toggle: (k) => { G.choices[k] = !G.choices[k]; save(); render(); },   // kept at once: a reload must not drop a tick
  stash: (a) => { const [id, v] = a.split('|'); G.choices[`st|${id}`] = !!v; render(); },
  second: (a) => { const [id, v] = a.split('|'); G.choices[`sr|${id}`] = v; render(); },
  newyear: () => step('The new league year', () => {
    const c = G.choices || {};
    for (const id of me().roster.filter((x) => c[`st|${x}`])) L.stash(G, G.user, id);
    L.newLeagueYear(G, r, { teamOption: (p) => !!c[`opt|${p.id}`], qo: (p) => !!c[`qo|${p.id}`], second: (p) => (c[`sr|${p.id}`] ?? (p.abroad ? '' : 'deal')) || null });
    if (G.renewal) renew();                         // a renewal left standing is taken as offered
    delete G.step; delete G.calls; G.choices = resignDefaults(); G.offers = []; view = 'resign';
  }),
  market: () => step('Free agency opens', () => {
    const no = [];
    L.faStart(G, r, { resign: (p) => { if (!G.choices[`re|${p.id}`]) return false; const v = O.veto(G, L.resignTerms(G, G.user, p).sal); if (v) no.push(`${p.nm}: ${v}`); return !v; } }); G.myOffers = []; G.matchAns = {}; view = 'fa';
    G.ownerSay = no.length ? no.join(' ') : null;
  }),
  faday: () => step('Free agency', faDay),
  farest: () => step('Free agency', async () => { while (G.phase === 'freeagency' && !Object.keys(G.fa_.sheets).length) await faDay(); }),
  match: (a) => { const [pid, v] = a.split('|'); G.matchAns[pid] = v === '1'; render(); },
  offer: () => {
    const p = P(ui.pid), how = $('#how').value, o = { pid: p.id, ab: G.user, how, sal: how === 'min' ? C.minSalary(p.yos, F().cap) : how === 'twoWay' ? C.twoWaySalary(F().cap) : Math.round(+$('#sal').value * 1e6), years: ['min', 'twoWay', 'bae', 'tpmle'].includes(how) ? Math.min(+$('#yrs').value, 2) : +$('#yrs').value };
    const v = C.validateSigning(G, { team: G.user, pid: p.id, how: o.how, date: G.date, years: L.years5(o.sal, o.years, 0.05), prior: (p.prior || 0) * 1e6 });
    if (!v.ok) { ui.err = v.errors.join('; '); return render(); }
    const no = O.veto(G, o.sal); if (no) { ui.err = no; return render(); }
    if (G.phase !== 'freeagency') {
      if (o.how !== 'twoWay' && o.sal < 0.5 * L.askOf(G, p, F()).sal) { ui.err = `He wants at least ${$M(0.5 * L.askOf(G, p, F()).sal)}.`; return render(); }
      return step('Signing', () => { L.sign(G, G.user, p, o.how, o.sal, o.years, G.date, 0.05); if (G.phase === 'season') L.assignRoles(G); ui = {}; });
    }
    G.myOffers = G.myOffers.filter((x) => x.pid !== p.id).concat(o); ui = {}; save(); render();
  },
  unoffer: (pid) => { G.myOffers = G.myOffers.filter((x) => x.pid !== pid); save(); render(); },
  // answer the agent: meet his number, or beat the rival's offer (more in all, over the same years)
  meet: (pid) => reoffer(pid, (o) => need(P(pid))),
  beat: (pid) => reoffer(pid, (o) => { const t = G.fa_.resp[pid].top; return Math.ceil((t.sal * t.years / o.years + 1e5) / 1e5) * 1e5; }),
  card: (id) => { ui.card = id; render(); },
  closecard: () => { ui.card = null; render(); },
  noop: () => {},
  sel: (pid) => { ui.pid = ui.pid === pid ? null : pid; ui.err = null; render(); },
  rmode: (m) => { ui.rmode = m; render(); },
  // the stats table's order: a header sorts by it, again the other way; names and positions A to Z first
  rsort: (k) => { ui.rsort = [k, ui.rsort?.[0] === k ? -ui.rsort[1] : ['nm', 'pos'].includes(k) ? 1 : -1]; render(); },
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
  partner: () => { ui.partner = $('#partner').value; ui.give = {}; ui.get = {}; ui.prot = {}; ui.swGive = {}; ui.swGet = {}; ui.verdict = null; render(); },
  prot: (el) => { const n = +el.value, [, id] = el.dataset.arg.split('#'), r = +id.split('|')[2]; ui.prot[id] = n ? [1 + 30 * (r - 1), n + 30 * (r - 1)] : null; ui.verdict = null; render(); },
  tsw: (k) => { const [side, y] = k.split('#'), m = side === 'give' ? ui.swGive : ui.swGet; m[y] = !m[y]; ui.verdict = null; render(); },
  tk: (k) => { const [side, id] = k.split('#'); ui[side][id] = !ui[side][id]; ui.verdict = null; render(); },
  take: (i) => { const j = X.judge(G, G.offers[+i].trade ?? G.offers[+i]);
    if (!j.ok) { alert(`No longer allowed: ${j.errors.join('; ')}`); G.offers.splice(+i, 1); return render(); }
    step('Trade', () => { X.complete(G, j); if (G.phase === 'season') L.assignRoles(G);
      // the other offers stand unless they share a player or a pick with this one
      const used = new Set([...j.trade.moves.map((m) => m.pid), ...j.trade.picks.map((k) => k.id)]);
      G.offers = G.offers.filter((o, k) => k !== +i && ![...o.moves.map((m) => m.pid), ...o.picks.map((x) => x.id)].some((x) => used.has(x))); }); },
  pass: (i) => { G.offers.splice(+i, 1); save(); render(); },
  uncheer: () => document.querySelector('.cheer')?.remove(),
  // the trading block: the men ticked to send, shopped to every club
  shop: () => { const ids = Object.keys(ui.give).filter((k) => ui.give[k] && G.players[k]);
    if (!ids.length) { alert('Tick the players you want to shop under "You send".'); return; }
    step('Shopping them around', () => { G.offers = X.offersFor(G, G.user, 6, ids); view = 'home'; ui = {}; if (!G.offers.length) alert('No club made an offer.'); }); },
  propose: () => { ui.verdict = judgeTrade(tradeOf()); render(); },
  accept: () => step('Trade', () => { const t = tradeOf(); if (!judgeTrade(t).accept) throw new Error('The deal fell through.');
    const yr = O.season(G), sal = (pid) => C.yearOf(P(pid).contract, yr)?.sal || 0, no = O.veto(G, t.moves.reduce((a, m) => a + (m.to === G.user ? sal(m.pid) : -sal(m.pid)), 0)); if (no) throw new Error(no); X.complete(G, judgeTrade(t, G)); if (G.phase === 'season') L.assignRoles(G); ui = { partner: ui.partner, give: {}, get: {}, done: true }; }),
  export: () => { G.rngState = r.state(); const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(G)], { type: 'application/json' }));
    a.download = `gm-${G.user}-${SEASON(G.season)}.json`; a.click(); },
  import: () => $('#importf').click(),
  takejob: (ab) => { O.move(G, ab, r, offersOpen().find((o) => o.ab === ab)); if (G.step === 'decisions') G.choices = defaults(); G.ownerSay = `Welcome to the ${NAME(ab)}. Your new owner: ${O.OWNERS[G.owner.type].label.toLowerCase()}.`; view = 'home'; ui = {}; save(); render(); },
  retire: () => { G.fired.retired = true; save(); render(); },
  path: (k) => { G.fired.path = k; save(); render(); },
  // a season out, on the path chosen (simmed lightly: no one is at your controls); all: until a club calls
  away: (all) => { const f = G.fired, k = f.path || 'away';
    step(`${f.out > 1 ? `Season ${f.out} out` : 'A season out'}: ${GM.PATHS[k].label.toLowerCase()}`, async () => {
      G.lite = true; try { await L.toNextDraft(G, r, (date, k) => tradeWindow(date, L.TRADES[k], null)); } finally { delete G.lite; }
      (f.log ||= []).push({ s: G.season, path: k }); f.out += 1; f.s = G.season;
      const o = GM.offers(G, r, f.out, k); f.offers = o.clubs.map((ab) => ({ ab, ...O.terms(G, r, G.season + 1) })); f.h = o.h;
      if (all && !f.offers.length) setTimeout(() => ACT.away(true), 50);
    }); },
  staff: () => { G.staffSigns = G.staffSigns === false; save(); render(); },
  newgame: () => { if (!G || confirm('Start over? The current game is replaced.')) { G = null; view = 'new'; render(); } },
  renounce: (pid) => { const T = me(); T.holds = T.holds.filter((h) => h.pid !== pid); T.rfa = (T.rfa || []).filter((x) => x !== pid); ui = {}; save(); render(); },
  renounceall: () => { if (confirm('Renounce every one of your free agents? You lose their Bird rights.')) { const T = me(); T.rfa = (T.rfa || []).filter((x) => !T.holds.some((h) => h.pid === x)); T.holds = []; ui = {}; save(); render(); } },
};
// The summer's ticks to start from, as a computer GM would decide them: a team option picked up, a
// qualifying offer tendered and a free agent of yours re-signed when he is worth it to your club
function defaults() {
  const s = G.season + 1, c = {};
  for (const p of me().roster.map(P)) {
    const y = C.yearOf(p.contract, s);
    if (y?.opt === 'tm') c[`opt|${p.id}`] = L.teamValue(G, G.user, p) >= y.sal;
    else if (!y && p.contract?.rookie && p.draft?.round === 1)
      c[`qo|${p.id}`] = L.teamValue(G, G.user, p) >= C.rookieQO(p.draft.pick, L.capAt(G, p.draft.year), (G.lastMins?.[p.id] || 0) / 82 >= 2000 / 82);
  }
  return c;
}
const resignDefaults = () => Object.fromEntries(me().holds.map((h) => P(h.pid)).filter((p) => G.fa.includes(p.id)).map((p) => [`re|${p.id}`, L.teamValue(G, G.user, p) >= L.resignTerms(G, G.user, p).sal]));
// what a free agent takes today: his ask, falling 2.5% a day through the summer
const need = (p) => Math.ceil(L.askOf(G, p, F()).sal * (1 - 0.025 * G.fa_.day) / 1e5) * 1e5;
function reoffer(pid, salOf) {
  const o = G.myOffers.find((x) => x.pid === pid), sal = salOf(o), p = P(pid);
  const v = C.validateSigning(G, { team: G.user, pid, how: o.how, date: G.date, years: L.years5(sal, o.years, 0.05), prior: (p.prior || 0) * 1e6 });
  if (!v.ok) { ui.err = `${$M(sal)} is more than ${o.how} allows: ${v.errors.join('; ')}.`; return render(); }
  o.sal = sal; ui.err = null; save(); render();
}
async function faDay() {
  const ok = G.myOffers.filter((o) => G.fa.includes(o.pid));
  const done = L.faDay(G, r, { offers: ok, match: G.matchAns });
  G.myOffers = G.myOffers.filter((o) => G.fa.includes(o.pid)); G.matchAns = {};
  if (done) { L.faEnd(G, r); await tradeWindow(`${G.season}-09-20`, L.TRADES.summer); G.phase = 'preseason'; G.offers = X.offersFor(G); view = 'home'; }
}
const slotOf = (k) => { const [o, y, rd] = k.split('|'); return G.draft?.year === +y ? G.draft.order.find((e) => e.origin === o && (e.slot <= 30) === (rd === '1'))?.slot : null; };
const RD = (r) => (+r === 1 ? '1st' : '2nd'), top = (p, r) => `top-${p[1] - 30 * (r - 1)} protected`;
const pickName = (k, prot) => { const a = X.picksView(G)[k];
  if (k.startsWith('op|')) return `${a.year} ${RD(a.round)}: ${esc(a.terms[0])}`;
  const [o, y, rd] = k.split('|'), n = slotOf(k);
  return `${y} ${RD(rd)} (${o}${n ? `, no. ${n}` : ''}${prot ? `, ${top(prot, +rd)}` : ''})${a?.terms.length ? ` <small>${esc(a.terms.join('; '))}</small>` : ''}`; };
const swapName = (s, to) => `the right to swap ${s.y} ${RD(s.r)}s with ${to === G.user ? s.from : 'you'}`;
const tradeText = (t) => { const side = (to) => [...t.moves.filter((m) => m.to === to).map((m) => { const p = P(m.pid); return `${nm(p.id)} <small>${Math.floor(p.age)} · ${sg(sp(p).rate)} · ${wr(p)} · ${$M(C.yearOf(p.contract, G.season)?.sal || 0)} × ${yrs(p).length}</small>`; }),
  ...t.picks.filter((k) => k.to === to).map((k) => pickName(k.id, k.prot)), ...(t.swaps || []).filter((x) => x.to === to).map((x) => swapName(x, to))].join('<br>') || 'nothing';
  return `<div class="two"><div><small>You get</small><br>${side(G.user)}</div><div><small>You send</small><br>${side(t.moves[0].to === G.user ? t.moves[0].from : t.moves[0].to)}</div></div>`; };
const tradeOf = () => {
  const moves = [], picks = [], sat = [], B = ui.partner;
  const add = (k, from, to) => k.includes('|') ? picks.push({ id: k, from, to, ...(ui.prot[k] ? { prot: ui.prot[k] } : {}) })
    : k.startsWith('sat:') ? (sat.push([from, k.slice(4)]), moves.push({ pid: k.slice(4), from, to })) : moves.push({ pid: k, from, to });
  for (const [k, on] of Object.entries(ui.give)) if (on) add(k, G.user, B);
  for (const [k, on] of Object.entries(ui.get)) if (on) add(k, B, G.user);
  const swaps = [...Object.entries(ui.swGive).filter(([, on]) => on).map(([y]) => ({ y: +y, r: 1, from: G.user, to: B })),
    ...Object.entries(ui.swGet).filter(([, on]) => on).map(([y]) => ({ y: +y, r: 1, from: B, to: G.user }))];
  return { moves, picks, sat, swaps };
};
// Judge a trade; any sign-and-trade is signed first, on a copy unless the trade is being made.
const judgeTrade = (t, g = structuredClone(G)) => { for (const [ab, pid] of t.sat) L.satSign(g, ab, g.players[pid]); return X.judge(g, { moves: t.moves, picks: t.picks, swaps: t.swaps }); };

// ---- views -------------------------------------------------------------------------------------
const TABS = [['home', 'Home'], ['roster', 'Roster'], ['league', 'League'], ['gms', 'GMs'], ['staff', 'Staff'], ['trade', 'Trade'], ['log', 'Moves'], ['menu', 'Game']];
function render() {
  if (!G) { root().innerHTML = newGame(); return; }
  if (G.fired) { root().innerHTML = fired(); return; }
  const phase = { preseason: 'Preseason', season: 'Season', playoffs: 'Playoffs', offseason: 'Offseason', draft: 'Draft', freeagency: 'Free agency' }[G.phase];
  const extra = G.phase === 'draft' ? [['draft', 'Draft']] : G.phase === 'playoffs' ? [['playoffs', 'Playoffs']] : ['freeagency', 'preseason', 'season'].includes(G.phase) ? [['fa', 'Free agents']] : G.step === 'decisions' ? [['decisions', 'Decisions']] : [];
  root().innerHTML = `<div class="top"><strong>${esc(NAME(G.user))}</strong> <span>${SEASON(G.season)} · ${phase} · ${G.date}</span></div>
${capStrip()}
<div class="tabs" role="navigation">${[...TABS.slice(0, 1), ...extra, ...TABS.slice(1)].filter(([k]) => k !== 'staff' || (G.hidden && !G.reveal)).map(([k, n]) => `<button data-act="go" data-arg="${k}"${view === k ? ' aria-current="page"' : ''}>${n}</button>`).join('')}</div>
<section>${(VIEWS[view] || VIEWS.home)()}</section>${ui.card && P(ui.card) ? card(ui.card) : ''}`;
  cheer();
}
// A series won, and the title (the Finals won): once each, a moment to enjoy it -- read off the
// rounds played as well as the live series, as a round simmed whole has moved on before the page draws
function cheer() {
  const po = G.po, x = mySeries();
  if (G.phase !== 'playoffs' || !po) return;
  const won = po.rounds.flatMap((res, k) => Object.entries(res).filter(([, z]) => z.winner === G.user).map(([m, z]) => ({ k, opp: m.split('-').find((t) => t !== G.user), g: z.games })));
  if (x && S.seriesDone(x) && (x.hi === G.user ? x.w : x.l) === 4) won.push({ k: po.round, opp: x.hi === G.user ? x.lo : x.hi, g: `${x.w}-${x.l}` });
  const fresh = won.filter((z) => !(G.cheered ||= []).includes(`${G.season}|${z.k}`)), last = fresh.at(-1);
  if (!last) return;
  fresh.forEach((z) => G.cheered.push(`${G.season}|${z.k}`)); save();
  const title = last.k === 3, opp = last.opp, [a, b] = last.g.split('-').map(Number), score = `${Math.max(a, b)}-${Math.min(a, b)}`;
  const cols = ['#f5c542', '#FF6B00', '#1F6B4A', '#ffffff', '#C2410C', '#3b82f6'];
  const bits = Array.from({ length: title ? 180 : 70 }, (_, i) => `<i class="cf" style="left:${(i * 37) % 100}%;background:${cols[i % cols.length]};animation-duration:${2.2 + (i % 7) * 0.35}s;animation-delay:${(i % 13) * 0.12}s"></i>`).join('');
  const next = ['the conference semifinals', 'the conference finals', 'the Finals'][last.k];
  root().insertAdjacentHTML('beforeend', `<div class="cheer${title ? ' title' : ''}" role="dialog" aria-label="${title ? 'Champions' : 'Series won'}">${bits}<div class="cheer-c">${title ? '<div class="trophy">🏆</div>' : ''}
<small>${title ? `${SEASON(G.season)} NBA champions` : ROUND[last.k]}</small><h2>${title ? `The ${esc(NAME(G.user))} are champions` : `${esc(NAME(G.user))} win the series`}</h2>
<p>${title ? `They beat the ${esc(NAME(opp))} ${score} in the Finals.` : `${score} over the ${esc(NAME(opp))}. On to ${next}.`}</p>${btn('uncheer', title ? 'Raise the banner' : 'On to the next round')}</div></div>`);
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
// his line under his name: this season's (or his last), per game; a prospect's pre-draft line until
// his first NBA game
const statLine = (p) => { const l = A.line(G, p);
  return l ? `${SEASON(l.s)}: ${l.gp} gp, ${l.mpg.toFixed(1)} mpg${l.pg ? ` · ${l.pg.pts.toFixed(1)} pts, ${l.pg.reb.toFixed(1)} reb, ${l.pg.ast.toFixed(1)} ast` : ''}` : ''; };
const playerRow = (p, extra = '') => { const l = statLine(p);
  return `<tr data-act="sel" data-arg="${p.id}" class="${ui.pid === p.id ? 'on' : ''}"><td><b>${esc(p.nm)}</b><small>${[p.pos, p.ht, Math.floor(p.age), p.contract?.twoWay && 'two-way', p.contract?.tenDay && '10-day', l].filter(Boolean).join(' · ')}</small>${p.pre && !l ? pre(p) : ''}</td>
<td class="n">${sg(sp(p).rate)}<small> ${od(sp(p).rate, p.lean)}</small></td><td class="n">${M.war(sp(p), 0, G.K).toFixed(1)}</td>${extra}</tr>`; };
// offense and defense: the net rating split by his lean (offense minus defense)
const od = (r, lean = 0) => `O ${sg((r + lean) / 2)} D ${sg((r - lean) / 2)}`;
// a prospect's last season before the draft, per game
const pre = (p) => { const [pts, trb, ast, stl, blk, fg, fg3, ft, g, mp] = p.pre.line, pc = (x) => (x == null ? '–' : (100 * x).toFixed(0));
  return `<small>${p.from ? `${esc(p.from)}, ${p.pre.lvl}` : p.pre.lvl}${p.wt ? ` · ${p.wt} lb` : ''}: ${pts} pts, ${trb} reb, ${ast} ast, ${stl} stl, ${blk} blk; ${pc(fg)}/${pc(fg3)}/${pc(ft)} shooting; ${mp} mpg in ${g} g</small>`; };
// a player's name, opening his card
const nm = (id) => `<a class="pl" data-act="card" data-arg="${id}">${esc(P(id).nm)}</a>`;
// what he has won, from the league's history
const honors = (id) => G.history.flatMap((h) => { const a = h.awards; if (!a) return [];
  return [a.mvp[0]?.[0] === id && 'MVP', ...a.allNba.map((t, i) => t.includes(id) && `All-NBA ${['First', 'Second', 'Third'][i]} Team`), a.roy[0]?.[0] === id && 'Rookie of the Year',
    a.smoy[0]?.[0] === id && 'Sixth Man of the Year', a.dpoy?.[0] === id && 'Defensive Player of the Year', a.mip?.[0] === id && 'Most Improved'].filter(Boolean).map((x) => `${x} ${SEASON(h.season)}`); });
// What he is worth past his pay, and where he is headed: his surplus over his deal and the re-signings
// after it, to your club (trades.js playerWorth) and at the market's price (marketWorth); then each
// season ahead, his rating as your club reads it (his trend, as far as you know it, and the age curve)
// with the tenth to ninetieth percentile of where he could be, his mWAR and market value at the
// median, and on his deal, his pay and the surplus
function outlook(p) {
  const q = sp(p), K = G.K, rho = K.dev.rho, t = G.reveal ? p.trend : L.trendRead(G, G.user, p).trend, s0 = G.season + (['offseason', 'draft'].includes(G.phase) ? 1 : 0);
  const sur = p.contract ? `<p>Surplus <b>${$M(X.playerWorth(G, G.user, p, X.mode(L.projWins(G, G.user))))}</b> to you · ${$M(X.marketWorth(G, p))} on the market <small>(his deal and the re-signings after it, discounted)</small></p>` : '';
  const rows = [0, 1, 2, 3, 4, 5].filter((h) => p.age + h < 40).map((h) => {
    const x = { ...q, rate: q.rate + t * (1 - rho ** h) / (1 - rho) }, mid = M.projRate(x, h, K), u = 1.2816 * M.uncertainty(q, h, K), cap = L.capAt(G, s0 + h);
    const mv = M.marketValue(x, h, cap, K), sal = C.yearOf(p.contract, s0 + h)?.sal;
    return `<tr><td>${SEASON(s0 + h)}</td><td class="n">${Math.floor(p.age) + h}</td><td class="n">${sg(mid)} <small>${sg(mid - u)} to ${sg(mid + u)}</small></td><td class="n">${M.war(x, h, K).toFixed(1)}</td><td class="n">${$M(mv)}</td><td class="n">${sal == null ? '–' : $M(sal)}</td><td class="n">${sal == null ? '–' : $M(mv - sal)}</td></tr>`; }).join('');
  return `${sur}<div class="scroll"><table class="t"><thead><tr><th>Season</th><th class="n">Age</th><th class="n">Rating <small>p10–p90</small></th><th class="n">mWAR</th><th class="n">Market value</th><th class="n">Salary</th><th class="n">Surplus</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
const card = (id) => { const p = P(id), h = honors(id);
  return `<div class="ov" data-act="closecard"><div class="ovc" data-act="noop" role="dialog" aria-label="${esc(p.nm)}"><button class="x" data-act="closecard" aria-label="Close">&times;</button>
<h3>${esc(p.nm)}</h3><p>${[p.pos, p.ht, `${Math.floor(p.age)} years old`, p.tm ? esc(NAME(p.tm)) : p.retired ? `retired ${SEASON(p.retired)}` : 'free agent'].filter(Boolean).join(' · ')}</p>
<p>mPM <b>${sg(sp(p).rate)}</b> <small>${od(sp(p).rate, p.lean)}</small> · ${wr(p)}${p.tm ? ` · ${usage(p)}` : ''}</p>
<p class="sub">${p.draft ? `Drafted ${p.draft.year}, round ${p.draft.round}, pick ${p.draft.pick}. ` : ''}${p.yos} years of service.</p>
${trajectory(p)}${p.contract ? `<p>${contract(p)}</p>` : ''}${p.retired ? '' : outlook(p)}${h.length ? `<p><b>Honors</b><br>${h.join('<br>')}</p>` : ''}${logTable(p)}</div></div>`; };
// Where he is heading as your club reads it (L.trendRead): a season's gain beyond the league's aging,
// fading by the year; your own man's, as far as you have seen him play; another club's, the league's
// expectation less what his club, knowing more, would keep to itself
const trajectory = (p) => { if (!G.hidden || p.retired) return '';
  if (G.reveal) { const t = L.trendRead(G, null, p); return `<p>Trajectory <b>${sg(p.trend)}</b> a season beyond aging, fading <small>the truth; the league reads ${sg(t.trend)}</small></p>`; }
  const t = L.trendRead(G, G.user, p), k = Math.round(100 * t.known);
  return `<p>Trajectory <b>${sg(t.trend)}</b> a season beyond aging, fading <small>${t.own ? (k ? `your read: you know about ${k}% of where he is heading, from his seasons with you` : 'the league\'s expectation: he has not played a season for you yet')
    : p.tm || t.known ? `the league's read${k ? `, marked down for what ${p.tm ? esc(NAME(p.tm)) : 'his club'} knows (about ${k}% of it)` : ''}` : 'the league\'s read: no club knows more'}</small></p>`; };
const logTable = (p) => !p.log?.length ? '' : `<div class="scroll"><table class="t log2"><thead><tr><th>Season</th><th>Club</th><th class="n">GP</th><th class="n">MPG</th><th class="n">Rtg</th><th class="n">Off / Def</th><th class="n">Pts/Reb/Ast/Stl/Blk per game</th></tr></thead><tbody>
${p.log.map((l) => `<tr><td>${SEASON(l.s)}</td><td>${l.tm || ''}</td><td class="n">${l.gp}</td><td class="n">${l.mpg}</td><td class="n">${l.rate == null ? '–' : sg(l.rate)}</td><td class="n">${l.rate == null || l.lean == null ? '–' : od(l.rate, l.lean).replace('O ', '').replace(' D ', ' / ')}</td><td class="n">${l.p100 ? l.p100.slice(0, 5).map((x) => (x * l.mpg / 48).toFixed(1)).join(' / ') : ''}</td></tr>`).join('')}</tbody></table></div>`;
// The roster's per-game lines as Basketball-Reference sets them out: this season's so far, else the
// last season's; mPM is the season's rating, mWAR the wins above replacement in his minutes so far
const BX = [['pos', 'Pos'], ['age', 'Age'], ['gp', 'G'], ['mpg', 'MP'], ['fgm', 'FG'], ['fga', 'FGA'], ['fg_pct', 'FG%'], ['fg3m', '3P'], ['ftm', 'FT'], ['fta', 'FTA'], ['ft_pct', 'FT%'],
  ['oreb', 'ORB'], ['dreb', 'DRB'], ['reb', 'TRB'], ['ast', 'AST'], ['stl', 'STL'], ['blk', 'BLK'], ['tov', 'TOV'], ['pf', 'PF'], ['pts', 'PTS'], ['ts_pct', 'TS%'], ['rate', 'mPM'], ['war', 'mWAR']];
const bxCell = (k, v) => (v == null || (typeof v === 'number' && !Number.isFinite(v)) ? '' : k === 'pos' ? v : ['age', 'gp'].includes(k) ? v
  : k.endsWith('_pct') ? v.toFixed(3).replace(/^0/, '') : k === 'rate' ? sg(v) : v.toFixed(1));
const statsTable = (ps) => {
  const s = G.cur ? G.season : ['offseason', 'draft'].includes(G.phase) ? G.season : G.season - 1, Ls = new Map(A.lines(G, s).map((x) => [x.p.id, x]));
  const rows = ps.map((p) => { const l = Ls.get(p.id);
    return { p, nm: p.nm, pos: p.pos, age: Math.floor(p.age), ...(l && { gp: l.gp, mpg: l.mpg, ...l.pg, rate: l.rate, war: G.K.beta * l.gp * l.mpg / 48 * (l.rate - G.K.repl) }) }; });
  const [k, d] = ui.rsort || ['mpg', -1];
  rows.sort((a, b) => (a[k] == null) - (b[k] == null) || d * (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0));
  const th = (c, n, cls = 'n') => `<th class="${cls}" data-act="rsort" data-arg="${c}"${k === c ? ` aria-sort="${d > 0 ? 'ascending' : 'descending'}"` : ''}>${n}</th>`;
  return `<p class="note">${G.cur ? `${SEASON(s)} so far` : `Last season, ${SEASON(s)}`}: per game. Click a heading to sort.</p><div class="scroll"><table class="t bx"><thead><tr>${th('nm', 'Player', '')}${BX.map(([c, n]) => th(c, n, c === 'pos' ? '' : 'n')).join('')}</tr></thead><tbody>
${rows.map((x) => `<tr><td>${nm(x.p.id)}</td>${BX.map(([c]) => `<td${c === 'pos' ? '' : ' class="n"'}>${bxCell(c, x[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
};
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
${L.rotation(G, G.user).map(([p, m], i) => `<li><b>${nm(p.id)}</b> <small>${ROLE(i, p)} · ${m.toFixed(0)} min${out(p) ? ' · <span class="bad">out injured</span>' : ''}</small></li>`).join('')}</ol></div>`;
};
// Both conferences' standings: the record so far, else last season's, else projected wins
// title odds (L.titleOdds), kept until the season, the playoffs or a roster moves on
let oddsMemo = {};
const odds = () => { const k = `${G.season}|${G.phase}|${G.date}|${G.cur?.d}|${G.po?.series.map((x) => x.w + x.l).join()}|${G.log.length}`;
  if (oddsMemo.k !== k) oddsMemo = { k, v: L.titleOdds(G) }; return oddsMemo.v; };
// none in the draws: out of it in the playoffs, a long shot before them
const oddsPct = (x) => (x === 0 && G.phase === 'playoffs' ? '–' : x < 0.01 ? '<1%' : `${Math.round(100 * x)}%`);
const standings = () => {
  const rec = G.cur?.record || (G.lastRecord && G.phase !== 'preseason' ? G.lastRecord : null);
  const conf = (c) => {
    const T = Object.keys(G.teams).filter((ab) => G.teams[ab].conf === c);
    const rows = rec ? T.sort((a, b) => rec[b].w - rec[a].w || rec[a].l - rec[b].l).map((ab) => [ab, rec[ab].w, rec[ab].l])
      : T.map((ab) => [ab, L.projWins(G, ab)]).sort((a, b) => b[1] - a[1]).map(([ab, w]) => [ab, w.toFixed(1), '']);
    // games behind the conference leader
    const gb = ([, w, l]) => (rec ? ((rows[0][1] - w + l - rows[0][2]) / 2 || '–') : '');
    const o = odds();
    return `<h3>${c}</h3><table class="t"><thead><tr><th>Team</th><th class="n">${rec ? 'W' : 'Proj. W'}</th><th class="n">${rec ? 'L' : ''}</th><th class="n">${rec ? 'GB' : ''}</th><th class="n" title="Chance of winning the title">Title</th></tr></thead><tbody>
${rows.map((x, i) => `<tr class="${x[0] === G.user ? 'me' : ''}${i === 5 || i === 9 ? ' cut' : ''}"><td>${i + 1}. ${esc(NAME(x[0]))}</td><td class="n">${x[1]}</td><td class="n">${x[2]}</td><td class="n">${gb(x)}</td><td class="n">${oddsPct(o[x[0]])}</td></tr>`).join('')}</tbody></table>`;
  };
  return `<div class="two"><div>${conf('East')}</div><div>${conf('West')}</div></div>`;
};
// ---- the season's numbers and the league's history -------------------------------------------
const who = (id) => `${nm(id)} <small>${P(id).tm || ''}</small>`;
const leadersCard = () => {
  const h = G.history.at(-1), s = G.cur ? G.season : h?.season, ld = G.cur ? A.leaders(G, s) : h?.leaders;
  if (!ld) return '';
  const col = (k, name, d = 1) => `<div><h4>${name}</h4><ol>${ld[k].map(([id, v]) => `<li><b>${v.toFixed(d)}</b><span class="w" title="${esc(P(id).nm)}">${who(id)}</span></li>`).join('')}</ol></div>`;
  return `<h3>League leaders · ${SEASON(s)}</h3><div class="lead">${col('pts', 'Points')}${col('reb', 'Rebounds')}${col('ast', 'Assists')}${col('stl', 'Steals')}${col('blk', 'Blocks')}${col('rating', 'Rating', 2)}</div>
<p class="note">Per game, among players in 70% of their club's games.</p>`;
};
const awardsCard = (h) => {
  const a = h?.awards;
  if (!a) return '';
  const share = (xs) => xs.map(([id, v]) => `<li><b>${v.toFixed(3)}</b><span class="w" title="${esc(P(id).nm)}">${who(id)}</span></li>`).join('');
  return `<h3>Awards · ${SEASON(h.season)}</h3><div class="lead">
<div><h4>Most Valuable Player</h4><ol>${share(a.mvp)}</ol></div>
${a.allNba.map((t, i) => `<div><h4>All-NBA ${['First', 'Second', 'Third'][i]} Team</h4><ul>${t.map((id) => `<li><span class="w" title="${esc(P(id).nm)}">${who(id)}</span></li>`).join('')}</ul></div>`).join('')}
<div><h4>Rookie of the Year</h4><ol>${share(a.roy)}</ol></div><div><h4>Sixth Man of the Year</h4><ol>${share(a.smoy)}</ol></div>
<div><h4>Defensive Player</h4><p>${a.dpoy ? `${who(a.dpoy[0])} <b>${sg(a.dpoy[1])}</b> defense` : '–'}</p><h4>Most Improved</h4><p>${a.mip ? `${who(a.mip[0])} <b>${sg(a.mip[1])}</b>` : '–'}</p></div></div>
<p class="note">Vote shares from 100 simulated voters who weigh rating, scoring, team record and games as the real MVP and All-NBA electorates have since 1999; Rookie and Sixth Man use the MVP voters' weights. Defensive Player goes to the best defensive rating and Most Improved to the largest rise in rating, both with 65 games, as do MVP and All-NBA.</p>`;
};
const finals = (h) => { const [k, v] = Object.entries(h.rounds?.[3] || {})[0] || []; return k ? { lo: k.split('-').find((x) => x !== v.winner), games: v.games } : null; };
const historyCards = () => {
  if (!G.history.length) return '';
  const champs = G.history.slice().reverse().map((h) => { const f = finals(h); return `<tr${h.champion === G.user ? ' class="me"' : ''}><td>${SEASON(h.season)}</td><td>${esc(NAME(h.champion))}</td><td>${f ? `${esc(NAME(f.lo))} <small>${f.games.split('-').sort().reverse().join('-')}</small>` : ''}</td><td>${h.awards?.mvp[0] ? who(h.awards.mvp[0][0]) : ''}</td></tr>`; }).join('');
  const t = Object.fromEntries(Object.keys(G.teams).map((ab) => [ab, { w: 0, l: 0, po: 0, fin: 0, ttl: 0 }]));
  for (const h of G.history) {
    for (const [ab, [w, l]] of Object.entries(h.record)) { t[ab].w += w; t[ab].l += l; }
    Object.values(h.seeds || {}).flat().forEach((ab) => t[ab].po++);
    const f = finals(h); if (f) { t[h.champion].fin++; t[f.lo].fin++; t[h.champion].ttl++; }
  }
  const rows = Object.entries(t).sort((a, b) => b[1].ttl - a[1].ttl || b[1].w / (b[1].w + b[1].l) - a[1].w / (a[1].w + a[1].l));
  return `<h3>Champions</h3><table class="t"><thead><tr><th>Season</th><th>Champion</th><th>Finals opponent</th><th>MVP</th></tr></thead><tbody>${champs}</tbody></table>
<h3>All-time · ${G.history.length} season${G.history.length > 1 ? 's' : ''}</h3><table class="t"><thead><tr><th>Team</th><th class="n">Titles</th><th class="n">Finals</th><th class="n">Playoffs</th><th class="n">W-L</th><th class="n">Pct</th></tr></thead><tbody>
${rows.map(([ab, x]) => `<tr${ab === G.user ? ' class="me"' : ''}><td>${esc(NAME(ab))}</td><td class="n">${x.ttl}</td><td class="n">${x.fin}</td><td class="n">${x.po}</td><td class="n">${x.w}-${x.l}</td><td class="n">${(x.w / (x.w + x.l)).toFixed(3).replace(/^0/, '')}</td></tr>`).join('')}</tbody></table>
<p class="note">Playoffs counts the 16 who make the bracket, through the play-in.</p>`;
};
// one line of the moves log
const logLine = (x) => x.type === 'trade' ? `${x.teams.join(' / ')}: ${x.moves ? x.moves.map((m) => `${nm(m.pid)} to ${m.to}`).join(', ') : x.players.map(nm).join(', ')}${x.picks.length ? `; picks ${x.picks.map((k, i) => `${k.startsWith('op|') ? `${k.split('|')[1]} claim` : `${k.split('|').slice(0, 2).join(' ')} ${k.endsWith('|1') ? '1st' : '2nd'}`}${x.prot?.find(([id]) => id === k) ? ' (protected)' : ''} to ${x.pickTo?.[i] ?? ''}`).join(', ')}` : ''}${x.swaps ? `; swap rights ${x.swaps.map((w) => `${w.y} to ${w.to}`).join(', ')}` : ''}`
  : x.type === 'owner' ? `${x.team} sold to new owners`
  : x.type === 'gm' ? (x.out ? `${x.team} part with GM ${esc(x.out)}` : `${x.team} hire ${esc(x.in)} as GM${x.back ? ' (back in the game)' : ''}`)
  : x.type === 'sign' ? `${x.team} sign ${nm(x.pid)}, ${$M(x.sal)} × ${x.years}` : x.type === 'extend' ? `${x.team} extend ${nm(x.pid)}, ${$M(x.sal)} × ${x.years} more` : x.type === 'retire' ? `${nm(x.pid)} retires${x.team ? ` (${x.team})` : ''}` : `${x.team} waive ${nm(x.pid)}`;
// What happened while the season was simmed: your stretch, who is hurt, the league's trades
function news(before) {
  const rec = G.cur.record[G.user], w = rec.w - before.w, l = rec.l - before.l, T = me(), g = G.cur.played[G.user];
  const conf = G.teams[G.user].conf, rank = Object.keys(G.teams).filter((ab) => G.teams[ab].conf === conf)
    .sort((a, b) => G.cur.record[b].w - G.cur.record[a].w || G.cur.record[a].l - G.cur.record[b].l).indexOf(G.user) + 1;
  const hurt = T.roster.map((id) => [id, G.cur.hurt[id]]).filter(([, h]) => h?.[g]).map(([id, h]) => { let n = 0; while (h[g + n]) n++; return [id, n]; });
  const trades = G.log.slice(before.log).filter((x) => x.type === 'trade');
  return [`You went ${w}-${l} over the stretch; ${rec.w}-${rec.l} now, ${rank}${['st', 'nd', 'rd'][rank - 1] || 'th'} in the ${conf}.`,
    hurt.length ? `Out injured: ${hurt.map(([id, n]) => `${nm(id)} (about ${n} more game${n > 1 ? 's' : ''})`).join(', ')}.` : 'Your whole roster is healthy.',
    ...trades.slice(-6).map((x) => `Trade: ${logLine(x)}`), trades.length > 6 ? `${trades.length - 6} more trades in the Moves tab.` : ''].filter(Boolean);
}
// What the user's club can spend on free agents now, and what bars each way of signing
function spendCard() {
  const f = F(), T = me(), p = G.fa.map(P).find((q) => !q.retired);
  if (!p || !T.exc) return '';                                  // exceptions are set from the first new league year
  const pay = C.teamSalary(T, G, G.season), capPay = C.teamSalary(T, G, G.season, { holds: true, offseason: G.phase !== 'season' });
  const holds = T.holds.reduce((a, h) => a + h.amt, 0), room = Math.max(0, f.cap - capPay), min = C.minSalary(p.yos, f.cap);
  const ways = [['room', 'Cap room', room], ['ntmle', 'Mid-level exception', T.exc.ntmle], ['tpmle', 'Taxpayer mid-level', T.exc.tpmle],
    ['roomMle', 'Room mid-level', T.exc.roomMle], ['bae', 'Bi-annual exception', T.exc.bae]];
  // each way tried on a free agent: at its full amount, and when that is barred, at the minimum;
  // the most it can pay is its amount, or what keeps the club under the apron that bars it
  const test = (how, sal) => C.validateSigning(G, { team: G.user, pid: p.id, how, date: G.date, years: L.years5(sal, 1, 0), prior: 0 });
  const usable = (how, amt) => { if (amt < min) return [0, how === 'room' ? 'no room' : 'used up'];
    const full = test(how, amt); if (full.ok) return [amt, ''];
    if (!test(how, min).ok) return [0, test(how, min).errors.join('; ')];
    const lvl = /first apron/.test(full.errors.join()) ? 'apron1' : /second apron/.test(full.errors.join()) ? 'apron2' : null;
    return [lvl ? Math.max(min, f[lvl] - pay) : min, full.errors.join('; ')]; };
  const rows = ways.map(([how, nm, amt]) => [nm, ...usable(how, amt)]);
  return `<div class="card"><h3>What you can spend</h3><div class="pay">${rows.map(([nm, a, w]) => `<div><span>${nm}</span><b class="${a ? '' : 'bad'}">${a ? `${w ? 'up to ' : ''}${$M(a)}` : '–'}</b></div>`).join('')}<div><span>Minimum contracts</span><b>any</b></div></div>
${rows.filter(([, , w]) => w && w !== 'used up' && w !== 'no room').map(([nm, a, w]) => `<p class="note">${nm}${a ? ', in full' : ''}: ${esc(w)}.</p>`).join('')}
<p class="note">Payroll ${$M(pay)}${holds ? `, plus ${$M(holds)} in cap holds for ${T.holds.length} of your own free agents: the cap counts ${$M(capPay)}. Renounce a player's rights to free his hold` : ''}. Your own free agents can be re-signed over the cap with their Bird rights.</p>
${T.holds.map((h) => `<div class="ck">${nm(h.pid)} <small>hold ${$M(h.amt)}</small> ${btn('renounce', 'Renounce', h.pid, 'warn')}</div>`).join('')}${T.holds.length > 1 ? btn('renounceall', 'Renounce them all', '', 'warn') : ''}</div>`;
}
// Free agency in the summer: your offers and what each agent says, yesterday's answers, and who
// signed where
function faCards() {
  const st = G.fa_, resp = st.resp || {}, today = G.log.filter((x) => x.type === 'sign' && x.date === G.date && st.day > 1);
  const summer = G.log.filter((x) => x.type === 'sign' && x.date >= `${G.season}-07-01` && x.date <= G.date && !['min', 'twoWay'].includes(x.how)).sort((a, b) => b.sal - a.sal);
  const say = (o) => { const p = P(o.pid), x = resp[o.pid], n = need(p);
    if (x?.status === 'outbid') return `<span class="bad">The ${esc(NAME(x.top.ab))} offer ${$M(x.top.sal)} × ${x.top.years}: beat it today or he signs there.</span> ${btn('beat', 'Beat it', o.pid)}`;
    if (o.sal < n) return `His agent wants ${$M(n)} a year. ${btn('meet', 'Meet it', o.pid)}`;
    return `<span class="good">That meets his ask.</span> He decides tomorrow, unless someone offers more.`; };
  const done = Object.entries(resp).filter(([, x]) => ['signed', 'lost'].includes(x.status));
  const line = (x) => `<li>${nm(x.pid)} <small>${Math.floor(P(x.pid).age)} · ${sg(sp(P(x.pid)).rate)} · ${wr(P(x.pid))}</small> to <b>${x.team}</b>, ${$M(x.sal)} × ${x.years}</li>`;
  return `<div class="card"><h3>Your offers · day ${st.day}</h3>${G.myOffers.map((o) => `<div class="off"><b>${nm(o.pid)}</b>: ${$M(o.sal)} × ${o.years} (${o.how}) ${btn('unoffer', 'Withdraw', o.pid, 'ghost')}<br><small>${say(o)}</small></div>`).join('') || '<p>None out. Open a player below to make one.</p>'}
${ui.err ? `<p class="bad">${esc(ui.err)}</p>` : ''}${done.length ? `<p>${done.map(([pid, x]) => x.status === 'signed' ? `<span class="good">${nm(pid)} signed with you.</span>` : `<span class="bad">${nm(pid)} took the ${esc(NAME(x.top.ab))}' offer, ${$M(x.top.sal)} × ${x.top.years}.</span>`).join(' ')}</p>` : ''}
<p class="note">A player takes the richest offer that meets his ask; asks fall about 2.5% a day. When a rival tops an offer of yours that meets his ask, his agent gives you a day to beat it.</p>
<div class="row">${btn('faday', 'Next day')}${btn('farest', 'Sim to the end')}</div></div>
${today.length ? `<div class="card"><h3>Signed today</h3><ul class="log">${today.sort((a, b) => b.sal - a.sal).map(line).join('')}</ul></div>` : ''}
${summer.length ? `<details class="card"><summary>Every signing this summer (${summer.length})</summary><ul class="log">${summer.map(line).join('')}</ul></details>` : ''}`;
}
// The draft board, as the site's draws it (board.js): ranked by his expected worth to the club that
// drafts him, each prospect's value violin, quality fans and the game's own odds; open one for his
// career arc and what his club keeps season by season.
function board(pool, onMe, tn, th, c) {
  const F_ = new Map(pool.map((p) => [p.id, L.fans(G, sp(p), G.reveal ? 0 : ST.miss(G, 0))])), f = (p) => F_.get(p.id), list = pool.slice().sort((a, b) => f(b).EV - f(a).EV).slice(0, 60);
  const all = [...F_.values()], VD = [Math.floor(Math.min(...all.map((x) => x.v[1]))), Math.ceil(Math.max(...all.map((x) => x.v[6])))];
  const QD = [Math.floor(Math.min(...all.flatMap((x) => ['r', 'q', 'k', 'o', 'd'].map((k) => x[k][1])))), Math.ceil(Math.max(...all.flatMap((x) => ['r', 'q', 'k', 'o', 'd'].map((k) => x[k][5]))))];
  const chip = (d) => `<span class="chip ${d > 0 ? 'up' : d < 0 ? 'dn' : 'na'}">${d > 0 ? '+' : ''}${d}</span>`;
  return `<div class="dftb"><div class="bhead"><span>Rk</span><span>Prospect</span><span>Value · outcome curve</span><span>Quality R/4/P · off/def</span><span class="r">Odds</span><span></span></div>
${list.map((p, i) => { const o = f(p), pj = G.draft.proj[p.id], open = ui.pid === p.id;
  return `<div class="brow${open ? ' open' : ''}" data-act="sel" data-arg="${p.id}"><div class="rk">${i + 1}</div>
<div class="who"><b>${esc(p.nm)}</b><div class="meta">${[esc(p.from || p.pre?.lvl || ''), Math.floor(p.age) + 'y', p.pos, p.ht, `P(NBA) ${Math.round(100 * o.pp)}%`].filter(Boolean).join(' · ')}</div><div class="meta">read ${sg(sp(p).rate)} · healthy ${Math.round(100 * p.av)}%</div></div>
<div class="vcell">${B.violin(o.v, VD)}<div class="ev"><b>${B.$M(o.EV)}</b> to his club <small>p10–p90 ${B.$M(o.V10)} – ${B.$M(o.V90)}</small></div></div>
<div>${B.qhz(o, QD)}</div>
<div class="cap">${chip(pj - (i + 1))}<small>league's no. ${pj}</small><small>in NBA yr 5 ${Math.round(100 * o.stay[4])}%</small>${tn ? `<small>goes at ${c.slot}: <b>${Math.round(100 * (tn[p.id] || 0))}%</b></small>` : ''}${th ? `<small>there at ${th.slot}: <b>${Math.round(100 * (th.p[p.id] || 0))}%</b></small>` : ''}</div>
<div>${onMe ? btn('pick', 'Pick', p.id) : ''}</div>
${open ? `<div class="bdet">${p.pre ? `<p class="note">${pre(p)}</p>` : ''}${B.arc(o.vs, G.draft.proj[p.id] <= 30 ? 4 : 2)}${B.bars(o.mkt, o.kept)}<p class="note">Star: a ${Math.round(100 * o.star)}% chance of a season at +3 or better by his seventh.</p></div>` : ''}</div>`; }).join('')}</div>
<p class="note">The board as the site's draft model draws it, from the game's own development: 400 careers each, his talent the league's read (the scouts' board) plus what boards like it miss (this class's misses, busts included), then the age curve, his own trend and the season-to-season noise. The violin is his value over his first four seasons, in wins a season (p5–p99, the tick the median); R, 4 and P are his quality as a rookie, over four seasons and at his peak, in wins a season at full health, and O and D split the four-year figure. The dollars are his worth to the club that drafts him at this summer's cap, on the board's contract model: his rookie deal at market while the club holds him, then at each deal's end it keeps him or not and pays him the max or what a player like him signs for. The chip is the league's rank of him (where the scouts' board would take him) less this board's. Goes at is his chance the club on the clock takes him now, There at his chance he is still there at your next pick.</p>
`;
}
// The owner: who he is, his confidence in you, and the books, this season's projection and the past
const $m = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(0)}M`;
function ownerBooks() {
  const b = G.owner.books;
  return b.length ? `<table class="t"><thead><tr><th>Season</th><th class="n">W</th><th class="n">Revenue</th><th class="n">Payroll</th><th class="n">Tax</th><th class="n">Other</th><th class="n">Profit</th></tr></thead><tbody>${b.slice().reverse().map((x) => `<tr><td>${SEASON(x.s)}</td><td class="n">${x.w}</td><td class="n">${$m(x.rev)}${x.n ? ` <small>(${x.n} home playoff games)</small>` : ''}</td><td class="n">${$m(x.pay)}</td><td class="n">${$m(x.tax)}</td><td class="n">${$m(x.other)}</td><td class="n ${x.profit < 0 ? 'bad' : ''}">${$m(x.profit)}</td></tr>`).join('')}</tbody></table>` : '';
}
// fired: the owner's verdict, the clubs that call, and the career so far
// A club's offer: its terms, a job to take (or, for your own owner's renewal, to sign), and your counter
const offersOpen = () => G.fired?.offers || G.calls || [];
function offerRow(o, rec) {
  const own = o.ab === 'renew', yr = (y) => `<option${y === o.years ? ' selected' : ''}>${y}</option>`;
  return `<div class="off">${own ? '' : `<b>${esc(NAME(o.ab))}</b> <small>${rec[o.ab][0]}-${rec[o.ab][1]} last season · payroll ${$m(O.payroll(G, o.ab) / 1e6)}</small> `}<b>${$M(o.sal)} a season × ${o.years}</b>
${own ? btn('renew', 'Sign it') : btn('takejob', 'Take the job', o.ab)} <span class="ask">or ask $<input id="ask-${o.ab}" type="number" step="0.1" min="0" value="${(o.sal / 1e6).toFixed(1)}" style="width:5em">M × <select id="yrs-${o.ab}">${[3, 4, 5].map(yr).join('')}</select> ${btn('counter', 'Counter', o.ab)}</span>${ui.said?.[o.ab] ? `<br><small>${esc(ui.said[o.ab])}</small>` : ''}</div>`;
}
function renew() { const o = G.renewal; G.deal = { sal: o.sal, from: G.season + 1, to: G.season + o.years }; delete G.renewal; }
// out of work by his own choice or his owner's: the renewal turned down, or talks broken off
function leave(why) {
  GM.hire(G, G.user, r);
  G.fired = { s: G.season, mode: why, from: G.user, out: 1, offers: G.calls || [], h: 0 };
  delete G.renewal; delete G.deal; delete G.calls;
}
ACT.renew = () => { renew(); save(); render(); };
ACT.walk = () => { if (confirm('Leave the club when your deal ends?')) { leave('walked'); save(); render(); } };
ACT.counter = (ab) => {
  const own = ab === 'renew', o = own ? G.renewal : offersOpen().find((x) => x.ab === ab), was = o.sal;
  const said = O.counter(o, { sal: Math.round(+$(`#ask-${ab}`).value * 10) * 1e5, years: +$(`#yrs-${ab}`).value }, r);
  (ui.said ||= {})[ab] = `${own ? 'Your owner' : `The ${NAME(ab)}`} ${said}${o.sal !== was ? `: ${$M(o.sal)} a season` : ''}.`;
  if (o.gone) { if (own) leave('talks'); else if (G.fired) G.fired.offers = G.fired.offers.filter((x) => x !== o); else G.calls = G.calls.filter((x) => x !== o); }
  save(); render();
};
function career() {
  const c = G.career || [];
  const pay = `<p>${G.deal ? `Your deal: ${$M(G.deal.sal)} a season through ${SEASON(G.deal.to)}. ` : ''}Career earnings: ${$M(G.earned || 0)}.</p>`;
  return pay + (c.length ? `<table class="t"><thead><tr><th>Season</th><th>Club</th><th class="n">W-L</th><th>Playoffs</th></tr></thead><tbody>${c.slice().reverse().map((x) => `<tr><td>${SEASON(x.s)}</td><td>${esc(NAME(x.ab))}</td><td class="n">${x.w}-${x.l}</td><td>${x.champ ? '<b>Champions</b>' : x.won ? `won ${x.won} round${x.won > 1 ? 's' : ''}` : ''}</td></tr>`).join('')}</tbody></table>` : '');
}
function fired() {
  const f = G.fired, rec = G.history.at(-1).record, pct = (x) => `${Math.round(100 * x)}%`;
  if (f.retired) return `<div class="card"><h2>Career over</h2>${career()}<div class="row">${btn('newgame', 'New game')}${btn('export', 'Export the save')}</div></div>`;
  const why = f.out > 1 ? `You have been out of the game ${f.out - 1} season${f.out > 2 ? 's' : ''}.`
    : f.mode === 'walked' ? `You turned down a new deal with the ${esc(NAME(f.from))} and left when your contract ran out.`
    : f.mode === 'talks' ? `Talks on a new deal with the ${esc(NAME(f.from))} broke down, and the owner let your contract run out.`
    : f.mode === 'realistic' ? `After the ${SEASON(f.s)} season the ${esc(NAME(f.from))} let you go. Real GMs are let go most when their club falls short of what it was expected to win; the model put the odds at ${pct(G.exitOdds)}.`
    : `After the ${SEASON(f.s)} season the ${esc(NAME(f.from))}' owner's confidence fell to ${Math.round(f.conf)} of 100, and he let you go.`;
  return `<div class="card"><h2>${f.out > 1 || f.mode === 'walked' ? 'Out of work' : "You're fired"}</h2><p>${why}</p>${f.out > 1 || !G.owner.books?.length ? '' : ownerBooks()}
<h3>Clubs that want you</h3>${f.offers.length ? f.offers.map((o) => offerRow(o, rec)).join('') : '<p>No one calls.</p>'}
<p class="note">Only clubs that changed GMs this summer are hiring (${G.openSeats.filter((ab) => ab !== f.from).length} of them). Real GMs who lose a job get another one at a rate that falls the longer they are out; for a career like yours, the model's chance of a job this summer is ${pct(f.h)}. Your new owner is the kind you asked for when you started.</p>
<h3>While you wait</h3><p class="note">Television puts you in front of the big markets (the ten clubs with the most revenue); a front-office job in front of the rest; a podcast in front of everyone, less strongly. The other seasons are simmed lightly while you are out: fewer trade talks, so they go faster.</p>
<div class="row">${Object.entries(GM.PATHS).map(([k, p]) => btn('path', `${(f.path || 'away') === k ? '✓ ' : ''}${p.label}`, k, (f.path || 'away') === k ? '' : 'ghost')).join('')}</div>
${f.log?.length ? `<p><small>${f.log.map((x) => `${SEASON(x.s)}: ${esc(GM.PATHS[x.path].say)}`).join(' · ')}</small></p>` : ''}
<h3>Your career</h3>${career()}<div class="row">${btn('away', 'Spend a season', '')}${btn('away', 'Until a club calls', 'all')}${btn('retire', 'Retire', '', 'warn')}${btn('export', 'Export the save')}</div></div>`;
}
function ownerCard() {
  if (!G.owner) return '';
  const o = O.OWNERS[G.owner.type], b = O.projected(G), c = Math.round(G.owner.conf), l = O.line(G, b.s);
  return `<div class="card"><h3>The owner</h3><p>${o.label}: he ${o.say}. Confidence in you: <b class="${c < 40 ? 'bad' : 'good'}">${c}</b> of 100${c < 40 && G.fireMode === 'simple' ? ' — he is losing patience; below 20 at a season\'s end you are fired' : ''}.${G.fireMode === 'realistic' && G.exitOdds != null ? ` After last season, the model put your odds of losing the job at ${Math.round(100 * G.exitOdds)}% (it is decided at each season's end).` : ''}</p>
<p>${SEASON(b.s)} as it stands: revenue ${$m(b.rev)} (${b.n.toFixed(1)} home playoff games expected), payroll ${$m(b.pay)}, tax ${$m(b.tax)}, other costs ${$m(b.other)}: <b class="${b.profit < l ? 'bad' : 'good'}">${$m(b.profit)}</b> against his line of ${$m(l)}. ${G.owner.order ? `<b class="bad">He has ordered payroll down to ${$m(G.owner.order.target / 1e6)} by the trade deadline.</b>` : ''}</p>
${G.ownerSay ? `<p class="note">${esc(G.ownerSay)}</p>` : ''}${ownerBooks()}
<p class="note">Revenue is the club's (Forbes, 2024-25, net of revenue sharing) growing with the cap, plus about $6M a home playoff game; regular-season wins don't measurably move it. Other costs are 28% of revenue.</p></div>`;
}
const VIEWS = {
  home: () => {
    const [say, ...b] = NEXT[G.phase]();
    const T = me(), rec = G.cur?.record[G.user], last = G.history.at(-1);
    return `<div class="card"><p>${say}</p><div class="row">${b.filter(Boolean).join('')}</div>${G.news && ['season', 'playoffs'].includes(G.phase) ? `<ul class="news">${G.news.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}</div>
${(G.offers || []).map((t, i) => `<div class="card"><h3>Offer from ${esc(NAME(t.moves[0].to))}</h3>${tradeText(t)}<div class="row">${btn('take', 'Accept', i)}${btn('pass', 'Decline', i, 'warn')}</div></div>`).join('')}
${G.phase === 'season' ? standings() : G.phase === 'playoffs' ? VIEWS.playoffs() : ''}
${['offseason', 'draft'].includes(G.phase) && last?.season === G.season ? `<div class="card"><h3>The ${SEASON(last.season)} season</h3><p><b>${esc(NAME(last.champion))}</b> are champions${finals(last) ? `, over the ${esc(NAME(finals(last).lo))}` : ''}. ${last.awards ? `MVP: ${who(last.awards.mvp[0][0])}.` : ''}</p>${awardsCard(last).replace(/<h3>.*?<\/h3>/, '')}</div>` : ''}
<div class="card"><h3>${esc(NAME(G.user))}</h3><p>${rec ? `Record ${rec.w}-${rec.l}. ` : ''}Projected wins ${L.projWins(G, G.user).toFixed(1)}, title odds ${oddsPct(odds()[G.user])}; ${std(T).length} standard contracts, ${T.roster.length - std(T).length} two-way.
${last ? `<br>Last season: ${summary(last)}` : ''}</p>${payroll()}</div>
${ownerCard()}
${(() => { const gone = G.log.filter((x) => x.type === 'retire' && x.team === G.user && x.date >= `${G.season}-06-01`); return gone.length && G.phase === 'freeagency' ? `<div class="card"><p>Retired this summer: ${gone.map((x) => nm(x.pid)).join(', ')}.</p></div>` : ''; })()}
${G.dev?.length && ['draft', 'offseason'].includes(G.phase) ? `<div class="card"><h3>How your players developed</h3><p class="note">Rating at the end of the season against the start${G.hidden ? ', as the league now sees it' : ''}.</p>
${G.dev.map(([id, b, a]) => `<div>${nm(id)} <small>${Math.floor(P(id).age)}</small>: ${sg(b)} → ${sg(a)} <b class="${a >= b ? 'good' : 'bad'}">(${sg(a - b)})</b></div>`).join('')}</div>` : ''}
<p class="note">${G.reveal ? 'Ratings are the truth, shown to you alone: the other clubs see only the league\'s read, as in the hidden game.' : G.hidden ? 'Ratings are what the league can see: each player\'s true talent is hidden and shows itself as he plays.' : 'Ratings are the truth: each player is exactly as good as his projection.'}
Ratings (mPM) are points per 100 possessions against an average player, split into offense (O) and defense (D); mWAR is wins above a replacement player this season, at the minutes and share of games he is projected to play.</p>`;
  },
  roster: () => {
    const T = me(), ps = T.roster.map(P).sort((a, b) => !!a.contract?.twoWay - !!b.contract?.twoWay || sp(b).rate - sp(a).rate);
    const canWaive = G.phase !== 'draft', mode = ui.rmode || (std(T).length > 15 ? 'contracts' : 'stats');
    const tog = `<div class="tabs sub">${[['stats', 'Stats'], ['contracts', 'Contracts']].map(([k, n]) => `<button data-act="rmode" data-arg="${k}"${mode === k ? ' aria-current="true"' : ''}>${n}</button>`).join('')}</div>`;
    return `${rotationCard()}${tog}${mode === 'stats' ? statsTable(ps) : `<table class="t"><thead><tr><th>Player</th><th class="n">mPM</th><th class="n">mWAR</th><th class="n">Salary</th><th class="n">Yrs</th></tr></thead><tbody>
${ps.map((p) => playerRow(p, `<td class="n">${$M(C.yearOf(p.contract, G.season)?.sal || 0)}</td><td class="n">${yrs(p).length}</td>`)
      + (ui.pid === p.id ? detail(p, extForm(p) + (canWaive ? `<div class="row"><label><input type="checkbox" id="stretch"> stretch</label>${btn('waive', 'Waive', p.id, 'warn')}</div>` : '')) : '')).join('')}</tbody></table>`}${payroll()}`;
  },
  league: () => {
    const hist = G.history.slice().reverse().map((h) => `<tr><td>${SEASON(h.season)}</td><td class="n">${h.record[G.user].join('-')}</td><td>${esc(playoffs(h))}</td><td>${h.champion}</td></tr>`).join('');
    return `${standings()}${leadersCard()}${awardsCard(G.history.at(-1))}${historyCards()}${hist ? `<h3>Your seasons</h3><table class="t"><thead><tr><th>Season</th><th class="n">W-L</th><th>Playoffs</th><th>Champion</th></tr></thead><tbody>${hist}</tbody></table>` : ''}`;
  },
  trade: () => {
    const others = Object.keys(G.teams).filter((ab) => ab !== G.user).sort();
    ui.partner ||= others[0]; ui.give ||= {}; ui.get ||= {}; ui.prot ||= {}; ui.swGive ||= {}; ui.swGet ||= {};
    const B = ui.partner, pv = X.picksView(G);
    const assets = (ab, side) => {
      const ps = G.teams[ab].roster.map(P).sort((a, b) => sp(b).rate - sp(a).rate);
      const pk = Object.values(pv).filter((k) => k.holder === ab && k.year > G.season).sort((a, b) => a.year - b.year || a.round - b.round);
      const ck = (k, label) => `<label class="ck"><input type="checkbox" data-act="tk" data-arg="${side}#${k}"${ui[side][k] ? ' checked' : ''}> ${label}</label>`;
      const sat = G.phase === 'freeagency' ? G.teams[ab].holds.map((h) => P(h.pid)).filter((p) => G.fa.includes(p.id) && !G.teams[ab].rfa?.includes(p.id)) : [];
      return sat.map((p) => { const o = L.satTerms(G, ab, p); return ck(`sat:${p.id}`, `<b>${esc(p.nm)}</b> <small>sign-and-trade · ${Math.floor(p.age)} · ${sg(sp(p).rate)} · ${wr(p)} · ${$M(o.sal)} × ${o.years}</small>`); }).join('')
        + ps.map((p) => ck(p.id, `<b>${esc(p.nm)}</b> <small>${Math.floor(p.age)} · ${sg(sp(p).rate)} · ${wr(p)} · ${$M(C.yearOf(p.contract, G.season)?.sal || 0)} × ${yrs(p).length}</small>`)).join('')
        + (G.teams[ab].rights ?? []).map(P).map((p) => ck(p.id, `<b>${esc(p.nm)}</b> <small>draft rights · ${Math.floor(p.age)} · ${sg(sp(p).rate)} · pick ${p.draft.pick}, ${p.draft.year}${p.abroad ? ' · abroad' : ''}</small>`)).join('')
        + (pk.length ? `<details${pk.some((k) => ui[side][k.id]) ? ' open' : ''}><summary>Draft picks (${pk.length})</summary>${pk.map((k) => ck(k.id, pickName(k.id, ui.prot[k.id])) + (ui[side][k.id] && k.kind === 'pick' && !k.prot && !k.terms.length ? protSel(side, k) : '')).join('')}</details>` : '')
        + swapsOf(ab, side);
    };
    // a protection the sender adds: from the top of the round, never top-12 to top-15 on a first
    const protSel = (side, k) => `<select class="prot" data-chg="prot" data-arg="${side}#${k.id}"><option value="0">no protection</option>${(k.round === 1 ? [1, 3, 4, 5, 8, 10, 11, 16, 20] : [5, 10, 15, 20, 25])
      .map((n) => `<option value="${n}"${ui.prot[k.id]?.[1] - 30 * (k.round - 1) === n ? ' selected' : ''}>top-${n} protected</option>`).join('')}</select>`;
    // new swap rights: in a draft where both clubs hold their own first, free of terms
    const swapsOf = (ab, side) => { const own = (c, y) => { const k = pv[`${c}|${y}|1`]; return k && k.holder === c && !k.prot && !k.terms.length; };
      const ys = P_.years(G).filter((y) => own(G.user, y) && own(B, y));
      return ys.length ? `<details${Object.values(side === 'give' ? ui.swGive : ui.swGet).some(Boolean) ? ' open' : ''}><summary>Swap rights</summary>${ys.map((y) => `<label class="ck"><input type="checkbox" data-act="tsw" data-arg="${side}#${y}"${(side === 'give' ? ui.swGive : ui.swGet)[y] ? ' checked' : ''}> ${side === 'give' ? `Let them swap ${y} 1sts with you` : `The right to swap ${y} 1sts with them`}</label>`).join('')}</details>` : '';
    };
    const v = ui.verdict, md = { contend: 'contending', middle: 'in the middle', rebuild: 'rebuilding' }[X.mode(L.projWins(G, B))];
    const say = !v ? '' : !v.ok ? `<p class="bad">Not allowed: ${esc(v.errors.join('; '))}.</p>`
      : v.accept ? `<p class="good">${esc(NAME(B))} accept.</p>${Object.entries(v.res.waive || {}).map(([ab, n]) => `<p class="note">${ab === G.user ? `You will have to waive ${n}` : `${esc(NAME(ab))} will waive ${n}`} to get back to the roster limit.</p>`).join('')}${btn('accept', 'Make the trade')}`
      : `<p class="bad">${esc(NAME(B))} decline: they would want about ${$M(Math.max(v.need[B] - v.gains[B], 0))} more in value.</p>`;
    const open = G.phase !== 'season' || G.date <= C.seasonDates(G.season).deadline;
    return `<div class="card"><label>Trade with <select id="partner" data-chg="partner">${others.map((ab) => `<option value="${ab}"${ab === B ? ' selected' : ''}>${esc(NAME(ab))}</option>`).join('')}</select></label>
${capStrip(B)}<details><summary>Their cap sheet</summary>${payroll(B)}</details><p class="note">${esc(NAME(B))} are ${md}.${open ? '' : ' The deadline has passed.'}${ui.done ? ' Trade done.' : ''}</p></div>
<div class="two"><div><h3>You send</h3>${assets(G.user, 'give')}</div><div><h3>You get</h3>${assets(B, 'get')}</div></div>
<div class="card sticky">${(() => { const t = tradeOf(), sal = (to) => t.moves.filter((m) => m.to === to).reduce((a, m) => a + (C.yearOf(P(m.pid).contract, G.season)?.sal || (t.sat.some(([, id]) => id === m.pid) ? L.satTerms(G, m.from, P(m.pid)).sal : 0)), 0);
  return `<p class="note">Salary out ${$M(sal(B))}, in ${$M(sal(G.user))}.</p>`; })()}${btn('propose', 'Propose')}${open ? btn('shop', 'Shop them to every club', '', 'ghost') : ''}${say}
<p class="note">Trading block: tick players under "You send" and shop them; each club that wants one makes its best offer, and the best six land on your home page.</p></div>`;
  },
  playoffs: () => {
    const po = G.po;
    if (!po) return '<p>No playoffs under way.</p>';
    // every round so far, finished and under way, in bracket order (1-8, 4-5, 3-6, 2-7 each side)
    const rounds = [...po.rounds.map((rd) => Object.entries(rd).map(([k, v]) => { const [hi, lo] = k.split('-'), [w, l] = v.games.split('-').map(Number); return { hi, lo, w, l, g: v.g }; })), ...(po.champion ? [] : [po.series])];
    const seed = (ab) => Object.values(po.seeds).map((S) => S.indexOf(ab) + 1).find((k) => k > 0);
    const line = (ab, n, won) => `<div class="${won ? 'won' : ''}${ab === G.user ? ' me' : ''}"><small>${seed(ab)}</small> ${ab}<b>${n}</b></div>`;
    const box = (x) => (x ? `<div class="bx">${line(x.hi, x.w, x.w === 4)}${line(x.lo, x.l, x.l === 4)}</div>` : '<div class="bx tbd">&nbsp;</div>');
    const side = (c) => `<div class="br">${[4, 2, 1].map((n, i) => { const xs = (rounds[i] || []).filter((x) => G.teams[x.hi].conf === c);
      return `<div class="rd"><small>${['First round', 'Semifinals', 'Conf. finals'][i]}</small><div class="rb">${Array.from({ length: n }, (_, j) => box(xs[j])).join('')}</div></div>`; }).join('')}</div>`;
    const mine = rounds.flat().filter((x) => x.hi === G.user || x.lo === G.user).at(-1);
    const games = mine ? `<div class="card mine"><b>${esc(NAME(mine.hi))} ${mine.w}, ${esc(NAME(mine.lo))} ${mine.l}</b><ol class="games">${mine.g.map((g, i) => `<li>Game ${i + 1} at ${g.h}: <b class="${g.win === G.user ? 'good' : 'bad'}">${g.win}</b> by ${g.by}</li>`).join('')}</ol></div>` : '';
    const pin = ['East', 'West'].map((c) => { const p = po.playin[c]; return `<p class="note">${c} play-in: ${p.w78} take the 7 seed; ${p.eighth} take the 8 seed; ${p.out.join(' and ')} are out.</p>`; }).join('');
    return `<div class="brk"><h3>East</h3>${side('East')}<h3>West</h3>${side('West')}<h3>Finals</h3><div class="br"><div class="rd">${box(rounds[3]?.[0])}</div><div class="rd"></div><div class="rd"></div></div>
${po.champion ? `<p><b>${esc(NAME(po.champion))}</b> are champions.</p>` : ''}</div>${games}${pin}`;
  },
  draft: () => {
    if (!G.draft) return '<p>No draft under way.</p>';
    const c = L.onClock(G), onMe = c?.holder === G.user, made = G.draft.picks.slice(-8).reverse();
    const pool = G.draft.avail.map(P);
    const next = G.draft.order.slice(G.draft.picks.length, G.draft.picks.length + 8);
    const roster = me().roster.map(P).filter((p) => !p.contract?.twoWay), byPos = (k) => roster.filter((p) => (p.pos || '').startsWith(k)).length;
    const [say, ...b] = NEXT.draft(), th = onMe ? null : L.there(G), tn = c && !onMe ? L.takenNow(G) : null;
    return `<div class="card"><p>${say}</p><div class="row">${onMe ? btn('autopick', 'Take the best available') : b.filter((x) => x && !x.includes('data-arg="draft"')).join('')}</div>
${c ? `<p class="note">On the clock, in order: ${next.map((e) => `${e.slot}. ${e.holder === G.user ? `<b>${e.holder}</b>` : e.holder}`).join(', ')}. You can trade picks and players between picks.</p>` : ''}
<p class="note">Your roster: ${byPos('G')} guards, ${byPos('F')} forwards, ${byPos('C')} centers.</p></div>
${board(pool, onMe, tn, th, c)}
<h3>Latest picks</h3><ul>${made.map((x) => `<li>${x.slot}. ${x.team}: ${nm(x.pid)}</li>`).join('')}</ul>`;
  },
  decisions: () => {
    const T = me(), s = G.season + 1, c = G.choices ||= {}, rec = G.history.at(-1).record;
    const calls = G.calls?.length ? `<div class="card"><h3>Clubs calling</h3><p class="note">Clubs changing GMs this summer call a sitting GM as often as they hire one out of work with his record. Take a job and your club hires a GM of its own; the offers lapse when the new league year starts.</p>
${G.calls.map((o) => offerRow(o, rec)).join('')}</div>` : '';
    const renewal = G.renewal ? `<div class="card"><h3>Your contract</h3><p>Your deal ends with this season. The owner offers to renew it.</p>${offerRow({ ...G.renewal, ab: 'renew' }, rec)}<div class="row">${btn('walk', 'Turn it down and leave', '', 'warn')}</div><p class="note">A renewal left standing is taken as offered when the new league year starts.</p></div>` : '';
    const opts = T.roster.map(P).filter((p) => C.yearOf(p.contract, s)?.opt === 'tm');
    const qos = T.roster.map(P).filter((p) => p.contract?.rookie && p.draft?.round === 1 && !C.yearOf(p.contract, s));
    const row = (k, p, what) => `<label class="ck"><input type="checkbox" data-act="toggle" data-arg="${k}|${p.id}"${c[`${k}|${p.id}`] ? ' checked' : ''}> <b>${esc(p.nm)}</b> <small>${Math.floor(p.age)} · ${sg(sp(p).rate)} · ${wr(p)} · ${what}</small></label>`;
    return `${renewal}${calls}<div class="card"><h3>Team options for ${SEASON(s)}</h3>${opts.map((p) => row('opt', p, `pick up ${$M(C.yearOf(p.contract, s).sal)}`)).join('') || '<p>None.</p>'}
<h3>Qualifying offers</h3><p class="note">Tendering one makes the player a restricted free agent: you may match any offer sheet.</p>
${qos.map((p) => row('qo', p, 'tender')).join('') || '<p>None.</p>'}
<h3>First-round picks</h3><p class="note">Sign one to his rookie-scale deal, or stash him abroad: you keep his rights and can bring him over in a later summer on the scale for his slot (for up to four summers).</p>
${T.roster.map(P).filter((p) => p.draft?.year === s && p.draft.round === 1 && p.contract?.rookie).map((p) => `<div class="ck"><b>${esc(p.nm)}</b> <small>${Math.floor(p.age)} · ${sg(sp(p).rate)} · pick ${p.draft.pick}${p.from || p.pre?.lvl ? ` · ${esc(p.from || p.pre.lvl)}` : ''}</small><div class="row">${[['', 'Sign him'], ['1', 'Stash abroad']].map(([k, l]) => btn('stash', l, `${p.id}|${k}`, (c[`st|${p.id}`] ? '1' : '') === k ? '' : 'ghost')).join('')}</div></div>`).join('') || '<p>None.</p>'}
<h3>Second-round picks and men abroad</h3><p class="note">You hold their rights: sign one to a two-year deal (the first year guaranteed, at the minimum), to a two-way deal, or leave him abroad another season, keeping his rights (for up to four summers).</p>
${(T.rights ?? []).map(P).map((p, _, R) => { const v = c[`sr|${p.id}`] ?? (p.abroad ? '' : 'deal'), full = v !== 'twoWay' && T.roster.map(P).filter((q) => q.contract?.twoWay && C.yearOf(q.contract, s)).length + R.filter((q) => c[`sr|${q.id}`] === 'twoWay').length >= 3; return `<div class="ck"><b>${esc(p.nm)}</b> <small>${Math.floor(p.age)} · ${sg(sp(p).rate)} · pick ${p.draft.pick}, ${p.draft.year}${p.abroad ? ' · abroad' : ''}</small><div class="row">${[['deal', p.draft.round === 1 ? 'Rookie-scale deal' : 'Two-year deal'], ...(p.draft.round === 1 ? [] : [['twoWay', 'Two-way']]), ['', 'Abroad']].map(([k, l]) => btn('second', l, `${p.id}|${k}`, v === k ? '' : 'ghost').replace('<button', k === 'twoWay' && full ? '<button disabled title="Your three two-way spots are full"' : '<button')).join('')}</div></div>`; }).join('') || '<p>None.</p>'}
${btn('newyear', 'Start the new league year')}</div>`;
  },
  resign: () => {
    if (G.fa_) return VIEWS.fa();
    const T = me(), c = G.choices ||= {};
    const mine = T.holds.map((h) => P(h.pid)).filter((p) => G.fa.includes(p.id));
    return `<div class="card"><h3>Your free agents</h3><p class="note">Each one's terms: his ask, as far as his Bird rights let you pay it.</p>
${(() => { let ex = 0;   // the owner judges each re-signing on top of the ones ticked before it, as the market will
  return mine.map((p) => { const o = L.resignTerms(G, G.user, p), on = !!c[`re|${p.id}`], v = O.veto(G, ex + o.sal); if (on && !v) ex += o.sal;
    return `<label class="ck"><input type="checkbox" data-act="toggle" data-arg="re|${p.id}"${on ? ' checked' : ''}> <b>${esc(p.nm)}</b> <small>${Math.floor(p.age)} · ${sg(sp(p).rate)} · ${wr(p)} · ${$M(o.sal)} × ${o.years} (${o.how})${T.rfa?.includes(p.id) ? ' · restricted' : ''}</small>${v ? `<br><small class="bad">${on ? 'The owner will veto this' : 'The owner would veto this'}: ${esc(v.replace(/^The owner won't approve it: /, ''))}</small>` : ''}</label>`; }).join('') || '<p>None.</p>'; })()}
${btn('market', 'Open the market')}</div>`;
  },
  fa: () => {
    const open = G.phase !== 'freeagency';                      // after the summer market: sign on the spot
    if (!G.fa_ && !open) return VIEWS.resign();
    const f = F(), sheets = open ? [] : Object.entries(G.fa_.sheets);
    const all = G.fa.map(P).filter((p) => !p.retired).sort((a, b) => sp(b).rate - sp(a).rate), pool = all.slice(0, ui.more ? 150 : 30);
    const ask = (p) => L.askOf(G, p, f);
    const lvl = (p) => me().holds.some((h) => h.pid === p.id) && C.birdLevel(p, G.user);
    const hows = (p) => [...(lvl(p) ? [{ full: 'bird', early: 'earlyBird' }[lvl(p)] || 'nonBird'] : []), 'room', 'ntmle', 'tpmle', 'roomMle', 'bae', 'min', ...(p.yos < 4 ? ['twoWay'] : []), ...(me().tpes.some((x) => x.dpe && x.expires >= G.date) ? ['dpe'] : [])];
    const valid = (p, how) => C.validateSigning(G, { team: G.user, pid: p.id, how, date: G.date, prior: (p.prior || 0) * 1e6,
      years: L.years5(how === 'min' ? C.minSalary(p.yos, f.cap) : ask(p).sal, how === 'min' ? 1 : Math.min(ask(p).years, 2), 0.05) }).ok;
    const form = (p) => { const h0 = hows(p).find((h) => valid(p, h)) || 'min'; return `<div class="form"><label>Using <select id="how">${hows(p).map((h) => `<option${h === h0 ? ' selected' : ''}>${h}</option>`).join('')}</select></label>
<label>Salary ($M) <input id="sal" type="number" step="0.1" value="${(ask(p).sal / 1e6).toFixed(1)}"></label>
<label>Years <input id="yrs" type="number" min="1" max="5" value="${ask(p).years}"></label>${btn('offer', 'Make the offer')}${lvl(p) ? btn('renounce', 'Renounce his rights', p.id, 'warn') : ''}${ui.err ? `<p class="bad">${esc(ui.err)}</p>` : ''}</div>`; };
    return `${sheets.map(([pid, o]) => `<div class="card"><p>${esc(NAME(o.ab))} offer ${esc(P(pid).nm)} ${$M(o.sal)} × ${o.years}.</p>${btn('match', 'Match', `${pid}|1`)}${btn('match', 'Let him go', `${pid}|0`)}${pid in G.matchAns ? ` <small>${G.matchAns[pid] ? 'matching' : 'declining'}</small>` : ''}</div>`).join('')}
${open ? `<div class="card"><p class="note">The market has closed: whoever is left signs on the spot for an offer at half his summer ask or better.</p></div>` : faCards()}${spendCard()}
<table class="t"><thead><tr><th>Free agent</th><th class="n">mPM</th><th class="n">mWAR</th><th class="n">Ask</th></tr></thead><tbody>
${pool.map((p) => playerRow(p, `<td class="n">${$M(ask(p).sal)} × ${ask(p).years}</td>`) + (ui.pid === p.id ? detail(p, form(p)) : '')).join('')}</tbody></table>
${all.length > pool.length ? `<div class="row">${btn('famore', `Show more (${all.length - pool.length} left)`, '', 'ghost')}</div>` : ''}${payroll()}`;
  },
  log: () => {
    const mine = ui.all ? G.log : G.log.filter((x) => (x.teams || [x.team]).includes(G.user));
    return `<div class="row">${btn('logall', ui.all ? 'Your club only' : 'Every club')}</div><ul class="log">${mine.slice(-150).reverse().map((x) => `<li><small>${x.date}</small> ${logLine(x)}</li>`).join('')}</ul>`;
  },
  menu: () => `<div class="card"><h3>This game</h3><p>${esc(NAME(G.user))}, ${G.reveal ? 'the truth, the other clubs scouting' : G.hidden ? 'hidden talent' : `projections as the truth, the other clubs knowing it ${G.clubs === 'exact' ? 'exactly' : 'with their leanings'}`}, started ${SEASON(G.history[0]?.season ?? G.season)}. Saved in this browser after every step.</p>
<div class="row">${btn('export', 'Export the save')}${btn('import', 'Import a save')}${btn('newgame', 'New game', '', 'warn')}</div>
<p class="note">Injury help: ${G.staffSigns === false ? 'off. Your club plays short when injuries pile up.' : 'on. When fewer than 13 of your men on standard deals are healthy, your staff signs the best free agent to a 10-day contract (past 15 under the hardship exception once four are out).'}</p>${btn('staff', G.staffSigns === false ? 'Let the staff sign injury help' : 'Stop the staff signing injury help', '', 'ghost')}</div>`,
};
// The front offices: who runs each club, his background, and his three fitted leanings
const BG = { former_player: 'Former player', cap_specialist: 'Cap specialist', former_agent: 'Former agent', former_scout: 'Former scout', analytics: 'Analytics' };
// Every GM, all time: the real records to 2025-26 (G.K.gm.records) with the game's seasons added
// (G.gmStats), yours among them; sortable, per season or over the career
const GCOL = [['n', 'GM', 0], ['seasons', 'Seasons', 0], ['pct', 'Win %', 0], ['vs_w', 'Wins vs line', 1], ['po_w', 'Playoff wins', 1], ['titles', 'Titles', 1], ['trade', 'Trades $M', 1], ['draft', 'Draft $M', 1]];
function allGMs() {
  const R = G.K.gm.records || {}, S = G.gmStats || {}, now = Object.fromEntries(Object.entries(G.teams).map(([ab, T]) => [ab === G.user && !G.fired ? 'you' : T.gm.id, ab]));
  return [...new Set([...Object.keys(R), ...Object.keys(S)])].map((id) => {
    const a = R[id], b = S[id], add = (k) => (a?.[k] || 0) + (b?.[k] || 0);
    const t = { id, n: (a || b).n, clubs: [...new Set([...(a?.clubs || []), ...(b?.clubs || [])])], first: a?.first ?? (b.last - b.seasons + 1), last: b?.last ?? a.last, now: now[id], sim: b?.seasons || 0 };
    for (const k of ['seasons', 'w', 'l', 'vs_w', 'lined', 'po_w', 'titles', 'trade', 'draft']) t[k] = add(k);
    t.pct = t.w / (t.w + t.l);
    return t; });
}
// Your staff (staff.js): who you have, who is out there, and what they add to your read
const staffRow = (h, b) => `<tr><td>${esc(h.nm)}</td><td>${ST.KINDS[h.t].label}</td><td class="n">${h.q.toFixed(2)}</td><td class="n">$${Math.round(h.sal / 1e3)}k</td><td>${b}</td></tr>`;
const STH = '<thead><tr><th>Name</th><th>Role</th><th class="n">Quality</th><th class="n">Pay</th><th></th></tr></thead>';
VIEWS.staff = () => {
  const st = ST.of(G), pool = G.staffPool || [], pct = (k) => Math.round(100 * ST.miss(G, k)), avg = (k) => Math.round(100 * Object.keys(G.teams).filter((ab) => ab !== G.user).reduce((a, ab) => a + ST.miss(G, k, ab), 0) / (Object.keys(G.teams).length - 1));
  return `<div class="card"><h3>Your staff</h3><p>Your read of a prospect misses by <b>${pct(0)}%</b> of what the league's does, of an NBA player by <b>${pct(1)}%</b> (the average club's: ${avg(0)}% and ${avg(1)}%). Pay this season: ${$M(ST.cost(G))}, with the club's other costs.</p>
${st.length ? `<table class="t">${STH}<tbody>${st.map((h) => staffRow(h, btn('stfire', 'Let go', h.id, 'warn'))).join('')}</tbody></table>` : '<p>No one: you see only what the league sees, and every other club sees more.</p>'}${G.staffSay ? `<p class="note">${esc(G.staffSay)}</p>` : ''}</div>
<div class="card"><h3>Available</h3>${pool.length ? `<table class="t">${STH}<tbody>${pool.map((h) => staffRow(h, btn('sthire', 'Hire', h.id))).join('')}</tbody></table>` : '<p>No one until the summer.</p>'}${ui.stsay ? `<p class="note">${esc(ui.stsay)}</p>` : ''}</div>
<p class="note">Each hire reads every player's true talent with an error of his own. Part of that error is shared by everyone on your staff, more of it by hires of the same kind (scouts watch the same games, analysts run the same numbers), so a second hire of a kind adds less than the first. Your ratings weigh the league's read and each hire's by how often they miss. Quality 1 is an average hire. In the game an average analyst is worth about 0.6 wins a season (a real study found up to 1.25: Wang, Sarker and Hosoi, 2025); scouts read prospects better and analysts NBA players. Every club has a staff, about 4 analysts (as real clubs had in 2023) and 6 scouts, and values players by its own read. Each summer some are hired away, more after a deep playoff run, and a new market opens. A staff stays with its club: take another job and you inherit that club's.</p>`;
};
ACT.sthire = (id) => {
  const h = G.staffPool.find((x) => x.id === id), b = O.projected(G), l = O.line(G, b.s);
  if (b.profit - h.sal / 1e6 < l) { ui.stsay = `The owner won't approve it: it would take this season below his line of ${$m(l)}.`; render(); return; }
  G.staffPool = G.staffPool.filter((x) => x !== h); (me().staff ||= []).push(h); ui.stsay = `${h.nm} joins your staff.`; save(); render();
};
ACT.stfire = (id) => { const h = ST.of(G).find((x) => x.id === id); me().staff = ST.of(G).filter((x) => x !== h); ui.stsay = `${h.nm} is let go.`; save(); render(); };
VIEWS.gms = () => {
  const cap = F().cap, per = ui.gmPer ?? true, key = ui.gmSort || 'seasons', dir = ui.gmDir ?? -1;
  const val = (t, k, f) => (k === 'n' ? t.n : k === 'pct' || k === 'seasons' || !f ? t[k] : per ? t[k] / (k === 'vs_w' ? t.lined || 1 : t.seasons) : t[k]);
  const usd = (v) => v / 100 * cap / 1e6;                                       // % of a season's cap, at this season's, $M
  const L = allGMs().filter((t) => t.seasons).sort((a, b) => { const f = GCOL.find((c) => c[0] === key)[2], x = val(a, key, f), y = val(b, key, f); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; });
  const cell = (t, [k, , f]) => { const v = val(t, k, f);
    return k === 'n' ? `<td>${t.id === 'you' ? '<b>You</b>' : esc(t.n)}${t.now ? ` <small>${t.now}</small>` : ''}<br><small>${t.clubs.join(', ')} · ${SEASON(t.first)}${t.last > t.first ? `–${SEASON(t.last).slice(-2)}` : ''}${t.sim ? ` · ${t.sim} in the game` : ''}</small></td>`
      : `<td class="n">${k === 'seasons' ? v : k === 'pct' ? `${t.w}-${t.l}<br><small>${v.toFixed(3).replace(/^0/, '')}</small>` : k === 'trade' || k === 'draft' ? sg(usd(v)) : k === 'vs_w' ? sg(+v.toFixed(1)) : per ? v.toFixed(k === 'titles' ? 2 : 1) : v}</td>`; };
  const head = GCOL.map(([k, h]) => `<th class="${k === 'n' ? '' : 'n'}" data-act="gmsort" data-arg="${k}" style="cursor:pointer">${h}${key === k ? (dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('');
  return `<div class="card"><h3>Every GM</h3><div class="row">${btn('gmper', per ? '✓ Per season' : 'Per season', '', per ? '' : 'ghost')}${btn('gmper', per ? 'Career' : '✓ Career', '', per ? 'ghost' : '')}</div>
<div class="scroll"><table class="t bx"><thead><tr><th>#</th>${head}</tr></thead><tbody>${L.map((t, i) => `<tr${t.id === 'you' ? ' class="me"' : ''}><td class="n">${i + 1}</td>${GCOL.map((c) => cell(t, c)).join('')}</tr>`).join('')}</tbody></table></div>
<p class="note">Every lead executive since 1999-2000 (Basketball-Reference's team pages), his real record through 2025-26 and his seasons in this game added, yours among them; click a column to sort. Wins vs line: games won over the preseason over-under (in the game, over the club's projection at the opener). Trades: the model's surplus of what his clubs took in over what they sent, players and picks; Draft: the worth of his picks against the best man left at each, so never above zero. Both are shares of each season's cap, shown at this season's (${$M(cap)}).</p></div>
${frontOffices()}`;
};
ACT.gmsort = (k) => { ui.gmDir = ui.gmSort === k ? -(ui.gmDir ?? -1) : (k === 'n' ? 1 : -1); ui.gmSort = k; render(); };
ACT.gmper = () => { ui.gmPer = !(ui.gmPer ?? true); render(); };
function frontOffices() {
  const K = G.K.gm, cap = F().cap, rows = Object.entries(G.teams).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([ab, T]) => {
    const g = T.gm, you = ab === G.user;
    return `<tr${you ? ' class="me"' : ''}><td>${esc(T.name)}</td><td>${you ? '<b>You</b>' : esc(g.n)}</td><td>${you ? '' : g.b.map((k) => BG[k]).join(', ') || '—'}</td><td class="n">${you ? '' : g.ten}</td>
<td class="n">${you ? '' : (K.tradesMean + g.trades).toFixed(1)}</td><td class="n">${you ? '' : (g.consolidate < 0 ? '−' : '+') + Math.abs(g.consolidate).toFixed(2)}</td><td class="n">${you ? '' : sg(g.sign_rate / 100 * cap / 1e6)}</td></tr>`; }).join('');
  return `<div class="card"><h3>Front offices now</h3><div class="scroll"><table class="t bx"><thead><tr><th>Club</th><th>GM</th><th>Background</th><th class="n">Seasons</th><th class="n">Trades a season</th><th class="n">Players out − in</th><th class="n">$M per mPM</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">The clubs opened with their real lead executives. Three leanings set real GMs apart beyond luck, and each GM has his own, estimated from his record and pulled toward the average for his background (a GM with a short record is mostly his background): how many trades he makes a season; how many more players he sends out than he takes back in a trade; and how much more (or less) than the league he pays a free agent for each point of mPM, in first-season salary. Analytics hires trade most and pay most for mPM, and their reads of players stray half as far from the model's as other GMs'. GMs lose their jobs as real ones do, mostly when their club falls short of what was expected, and more often under a new owner (clubs change hands about one in 21 a year, yours included); ${G.gmPool.length} are out of work, and they come back at the rates real ones did; the rest of the openings go to first-time GMs.</p></div>`;
}
ACT.logall = () => { ui.all = !ui.all; render(); };
ACT.famore = () => { ui.more = true; render(); };

function newGame() {
  return `<div class="card"><h2>Run a club</h2><p>Take over any team on the eve of the 2026-27 season, with its real roster, contracts and picks.
Every rule of the collective bargaining agreement applies; the other 29 clubs are run by computer GMs who value players the way this site does, each with his own leanings.</p>
<label>Club <select id="team">${Object.entries(TEAMS).sort((a, b) => a[1].localeCompare(b[1])).map(([ab, n]) => `<option value="${ab}">${esc(n)}</option>`).join('')}</select></label>
<fieldset><legend>Talent</legend><label class="ck"><input type="radio" name="mode" value="hidden" checked> Hidden: ratings are estimates, and players turn out better or worse</label>
<label class="ck"><input type="radio" name="mode" value="truth"> The truth: every player is exactly his projection</label>
<label>With the truth, the other clubs <select id="clubs"><option value="lean">know it too, each with his own leanings</option><option value="exact">know it exactly, as you do</option><option value="scout">scout as in the hidden game: only you see the truth</option></select></label></fieldset>
<label>Owner <select id="owner"><option value="random">Random</option>${Object.entries(O.OWNERS).map(([k, o]) => `<option value="${k}">${o.label}</option>`).join('')}</select></label>
<label>Can you be fired? <select id="fire"><option value="simple">Simple: when the owner's confidence ends a season below 20</option><option value="realistic">Realistic: as real GMs lose their jobs, by the record against expectations</option><option value="never">Never</option></select></label>
<div class="row"><button class="b" id="create">Start</button>${btn('import', 'Import a save')}</div></div>`;
}
let TEAMS = {};

// ---- wiring ------------------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && root().contains(b) && b.tagName !== 'SELECT') { if (b.tagName === 'TR' && e.target.closest('button,input,label,select')) return; ACT[b.dataset.act](b.dataset.arg); }
  if (e.target.id === 'create') create();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.card) ACT.closecard(); });
document.addEventListener('change', (e) => { if (e.target.dataset.chg) ACT[e.target.dataset.chg](e.target); });
async function data() { return (await fetch('gm/league.json')).json(); }
// a save keeps its league; the model's constants (K) are the site's current ones, which the code expects
// A save from before the clubs had their real GMs gets them now, on the season under way.
const current = async (g) => { const d = await data(), G_ = { ...g, K: { ...d.league.const, ...d.cal } }; if (G_.draft) L.settleDraft(G_);
  M.setDisc(G_.K);
  // a save from before contracts: its calls and offers were clubs alone, now each with its terms
  const withTerms = (L) => L.map((x) => (typeof x === 'string' ? { ab: x, ...O.terms(G_, S.rng(1), G_.season + 1) } : x));
  if (G_.calls) G_.calls = withTerms(G_.calls); if (G_.fired?.offers) G_.fired.offers = withTerms(G_.fired.offers);
  if (G_.hidden && !G_.teams[G_.user].staff) ST.init(G_, S.rng(1));     // a save from before staffs
  for (const p of Object.values(G_.players)) V.initSeen(p, G_.K);   // a save from before ratings kept what they stand on
  if (!G_.gmPool) { GM.init(G_, d.league, S.rng(G_.seed ?? 1)); G_.fireMode = 'simple'; if (['season', 'playoffs'].includes(G_.phase)) for (const ab in G_.teams) G_.teams[ab].gm.pre = L.projWins(G_, ab) / 82; }
  return G_; };
async function create() {
  const team = $('#team').value, truth = document.querySelector('input[name=mode]:checked').value === 'truth', clubs = $('#clubs').value;
  // the clubs scouting while you see the truth: the hidden game, its talent shown to you alone (G.reveal)
  const hidden = !truth || clubs === 'scout';
  root().insertAdjacentHTML('beforeend', '<div class="busy" role="status">Building the league…</div>');
  const d = await data(), seed = Math.floor(Math.random() * 2 ** 31);
  adopt(L.newGame(d.league, d.cal, { team, hidden, seed }));
  if (truth) Object.assign(G, clubs === 'scout' ? { reveal: true } : { clubs });
  O.hire(G, $('#owner').value, r); G.fireMode = $('#fire').value; G.deal = { sal: O.terms(G, r, G.season).sal, from: G.season, to: G.season + 4 };
  view = 'home'; await save(); render();
}
async function boot() {
  $('#importf').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    adopt(await current(JSON.parse(await f.text()))); view = 'home'; await save(); render();
  });
  const g = await idb('readonly', (s) => s.get('game')).catch(() => null);
  TEAMS = JSON.parse(root().dataset.teams);         // the start screen needs only the names; the league loads on Start
  if (g) adopt(await current(g));
  render();
}
boot();
