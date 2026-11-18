// ---------------------------------------------------------------------------
// Trading engine — one pipeline, two modes:
//   paper : public market data + real proposals, simulated fills (no token,
//           no money). Uses the exact tick-contract settlement rule.
//   live  : authenticated socket, real proposal -> buy -> contract monitoring.
//
// Pipeline: ticks -> strategy signal -> risk gate -> proposal -> payout gate
//           -> buy -> monitor -> settle -> journal -> risk update.
// ---------------------------------------------------------------------------
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { DerivSocket, api } from './client.mjs';
import { makeStrategy } from './strategies.mjs';
import { RiskManager } from './risk.mjs';

const round2 = (x) => Math.round(x * 100) / 100;

export class Engine extends EventEmitter {
  constructor(config) {
    super();
    this.cfg = config;
    this.mode = config.mode;                 // 'paper' | 'live'
    this.sock = null; this.tickSub = null; this.balanceSub = null;
    this.strategy = makeStrategy(config.strategy.name, config.strategy.params);
    this.paused = false; this.running = false;
    this.open = new Map();                   // key -> position
    this.journal = [];
    this.equityHistory = [];
    this.lastTick = null; this.tickCount = 0;
    this.markupEarnedEst = 0;                // developer commission estimate
    this.startBalance = config.paper.starting_balance;
    this.risk = new RiskManager(config.risk, this.startBalance);
    this.logDir = config.logging?.dir ?? 'data';
    fs.mkdirSync(this.logDir, { recursive: true });
    this.journalFile = path.join(this.logDir, `journal-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  async start() {
    if (this.running) return;
    if (this.mode === 'live') {
      if (!this.cfg.token || !this.cfg.account_id)
        throw new Error('live mode requires token (DERIV_TOKEN) and account_id');
      this.sock = new DerivSocket({ token: this.cfg.token, appId: this.cfg.app_id, accountId: this.cfg.account_id });
    } else {
      this.sock = new DerivSocket({ url: undefined }); // public endpoint
    }
    this.sock.on('warn', (m) => this.emit('status', { level: 'warn', message: m }));
    this.sock.on('reconnect', () => this.emit('status', { level: 'info', message: 'reconnected; subscriptions restored' }));
    this.sock.on('api_error', (e) => this.emit('status', { level: 'error', message: `${e.code}: ${e.message}` }));
    await this.sock.connect();

    if (this.mode === 'live') {
      const bal = await this.sock.call({ balance: 1 });
      this.startBalance = bal.balance.balance;
      this.risk = new RiskManager(this.cfg.risk, this.startBalance);
      this.balanceSub = await this.sock.subscribe({ balance: 1 }, (m) => {
        this.emit('balance', m.balance);
      });
      this.emit('status', { level: 'info', message: `authenticated; balance ${this.startBalance} ${bal.balance.currency}` });
    } else {
      this.emit('status', { level: 'info', message: `paper mode on public feed; virtual balance ${this.startBalance}` });
    }

    await this._subscribeTicks();
    this.running = true;
    this.equityHistory.push({ t: Date.now(), equity: this.risk.equity });
    this.emit('status', { level: 'info', message: `engine running: ${this.cfg.symbol}, strategy ${this.cfg.strategy.name}` });
  }

  async _subscribeTicks() {
    this.tickSub = await this.sock.subscribe({ ticks: this.cfg.symbol }, (m) => {
      if (m.msg_type === 'tick') this._onTick(m.tick);
    });
  }

  async _onTick(tick) {
    this.tickCount++; this.lastTick = tick;
    this.risk.onTick();
    this._settlePaperPositions(tick);
    const sig = this.strategy.update(tick);
    this.emit('tick', { quote: tick.quote, epoch: tick.epoch, i: this.tickCount });
    if (sig && !this.paused && this.running) {
      this.emit('signal', { ...sig, epoch: tick.epoch });
      this._attemptTrade(sig).catch((e) => this.emit('status', { level: 'error', message: `trade: ${e.message}` }));
    }
  }

  async _attemptTrade(sig) {
    if (this.open.size >= (this.cfg.risk.max_open_positions ?? 1)) return;
    const pre = this.risk.canTrade({ openPositions: this.open.size });
    if (!pre.ok) { this.emit('status', { level: 'info', message: `skip: ${pre.reason}` }); return; }
    const stake = pre.stake;
    const c = this.cfg.contract;
    const prop = (await this.sock.call({
      proposal: 1, amount: stake, basis: 'stake',
      contract_type: sig.signal, currency: this.cfg.currency,
      duration: c.duration, duration_unit: c.duration_unit,
      underlying_symbol: this.cfg.symbol,
    })).proposal;

    const payoutRatio = prop.payout / prop.ask_price;
    const gate = this.risk.canTrade({ payoutRatio, openPositions: this.open.size });
    if (!gate.ok) { this.emit('status', { level: 'info', message: `skip: ${gate.reason}` }); return; }

    if (this.mode === 'paper') {
      const key = `paper-${prop.id}`;
      const pos = {
        key, mode: 'paper', contract_type: sig.signal, stake: prop.ask_price, payout: prop.payout,
        reason: sig.reason, meta: sig.meta, proposal_id: prop.id,
        duration: c.duration, duration_unit: c.duration_unit,
        entry: null, entryEpoch: null, ticksLeft: c.duration_unit === 't' ? c.duration : null,
        expiryEpoch: c.duration_unit === 't' ? null : tickEpochNow() + toSeconds(c.duration, c.duration_unit),
        opened: Date.now(),
      };
      this.open.set(key, pos);
      this.emit('trade_open', this._publicPos(pos));
    } else {
      const buy = (await this.sock.call({ buy: prop.id, price: prop.ask_price })).buy;
      const key = `live-${buy.contract_id}`;
      const pos = {
        key, mode: 'live', contract_type: sig.signal, stake: buy.buy_price, payout: buy.payout,
        reason: sig.reason, meta: sig.meta, proposal_id: prop.id,
        contract_id: buy.contract_id, transaction_id: buy.transaction_id,
        opened: Date.now(), pocSub: null,
      };
      this.open.set(key, pos);
      this.emit('trade_open', this._publicPos(pos));
      pos.pocSub = await this.sock.subscribe({ proposal_open_contract: 1, contract_id: buy.contract_id }, (m) => {
        const poc = m.proposal_open_contract;
        if (!poc) return;
        this.emit('position_update', { key, profit: poc.profit, status: poc.status, current_spot: poc.current_spot, markup: poc.app_markup_amount });
        if (poc.is_sold) {
          const profit = round2(poc.sell_price - poc.buy_price);
          pos.entry = poc.entry_spot; pos.exit = poc.exit_spot ?? poc.current_spot;
          pos.app_markup_amount = poc.app_markup_amount ?? null;
          this._finalize(pos, profit);
          pos.pocSub?.forget().catch(() => {});
        }
      });
    }
  }

  // Paper settlement replicates Deriv tick-contract rules:
  // entry = first tick after purchase; exit = Nth tick after entry (ticks),
  // or last tick at/before expiry (time contracts). CALL wins iff exit > entry.
  _settlePaperPositions(tick) {
    for (const [, pos] of this.open) {
      if (pos.mode !== 'paper') continue;
      if (pos.entry === null) { pos.entry = tick.quote; pos.entryEpoch = tick.epoch; continue; }
      if (pos.ticksLeft !== null) {
        pos.ticksLeft--;
        if (pos.ticksLeft <= 0) {
          pos.exit = tick.quote;
          const win = pos.contract_type === 'CALL' ? pos.exit > pos.entry : pos.exit < pos.entry;
          this._finalize(pos, win ? round2(pos.payout - pos.stake) : -pos.stake);
        }
      } else if (tick.epoch >= pos.expiryEpoch) {
        pos.exit = tick.quote;
        const win = pos.contract_type === 'CALL' ? pos.exit > pos.entry : pos.exit < pos.entry;
        this._finalize(pos, win ? round2(pos.payout - pos.stake) : -pos.stake);
      }
    }
  }

  _finalize(pos, profit) {
    if (!this.open.has(pos.key)) return;
    this.open.delete(pos.key);
    const r = this.risk.onResult(profit);
    const markupEst = round2(pos.payout * (this.cfg.commission?.markup_pct ?? 0) / 100);
    this.markupEarnedEst = round2(this.markupEarnedEst + markupEst);
    const rec = {
      ts: new Date().toISOString(), mode: pos.mode, symbol: this.cfg.symbol,
      strategy: this.cfg.strategy.name, contract_type: pos.contract_type,
      stake: pos.stake, payout: pos.payout, entry: pos.entry, exit: pos.exit,
      profit, result: profit > 0 ? 'win' : 'loss', reason: pos.reason, meta: pos.meta,
      proposal_id: pos.proposal_id, contract_id: pos.contract_id ?? null,
      app_markup_amount: pos.app_markup_amount ?? null, markup_estimate: markupEst,
      session_pnl: r.sessionPnl, equity: r.equity,
    };
    this.journal.push(rec);
    if (this.journal.length > 500) this.journal.shift();
    fs.appendFile(this.journalFile, JSON.stringify(rec) + '\n', () => {});
    this.equityHistory.push({ t: Date.now(), equity: r.equity });
    if (this.equityHistory.length > 3000) this.equityHistory.shift();
    this.emit('trade_close', rec);
    if (r.halted) this.emit('status', { level: 'warn', message: `RISK HALT: ${this.risk.haltReason}` });
  }

  _publicPos(pos) {
    return { key: pos.key, mode: pos.mode, contract_type: pos.contract_type, stake: pos.stake,
             payout: pos.payout, entry: pos.entry, ticksLeft: pos.ticksLeft, reason: pos.reason, opened: pos.opened };
  }

  // Runtime tuning from the dashboard / CLI.
  applyConfig(partial) {
    const prevSymbol = this.cfg.symbol;
    if (partial.strategy) {
      this.cfg.strategy = { ...this.cfg.strategy, ...partial.strategy, params: { ...this.cfg.strategy.params, ...(partial.strategy.params ?? {}) } };
      this.strategy = makeStrategy(this.cfg.strategy.name, this.cfg.strategy.params);
    }
    if (partial.risk) { this.cfg.risk = { ...this.cfg.risk, ...partial.risk }; Object.assign(this.risk.cfg, partial.risk); }
    if (partial.contract) this.cfg.contract = { ...this.cfg.contract, ...partial.contract };
    if (partial.commission) this.cfg.commission = { ...this.cfg.commission, ...partial.commission };
    if (partial.symbol && partial.symbol !== prevSymbol) {
      this.cfg.symbol = partial.symbol;
      this.tickSub?.forget().then(() => this._subscribeTicks()).catch(() => {});
    }
    this.emit('config', this.publicConfig());
    return this.publicConfig();
  }

  publicConfig() {
    const { token, ...safe } = this.cfg;
    return safe;
  }

  pause() { this.paused = true; this.emit('status', { level: 'info', message: 'paused — no new entries; open contracts run to expiry' }); }
  resume() { this.paused = false; this.risk.resume(); this.emit('status', { level: 'info', message: 'resumed' }); }

  async stop() {
    this.running = false;
    await this.sock?.forgetAll('ticks', 'balance', 'proposal_open_contract').catch(() => {});
    this.sock?.close();
    this.emit('status', { level: 'info', message: 'engine stopped' });
  }

  state() {
    return {
      mode: this.mode, running: this.running, paused: this.paused,
      symbol: this.cfg.symbol, tickCount: this.tickCount, lastTick: this.lastTick,
      risk: this.risk.stats(), open: [...this.open.values()].map((p) => this._publicPos(p)),
      journal: this.journal.slice(-60).reverse(), equityHistory: this.equityHistory.slice(-600),
      markupEarnedEst: this.markupEarnedEst, config: this.publicConfig(),
    };
  }
}

function tickEpochNow() { return Math.floor(Date.now() / 1000); }
function toSeconds(d, unit) { return { s: 1, m: 60, h: 3600, d: 86400 }[unit] * d; }
