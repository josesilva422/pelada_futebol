'use strict';
// Núcleo da API, independente de onde roda (servidor local ou função do Netlify) e de onde guarda os dados.
//
// Um "store" precisa ter:
//   load()            -> { db, version }   (db é uma cópia, pode ser alterada à vontade)
//   save(db, version) -> boolean           (false se outra requisição salvou antes: a API tenta de novo)
//   notify()          -> avisa os clientes que algo mudou
const crypto = require('crypto');
const L = require('./logic');

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

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// adminPassword: senha do admin. realtime: { url, anonKey } do Supabase (ou null para usar SSE local)
function createApi({ adminPassword, realtime = null }) {
  const adminToken = (db) => crypto.createHmac('sha256', db.secret).update('admin:' + adminPassword).digest('hex');
  // o EventSource do navegador não envia cabeçalhos, então aceitamos também ?token=
  const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.get('token') || '';
  const isAdmin = (db, req) => safeEqual(tokenOf(req), adminToken(db));

  // lê, altera e grava; se outra requisição gravou no meio, repete. fn devolvendo false = nada a gravar.
  async function mutate(store, fn) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { db, version } = await store.load();
      if (fn(db) === false) return { db };
      if (await store.save(db, version)) {
        await store.notify();
        return { db };
      }
    }
    throw new L.AppError('Muitas ações ao mesmo tempo, tente de novo', 503);
  }

  // encerra por tempo quando o cronômetro acabou (chamado a cada leitura e pelo servidor local)
  const tickOnly = (now) => (db) => (L.tick(db, now) ? true : false);
  const tick = (store) => mutate(store, tickOnly(Date.now()));

  async function handle(store, req) {
    const now = Date.now();
    const { method, pathname } = req;
    const code = req.query.get('code');
    const ok = (body) => ({ status: 200, body });
    try {
      if (method === 'GET' && pathname === '/api/config') return ok({ realtime });

      if (method === 'GET' && (pathname === '/api/state' || pathname === '/api/me')) {
        const { db } = await mutate(store, tickOnly(now));
        const admin = isAdmin(db, req);
        return ok(pathname === '/api/me' ? { admin } : L.viewState(db, now, { admin, code }));
      }

      if (method === 'POST' && pathname === '/api/login') {
        await new Promise((r) => setTimeout(r, 300)); // freia tentativas de adivinhar a senha
        const { db } = await store.load();
        if (!safeEqual((req.body || {}).password || '', adminPassword)) throw new L.AppError('Senha incorreta', 401);
        return ok({ token: adminToken(db) });
      }

      for (const [m, re, handler] of routes) {
        const match = method === m && pathname.match(re);
        if (!match) continue;
        const { db } = await mutate(store, (d) => {
          if (!isAdmin(d, req)) throw new L.AppError('Acesso restrito ao administrador', 401);
          handler(d, now, match.slice(1), req.body || {});
        });
        return ok(L.viewState(db, now, { admin: true, code }));
      }
      return { status: 404, body: { error: 'Rota não encontrada' } };
    } catch (e) {
      if (!(e instanceof L.AppError)) console.error(e);
      return { status: e.status || 500, body: { error: e instanceof L.AppError ? e.message : 'Erro interno' } };
    }
  }

  return { handle, tick, isAdmin };
}

module.exports = { createApi };
