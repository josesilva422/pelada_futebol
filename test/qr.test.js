'use strict';
// O gerador de QR não tem biblioteca de referência aqui, então os testes conferem: valores conhecidos do padrão
// (bits de formato, de versão e o exemplo clássico de Reed-Solomon), a estrutura da matriz e, por fim,
// um leitor independente que desfaz máscara, intercalação e correção de erro e recupera o texto.
const test = require('node:test');
const assert = require('node:assert/strict');
const QR = require('../public/qr.js');

const { M_TABLE, rsDivisor, rsRemainder, formatBits, versionBits } = QR.internals;
const binary = (x, n) => x.toString(2).padStart(n, '0');

test('QR: bits de formato do nível M para as 8 máscaras batem com a tabela do padrão', () => {
  const expected = ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
  expected.forEach((bits, mask) => assert.equal(binary(formatBits(mask), 15), bits, `máscara ${mask}`));
});

test('QR: bits de versão das versões 7 a 10 batem com a tabela do padrão', () => {
  assert.equal(binary(versionBits(7), 18), '000111110010010100');
  assert.equal(binary(versionBits(8), 18), '001000010110111100');
  assert.equal(binary(versionBits(9), 18), '001001101010011001');
  assert.equal(binary(versionBits(10), 18), '001010010011010011');
});

test('QR: Reed-Solomon reproduz o exemplo clássico "HELLO WORLD" (1-M)', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('QR: tabela do nível M soma o total de codewords de cada versão', () => {
  const totals = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  totals.forEach((total, i) => {
    const [ecc, [n1], [n2]] = M_TABLE[i + 1];
    assert.equal(QR.internals.dataCodewords(i + 1) + ecc * (n1 + n2), total, `versão ${i + 1}`);
  });
});

test('QR: estrutura (cantos, sincronização, módulo escuro) e quantidade de módulos de dados por versão', () => {
  const remainder = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
  const totals = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  // textos que caem nas versões 1 a 10
  [5, 20, 40, 60, 80, 100, 120, 150, 175, 205].forEach((len, i) => {
    const q = QR.matrix('a'.repeat(len));
    const v = i + 1;
    assert.equal(q.version, v, `${len} bytes`);
    assert.equal(q.size, 17 + 4 * v);
    const dataModules = q.isFunction.flat().filter((f) => !f).length;
    assert.equal(dataModules, totals[v] * 8 + remainder[v], `módulos de dados da versão ${v}`);

    // cantos de localização: anel escuro, anel claro, centro 3x3 escuro
    [[0, 0], [q.size - 7, 0], [0, q.size - 7]].forEach(([ox, oy]) => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          assert.equal(q.modules[oy + dy][ox + dx], ring !== 2, `canto ${ox},${oy} em ${dx},${dy}`);
        }
      }
    });
    for (let i2 = 8; i2 < q.size - 8; i2++) {
      assert.equal(q.modules[6][i2], i2 % 2 === 0); // sincronização horizontal
      assert.equal(q.modules[i2][6], i2 % 2 === 0); // sincronização vertical
    }
    assert.equal(q.modules[q.size - 8][8], true); // módulo escuro fixo
    if (v >= 2) { // padrão de alinhamento do canto inferior direito
      const c = QR.internals.ALIGN[v].slice(-1)[0];
      assert.equal(q.modules[c][c], true);
      assert.equal(q.modules[c][c + 1], false);
      assert.equal(q.modules[c + 2][c + 2], true);
    }
  });
});

// ---------- leitor independente ----------

// GF(256) por tabelas de log/antilog (o gerador usa outro método)
const EXP = new Array(512).fill(0);
const LOG = new Array(256).fill(0);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function eccOf(data, eccLen) {
  let gen = [1];
  for (let i = 0; i < eccLen; i++) { // gen *= (x - alfa^i)
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    gen = next;
  }
  const rem = data.concat(new Array(eccLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const f = rem[i];
    if (f) gen.forEach((c, j) => { rem[i + j] ^= mul(c, f); });
  }
  return rem.slice(data.length);
}

const MASK_FORMULAS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function decode(q) {
  const { size, version, modules: m, isFunction } = q;
  const at = (x, y) => (m[y][x] ? 1 : 0);
  // as duas cópias da informação de formato (bit 0 primeiro), nas posições do padrão
  const copy1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const copy2 = [];
  for (let i = 0; i < 8; i++) copy2.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) copy2.push([8, size - 15 + i]);
  const read = (cells) => cells.reduce((acc, [x, y], i) => acc | (at(x, y) << i), 0);
  assert.equal(read(copy1), read(copy2), 'as duas cópias do formato são iguais');
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((k) => formatBits(k) === read(copy1));
  assert.notEqual(mask, undefined, 'formato válido');

  // desfaz a máscara e lê os bits em zigue-zague
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (isFunction[y][x]) continue;
        bits.push(at(x, y) ^ (MASK_FORMULAS[mask](y, x) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // desfaz a intercalação e confere a correção de erro de cada bloco
  const [eccLen, [n1, d1], [n2, d2]] = M_TABLE[version];
  const lens = [...new Array(n1).fill(d1), ...new Array(n2).fill(d2)];
  const blocks = lens.map(() => []);
  const ecc = lens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) lens.forEach((len, b) => { if (i < len) blocks[b].push(codewords[k++]); });
  for (let i = 0; i < eccLen; i++) lens.forEach((_, b) => ecc[b].push(codewords[k++]));
  blocks.forEach((dat, b) => assert.deepEqual(eccOf(dat, eccLen), ecc[b], `correção do bloco ${b}`));

  // lê o modo byte
  const stream = blocks.flat().map((c) => binary(c, 8)).join('');
  assert.equal(stream.slice(0, 4), '0100');
  const lenBits = version < 10 ? 8 : 16;
  const length = parseInt(stream.slice(4, 4 + lenBits), 2);
  const out = [];
  for (let i = 0; i < length; i++) out.push(parseInt(stream.slice(4 + lenBits + i * 8, 12 + lenBits + i * 8), 2));
  return Buffer.from(out).toString('utf8');
}

test('QR: o leitor independente recupera o texto em todas as versões, com acentos e emoji', () => {
  const texts = [
    'https://pelada.netlify.app/?c=K7X2M',
    'oi',
    'Pelada de hoje! ⚽ São Paulo, açaí e pão de queijo',
    'https://meu-site-de-pelada-com-nome-bem-comprido.netlify.app/?c=ABCDE&utm_source=whatsapp&utm_medium=convite',
    'x'.repeat(14), 'x'.repeat(15), 'y'.repeat(62), 'z'.repeat(63), 'w'.repeat(122), 'v'.repeat(123), 'u'.repeat(213),
  ];
  texts.forEach((t) => assert.equal(decode(QR.matrix(t)), t, t.slice(0, 40)));
});

test('QR: texto grande demais dá erro claro; svg sai com viewBox e margem de 4 módulos', () => {
  assert.throws(() => QR.matrix('a'.repeat(214)), /grande demais/);
  const q = QR.matrix('https://x.app/?c=ABCDE');
  const s = QR.svg('https://x.app/?c=ABCDE');
  assert.match(s, new RegExp(`viewBox="0 0 ${q.size + 8} ${q.size + 8}"`));
  assert.match(s, /^<svg /);
  assert.ok(s.includes('M4,4h1v1h-1z')); // o primeiro módulo do canto de localização, já com a margem
});
