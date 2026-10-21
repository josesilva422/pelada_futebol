'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const FN = require.resolve('../netlify/functions/api.js');
const base = {
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
  SUPABASE_SECRET_KEY: 'sb_secret_y',
  ADMIN_PASSWORD: 'uma-senha-longa-123',
};
const NAMES = [...Object.keys(base), 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];

async function call(env) {
  const backup = { ...process.env };
  NAMES.forEach((k) => delete process.env[k]);
  Object.assign(process.env, env);
  delete require.cache[FN];
  try {
    return await require(FN).handler({ httpMethod: 'GET', path: '/api/config', headers: {}, rawQuery: '' });
  } finally {
    NAMES.forEach((k) => { if (k in backup) process.env[k] = backup[k]; else delete process.env[k]; });
  }
}

test('configuração certa: a função responde', async () => {
  const r = await call(base);
  assert.equal(r.statusCode, 200);
});

test('SUPABASE_URL com uma chave colada: erro claro, sem repetir a chave', async () => {
  const r = await call({ ...base, SUPABASE_URL: 'sb_publishable_QGpj-segredo' });
  assert.equal(r.statusCode, 500);
  const { error } = JSON.parse(r.body);
  assert.match(error, /SUPABASE_URL inválida/);
  assert.ok(!error.includes('QGpj'));
});

test('chaves trocadas entre os campos: erro claro', async () => {
  let r = await call({ ...base, SUPABASE_SECRET_KEY: 'sb_publishable_x' });
  assert.match(JSON.parse(r.body).error, /SUPABASE_SECRET_KEY está com a chave pública/);
  r = await call({ ...base, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_y' });
  assert.match(JSON.parse(r.body).error, /SUPABASE_PUBLISHABLE_KEY está com a chave secreta/);
});

test('nomes antigos das variáveis continuam aceitos', async () => {
  const r = await call({ SUPABASE_URL: base.SUPABASE_URL, SUPABASE_ANON_KEY: 'eyJ.anon.jwt', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.svc.jwt', ADMIN_PASSWORD: base.ADMIN_PASSWORD });
  assert.equal(r.statusCode, 200);
});
