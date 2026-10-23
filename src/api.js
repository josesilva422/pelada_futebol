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

// Limite de tentativas de login por endereço. Fica no próprio estado (db.loginGuard), então vale para todas as
// instâncias da função do Netlify, e as tentativas simultâneas se contam umas às outras (controle otimista).
const LOGIN_MAX_FAILS = 5; // no 5º erro seguido começa o bloqueio
const LOGIN_LOCK_MS = 60_000; // 1º bloqueio; dobra a cada novo erro, até o máximo
const LOGIN_LOCK_MAX_MS = 15 * 60_000;
const LOGIN_FORGET_MS = 60 * 60_000; // erros antigos são esquecidos
const LOGIN_MAX_ENTRIES = 200;

const waitText = (ms) => {
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec} segundos`;
  const min = Math.ceil(sec / 60);
  return `${min} ${min === 1 ? 'minuto' : 'minutos'}`;
};

function recordLoginFailure(guard, ip, now) {
  const prev = guard[ip];
  const fails = (prev && now - prev.last < LOGIN_FORGET_MS ? prev.fails : 0) + 1;
  const over = fails - LOGIN_MAX_FAILS + 1; // 1 no 5º erro, 2 no 6º...
  guard[ip] = { fails, last: now, until: over > 0 ? now + Math.min(LOGIN_LOCK_MAX_MS, LOGIN_LOCK_MS * 2 ** (over - 1)) : 0 };
  Object.keys(guard).forEach((k) => { if (now - guard[k].last > LOGIN_FORGET_MS) delete guard[k]; });
  const keys = Object.keys(guard);
  if (keys.length > LOGIN_MAX_ENTRIES) keys.sort((a, b) => guard[a].last - guard[b].last).slice(0, keys.length - LOGIN_MAX_ENTRIES).forEach((k) => delete guard[k]);
}

// adminPassword: senha do admin. realtime: { url, anonKey } do Supabase (ou null para usar SSE local).
// lanUrls: endereços do servidor na rede local (só no servidor local), usados no link de convite do admin.
function createApi({ adminPassword, realtime = null, lanUrls = [] }) {
  const adminToken = (db) => crypto.createHmac('sha256', db.secret).update('admin:' + adminPassword).digest('hex');
  // o EventSource do navegador não envia cabeçalhos, então aceitamos também ?token=
  const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.get('token') || '';
  const isAdmin = (db, req) => safeEqual(tokenOf(req), adminToken(db));

  // lê, altera e grava; se outra requisição gravou no meio, repete. fn devolvendo false = nada a gravar.
  // notify: false grava sem avisar os celulares (para o que não muda nada na tela, como o registro de logins errados).
  async function mutate(store, fn, { notify = true } = {}) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { db, version } = await store.load();
      if (fn(db) === false) return { db };
      if (await store.save(db, version)) {
        if (notify) await store.notify();
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
      if (method === 'GET' && pathname === '/api/config') return ok({ realtime, lanUrls });

      if (method === 'GET' && (pathname === '/api/state' || pathname === '/api/me')) {
        const { db } = await mutate(store, tickOnly(now));
        const admin = isAdmin(db, req);
        return ok(pathname === '/api/me' ? { admin } : L.viewState(db, now, { admin, code }));
      }

      if (method === 'POST' && pathname === '/api/login') {
        await new Promise((r) => setTimeout(r, 300)); // atraso fixo por tentativa
        const ip = req.ip || 'desconhecido';
        const password = (req.body || {}).password || '';
        let outcome;
        const { db } = await mutate(store, (d) => {
          const t = Date.now();
          const guard = d.loginGuard || (d.loginGuard = {});
          const entry = guard[ip];
          if (entry && entry.until > t) { outcome = { wait: entry.until - t }; return false; }
          if (safeEqual(password, adminPassword)) {
            outcome = { ok: true };
            if (!entry) return false; // nada a gravar
            delete guard[ip]; // acertou: zera os erros
            return true;
          }
          recordLoginFailure(guard, ip, t);
          outcome = { fail: true, wait: Math.max(0, guard[ip].until - t) }; // wait > 0: este erro acabou de bloquear
          return true;
        }, { notify: false });
        if (outcome.wait) throw new L.AppError(`Muitas tentativas erradas. Tente de novo em ${waitText(outcome.wait)}.`, 429);
        if (outcome.fail) throw new L.AppError('Senha incorreta', 401);
        return ok({ token: adminToken(db) });
      }

      for (const [m, re, handler] of routes) {
        const match = method === m && pathname.match(re);
        if (!match) continue;
        const { db } = await mutate(store, (d) => {
          if (!isAdmin(d, req)) throw new L.AppError('Acesso restrito ao administrador', 401);
          // o handler devolve false quando o pedido já tinha sido feito (ex.: gol repetido): nada a gravar
          if (handler(d, now, match.slice(1), req.body || {}) === false) return false;
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
