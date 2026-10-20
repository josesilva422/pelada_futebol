'use strict';
// Cadastra jogadores de exemplo em data/db.json (pula nomes que já existem).
// Com o servidor no ar, cadastra pela API (usa ADMIN_PASSWORD, padrão admin123); com ele parado, grava no arquivo.
const fs = require('fs');
const path = require('path');
const L = require('../src/logic');

const FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const SAMPLE = [
  ['Rafael', 'bom', 'gol'], ['Thiago', 'medio', 'gol'], ['Caio', 'fraco', 'gol'],
  ['Lucas', 'bom'], ['Mateus', 'bom'], ['Gabriel', 'bom'], ['Pedro', 'bom'], ['Bruno', 'bom'],
  ['Felipe', 'medio'], ['Diego', 'medio'], ['Rodrigo', 'medio'], ['André', 'medio'], ['Vinícius', 'medio'], ['Leandro', 'medio'], ['Marcelo', 'medio'], ['Júnior', 'medio'],
  ['Fábio', 'fraco'], ['Renato', 'fraco'], ['Sérgio', 'fraco'], ['Paulo', 'fraco'], ['Edson', 'fraco'], ['Davi', 'fraco'], ['Henrique', 'fraco'], ['Otávio', 'fraco'], ['Wellington', 'fraco'],
];

async function viaApi() {
  const base = `http://127.0.0.1:${process.env.PORT || 3333}`;
  let res;
  try {
    res = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || 'admin123' }) });
  } catch { return false; } // servidor parado
  if (!res.ok) throw new Error('Servidor no ar, mas a senha do admin não confere. Defina ADMIN_PASSWORD.');
  const { token } = await res.json();
  let added = 0;
  for (const [name, level, position = 'linha'] of SAMPLE) {
    const r = await fetch(`${base}/api/players`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name, level, position }) });
    if (r.ok) added++;
  }
  console.log(`${added} jogadores adicionados pelo servidor em execução`);
  return true;
}

function viaFile() {
  let db;
  try { db = L.normalizeDb(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { db = L.defaultDb(); }
  let added = 0;
  for (const [name, level, position = 'linha'] of SAMPLE) {
    try { L.addPlayer(db, { name, level, position }); added++; } catch { /* já existe */ }
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db));
  console.log(`${added} jogadores adicionados (${db.players.length} no total) em ${FILE}`);
}

viaApi().then((done) => done || viaFile()).catch((e) => { console.error(e.message); process.exit(1); });
