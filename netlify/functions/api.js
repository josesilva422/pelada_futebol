'use strict';
// Função do Netlify que atende todas as rotas /api/* (veja netlify.toml).
// Variáveis de ambiente (Netlify > Site configuration > Environment variables):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, ADMIN_PASSWORD
// (os nomes antigos SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY também são aceitos)
const { createApi } = require('../../src/api');
const { createSupabaseStore } = require('../../src/supabase-store');

let cached;
function setup() {
  if (cached) return cached;
  const env = process.env;
  const url = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !url && 'SUPABASE_URL',
    !publishableKey && 'SUPABASE_PUBLISHABLE_KEY',
    !secretKey && 'SUPABASE_SECRET_KEY',
    !env.ADMIN_PASSWORD && 'ADMIN_PASSWORD',
  ].filter(Boolean);
  if (missing.length) throw new Error(`Variáveis de ambiente faltando no Netlify: ${missing.join(', ')}`);

  // erros comuns de configuração viram mensagens claras (sem repetir o valor, que pode ser uma chave)
  let validUrl = false;
  try { validUrl = ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* inválida */ }
  if (!validUrl) {
    throw new Error('SUPABASE_URL inválida: deve ser o endereço do projeto (https://<id>.supabase.co), mas o valor cadastrado não é um endereço. Parece que uma chave foi colada no campo errado.');
  }
  if (String(secretKey).startsWith('sb_publishable_')) {
    throw new Error('SUPABASE_SECRET_KEY está com a chave pública (sb_publishable_...). Ali vai a Secret key (sb_secret_...).');
  }
  if (String(publishableKey).startsWith('sb_secret_')) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY está com a chave secreta (sb_secret_...). Ali vai a Publishable key (sb_publishable_...).');
  }
  cached = {
    api: createApi({ adminPassword: env.ADMIN_PASSWORD, realtime: { url, anonKey: publishableKey } }),
    store: createSupabaseStore({ url, serviceKey: secretKey }),
  };
  return cached;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  let api;
  let store;
  try {
    ({ api, store } = setup());
  } catch (e) {
    console.error(e.message);
    return json(500, { error: e.message });
  }

  // com o redirect do netlify.toml o caminho chega como /api/..., sem ele como /.netlify/functions/api/...
  let pathname = event.path.replace(/^\/\.netlify\/functions\/api/, '/api');
  if (!pathname.startsWith('/api')) pathname = '/api' + pathname;

  let body = null;
  if (event.body) {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
    } catch {
      return json(400, { error: 'JSON inválido' });
    }
  }

  // endereço de quem chamou, para o limite de tentativas de login (o Netlify preenche x-nf-client-connection-ip)
  const headers = event.headers || {};
  const ip = headers['x-nf-client-connection-ip'] || String(headers['x-forwarded-for'] || '').split(',')[0].trim() || null;

  const res = await api.handle(store, {
    method: event.httpMethod,
    pathname,
    query: new URLSearchParams(event.rawQuery || ''),
    headers,
    body,
    ip,
  });
  return json(res.status, res.body);
};
