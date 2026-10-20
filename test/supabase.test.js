'use strict';
// Testa a API com o armazenamento do Supabase usando um servidor falso que imita o PostgREST
// (leitura, insert com 409, PATCH condicionado a "version") e o broadcast do Realtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApi } = require('../src/api');
const { createSupabaseStore } = require('../src/supabase-store');

function fakeSupabase() {
  const state = { row: null, broadcasts: 0, badAuth: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.headers.apikey !== 'svc' || req.headers.authorization !== 'Bearer svc') state.badAuth++;
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname === '/realtime/v1/api/broadcast') {
        assert.equal(body.messages[0].topic, 'pelada');
        state.broadcasts++;
        return send(202, {});
      }
      assert.equal(url.pathname, '/rest/v1/pelada_state');
      if (req.method === 'GET') return send(200, state.row ? [{ data: state.row.data, version: state.row.version }] : []);
      if (req.method === 'POST') {
        if (state.row) return send(409, { message: 'duplicate' });
        state.row = { data: body.data, version: body.version };
        return send(201, {});
      }
      if (req.method === 'PATCH') {
        const want = Number(url.searchParams.get('version').replace('eq.', ''));
        if (!state.row || state.row.version !== want) return send(200, []);
        state.row = { data: body.data, version: body.version };
        return send(200, [{ version: body.version }]);
      }
      send(405, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

const req = (method, pathname, { token, body, query = '' } = {}) => ({
  method, pathname, query: new URLSearchParams(query), body: body || null,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

test('API completa sobre o Supabase: login, pelada com código, ranking público e nível escondido', async (t) => {
  const fake = await fakeSupabase();
  t.after(() => fake.server.close());
  const store = createSupabaseStore({ url: fake.url, serviceKey: 'svc' });
  const api = createApi({ adminPassword: 'segredo', realtime: { url: fake.url, anonKey: 'anon' } });

  assert.equal((await api.handle(store, req('GET', '/api/config'))).body.realtime.anonKey, 'anon');
  assert.equal((await api.handle(store, req('POST', '/api/login', { body: { password: 'errada' } }))).status, 401);
  const { token } = (await api.handle(store, req('POST', '/api/login', { body: { password: 'segredo' } }))).body;
  assert.ok(token);

  // sem token não escreve
  assert.equal((await api.handle(store, req('POST', '/api/players', { body: { name: 'X', level: 'bom', position: 'linha' } }))).status, 401);

  await api.handle(store, req('POST', '/api/players', { token, body: { name: 'Ana', level: 'bom', position: 'linha' } }));
  const started = (await api.handle(store, req('POST', '/api/session/start', { token }))).body;
  const code = started.session.code;
  assert.match(code, /^[A-Z2-9]{5}$/);
  assert.ok(fake.state.broadcasts >= 2);

  const locked = (await api.handle(store, req('GET', '/api/state', { query: 'code=ERRADO' }))).body;
  assert.equal(locked.locked, true);
  assert.ok(Array.isArray(locked.ranking)); // ranking é público

  const spectator = (await api.handle(store, req('GET', '/api/state', { query: `code=${code.toLowerCase()}` }))).body;
  assert.equal(spectator.locked, undefined);
  assert.equal(spectator.players[0].level, undefined);
  const admin = (await api.handle(store, req('GET', '/api/state', { token }))).body;
  assert.equal(admin.players[0].level, 'bom');
  assert.equal(fake.state.badAuth, 0);
});

test('duas ações ao mesmo tempo não se sobrescrevem (controle otimista com retry)', async (t) => {
  const fake = await fakeSupabase();
  t.after(() => fake.server.close());
  const store = createSupabaseStore({ url: fake.url, serviceKey: 'svc' });
  const api = createApi({ adminPassword: 'segredo' });
  const { token } = (await api.handle(store, req('POST', '/api/login', { body: { password: 'segredo' } }))).body;

  const names = ['A', 'B', 'C', 'D', 'E', 'F'];
  const results = await Promise.all(names.map((name) => api.handle(store, req('POST', '/api/players', { token, body: { name, level: 'medio', position: 'linha' } }))));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const saved = fake.state.row.data.players.map((p) => p.name).sort();
  assert.deepEqual(saved, names);
});

test('ao ler o estado depois do tempo, a partida é encerrada e todos são avisados', async (t) => {
  const fake = await fakeSupabase();
  t.after(() => fake.server.close());
  const store = createSupabaseStore({ url: fake.url, serviceKey: 'svc' });
  const api = createApi({ adminPassword: 'segredo' });
  const { token } = (await api.handle(store, req('POST', '/api/login', { body: { password: 'segredo' } }))).body;
  const call = async (m, p, body) => (await api.handle(store, req(m, p, { token, body }))).body;

  for (let i = 1; i <= 10; i++) await call('POST', '/api/players', { name: `J${String(i).padStart(2, '0')}`, level: 'medio', position: 'linha' });
  await call('POST', '/api/session/start');
  const players = (await call('GET', '/api/state')).players;
  for (const p of players) await call('POST', '/api/session/checkin', { playerId: p.id });
  await call('POST', '/api/session/draw');
  const running = await call('POST', '/api/match/start');
  assert.equal(running.session.match.status, 'running');

  // volta o relógio 8 minutos (a partida dura 7)
  fake.state.row.data.session.match.startedAt -= 8 * 60 * 1000;
  const before = fake.state.broadcasts;
  const after = await call('GET', '/api/state');
  assert.equal(after.session.match.status, 'finished');
  assert.equal(after.session.match.reason, 'tempo');
  assert.equal(fake.state.broadcasts, before + 1);
});

test('função do Netlify: caminhos com e sem redirect, corpo JSON e variáveis obrigatórias', async (t) => {
  const fake = await fakeSupabase();
  t.after(() => fake.server.close());
  const env = { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon', ADMIN_PASSWORD: 'segredo' };
  const backup = { ...process.env };
  t.after(() => { Object.keys(env).forEach((k) => { if (k in backup) process.env[k] = backup[k]; else delete process.env[k]; }); });

  // sem variáveis: erro claro, sem derrubar nada
  Object.keys(env).forEach((k) => delete process.env[k]);
  delete require.cache[require.resolve('../netlify/functions/api.js')];
  let { handler } = require('../netlify/functions/api.js');
  const missing = await handler({ httpMethod: 'GET', path: '/api/config', headers: {}, rawQuery: '' });
  assert.equal(missing.statusCode, 500);
  assert.match(JSON.parse(missing.body).error, /ADMIN_PASSWORD/);

  Object.assign(process.env, env);
  delete require.cache[require.resolve('../netlify/functions/api.js')];
  ({ handler } = require('../netlify/functions/api.js'));

  const cfg = await handler({ httpMethod: 'GET', path: '/.netlify/functions/api/config', headers: {}, rawQuery: '' });
  assert.equal(cfg.statusCode, 200);
  assert.equal(JSON.parse(cfg.body).realtime.url, fake.url);

  const login = await handler({ httpMethod: 'POST', path: '/api/login', headers: {}, rawQuery: '', body: JSON.stringify({ password: 'segredo' }) });
  assert.equal(login.statusCode, 200);
  const { token } = JSON.parse(login.body);

  const created = await handler({
    httpMethod: 'POST', path: '/api/players', headers: { authorization: `Bearer ${token}` }, rawQuery: '',
    body: Buffer.from(JSON.stringify({ name: 'Bia', level: 'fraco', position: 'linha' })).toString('base64'), isBase64Encoded: true,
  });
  assert.equal(created.statusCode, 200);
  assert.equal(JSON.parse(created.body).players[0].name, 'Bia');
  assert.equal((await handler({ httpMethod: 'GET', path: '/api/nada', headers: {}, rawQuery: '' })).statusCode, 404);
});
