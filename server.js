'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const L = require('./src/logic');

const PORT = Number(process.env.PORT) || 3333;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- persistencia ----------

function load() {
  try {
    return L.normalizeDb(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    return L.defaultDb();
  }
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

const db = load();

// ---------- autenticacao (perfil admin) ----------

const adminToken = () => crypto.createHmac('sha256', db.secret).update('admin:' + ADMIN_PASSWORD).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// o EventSource do navegador não envia cabeçalhos, então o stream aceita ?token=
const tokenOf = (req, url) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
const isAdmin = (req, url) => safeEqual(tokenOf(req, url), adminToken());

// ---------- tempo real (SSE) ----------

const clients = new Map(); // resposta SSE -> { admin, code }
const stateFor = ({ admin, code }) => L.viewState(db, Date.now(), { admin, code });

function broadcast() {
  clients.forEach((who, res) => res.write(`data: ${JSON.stringify(stateFor(who))}\n\n`));
}

function commit() {
  save();
  broadcast();
}

setInterval(() => {
  if (L.tick(db, Date.now())) commit();
}, 500);
setInterval(() => clients.forEach((who, res) => res.write(': ping\n\n')), 20000);

// ---------- rotas de escrita (somente admin) ----------

const id = '([a-f0-9]+)';
const routes = [
  ['POST', /^\/api\/players$/, (d, n, p, b) => L.addPlayer(d, b)],
  ['PUT', new RegExp(`^/api/players/${id}$`), (d, n, p, b) => L.updatePlayer(d, p[0], b)],
  ['DELETE', new RegExp(`^/api/players/${id}$`), (d, n, p) => L.deletePlayer(d, p[0])],
  ['POST', /^\/api\/session\/start$/, (d) => L.startPelada(d)],
  ['POST', /^\/api\/session\/end$/, (d) => L.endPelada(d)],
  ['POST', /^\/api\/session\/checkin$/, (d, n, p, b) => L.arrive(d, b.playerId)],
  ['POST', /^\/api\/session\/draw$/, (d) => L.draw(d)],
  ['POST', /^\/api\/session\/redraw$/, (d) => L.redraw(d)],
  ['POST', new RegExp(`^/api/session/players/${id}/back$`), (d, n, p) => L.sendToBack(d, p[0])],
  ['POST', new RegExp(`^/api/session/players/${id}/remove$`), (d, n, p) => L.removePlayer(d, p[0])],
  ['POST', /^\/api\/match\/start$/, (d, n) => L.startMatch(d, n)],
  ['POST', /^\/api\/match\/pause$/, (d, n) => L.pauseMatch(d, n)],
  ['POST', /^\/api\/match\/resume$/, (d, n) => L.resumeMatch(d, n)],
  ['POST', /^\/api\/match\/finish$/, (d, n) => L.finishMatch(d, 'manual', n)],
  ['POST', /^\/api\/match\/next$/, (d, n, p, b) => L.nextMatch(d, n, b.winnerTeamId)],
  ['POST', /^\/api\/match\/goal$/, (d, n, p, b) => L.recordGoal(d, b, n)],
  ['DELETE', new RegExp(`^/api/match/goals/${id}$`), (d, n, p) => L.undoGoal(d, p[0])],
  ['PUT', /^\/api\/config$/, (d, n, p, b) => L.setConfig(d, b)],
  ['POST', /^\/api\/season\/reset$/, (d) => L.resetSeason(d)],
];

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
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new L.AppError('JSON inválido')); }
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

    const admin = isAdmin(req, url);
    const who = { admin, code: url.searchParams.get('code') };

    if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, stateFor(who));
    if (req.method === 'GET' && pathname === '/api/me') return send(res, 200, { admin });

    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(stateFor(who))}\n\n`);
      clients.set(res, who);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readBody(req);
      await new Promise((r) => setTimeout(r, 300)); // freia tentativas de adivinhar a senha
      if (!safeEqual(body.password || '', ADMIN_PASSWORD)) throw new L.AppError('Senha incorreta', 401);
      return send(res, 200, { token: adminToken() });
    }

    for (const [method, re, handler] of routes) {
      const m = req.method === method && pathname.match(re);
      if (!m) continue;
      if (!admin) throw new L.AppError('Acesso restrito ao administrador', 401);
      const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};
      handler(db, Date.now(), m.slice(1), body);
      commit();
      return send(res, 200, stateFor(who));
    }
    send(res, 404, { error: 'Rota não encontrada' });
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
