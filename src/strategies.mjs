// ---------------------------------------------------------------------------
// Signal strategies. Each strategy consumes ticks one at a time and returns
// { signal: 'CALL'|'PUT', reason, meta } on entry conditions, else null.
// Every knob is exposed in `paramSpec` so the dashboard can render tuning
// controls automatically and the backtester can sweep parameters.
//
// IMPORTANT: none of these (or any) indicator combinations guarantee profit.
// On RNG-driven synthetic indices, indicators describe the past; they do not
// predict the next tick. Validate on demo + backtests before risking money.
// ---------------------------------------------------------------------------
import { EMA, RSI, ATR, ADX, Bollinger, Donchian } from './indicators.mjs';

class Base {
  constructor(params) { this.p = { ...this.constructor.defaults, ...params }; this.lastSignalIdx = -1e9; this.i = 0; }
  cooldownOk() { return this.i - this.lastSignalIdx >= this.p.cooldown_ticks; }
  emit(signal, reason, meta = {}) { this.lastSignalIdx = this.i; return { signal, reason, meta }; }
}

// 1) Trend Rider — EMA crossover with regime + momentum + volatility filters.
export class TrendRider extends Base {
  static defaults = {
    ema_fast: 12, ema_slow: 36, rsi_period: 14, adx_period: 14,
    min_adx: 22, rsi_call_max: 72, rsi_put_min: 28,
    atr_period: 14, min_vol_bps: 0.5, cooldown_ticks: 10,
  };
  static paramSpec = {
    ema_fast:      { label: 'Fast EMA period', min: 3, max: 60, step: 1 },
    ema_slow:      { label: 'Slow EMA period', min: 10, max: 200, step: 1 },
    min_adx:       { label: 'Min ADX (trend strength)', min: 0, max: 60, step: 1 },
    rsi_call_max:  { label: 'RSI ceiling for CALL', min: 50, max: 95, step: 1 },
    rsi_put_min:   { label: 'RSI floor for PUT', min: 5, max: 50, step: 1 },
    min_vol_bps:   { label: 'Min ATR volatility (bps of price)', min: 0, max: 20, step: 0.1 },
    cooldown_ticks:{ label: 'Cooldown between trades (ticks)', min: 0, max: 200, step: 1 },
  };
  constructor(params) {
    super(params);
    this.fast = new EMA(this.p.ema_fast); this.slow = new EMA(this.p.ema_slow);
    this.rsi = new RSI(this.p.rsi_period); this.adx = new ADX(this.p.adx_period);
    this.atr = new ATR(this.p.atr_period); this.prevDiff = null;
  }
  update(tick) {
    this.i++;
    const x = tick.quote;
    const f = this.fast.update(x), s = this.slow.update(x);
    const r = this.rsi.update(x), a = this.adx.update(x), v = this.atr.update(x);
    if (f === null || s === null || r === null || a === null || v === null) return null;
    const diff = f - s; const prev = this.prevDiff; this.prevDiff = diff;
    if (prev === null || !this.cooldownOk()) return null;
    const volBps = (v / x) * 10000;
    if (volBps < this.p.min_vol_bps) return null;         // dead market gate
    if (a.adx < this.p.min_adx) return null;              // chop gate
    const meta = { adx: +a.adx.toFixed(1), rsi: +r.toFixed(1), vol_bps: +volBps.toFixed(2) };
    if (prev <= 0 && diff > 0 && r < this.p.rsi_call_max)
      return this.emit('CALL', `EMA${this.p.ema_fast} crossed above EMA${this.p.ema_slow}, ADX ${meta.adx}`, meta);
    if (prev >= 0 && diff < 0 && r > this.p.rsi_put_min)
      return this.emit('PUT', `EMA${this.p.ema_fast} crossed below EMA${this.p.ema_slow}, ADX ${meta.adx}`, meta);
    return null;
  }
}

