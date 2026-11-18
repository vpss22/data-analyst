// ---------------------------------------------------------------------------
// Backtester — replays real historical ticks from Deriv's public feed through
// the exact same strategy + risk code used live.
//
// HONEST LIMITATIONS (read before trusting any number):
//  * Historical proposal prices are not published, so payouts are modelled as
//    stake x payout_ratio (measure the live ratio with `node main.mjs probe`).
//  * Entry is the tick AFTER the signal tick (no look-ahead), exit is the Nth
//    tick after entry — matching Deriv's tick-contract settlement.
//  * Synthetic indices are RNG-driven: a profitable backtest is a hypothesis,
//    not proof of edge. Always forward-test on a demo account.
// ---------------------------------------------------------------------------
import fs from 'fs';
import { DerivSocket } from './client.mjs';
import { makeStrategy, STRATEGIES } from './strategies.mjs';
import { RiskManager } from './risk.mjs';

const round2 = (x) => Math.round(x * 100) / 100;

export async function fetchTicks(symbol, count, log = console) {
  const sock = new DerivSocket();
  await sock.connect();
  const out = [];
  let end = 'latest';
  try {
    while (out.length < count) {
      const want = Math.min(1000, count - out.length); // new API caps ticks_history at 1000/call
      const r = await sock.call({ ticks_history: symbol, count: want, end, style: 'ticks' });
      const h = r.history;
      if (!h?.prices?.length) break;
      const chunk = h.prices.map((p, i) => ({ quote: +p, epoch: h.times[i] }));
      out.unshift(...chunk);
      end = String(h.times[0] - 1);
      log.log(`  fetched ${out.length}/${count} ticks (back to ${new Date(h.times[0] * 1000).toISOString()})`);
      if (h.prices.length === 0) break;
    }
  } finally { sock.close(); }
  return out.slice(-count);
}

export function runBacktest(ticks, cfg, { label = 'full' } = {}) {
  const strat = makeStrategy(cfg.strategy.name, cfg.strategy.params);
  const risk = new RiskManager(cfg.risk, cfg.start_balance ?? 1000);
  const ratio = cfg.payout_ratio ?? 1.95;
  const dur = cfg.contract.duration;
  if (cfg.contract.duration_unit !== 't')
    throw new Error('backtester supports tick-duration contracts (duration_unit: "t") — set it in config');
  const trades = [];
  let pending = null; // signal waiting for entry tick
  let open = null;    // {entry, ticksLeft, dir, stake, payout, i, reason}

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    risk.onTick();
    if (open) {
      open.ticksLeft--;
      if (open.ticksLeft <= 0) {
        const win = open.dir === 'CALL' ? t.quote > open.entry : t.quote < open.entry;
        const profit = win ? round2(open.payout - open.stake) : -open.stake;
        risk.onResult(profit);
        trades.push({ i, epoch: t.epoch, dir: open.dir, stake: open.stake, entry: open.entry, exit: t.quote,
                      win, profit, equity: risk.equity, reason: open.reason });
        open = null;
      }
    } else if (pending) {
      open = { ...pending, entry: t.quote, ticksLeft: dur, i };
      pending = null;
    }
    const sig = strat.update(t);
    if (sig && !open && !pending) {
      const gate = risk.canTrade({ payoutRatio: ratio, openPositions: 0 });
      if (gate.ok) pending = { dir: sig.signal, stake: gate.stake, payout: round2(gate.stake * ratio), reason: sig.reason };
    }
  }

  const wins = trades.filter((t) => t.win).length;
  const n = trades.length;
  const grossWin = trades.filter((t) => t.win).reduce((a, t) => a + t.profit, 0);
  const grossLoss = -trades.filter((t) => !t.win).reduce((a, t) => a + t.profit, 0);
  const net = round2(grossWin - grossLoss);
  const breakeven = 1 / ratio;
  return {
    label, ticks: ticks.length, from: new Date(ticks[0]?.epoch * 1000).toISOString(), to: new Date(ticks.at(-1)?.epoch * 1000).toISOString(),
    trades: n, wins, winRate: n ? wins / n : null,
    breakevenWinRate: breakeven,
    edgePp: n ? (wins / n - breakeven) * 100 : null,           // percentage points above breakeven
    netPnl: net, evPerTrade: n ? round2(net / n) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : null,
    maxDrawdown: risk.maxDrawdown, worstLossStreak: risk.worstLossStreak,
    finalEquity: risk.equity, halted: risk.halted, haltReason: risk.haltReason,
    payoutRatioAssumed: ratio, tradeList: trades,
  };
}

