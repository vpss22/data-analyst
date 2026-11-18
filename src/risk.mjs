// ---------------------------------------------------------------------------
// Risk engine — the part that actually keeps accounts alive.
// Gates every trade BEFORE it is placed and sizes every stake.
//
// Staking modes:
//   fixed      – same stake every trade (recommended default)
//   fractional – stake = equity * fraction (anti-martingale; shrinks in DD)
//   martingale – multiply after loss, reset after win. DANGEROUS: negative
//                expectancy games are NOT fixed by progression; ruin risk is
//                real. Off by default, hard-capped, max_steps enforced.
//   dalembert  – add `unit` after loss, subtract after win ( gentler, still
//                does not create edge).
// ---------------------------------------------------------------------------

const round2 = (x) => Math.round(x * 100) / 100;

export class RiskManager {
  constructor(cfg, startEquity) {
    this.cfg = cfg;
    this.startEquity = startEquity;
    this.equity = startEquity;
    this.sessionPnl = 0;
    this.trades = 0;
    this.wins = 0;
    this.lossStreak = 0;
    this.worstLossStreak = 0;
    this.peakEquity = startEquity;
    this.maxDrawdown = 0;
    this.halted = false;
    this.haltReason = null;
    this.cooldownUntilIdx = 0;
    this.tickIdx = 0;
    this.currentStake = cfg.stake;
    this.martingaleStep = 0;
  }

  onTick() { this.tickIdx++; }

  // Pre-trade gate. Returns { ok, reason }.
  canTrade({ payoutRatio = null, openPositions = 0 } = {}) {
    const c = this.cfg;
    if (this.halted) return { ok: false, reason: `halted: ${this.haltReason}` };
    if (this.tickIdx < this.cooldownUntilIdx)
      return { ok: false, reason: `loss-streak cooldown (${this.cooldownUntilIdx - this.tickIdx} ticks left)` };
    if (openPositions >= (c.max_open_positions ?? 1))
      return { ok: false, reason: 'max open positions reached' };
    if (this.trades >= c.max_trades_per_session)
      return { ok: false, reason: 'max trades per session reached' };
    if (this.sessionPnl <= -Math.abs(c.session_stop_loss))
      return this.halt('session stop-loss hit');
    if (this.sessionPnl >= Math.abs(c.session_take_profit))
      return this.halt('session take-profit hit');
    if (payoutRatio !== null && payoutRatio < c.min_payout_ratio)
      return { ok: false, reason: `payout ratio ${payoutRatio.toFixed(3)} < min ${c.min_payout_ratio}` };
    const stake = this.nextStake();
    if (stake > this.equity * (c.max_equity_fraction_per_trade ?? 0.05) && c.stake_mode !== 'martingale')
      return { ok: false, reason: 'stake exceeds max equity fraction' };
    if (stake > this.equity) return { ok: false, reason: 'insufficient equity for stake' };
    return { ok: true, stake };
  }

  nextStake() {
    const c = this.cfg;
    let s;
    switch (c.stake_mode) {
      case 'fractional':
        s = this.equity * c.equity_fraction; break;
      case 'martingale':
        s = this.currentStake; break;
      case 'dalembert':
        s = this.currentStake; break;
      default:
        s = c.stake;
    }
    s = Math.min(s, c.max_stake);
    s = Math.max(s, c.min_stake ?? 0.35);
    return round2(s);
  }

  // Post-trade update. profit = payout - stake (win) or -stake (loss).
  onResult(profit) {
    const c = this.cfg;
    this.trades++;
    this.sessionPnl = round2(this.sessionPnl + profit);
    this.equity = round2(this.equity + profit);
    this.peakEquity = Math.max(this.peakEquity, this.equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, round2(this.peakEquity - this.equity));
    if (profit > 0) { this.wins++; this.lossStreak = 0; } else { this.lossStreak++; this.worstLossStreak = Math.max(this.worstLossStreak, this.lossStreak); }

    if (c.stake_mode === 'martingale') {
      if (profit > 0) { this.currentStake = c.stake; this.martingaleStep = 0; }
      else {
        this.martingaleStep++;
        if (this.martingaleStep >= (c.martingale_max_steps ?? 4)) {
          this.currentStake = c.stake; this.martingaleStep = 0;   // hard reset, take the loss
        } else this.currentStake = round2(this.currentStake * (c.martingale_multiplier ?? 2));
      }
    } else if (c.stake_mode === 'dalembert') {
      if (profit > 0) this.currentStake = Math.max(c.stake, round2(this.currentStake - (c.dalembert_unit ?? c.stake)));
      else this.currentStake = round2(this.currentStake + (c.dalembert_unit ?? c.stake));
    }

    if (this.lossStreak >= c.max_consecutive_losses) {
      this.cooldownUntilIdx = this.tickIdx + (c.loss_streak_cooldown_ticks ?? 300);
      this.lossStreak = 0;
    }
    if (this.sessionPnl <= -Math.abs(c.session_stop_loss)) this.halt('session stop-loss hit');
    if (this.sessionPnl >= Math.abs(c.session_take_profit)) this.halt('session take-profit hit');
    if (this.equity <= (c.min_equity ?? 0)) this.halt('equity floor reached');
    return { sessionPnl: this.sessionPnl, equity: this.equity, halted: this.halted };
  }

  halt(reason) { this.halted = true; this.haltReason = reason; return { ok: false, reason }; }
  resume() { this.halted = false; this.haltReason = null; }

  stats() {
    return {
      trades: this.trades, wins: this.wins,
      winRate: this.trades ? this.wins / this.trades : null,
      sessionPnl: this.sessionPnl, equity: this.equity,
      maxDrawdown: this.maxDrawdown, worstLossStreak: this.worstLossStreak,
      halted: this.halted, haltReason: this.haltReason,
      nextStake: this.nextStake(),
    };
  }
}
