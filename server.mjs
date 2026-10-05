import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Controller } from './lib/controller.mjs';
import { SimulationAdapter, HookAdapter } from './lib/adapters.mjs';
import { allowedAddresses } from './lib/access.mjs';
import { ReadOnlySshAdapter } from './lib/ssh-status.mjs';
import { ControlAdapter, ControlController } from './lib/control.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4180);
const mode = process.env.CONVOX_MODE || 'simulation';
if (!['simulation', 'observe', 'live', 'control'].includes(mode)) throw new Error('CONVOX_MODE must be simulation, observe, live or control');
const config = mode !== 'simulation' ? JSON.parse(await readFile(process.env.CONVOX_CONFIG_FILE || path.join(root, 'config.local.json'), 'utf8')) : {};
const adapter = mode === 'simulation' ? new SimulationAdapter() : mode === 'observe' ? new ReadOnlySshAdapter(config) : mode === 'control' ? new ControlAdapter(config) : new HookAdapter(config);
const ControllerClass = mode === 'control' ? ControlController : Controller;
const controller = await new ControllerClass({ dataDir: path.resolve(root, process.env.CONVOX_DATA_DIR || `data/${mode}`), adapter, mode }).init();
const token = randomBytes(32).toString('hex');
let proxySecret;
if (mode === 'control') {
  if (!process.env.CONVOX_PROXY_SECRET_FILE) throw new Error('Control mode requires a private Nginx proxy secret file');
  proxySecret = (await readFile(process.env.CONVOX_PROXY_SECRET_FILE, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(proxySecret)) throw new Error('Invalid control proxy secret');
}
const { origins, hosts } = allowedAddresses(port, process.env.CONVOX_PUBLIC_ORIGIN);
const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);

function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
function authenticated(req) {
  const provided = Buffer.from(req.headers['x-console-token'] || '');
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function trustedOperator(req) {
  if (mode !== 'control') return true;
  const supplied = Buffer.from(req.headers['x-console-proxy'] || '');
  const expected = Buffer.from(proxySecret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) &&
    typeof req.headers['x-console-operator'] === 'string' && /^[A-Za-z0-9_.@-]{1,128}$/.test(req.headers['x-console-operator']);
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('Request too large'); }
  return JSON.parse(raw || '{}');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'Invalid host' });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (!trustedOperator(req)) return json(res, 403, { error: 'Control access requires authenticated management proxy' });
    if (req.method === 'GET' && files.has(url.pathname)) {
      const [file, type] = files.get(url.pathname); res.setHeader('Content-Type', `${type}; charset=utf-8`);
      return res.end(await readFile(path.join(root, 'public', file)));
    }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request denied' });
      return json(res, 200, { token, mode });
    }
    if (!authenticated(req)) return json(res, 401, { error: 'Refresh the page to establish a local session' });
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, controller.view());
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
    if (!origins.has(req.headers.origin)) return json(res, 403, { error: 'Invalid origin' });
    const input = await body(req);
    if (url.pathname === '/api/refresh') return json(res, 200, await controller.refresh());
    if (url.pathname === '/api/preflight') {
      if (mode !== 'control') throw new Error('Control agents are not installed in this mode');
      return json(res, 200, await controller.preflight());
    }
    if (url.pathname === '/api/validate-traffic') {
      if (mode !== 'control') throw new Error('Control agents are not installed in this mode');
      return json(res, 200, await controller.validateTraffic(input.confirmation, req.headers['x-console-operator']));
    }
    if (url.pathname === '/api/jobs') return json(res, 202, await controller.start(input.action, input.confirmation, input.outageAccepted === true, req.headers['x-console-operator']));
    if (url.pathname === '/api/demo') return json(res, 200, await controller.demo(input.command));
    if (url.pathname === '/api/reconcile') return json(res, 200, await controller.reconcile(input.confirmation, req.headers['x-console-operator']));
    return json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 409, { error: error.message }); }
});
server.requestTimeout = 30000;
server.listen(port, '127.0.0.1', () => console.log(`ConVox DR console (${mode}): http://127.0.0.1:${port}`));
