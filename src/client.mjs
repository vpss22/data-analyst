// ---------------------------------------------------------------------------
// Deriv API client — new-generation Third Party API (verified Nov 2026).
//
//   REST base : https://api.derivws.com
//   WS public : wss://api.derivws.com/trading/v1/options/ws/public
//   WS demo   : wss://api.derivws.com/trading/v1/options/ws/demo?otp=...
//   WS real   : wss://api.derivws.com/trading/v1/options/ws/real?otp=...
//
// Auth model: PAT or OAuth Bearer token -> REST OTP endpoint -> single-use
// authenticated WS URL (valid 120 s). No `authorize` message on the socket.
//
// Features: req_id multiplexing, subscription routing + auto-resubscribe,
// exponential-backoff reconnect (fresh OTP each time), 30 s keepalive ping,
// and per-group sliding-window rate limiting matching the published budgets.
// ---------------------------------------------------------------------------
import WebSocket from 'ws';
import { EventEmitter } from 'events';

export const REST_BASE = 'https://api.derivws.com';
export const WS_PUBLIC = 'wss://api.derivws.com/trading/v1/options/ws/public';

// Published WebSocket budgets (calls share a row's budget).
const WS_BUDGETS = {
  trading:   { calls: ['proposal', 'proposal_open_contract', 'buy', 'sell'], perMin: 360, perHour: 14400 },
  account:   { calls: ['balance', 'statement'],                            perMin: 100, perHour: 2000 },
  portfolio: { calls: ['portfolio', 'profit_table'],                       perMin: 30,  perHour: 1500 },
  general:   { calls: null,                                                perMin: 220, perHour: 14400 },
};

class RateLimiter {
  constructor() { this.hits = { trading: [], account: [], portfolio: [], general: [] }; }
  groupOf(call) {
    for (const [g, b] of Object.entries(WS_BUDGETS)) if (b.calls && b.calls.includes(call)) return g;
    return 'general';
  }
  async acquire(call) {
    if (call === 'ping') return;
    const g = this.groupOf(call); const b = WS_BUDGETS[g];
    for (;;) {
      const now = Date.now();
      this.hits[g] = this.hits[g].filter((t) => now - t < 3600_000);
      const lastMin = this.hits[g].filter((t) => now - t < 60_000).length;
      if (lastMin < b.perMin && this.hits[g].length < b.perHour) { this.hits[g].push(now); return; }
      await new Promise((r) => setTimeout(r, 250)); // queue, don't burst
    }
  }
}

// ----------------------------- REST helpers --------------------------------
export async function rest(path, { method = 'GET', token, appId, body, query } = {}) {
  const url = new URL(REST_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (appId) headers['Deriv-App-ID'] = String(appId); // required for PAT auth
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || `HTTP ${res.status}`;
    const err = new Error(`REST ${method} ${path}: ${msg}`); err.status = res.status; err.payload = json;
    throw err;
  }
  return json;
}

export const api = {
  accounts: (token, appId) => rest('/trading/v1/options/accounts', { token, appId }),
  otpUrl: async (token, appId, accountId) => {
    const r = await rest(`/trading/v1/options/accounts/${accountId}/otp`, { method: 'POST', token, appId });
    if (!r?.data?.url) throw new Error('OTP response missing data.url');
    return r.data.url;
  },
  resetDemo: (token, appId, accountId) =>
    rest(`/trading/v1/options/accounts/${accountId}/reset-demo-balance`, { method: 'POST', token, appId }),
  markupStatistics: (token, appId, dateFrom, dateTo) =>
    rest('/applications/v1/markup-statistics', { token, appId, query: { date_from: dateFrom, date_to: dateTo } }),
  partnerOverview: (token, appId, startDate, endDate) =>
    rest('/partners/analytics/v1/overview', { token, appId, query: { start_date: startDate, end_date: endDate } }),
  clientTagsCheck: (token, appId, clientIds) =>
    rest('/partners/client-tags/check', { method: 'POST', token, appId, body: { client_ids: clientIds } }),
  bulkPurchase: (appId, accountType, contractParameters, accounts) =>
    rest(`/trading/v1/options/contracts/bulk-purchase/${accountType}`, {
      method: 'POST', appId, body: { contract_parameters: contractParameters, accounts } }),
};

// ----------------------------- WebSocket client ----------------------------
export class DerivSocket extends EventEmitter {
  constructor({ token = null, appId = null, accountId = null, url = null, log = console } = {}) {
    super();
    this.creds = token && accountId ? { token, appId, accountId } : null;
    this.url = url || (this.creds ? null : WS_PUBLIC);
    this.log = log;
    this.ws = null; this.reqId = 0;
    this.pending = new Map();          // req_id -> {resolve, reject, timer, msg}
    this.subs = new Map();             // subKey -> { msg, handler, id }
    this.limiter = new RateLimiter();
    this.alive = false; this.closedByUser = false;
    this.backoff = 1000; this.pingTimer = null; this.lastPong = Date.now();
  }

