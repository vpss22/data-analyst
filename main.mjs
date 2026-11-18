#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CLI entry point.
//   node main.mjs probe                 – measure live payout ratio & tick speed
//   node main.mjs symbols               – list tradable synthetic indices
//   node main.mjs strategies            – local strategies + Deriv native ones
//   node main.mjs backtest [--ticks N] [--symbol R_50]
//   node main.mjs paper                 – live public data, simulated fills
//   node main.mjs live                  – REAL trades (needs DERIV_TOKEN etc.)
//   node main.mjs dashboard [--port N]  – web UI + tuning (paper by default)
//   node main.mjs commission [--from D --to D]
//   node main.mjs fanout [--type demo|real] [--direction CALL|PUT] [--execute]
// ---------------------------------------------------------------------------
import fs from 'fs';
import { DerivSocket } from './src/client.mjs';
import { STRATEGIES } from './src/strategies.mjs';
import { Engine } from './src/engine.mjs';
import { backtestCommand } from './src/backtest.mjs';
import { commissionCommand } from './src/commission.mjs';
import { fanoutCommand } from './src/fanout.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
cfg.token = process.env.DERIV_TOKEN || null;
cfg.app_id = process.env.DERIV_APP_ID || cfg.app_id;
cfg.account_id = process.env.DERIV_ACCOUNT_ID || cfg.account_id;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const opt = (name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def; };

function banner(mode) {
  console.log('┌──────────────────────────────────────────────────────────┐');
  console.log('│  Deriv Options Bot — reference implementation            │');
  console.log(`│  mode: ${mode.padEnd(50)}│`);
  console.log('│  No strategy guarantees profit. Demo-first. Risk caps on.│');
  console.log('└──────────────────────────────────────────────────────────┘');
}

async function runEngine(mode) {
  cfg.mode = mode;
  banner(mode);
  const eng = new Engine(cfg);
  eng.on('status', (s) => console.log(`[${s.level}] ${s.message}`));
  eng.on('signal', (s) => console.log(`SIGNAL ${s.signal}: ${s.reason}`));
  eng.on('trade_open', (p) => console.log(`OPEN  ${p.contract_type} stake $${p.stake} -> payout $${p.payout}`));
  eng.on('trade_close', (t) => console.log(`CLOSE ${t.result.toUpperCase()} ${t.contract_type} ${t.entry} -> ${t.exit}  P&L $${t.profit}  session $${t.session_pnl}  equity $${t.equity}`));
  await eng.start();
  process.on('SIGINT', async () => { console.log('\nshutting down...'); await eng.stop(); process.exit(0); });
}

switch (cmd) {
  case 'probe': {
    const sock = new DerivSocket(); await sock.connect();
    const c = cfg.contract;
    const p = (await sock.call({ proposal: 1, amount: cfg.risk.stake, basis: 'stake', contract_type: 'CALL', currency: cfg.currency, duration: c.duration, duration_unit: c.duration_unit, underlying_symbol: cfg.symbol })).proposal;
    const ratio = p.payout / p.ask_price;
    console.log(`\n${cfg.symbol} CALL ${c.duration}${c.duration_unit}: stake $${p.ask_price} -> payout $${p.payout}`);
    console.log(`payout ratio ${ratio.toFixed(4)}  |  breakeven win rate ${(100 / ratio).toFixed(2)}%`);
    console.log(`validation: min stake $${p.validation_params?.stake?.min}, max payout $${p.validation_params?.payout?.max}`);
    const h = (await sock.call({ ticks_history: cfg.symbol, count: 6, end: 'latest', style: 'ticks' })).history;
    const gaps = h.times.slice(1).map((t, i) => t - h.times[i]);
    console.log(`tick interval: ~${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)}s  (${cfg.symbol})`);
    console.log(`\nSet risk.min_payout_ratio below ${ratio.toFixed(2)} (e.g. ${(ratio - 0.1).toFixed(2)}) and backtest.payout_ratio near it.\n`);
    sock.close(); break;
  }
  case 'symbols': {
    const sock = new DerivSocket(); await sock.connect();
    const s = (await sock.call({ active_symbols: 'brief' })).active_symbols;
    for (const x of s.filter((y) => y.market === 'synthetic_index'))
      console.log(`${x.underlying_symbol.padEnd(12)} ${x.underlying_symbol_name.padEnd(34)} open=${x.exchange_is_open}`);
    sock.close(); break;
  }
  case 'strategies': {
    console.log('\nLOCAL STRATEGIES (this bot):');
    for (const [k, v] of Object.entries(STRATEGIES)) {
      console.log(`\n  ${k} — ${v.label}`);
      console.log('  defaults:', JSON.stringify(v.cls.defaults));
    }
    const sock = new DerivSocket(); await sock.connect();
    const nat = (await sock.call({ auto_list_strategies: 1 })).auto_list_strategies;
    console.log('\nDERIV NATIVE AUTOMATION (server-side, via auto_start):');
    for (const s of nat.strategies) console.log(`  ${s.strategy_id} — ${s.description}`);
    console.log('\nNote: native strategies are stake progressions, not signal edge. See guide §9.\n');
    sock.close(); break;
  }
  case 'backtest': await backtestCommand(cfg, { ticks: opt('ticks') ? +opt('ticks') : undefined, symbol: opt('symbol') }); break;
  case 'paper': await runEngine('paper'); break;
  case 'live':
    if (!cfg.token || !cfg.account_id || !cfg.app_id) { console.error('live mode needs DERIV_TOKEN, DERIV_ACCOUNT_ID and DERIV_APP_ID (see guide §5).'); process.exit(1); }
    console.log('*** LIVE MODE — REAL MONEY. Starting in 5 s. Ctrl-C to abort. ***');
    await new Promise((r) => setTimeout(r, 5000));
    await runEngine('live'); break;
  case 'commission': await commissionCommand(cfg, { from: opt('from'), to: opt('to') }); break;
  case 'fanout': await fanoutCommand(cfg, { type: opt('type', 'demo'), direction: opt('direction', 'CALL'), execute: !!opt('execute', false), users: opt('users') }); break;
  case 'dashboard': { const { startDashboard } = await import('./server.mjs'); await startDashboard(cfg, { port: +(opt('port', 8080)) }); break; }
  default:
    console.log(fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8').split('## Commands')[1]?.split('##')[0] ?? 'commands: probe | symbols | strategies | backtest | paper | live | dashboard | commission | fanout');
}
