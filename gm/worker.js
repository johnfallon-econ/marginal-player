// A trade window's offers, drawn up off the page (trades.js tradeWindowWith). The worker holds the
// league for the window: given it at the start, then each deal that goes through, applied here as
// on the page, so what it has learned of the league (players' and picks' worth) carries over.
import * as X from './trades.js';
import * as M from './value.js';

const port = globalThis.WorkerGlobalScope ? globalThis : (await import('node:worker_threads')).parentPort;   // a browser's, or Node's (tests)
let G = null;
const on = (data) => {
  if (data.G) { G = data.G; M.setDisc(G.K); return; }
  if (data.trade) { X.execute(G, data.trade, data.res); Object.assign(G._wins, data.wins); return; }
  const x = X.market(G);
  port.postMessage({ id: data.id, out: data.need.map(([S, pid, B, V]) => X.buildOffer(G, x, B, S, G.players[pid], data.date, false, V)) });
};
if (globalThis.WorkerGlobalScope) port.onmessage = (e) => on(e.data); else port.on('message', on);
