'use strict';
// Convite e instalação: endereços da rede local na configuração, arquivos do manifest/ícones/pré-visualização
// e o script que completa o endereço da imagem de pré-visualização no deploy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../src/logic');
const { createApi } = require('../src/api');
const { inject } = require('../scripts/set-site-url');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f));
const pngSize = (buf) => {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'assinatura PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};

test('configuração devolve os endereços da rede local para o link de convite', async () => {
  const store = { async load() { return { db: L.defaultDb(), version: 0 }; }, async save() { return true; }, async notify() {} };
  const get = (api) => api.handle(store, { method: 'GET', pathname: '/api/config', query: new URLSearchParams(), headers: {}, body: null });
  const local = await get(createApi({ adminPassword: 'x', lanUrls: ['http://192.168.0.10:3333'] }));
  assert.deepEqual(local.body, { realtime: null, lanUrls: ['http://192.168.0.10:3333'] });
  const prod = await get(createApi({ adminPassword: 'x', realtime: { url: 'https://a.supabase.co', anonKey: 'k' } }));
  assert.deepEqual(prod.body.lanUrls, []);
});

test('manifest: ícones existem com o tamanho declarado e a página aponta para os arquivos certos', () => {
  const manifest = JSON.parse(read('manifest.webmanifest').toString('utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.lang, 'pt-BR');
  manifest.icons.filter((i) => i.type === 'image/png').forEach((icon) => {
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(read(icon.src)), [w, h], icon.src);
  });
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  assert.match(read('icon.svg').toString('utf8'), /^<svg /);

  const html = read('index.html').toString('utf8');
  ['manifest.webmanifest', 'icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'style.css', 'qr.js', 'app.js'].forEach((f) => {
    assert.ok(html.includes(`"${f}"`), `index.html referencia ${f}`);
    assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} existe`);
  });
  assert.deepEqual(pngSize(read('apple-touch-icon.png')), [180, 180]);
  assert.ok(html.indexOf('src="qr.js"') < html.indexOf('src="app.js"'), 'qr.js carrega antes do app.js');

  // favicon.ico com um PNG dentro
  const ico = read('favicon.ico');
  assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4)], [1, 1]);
  assert.deepEqual(pngSize(ico.subarray(ico.readUInt32LE(18))), [48, 48]);
});

test('pré-visualização do link: imagem 1200x630 e tags principais', () => {
  assert.deepEqual(pngSize(read('og-image.png')), [1200, 630]);
  const html = read('index.html').toString('utf8');
  ['og:title', 'og:description', 'og:image'].forEach((p) => assert.ok(html.includes(`property="${p}"`), p));
  assert.match(html, /<meta name="description" content="[^"]{40,}"/);
  assert.match(html, /<meta property="og:image" content="\/og-image\.png">/); // relativo: o deploy completa
});

test('set-site-url: coloca o endereço do site na frente do og:image só quando existe um endereço válido', () => {
  const html = '<meta property="og:image" content="/og-image.png"><meta property="og:title" content="/x">';
  assert.equal(inject(html, 'https://pelada.netlify.app'), '<meta property="og:image" content="https://pelada.netlify.app/og-image.png"><meta property="og:title" content="/x">');
  assert.equal(inject(html, 'https://pelada.netlify.app/'), inject(html, 'https://pelada.netlify.app')); // barra no fim
  assert.equal(inject(html, undefined), html);
  assert.equal(inject(html, 'pelada.netlify.app'), html); // sem http(s): não mexe
  const done = inject(html, 'https://a.app');
  assert.equal(inject(done, 'https://b.app'), done); // já completo: não duplica
});