  async connect() {
    this.closedByUser = false;
    const url = this.creds ? await api.otpUrl(this.creds.token, this.creds.appId, this.creds.accountId) : this.url;
    await this._open(url);
    return this;
  }

  _open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const failFast = (e) => { ws.removeAllListeners(); reject(e); };
      ws.once('error', failFast);
      ws.once('open', () => {
        ws.removeListener('error', failFast);
        this.ws = ws; this.alive = true; this.backoff = 1000; this.lastPong = Date.now();
        ws.on('message', (d) => this._route(d));
        ws.on('close', () => this._onClose());
        ws.on('error', (e) => this.emit('warn', `ws error: ${e.message}`));
        ws.on('pong', () => { this.lastPong = Date.now(); });
        this.pingTimer = setInterval(() => {
          if (!this.alive) return;
          if (Date.now() - this.lastPong > 90_000) { this.emit('warn', 'silent disconnect detected; reconnecting'); ws.terminate(); return; }
          this.send({ ping: 1 }).catch(() => {});
        }, 30_000);
        this.emit('open', { authenticated: !!this.creds });
        resolve(this);
        this._resubscribe().catch((e) => this.emit('warn', `resubscribe: ${e.message}`));
      });
    });
  }

  async _onClose() {
    this.alive = false; clearInterval(this.pingTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
    this.pending.clear();
    this.emit('close');
    if (this.closedByUser) return;
    const delay = Math.min(this.backoff, 30_000) + Math.random() * 500;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.emit('warn', `reconnecting in ${Math.round(delay)} ms`);
    setTimeout(async () => {
      try { await this.connect(); this.emit('reconnect'); }
      catch (e) { this.emit('warn', `reconnect failed: ${e.message}`); this._onClose(); }
    }, delay);
  }

  async _resubscribe() {
    for (const [, s] of this.subs) { s.id = null; await this._send({ ...s.msg, subscribe: 1 }, s); }
  }

  _route(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.error) this.emit('api_error', m.error);
    if (m.req_id && this.pending.has(m.req_id)) {
      const p = this.pending.get(m.req_id); this.pending.delete(m.req_id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'API error'), { code: m.error.code, details: m.error.details }));
      else {
        if (p.sub) { // first response of a subscription: capture stream id
          const body = m[m.msg_type];
          p.sub.id = body?.id ?? body?.contract_id ?? null;
        }
        p.resolve(m);
      }
    }
    // route subscription updates (no req_id) by msg_type + stream id
    const type = m.msg_type;
    if (type && !m.req_id) {
      const body = m[type];
      for (const [, s] of this.subs) {
        if (s.msg[type] !== undefined || (type === 'tick' && s.msg.ticks) || (type === 'history' && s.msg.ticks_history) || (type === 'candles' && s.msg.ticks_history)) {
          const sid = body?.id ?? body?.contract_id;
          if (!s.id || !sid || s.id === sid || String(s.id) === String(sid)) { try { s.handler(m); } catch (e) { this.emit('warn', `handler: ${e.message}`); } }
        }
      }
    }
    this.emit('message', m);
  }

  async send(msg) {
    const call = Object.keys(msg).find((k) => !['req_id', 'subscribe', 'passthrough'].includes(k));
    await this.limiter.acquire(call);
    if (!this.alive) throw new Error('socket not connected');
    this.ws.send(JSON.stringify(msg));
  }

  async _send(msg, sub = null, timeout = 20_000) {
    const req_id = ++this.reqId;
    const payload = { ...msg, req_id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req_id); reject(new Error(`timeout: ${JSON.stringify(msg).slice(0, 80)}`)); }, timeout);
      this.pending.set(req_id, { resolve, reject, timer, sub });
      this.send(payload).catch((e) => { clearTimeout(timer); this.pending.delete(req_id); reject(e); });
    });
  }

  // One-shot request/response.
  call(msg, timeout) { return this._send(msg, null, timeout); }

  // Streaming subscription. Returns { id, forget() }.
  async subscribe(msg, handler) {
    const sub = { msg, handler, id: null };
    const key = `${Object.keys(msg)[0]}:${JSON.stringify(msg)}`;
    this.subs.set(key, sub);
    const first = await this._send({ ...msg, subscribe: 1 }, sub);
    handler(first); // deliver snapshot immediately
    return {
      get id() { return sub.id; },
      forget: async () => {
        this.subs.delete(key);
        if (sub.id && this.alive) await this.call({ forget: sub.id }).catch(() => {});
      },
    };
  }

  async forgetAll(...types) { if (this.alive) await this.call({ forget_all: types.length ? types : ['ticks'] }).catch(() => {}); this.subs.clear(); }

  close() { this.closedByUser = true; clearInterval(this.pingTimer); this.ws?.close(); this.alive = false; }
}
