'use strict';
// Gera os ícones do site e a imagem de pré-visualização do link (os arquivos prontos ficam em public/ e vão no Git).
// Só precisa rodar de novo se o desenho mudar:  node scripts/make-icons.js
// Sem dependências: desenha a bola com testes geométricos, suaviza com supersampling e grava PNG/ICO/SVG na mão.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');
const DEG = Math.PI / 180;
const PATCH = [20, 38, 28]; // gomos e costuras da bola
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// ---------- geometria da bola ----------

const polygon = (cx, cy, r, rot) => Array.from({ length: 5 }, (_, k) => [cx + r * Math.cos((rot + 72 * k) * DEG), cy + r * Math.sin((rot + 72 * k) * DEG)]);

function inPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// bola de centro (cx, cy) e raio R: gomo central, 5 costuras e 5 gomos na borda
function makeBall(cx, cy, R) {
  const center = polygon(cx, cy, 0.317 * R, -90);
  const seams = Array.from({ length: 5 }, (_, k) => {
    const a = (-90 + 72 * k) * DEG;
    return [cx + 0.317 * R * Math.cos(a), cy + 0.317 * R * Math.sin(a), cx + R * Math.cos(a), cy + R * Math.sin(a)];
  });
  const outer = Array.from({ length: 5 }, (_, k) => {
    const b = -54 + 72 * k;
    return polygon(cx + R * Math.cos(b * DEG), cy + R * Math.sin(b * DEG), 0.283 * R, b + 180);
  });
  return {
    cx, cy, R, center, seams, outer,
    color(x, y) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) return null;
      if (d > R - 0.045 * R) return PATCH; // contorno
      if (inPolygon(center, x, y) || outer.some((p) => inPolygon(p, x, y))) return PATCH;
      if (seams.some(([x1, y1, x2, y2]) => distToSegment(x, y, x1, y1, x2, y2) < 0.02 * R)) return PATCH;
      const shade = clamp(0.5 * (d / R) ** 2 + 0.12 * ((dx + dy) / (1.4 * R))); // mais escura para baixo e para a direita
      return mix([255, 255, 255], [185, 202, 193], shade);
    },
  };
}

// sombra suave embaixo da bola (escurece o fundo)
const shadowFactor = (x, y, b) => 1 - 0.38 * Math.exp(-(((x - b.cx) / (0.85 * b.R)) ** 2 + ((y - (b.cy + 1.0 * b.R)) / (0.15 * b.R)) ** 2));

// ---------- imagens ----------

function render(w, h, paint, ss = 4) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const c = paint(px + (i + 0.5) / ss, py + (j + 0.5) / ss);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (py * w + px) * 3;
      rgb[o] = Math.round(r / ss ** 2); rgb[o + 1] = Math.round(g / ss ** 2); rgb[o + 2] = Math.round(b / ss ** 2);
    }
  }
  return rgb;
}

// ícone quadrado, sem cantos arredondados (o sistema recorta); a bola fica na área segura central
function iconPainter(S) {
  const ball = makeBall(0.5 * S, 0.48 * S, 0.3 * S);
  return (x, y) => {
    const t = clamp(Math.hypot(x - 0.35 * S, y - 0.28 * S) / (0.95 * S));
    let c = mix([52, 194, 122], [14, 90, 49], t);
    c = c.map((v) => v * shadowFactor(x, y, ball));
    return ball.color(x, y) || c;
  };
}

// campo com a bola no centro, para a pré-visualização do link (sem texto: o título e a descrição vêm das tags)
function pitchPainter(W, H) {
  const ball = makeBall(W / 2, H / 2, 105);
  return (x, y) => {
    let c = Math.floor(x / 75) % 2 ? [26, 98, 56] : [29, 107, 61];
    const vignette = clamp((Math.hypot((x - W / 2) / (W / 2), (y - H / 2) / (H / 2)) - 0.55) / 0.6);
    c = c.map((v) => v * (1 - 0.5 * vignette));
    const ring = Math.abs(Math.hypot(x - W / 2, y - H / 2) - 175) < 3.5;
    const line = Math.abs(x - W / 2) < 3.5;
    if (ring || line) c = mix(c, [255, 255, 255], 0.55);
    c = c.map((v) => v * shadowFactor(x, y, ball));
    return ball.color(x, y) || c;
  };
}

