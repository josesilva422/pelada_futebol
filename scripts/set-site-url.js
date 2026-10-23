'use strict';
// Roda no deploy do Netlify (netlify.toml > build.command). A imagem de pré-visualização do link (og:image) precisa de
// endereço completo para o WhatsApp e outros apps mostrarem; no HTML ela é relativa (/og-image.png), então aqui
// colocamos o endereço do site na frente. Se não houver endereço (rodando local), não muda nada. Nunca derruba o deploy.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'index.html');

function inject(html, site) {
  const base = String(site || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return html;
  return html.replace(/(<meta property="og:image" content=")\/(?!\/)/, `$1${base}/`);
}

if (require.main === module) {
  try {
    const site = process.env.SITE_URL || process.env.URL;
    const html = fs.readFileSync(FILE, 'utf8');
    const next = inject(html, site);
    if (next !== html) {
      fs.writeFileSync(FILE, next);
      console.log(`og:image agora aponta para ${site}`);
    } else {
      console.log('og:image mantido (sem URL do site no ambiente)');
    }
  } catch (e) {
    console.log('set-site-url ignorado:', e.message);
  }
}

module.exports = { inject };
