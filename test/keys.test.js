'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseStore } = require('../src/supabase-store');

function capture() {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push(opts.headers);
    return { ok: true, status: 200, json: async () => [{ data: {}, version: 1 }], text: async () => '' };
  };
  return { seen, fetchImpl };
}

test('Secret key nova (sb_secret_...) vai só em apikey, sem Authorization', async () => {
  const { seen, fetchImpl } = capture();
  const store = createSupabaseStore({ url: 'https://x.supabase.co', serviceKey: 'sb_secret_abc', fetchImpl });
  await store.load();
  await store.notify();
  assert.ok(seen.length >= 2);
  for (const h of seen) {
    assert.equal(h.apikey, 'sb_secret_abc');
    assert.equal(h.Authorization, undefined);
  }
});

test('chave antiga (service_role, JWT) continua indo também em Authorization', async () => {
  const { seen, fetchImpl } = capture();
  const store = createSupabaseStore({ url: 'https://x.supabase.co', serviceKey: 'eyJhbGciOi.legacy.jwt', fetchImpl });
  await store.load();
  assert.equal(seen[0].apikey, 'eyJhbGciOi.legacy.jwt');
  assert.equal(seen[0].Authorization, 'Bearer eyJhbGciOi.legacy.jwt');
});
