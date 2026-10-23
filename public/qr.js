'use strict';
// Gerador de QR code sem dependências: modo byte (UTF-8), correção de erro nível M, versões 1 a 10
// (até 213 bytes, de sobra para um link). No navegador vira window.QR; no Node, module.exports.
//   QR.matrix(texto) -> { size, version, modules: boolean[][] (true = escuro), isFunction: boolean[][] }
//   QR.svg(texto)    -> string <svg> pronta para inserir na página (com a margem de 4 módulos)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // nível M: [codewords de correção por bloco, [blocos do grupo 1, dados por bloco], [blocos do grupo 2, dados por bloco]]
  const M_TABLE = [null,
    [10, [1, 16], [0, 0]], [16, [1, 28], [0, 0]], [26, [1, 44], [0, 0]], [18, [2, 32], [0, 0]], [24, [2, 43], [0, 0]],
    [16, [4, 27], [0, 0]], [18, [4, 31], [0, 0]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const MAX_VERSION = 10;

  const dataCodewords = (v) => M_TABLE[v][1][0] * M_TABLE[v][1][1] + M_TABLE[v][2][0] * M_TABLE[v][2][1];
  const bit = (x, i) => ((x >>> i) & 1) === 1;

  // ---------- Reed-Solomon sobre GF(256), polinômio 0x11D ----------

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    data.forEach((b) => {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  // ---------- informações de formato e de versão (códigos BCH) ----------

  function formatBits(mask) {
    const data = mask; // nível M = 00, seguido dos 3 bits da máscara
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
  }

  // ---------- dados ----------

  function pickVersion(length) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      if (4 + (v < 10 ? 8 : 16) + length * 8 <= dataCodewords(v) * 8) return v;
    }
    throw new Error('Texto grande demais para o QR code');
  }

  function buildData(bytes, version) {
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4); // modo byte
    put(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    const capacity = dataCodewords(version) * 8;
    put(0, Math.min(4, capacity - bits.length)); // terminador
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < dataCodewords(version); pad ^= 0xec ^ 0x11) data.push(pad);
    return data;
  }

  // divide em blocos, calcula a correção de cada um e intercala (dados de todos os blocos, depois a correção)
  function interleave(data, version) {
    const [eccLen, [n1, d1], [n2, d2]] = M_TABLE[version];
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    let k = 0;
    for (let i = 0; i < n1 + n2; i++) {
      const dat = data.slice(k, k + (i < n1 ? d1 : d2));
      k += dat.length;
      blocks.push({ dat, ecc: rsRemainder(dat, divisor) });
    }
    const out = [];
    const longest = Math.max(d1, d2);
    for (let i = 0; i < longest; i++) blocks.forEach((b) => { if (i < b.dat.length) out.push(b.dat[i]); });
    for (let i = 0; i < eccLen; i++) blocks.forEach((b) => out.push(b.ecc[i]));
    return out;
  }

  // ---------- matriz ----------

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function penalty(m, size) {
    let result = 0;
    // sequências de 5 ou mais módulos iguais, em linhas e colunas
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let color = null;
        let run = 0;
        for (let b = 0; b < size; b++) {
          const c = pass ? m[b][a] : m[a][b];
          if (c === color) { run++; if (run === 5) result += 3; else if (run > 5) result++; } else { color = c; run = 1; }
        }
      }
    }
    // blocos 2x2 da mesma cor
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    }
    // padrões parecidos com o desenho dos cantos (1:1:3:1:1 com 4 claros de um lado)
    const lines = [];
    for (let a = 0; a < size; a++) {
      lines.push(m[a].map((c) => (c ? '1' : '0')).join(''));
      lines.push(m.map((row) => (row[a] ? '1' : '0')).join(''));
    }
    lines.forEach((line) => {
      ['10111010000', '00001011101'].forEach((p) => {
        for (let i = line.indexOf(p); i !== -1; i = line.indexOf(p, i + 1)) result += 40;
      });
    });
    // equilíbrio entre escuros e claros
    const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
    result += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
    return result;
  }

  function matrix(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const version = pickVersion(bytes.length);
    const size = 17 + 4 * version;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

    // linhas de sincronização
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    // três cantos de localização, com o espaço claro em volta
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    // padrões de alinhamento (menos onde bateriam nos cantos de localização)
    const pos = ALIGN[version];
    pos.forEach((py, i) => pos.forEach((px, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));

    const drawFormat = (mask) => {
      const bits = formatBits(mask);
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
      setFn(8, 7, bit(bits, 6));
      setFn(8, 8, bit(bits, 7));
      setFn(7, 8, bit(bits, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
      setFn(8, size - 8, true); // módulo escuro fixo
    };
    drawFormat(0); // reserva o lugar; o valor certo entra depois de escolher a máscara
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFn(a, b, bit(bits, i));
        setFn(b, a, bit(bits, i));
      }
    }

    // codewords em zigue-zague, de baixo para cima nas colunas da direita, em faixas de 2 colunas
    const codewords = interleave(buildData(bytes, version), version);
    let n = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // a coluna 6 é só sincronização
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!isFunction[y][x] && n < codewords.length * 8) {
            modules[y][x] = bit(codewords[n >>> 3], 7 - (n & 7));
            n++;
          }
        }
      }
    }

    // escolhe a máscara de menor penalidade
    const applyMask = (mask) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    };
    let best = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(mask);
      drawFormat(mask);
      const score = penalty(modules, size);
      if (score < bestScore) { best = mask; bestScore = score; }
      applyMask(mask); // desfaz
    }
    applyMask(best);
    drawFormat(best);
    return { size, version, modules, isFunction, mask: best };
  }

  function svg(text, { margin = 4, dark = '#000', light = '#fff' } = {}) {
    const { size, modules } = matrix(text);
    const path = [];
    modules.forEach((row, y) => row.forEach((on, x) => { if (on) path.push(`M${x + margin},${y + margin}h1v1h-1z`); }));
    const total = size + margin * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${total}" height="${total}" fill="${light}"/><path d="${path.join('')}" fill="${dark}"/></svg>`;
  }

  return { matrix, svg, internals: { M_TABLE, ALIGN, MASKS, rsDivisor, rsRemainder, formatBits, versionBits, dataCodewords } };
});
