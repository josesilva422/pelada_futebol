'use strict';
// Servidor local (desenvolvimento e uso na rede do campo): guarda os dados em data/db.json
// e atualiza os celulares por SSE. Em produção (Netlify + Supabase) quem atende é netlify/functions/api.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./src/logic');
const { createApi } = require('./src/api');

const PORT = Number(process.env.PORT) || 3333;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- armazenamento em arquivo ----------

let current;
try {
  current = L.normalizeDb(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch {
  current = L.defaultDb();
}
let version = 0;

const clients = new Map(); // resposta SSE -> { admin, code }
const stateFor = ({ admin, code }) => L.viewState(current, Date.now(), { admin, code });

const store = {
  async load() { return { db: JSON.parse(JSON.stringify(current)), version }; },
  async save(db, v) {
    if (v !== version) return false;
    version++;
    current = db;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
    return true;
  },
  async notify() {
    clients.forEach((who, res) => res.write(`data: ${JSON.stringify(stateFor(who))}\n\n`));
  },
};

const api = createApi({ adminPassword: ADMIN_PASSWORD, realtime: null }); // realtime null: o navegador usa SSE

setInterval(() => api.tick(store).catch(console.error), 500); // encerra a partida quando o tempo acaba
setInterval(() => clients.forEach((who, res) => res.write(': ping\n\n')), 20000);

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 100_000) { reject(new L.AppError('Requisição muito grande', 413)); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { reject(new L.AppError('JSON inválido')); }
    });
  });
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Acesso negado' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Não encontrado' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;
  try {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    if (req.method === 'GET' && pathname === '/api/stream') {
      const { db } = await store.load();
      const who = { admin: api.isAdmin(db, { headers: req.headers, query: url.searchParams }), code: url.searchParams.get('code') };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(stateFor(who))}\n\n`);
      clients.set(res, who);
      req.on('close', () => clients.delete(res));
      return;
    }

    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : null;
    const out = await api.handle(store, { method: req.method, pathname, query: url.searchParams, headers: req.headers, body, ip: req.socket.remoteAddress });
    send(res, out.status, out.body);
  } catch (e) {
    if (!(e instanceof L.AppError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof L.AppError ? e.message : 'Erro interno' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pelada rodando em http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat()
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .forEach((i) => console.log(`  na rede local: http://${i.address}:${PORT}`));
  if (!process.env.ADMIN_PASSWORD) console.log('Senha do admin: "admin123" (troque com a variável ADMIN_PASSWORD)');
});