// 2) Band Fade — Bollinger mean reversion, only in low-trend (ranging) regimes.
export class BandFade extends Base {
  static defaults = {
    bb_period: 24, bb_mult: 2.2, rsi_period: 14, rsi_low: 30, rsi_high: 70,
    adx_period: 14, max_adx: 20, entry_z: 2.0, cooldown_ticks: 8,
  };
  static paramSpec = {
    bb_period:    { label: 'Bollinger period', min: 8, max: 100, step: 1 },
    bb_mult:      { label: 'Bollinger width (σ)', min: 1, max: 4, step: 0.1 },
    entry_z:      { label: 'Entry z-score', min: 1, max: 4, step: 0.1 },
    rsi_low:      { label: 'RSI oversold (CALL)', min: 5, max: 45, step: 1 },
    rsi_high:     { label: 'RSI overbought (PUT)', min: 55, max: 95, step: 1 },
    max_adx:      { label: 'Max ADX (range regime)', min: 5, max: 50, step: 1 },
    cooldown_ticks:{ label: 'Cooldown between trades (ticks)', min: 0, max: 200, step: 1 },
  };
  constructor(params) {
    super(params);
    this.bb = new Bollinger(this.p.bb_period, this.p.bb_mult);
    this.rsi = new RSI(this.p.rsi_period); this.adx = new ADX(this.p.adx_period);
  }
  update(tick) {
    this.i++;
    const x = tick.quote;
    const b = this.bb.update(x), r = this.rsi.update(x), a = this.adx.update(x);
    if (!b || r === null || a === null || !this.cooldownOk()) return null;
    if (a.adx > this.p.max_adx) return null;              // don't fade strong trends
    const meta = { z: +b.z.toFixed(2), rsi: +r.toFixed(1), adx: +a.adx.toFixed(1) };
    if (b.z <= -this.p.entry_z && r <= this.p.rsi_low)
      return this.emit('CALL', `Price ${meta.z}σ below mean, RSI ${meta.rsi} (range regime)`, meta);
    if (b.z >= this.p.entry_z && r >= this.p.rsi_high)
      return this.emit('PUT', `Price ${meta.z}σ above mean, RSI ${meta.rsi} (range regime)`, meta);
    return null;
  }
}

// 3) Breakout Rider — Donchian channel break with volatility + trend alignment.
export class BreakoutRider extends Base {
  static defaults = {
    channel: 30, atr_period: 14, min_vol_bps: 0.8,
    trend_ema: 100, require_trend: true, cooldown_ticks: 15,
  };
  static paramSpec = {
    channel:      { label: 'Donchian lookback (ticks)', min: 5, max: 200, step: 1 },
    min_vol_bps:  { label: 'Min ATR volatility (bps)', min: 0, max: 20, step: 0.1 },
    trend_ema:    { label: 'Trend filter EMA period', min: 20, max: 400, step: 1 },
    cooldown_ticks:{ label: 'Cooldown between trades (ticks)', min: 0, max: 200, step: 1 },
  };
  constructor(params) {
    super(params);
    this.dc = new Donchian(this.p.channel); this.atr = new ATR(this.p.atr_period);
    this.trend = new EMA(this.p.trend_ema);
  }
  update(tick) {
    this.i++;
    const x = tick.quote;
    const ch = this.dc.update(x), v = this.atr.update(x), t = this.trend.update(x);
    if (!ch || v === null || t === null || !this.cooldownOk()) return null;
    const volBps = (v / x) * 10000;
    if (volBps < this.p.min_vol_bps) return null;
    const meta = { vol_bps: +volBps.toFixed(2), chan_high: ch.high, chan_low: ch.low };
    if (x > ch.high && (!this.p.require_trend || x > t))
      return this.emit('CALL', `Broke ${this.p.channel}-tick high ${ch.high}`, meta);
    if (x < ch.low && (!this.p.require_trend || x < t))
      return this.emit('PUT', `Broke ${this.p.channel}-tick low ${ch.low}`, meta);
    return null;
  }
}

export const STRATEGIES = {
  trend_rider:     { cls: TrendRider,    label: 'Trend Rider (EMA cross + ADX/RSI/vol filters)' },
  band_fade:       { cls: BandFade,      label: 'Band Fade (Bollinger mean reversion, range only)' },
  breakout_rider:  { cls: BreakoutRider, label: 'Breakout Rider (Donchian break + trend filter)' },
};

export function makeStrategy(name, params = {}) {
  const s = STRATEGIES[name];
  if (!s) throw new Error(`Unknown strategy '${name}'. Available: ${Object.keys(STRATEGIES).join(', ')}`);
  return new s.cls(params);
}
