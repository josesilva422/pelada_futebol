'use strict';
// Função do Netlify que atende todas as rotas /api/* (veja netlify.toml).
// Variáveis de ambiente (Netlify > Site configuration > Environment variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, ADMIN_PASSWORD
const { createApi } = require('../../src/api');
const { createSupabaseStore } = require('../../src/supabase-store');

let cached;
function setup() {
  if (cached) return cached;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, ADMIN_PASSWORD } = process.env;
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'ADMIN_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Variáveis de ambiente faltando no Netlify: ${missing.join(', ')}`);
  cached = {
    api: createApi({ adminPassword: ADMIN_PASSWORD, realtime: { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY } }),
    store: createSupabaseStore({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY }),
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

  const res = await api.handle(store, {
    method: event.httpMethod,
    pathname,
    query: new URLSearchParams(event.rawQuery || ''),
    headers: event.headers || {},
    body,
  });
  return json(res.status, res.body);
};
