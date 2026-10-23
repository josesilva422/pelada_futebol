'use strict';
// Limite de tentativas de login (por endereço, guardado no estado) e o que a API devolve em cada caso.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic');
const { createApi } = require('../src/api');

function memoryStore() {
  let db = L.defaultDb();
  let version = 0;
  return {
    notified: 0,
    async load() { return { db: JSON.parse(JSON.stringify(db)), version }; },
    async save(next, v) { if (v !== version) return false; version++; db = next; return true; },
    async notify() { this.notified++; },
    peek: () => db,
  };
}

const login = (api, store, password, ip = '1.1.1.1') => api.handle(store, {
  method: 'POST', pathname: '/api/login', query: new URLSearchParams(), headers: {}, body: { password }, ip,
});

test('login: no 5º erro seguido o endereço é bloqueado, mesmo com a senha certa', async () => {
  const store = memoryStore();
  const api = createApi({ adminPassword: 'segredo' });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await login(api, store, 'errada')).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 429]);

  const blocked = await login(api, store, 'segredo');
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Tente de novo em 1 minuto/);
  assert.equal(blocked.body.token, undefined);

  // outro endereço não é afetado
  assert.equal((await login(api, store, 'segredo', '2.2.2.2')).status, 200);
  // erros não avisam os celulares (nada mudou na tela)
  assert.equal(store.notified, 0);
});

test('login: o bloqueio acaba com o tempo, dobra se o erro continua e acertar zera a contagem', async () => {
  const store = memoryStore();
  const api = createApi({ adminPassword: 'segredo' });
  for (let i = 0; i < 5; i++) await login(api, store, 'errada');
  assert.equal(store.peek().loginGuard['1.1.1.1'].fails, 5);

  // passou o minuto de bloqueio: errar de novo bloqueia por 2 minutos
  store.peek().loginGuard['1.1.1.1'].until = Date.now() - 1;
  const again = await login(api, store, 'errada');
  assert.equal(again.status, 429);
  assert.match(again.body.error, /2 minutos/);

  // passou o bloqueio e acertou: entra e a contagem some
  store.peek().loginGuard['1.1.1.1'].until = Date.now() - 1;
  const ok = await login(api, store, 'segredo');
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(store.peek().loginGuard['1.1.1.1'], undefined);
});

test('login: erros antigos (mais de 1 hora) são esquecidos', async () => {
  const store = memoryStore();
  const api = createApi({ adminPassword: 'segredo' });
  for (let i = 0; i < 3; i++) await login(api, store, 'errada');
  store.peek().loginGuard['1.1.1.1'].last = Date.now() - 2 * 60 * 60 * 1000;
  assert.equal((await login(api, store, 'errada')).status, 401);
  assert.equal(store.peek().loginGuard['1.1.1.1'].fails, 1);
});

test('login: tentativas simultâneas se contam umas às outras (não dá para furar o limite em paralelo)', async () => {
  const store = memoryStore();
  const api = createApi({ adminPassword: 'segredo' });
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) => login(api, store, `errada${i}`)));
  const status = res.map((r) => r.status);
  assert.ok(status.every((s) => [401, 429, 503].includes(s)), JSON.stringify(status));
  assert.ok(status.filter((s) => s === 401).length <= 4, `passaram ${status.filter((s) => s === 401).length} tentativas`);
  assert.equal((await login(api, store, 'segredo')).status, 429);
});

test('login: o token continua valendo e o limite não afeta quem usa a API com ele', async () => {
  const store = memoryStore();
  const api = createApi({ adminPassword: 'segredo' });
  const { token } = (await login(api, store, 'segredo')).body;
  for (let i = 0; i < 5; i++) await login(api, store, 'errada');
  const me = await api.handle(store, { method: 'GET', pathname: '/api/me', query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` }, body: null });
  assert.equal(me.body.admin, true);
});
