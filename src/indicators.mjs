// ---------------------------------------------------------------------------
// Incremental technical indicators. Each indicator is a small stateful object
// with .update(x) -> value|null and .ready flag, so the same code runs in the
// backtester (historical ticks) and the live engine (streaming ticks).
// ---------------------------------------------------------------------------

export class EMA {
  constructor(period) { this.k = 2 / (period + 1); this.value = null; this.n = 0; this.period = period; }
  update(x) {
    this.n++;
    this.value = this.value === null ? x : x * this.k + this.value * (1 - this.k);
    return this.n >= this.period ? this.value : null;
  }
  get ready() { return this.n >= this.period; }
}

export class SMA {
  constructor(period) { this.period = period; this.buf = []; this.sum = 0; }
  update(x) {
    this.buf.push(x); this.sum += x;
    if (this.buf.length > this.period) this.sum -= this.buf.shift();
    return this.buf.length === this.period ? this.sum / this.period : null;
  }
  get ready() { return this.buf.length === this.period; }
}

export class RollingStd {
  constructor(period) { this.period = period; this.buf = []; }
  update(x) {
    this.buf.push(x);
    if (this.buf.length > this.period) this.buf.shift();
    if (this.buf.length < this.period) return null;
    const m = this.buf.reduce((a, b) => a + b, 0) / this.period;
    return Math.sqrt(this.buf.reduce((a, b) => a + (b - m) ** 2, 0) / this.period);
  }
  get ready() { return this.buf.length === this.period; }
}

// Wilder's RSI
export class RSI {
  constructor(period = 14) {
    this.period = period; this.prev = null; this.avgGain = null; this.avgLoss = null; this.n = 0;
  }
  update(x) {
    if (this.prev === null) { this.prev = x; return null; }
    const chg = x - this.prev; this.prev = x;
    const gain = Math.max(chg, 0), loss = Math.max(-chg, 0);
    this.n++;
    if (this.avgGain === null) {
      this._g = (this._g || 0) + gain; this._l = (this._l || 0) + loss;
      if (this.n < this.period) return null;
      this.avgGain = this._g / this.period; this.avgLoss = this._l / this.period;
    } else {
      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    }
    if (this.avgLoss === 0) return 100;
    return 100 - 100 / (1 + this.avgGain / this.avgLoss);
  }
  get ready() { return this.avgGain !== null; }
}

// Average true range over ticks (|x - prev| as the "true range")
export class ATR {
  constructor(period = 14) { this.period = period; this.prev = null; this.ema = new EMA(period); this.value = null; }
  update(x) {
    if (this.prev === null) { this.prev = x; return null; }
    const tr = Math.abs(x - this.prev); this.prev = x;
    this.value = this.ema.update(tr);
    return this.value;
  }
  get ready() { return this.ema.ready; }
}

export class Bollinger {
  constructor(period = 20, mult = 2) { this.sma = new SMA(period); this.std = new RollingStd(period); this.mult = mult; }
  update(x) {
    const m = this.sma.update(x); const s = this.std.update(x);
    if (m === null || s === null) return null;
    return { mid: m, upper: m + this.mult * s, lower: m - this.mult * s, sd: s,
             z: s > 0 ? (x - m) / s : 0, width: m !== 0 ? (2 * this.mult * s) / m : 0 };
  }
  get ready() { return this.sma.ready; }
}

// Wilder's ADX computed on the tick series (treated as a bar series).
export class ADX {
  constructor(period = 14) {
    this.period = period; this.prev = null;
    this.smPlus = null; this.smMinus = null; this.smTR = null;
    this.adx = null; this.dxCount = 0;
  }
  update(x) {
    if (this.prev === null) { this.prev = x; return null; }
    const up = x - this.prev, down = this.prev - x; this.prev = x;
    const plusDM = up > down && up > 0 ? up : 0;
    const minusDM = down > up && down > 0 ? down : 0;
    const tr = Math.abs(up) || 1e-12;
    const p = this.period;
    if (this.smTR === null) {
      this._tr = (this._tr || 0) + tr; this._p = (this._p || 0) + plusDM; this._m = (this._m || 0) + minusDM;
      this.dxCount++;
      if (this.dxCount < p) return null;
      this.smTR = this._tr; this.smPlus = this._p; this.smMinus = this._m;
    } else {
      this.smTR = this.smTR - this.smTR / p + tr;
      this.smPlus = this.smPlus - this.smPlus / p + plusDM;
      this.smMinus = this.smMinus - this.smMinus / p + minusDM;
    }
    const plusDI = 100 * this.smPlus / this.smTR, minusDI = 100 * this.smMinus / this.smTR;
    const sum = plusDI + minusDI;
    const dx = sum > 0 ? 100 * Math.abs(plusDI - minusDI) / sum : 0;
    this.adx = this.adx === null ? dx : (this.adx * (p - 1) + dx) / p;
    return { adx: this.adx, plusDI, minusDI };
  }
  get ready() { return this.adx !== null; }
}

// Donchian channel over the last N ticks (excluding the current tick)
export class Donchian {
  constructor(period = 20) { this.period = period; this.buf = []; }
  update(x) {
    const out = this.buf.length === this.period
      ? { high: Math.max(...this.buf), low: Math.min(...this.buf) } : null;
    this.buf.push(x);
    if (this.buf.length > this.period) this.buf.shift();
    return out;
  }
  get ready() { return this.buf.length === this.period; }
}