export async function backtestCommand(cfg, opts = {}) {
  const count = opts.ticks ?? cfg.backtest.ticks ?? 20000;
  const symbol = opts.symbol ?? cfg.symbol;
  console.log(`\nFetching ${count} real ticks for ${symbol} from Deriv public feed...`);
  const ticks = await fetchTicks(symbol, count);
  if (ticks.length < 500) throw new Error('not enough history returned');
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(`data/backtest-ticks-${symbol}.json`, JSON.stringify(ticks));

  const btCfg = {
    strategy: cfg.strategy, risk: cfg.risk, contract: cfg.contract,
    payout_ratio: cfg.backtest.payout_ratio, start_balance: cfg.paper.starting_balance,
  };

  console.log('\n================ BACKTEST RESULTS ================');
  console.log(`Strategy: ${cfg.strategy.name}  |  Symbol: ${symbol}  |  Contract: ${cfg.contract.duration}${cfg.contract.duration_unit} CALL/PUT`);
  console.log(`Assumed payout ratio: ${btCfg.payout_ratio} (breakeven win rate ${(100 / btCfg.payout_ratio).toFixed(2)}%)`);

  const wf = cfg.backtest.walk_forward ?? 0.6;
  const split = Math.floor(ticks.length * wf);
  const results = [
    runBacktest(ticks, btCfg, { label: 'FULL' }),
    runBacktest(ticks.slice(0, split), btCfg, { label: `TRAIN (first ${Math.round(wf * 100)}%)` }),
    runBacktest(ticks.slice(split), btCfg, { label: `TEST (last ${Math.round((1 - wf) * 100)}%)` }),
  ];
  for (const r of results) printResult(r);

  const full = results[0];
  fs.writeFileSync('data/backtest-trades.csv',
    'i,epoch,dir,stake,entry,exit,win,profit,equity,reason\n' +
    full.tradeList.map((t) => [t.i, t.epoch, t.dir, t.stake, t.entry, t.exit, t.win ? 1 : 0, t.profit, t.equity, `"${t.reason}"`].join(',')).join('\n'));
  console.log('\nTrade list saved to data/backtest-trades.csv');
  console.log('\nREMINDER: assumed constant payout ratio; synthetic indices are RNG-driven.');
  console.log('A green backtest is a hypothesis. Forward-test on DEMO before any real money.\n');
  return results;
}

function printResult(r) {
  const pct = (x) => x === null ? 'n/a' : (100 * x).toFixed(2) + '%';
  console.log(`\n--- ${r.label} ---  (${r.ticks} ticks, ${r.from} -> ${r.to})`);
  console.log(`trades: ${r.trades}   wins: ${r.wins}   win rate: ${pct(r.winRate)}   breakeven: ${pct(r.breakevenWinRate)}`);
  console.log(`edge vs breakeven: ${r.edgePp === null ? 'n/a' : r.edgePp.toFixed(2) + ' pp'}   EV/trade: $${r.evPerTrade ?? 'n/a'}`);
  console.log(`net P&L: $${r.netPnl}   profit factor: ${r.profitFactor ?? 'n/a'}   max DD: $${r.maxDrawdown}   worst loss streak: ${r.worstLossStreak}`);
  if (r.halted) console.log(`risk halt: ${r.haltReason}`);
}
