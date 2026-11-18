// ---------------------------------------------------------------------------
// Tuning dashboard — zero-dependency HTTP + SSE server around the Engine.
//   GET  /              single-page UI (public/index.html)
//   GET  /api/state     full engine state snapshot
//   GET  /api/strategies  strategy metadata (auto-renders tuning controls)
//   POST /api/config    runtime tuning: {strategy:{name,params},risk:{...},...}
//   POST /api/control   {action: pause|resume|stop|start}
//   GET  /api/events    Server-Sent Events stream
//
// SECURITY: no built-in auth. Run paper mode publicly; put live mode behind
// your own authenticated reverse proxy. Never expose a live-token bot naked.
// ---------------------------------------------------------------------------
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Engine } from './src/engine.mjs';
import { STRATEGIES } from './src/strategies.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startDashboard(cfg, { port = 8080 } = {}) {
  cfg.mode = process.env.DASHBOARD_MODE === 'live' ? 'live' : 'paper';
  const engine = new Engine(cfg);
  const clients = new Set();
  let lastTickBroadcast = 0;

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  engine.on('tick', (t) => { const now = Date.now(); if (now - lastTickBroadcast > 900) { lastTickBroadcast = now; broadcast('tick', t); } });
  for (const ev of ['signal', 'trade_open', 'trade_close', 'status', 'config', 'position_update', 'balance'])
    engine.on(ev, (d) => broadcast(ev, d));

  const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
  const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      }
      if (u.pathname === '/api/state') return send(res, 200, engine.state());
      if (u.pathname === '/api/strategies') {
        const out = {};
        for (const [k, v] of Object.entries(STRATEGIES)) out[k] = { label: v.label, defaults: v.cls.defaults, paramSpec: v.cls.paramSpec };
        return send(res, 200, out);
      }
      if (u.pathname === '/api/config' && req.method === 'POST') return send(res, 200, engine.applyConfig(await readBody(req)));
      if (u.pathname === '/api/control' && req.method === 'POST') {
        const { action } = await readBody(req);
        if (action === 'pause') engine.pause();
        else if (action === 'resume') engine.resume();
        else if (action === 'stop') await engine.stop();
        else if (action === 'start' && !engine.running) await engine.start();
        else return send(res, 400, { error: 'unknown action' });
        return send(res, 200, { ok: true, running: engine.running, paused: engine.paused });
      }
      if (u.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        res.write(`event: hello\ndata: {}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: e.message }); }
  });

  await engine.start();
  server.listen(port, '0.0.0.0', () => {
    console.log(`\nDashboard: http://0.0.0.0:${port}  (mode: ${cfg.mode})`);
    console.log('Tune strategy/risk live from the UI. Paper mode = public data, simulated fills, zero risk.\n');
  });
  const keepalive = setInterval(() => broadcast('ping', { t: Date.now() }), 25_000);
  process.on('SIGINT', async () => { clearInterval(keepalive); await engine.stop(); server.close(); process.exit(0); });
  return { server, engine };
}
