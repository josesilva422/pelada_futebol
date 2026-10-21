'use strict';
// Guarda o estado da pelada numa única linha da tabela public.pelada_state do Supabase.
// Usa só a API REST (PostgREST) e o broadcast do Realtime, sem dependências.
// A chave service_role fica apenas no servidor (função do Netlify): nunca vai para o navegador.
const L = require('./logic');

function createSupabaseStore({ url, serviceKey, fetchImpl = fetch }) {
  const base = String(url).replace(/\/$/, '');
  // chaves novas (sb_secret_...) não são JWT e vão só em "apikey"; as antigas (service_role, JWT) também em Authorization
  const headers = {
    apikey: serviceKey,
    ...(String(serviceKey).startsWith('sb_') ? {} : { Authorization: `Bearer ${serviceKey}` }),
    'Content-Type': 'application/json',
  };

  async function rest(path, { method = 'GET', prefer, body } = {}) {
    const res = await fetchImpl(base + path, {
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && res.status !== 409) throw new Error(`Supabase ${method} ${path} falhou: ${res.status} ${await res.text()}`);
    return res;
  }

  return {
    async load() {
      for (let i = 0; i < 3; i++) {
        const rows = await (await rest('/rest/v1/pelada_state?id=eq.1&select=data,version')).json();
        if (rows.length) return { db: L.normalizeDb(rows[0].data), version: rows[0].version };
        // primeira execução: cria a linha (se outra requisição criou antes, dá 409 e lemos de novo)
        await rest('/rest/v1/pelada_state', { method: 'POST', prefer: 'return=minimal', body: { id: 1, data: L.defaultDb(), version: 0 } });
      }
      throw new Error('Não foi possível ler o estado no Supabase');
    },

    // grava só se ninguém salvou depois da nossa leitura (controle otimista por "version")
    async save(db, version) {
      const res = await rest(`/rest/v1/pelada_state?id=eq.1&version=eq.${version}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: { data: db, version: version + 1, updated_at: new Date().toISOString() },
      });
      return (await res.json()).length === 1;
    },

    // avisa os celulares conectados no canal "pelada" (sem dados: eles pedem o estado à API)
    async notify() {
      try {
        await fetchImpl(`${base}/realtime/v1/api/broadcast`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ messages: [{ topic: 'pelada', event: 'changed', payload: {}, private: false }] }),
        });
      } catch { /* o app também atualiza por polling */ }
    },
  };
}

module.exports = { createSupabaseStore };