// ---------- formatos de arquivo ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3); // filtro 0 em cada linha
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// .ico com um PNG dentro (aceito por todos os navegadores atuais)
function ico(size, pngData) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); // tipo: ícone
  head.writeUInt16LE(1, 4); // 1 imagem
  head[6] = size; head[7] = size;
  head.writeUInt16LE(1, 10); // planos
  head.writeUInt16LE(32, 12); // bits por pixel
  head.writeUInt32LE(pngData.length, 14);
  head.writeUInt32LE(22, 18); // onde a imagem começa
  return Buffer.concat([head, pngData]);
}

// SVG do ícone (cantos arredondados), com o mesmo desenho dos PNG
function iconSvg() {
  const S = 512;
  const ball = makeBall(0.5 * S, 0.48 * S, 0.3 * S);
  const pts = (poly) => poly.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const patch = hex(PATCH);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="bg" gradientUnits="userSpaceOnUse" cx="${0.35 * S}" cy="${0.28 * S}" r="${0.95 * S}"><stop offset="0" stop-color="${hex([52, 194, 122])}"/><stop offset="1" stop-color="${hex([14, 90, 49])}"/></radialGradient>
    <radialGradient id="ball" gradientUnits="userSpaceOnUse" cx="${ball.cx - 0.25 * ball.R}" cy="${ball.cy - 0.25 * ball.R}" r="${1.35 * ball.R}"><stop offset="0.35" stop-color="#ffffff"/><stop offset="1" stop-color="${hex([185, 202, 193])}"/></radialGradient>
    <clipPath id="disc"><circle cx="${ball.cx}" cy="${ball.cy}" r="${ball.R}"/></clipPath>
    <filter id="blur" x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <rect width="${S}" height="${S}" rx="${0.22 * S}" fill="url(#bg)"/>
  <ellipse cx="${ball.cx}" cy="${ball.cy + ball.R}" rx="${0.85 * ball.R}" ry="${0.15 * ball.R}" fill="#000" opacity="0.38" filter="url(#blur)"/>
  <circle cx="${ball.cx}" cy="${ball.cy}" r="${ball.R}" fill="url(#ball)"/>
  <g clip-path="url(#disc)" fill="${patch}" stroke="${patch}" stroke-width="${0.04 * ball.R}" stroke-linecap="round">
    <polygon points="${pts(ball.center)}" stroke="none"/>
    ${ball.outer.map((p) => `<polygon points="${pts(p)}" stroke="none"/>`).join('\n    ')}
    ${ball.seams.map(([x1, y1, x2, y2]) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" fill="none"/>`).join('\n    ')}
  </g>
  <circle cx="${ball.cx}" cy="${ball.cy}" r="${ball.R - 0.0225 * ball.R}" fill="none" stroke="${patch}" stroke-width="${0.045 * ball.R}"/>
</svg>
`;
}

function main() {
  const write = (name, data) => { fs.writeFileSync(path.join(OUT, name), data); console.log(`${name}: ${data.length} bytes`); };
  [192, 512, 180].forEach((s) => write(s === 180 ? 'apple-touch-icon.png' : `icon-${s}.png`, png(s, s, render(s, s, iconPainter(s)))));
  write('favicon.ico', ico(48, png(48, 48, render(48, 48, iconPainter(48), 6))));
  write('og-image.png', png(1200, 630, render(1200, 630, pitchPainter(1200, 630), 3)));
  write('icon.svg', Buffer.from(iconSvg()));
}

main();
