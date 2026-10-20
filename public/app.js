(() => {
  'use strict';

  const LV = { fraco: 'Fraco', medio: 'Médio', bom: 'Bom' };
  const TOKEN_KEY = 'pelada_admin_token';
  const CODE_KEY = 'pelada_code';
  const keep = (key, v) => {
    try { if (v === undefined) return localStorage.getItem(key) || ''; v ? localStorage.setItem(key, v) : localStorage.removeItem(key); } catch { /* ignora */ }
    return '';
  };

  let state = null;
  let lastKey = '';
  let offset = 0; // relogio do servidor - relogio local
  let token = keep(TOKEN_KEY);
  let code = keep(CODE_KEY);
  let source = null; // SSE (servidor local)
  let realtimeCfg; // undefined: ainda não carregou; null: sem Supabase (usa SSE); senão { url, anonKey }
  let channel = null; // canal Realtime do Supabase
  let lastEndFetch = 0;
  let tab = 'jogo';
  let rankBy = 'goals';
  let search = '';

  // ---------- som: apito no início e no fim da partida ----------

  let soundOn = keep('pelada_sound') !== 'off';
  let audioCtx = null;

  // o navegador só libera áudio depois de um toque/clique; qualquer clique na página destrava
  function audio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function whistle(ctx, t0, dur) {
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator(); // trinado do apito
    const lfoGain = ctx.createGain();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 2900;
    lfo.frequency.value = 38;
    lfoGain.gain.value = 190;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.5, t0 + 0.02);
    gain.gain.setValueAtTime(0.5, t0 + dur - 0.05);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0); lfo.start(t0);
    osc.stop(t0 + dur); lfo.stop(t0 + dur);
  }

  function playSound(kind) {
    if (!soundOn) return;
    const ctx = audio();
    if (!ctx) return;
    const t = ctx.currentTime + 0.05;
    if (kind === 'start') whistle(ctx, t, 0.6); // um apito
    else if (kind === 'test') whistle(ctx, t, 0.25);
    else { whistle(ctx, t, 0.3); whistle(ctx, t + 0.4, 0.3); whistle(ctx, t + 0.8, 0.9); } // fim: três apitos
  }

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAdmin = () => !!(state && state.admin);
  const player = (id) => state.players.find((p) => p.id === id);

  // ---------- rede ----------

  const qs = () => `code=${encodeURIComponent(code)}`;

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro inesperado');
    return data;
  }

  async function act(method, url, body) {
    try {
      setState(await api(method, `${url}?${qs()}`, body));
      return true;
    } catch (e) {
      toast(e.message, true);
      if (/restrito ao administrador/.test(e.message)) logout();
      return false;
    }
  }
  const post = (url, body) => act('POST', url, body);

  function setState(s) {
    offset = s.now ? s.now - Date.now() : offset;
    const before = state && state.session && state.session.match;
    const after = s.session && s.session.match;
    if (before && after && before.id === after.id) {
      if (before.status === 'idle' && after.status === 'running') playSound('start');
      else if (before.status !== 'finished' && after.status === 'finished') playSound('end');
    }
    const key = JSON.stringify({ ...s, now: 0 });
    if (key === lastKey) return; // nada mudou: não redesenha (evita perder cliques)
    lastKey = key;
    state = s;
    render();
  }

  const loadScript = (src) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = reject;
    document.head.appendChild(el);
  });

  async function fetchState() {
    try { setState(await api('GET', `/api/state?${qs()}`)); } catch { /* tenta de novo no próximo ciclo */ }
  }

  // Produção: o Supabase Realtime só avisa "algo mudou" e cada celular pede o estado à API (que valida o código).
  // Servidor local: SSE. Nos dois casos há polling de segurança.
  async function connect() {
    if (realtimeCfg === undefined) {
      try { realtimeCfg = (await api('GET', '/api/config')).realtime || null; } catch { realtimeCfg = null; }
    }
    if (!realtimeCfg) {
      if (source) source.close();
      source = new EventSource(`/api/stream?${qs()}${token ? '&token=' + encodeURIComponent(token) : ''}`);
      source.onmessage = (e) => setState(JSON.parse(e.data));
      return;
    }
    if (channel) return; // o canal é o mesmo para todos, não depende do código nem do login
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js');
      const client = window.supabase.createClient(realtimeCfg.url, realtimeCfg.anonKey);
      channel = client.channel('pelada').on('broadcast', { event: 'changed' }, fetchState).subscribe();
    } catch { /* sem tempo real: o polling mantém a tela atualizada */ }
  }

  async function refresh() {
    await connect();
    await fetchState();
  }

  setInterval(() => { if (realtimeCfg) fetchState(); }, 10000);

  function logout() {
    token = ''; code = '';
    keep(TOKEN_KEY, ''); keep(CODE_KEY, '');
    tab = 'jogo';
    lastKey = '';
    refresh();
  }

  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 4000);
  }

  // ---------- modal (inclui confirmação própria: confirm() nativo falha em vários navegadores) ----------

  function openModal(html) {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet">${html}</div>`;
    m.hidden = false;
    m.onclick = (e) => { if (e.target === m) closeModal(); };
    return $('.sheet', m);
  }
  const closeModal = () => { $('#modal').hidden = true; $('#modal').innerHTML = ''; };

  function ask(message, okLabel = 'Confirmar') {
    return new Promise((resolve) => {
      const sheet = openModal(`<h3>${esc(message)}</h3><div class="row">
        <button class="btn grow" id="no">Cancelar</button><button class="btn primary grow" id="yes">${esc(okLabel)}</button></div>`);
      $('#no', sheet).onclick = () => { closeModal(); resolve(false); };
      $('#yes', sheet).onclick = () => { closeModal(); resolve(true); };
    });
  }

  // ---------- partes de UI ----------

  const levelChip = (p) => (isAdmin() && p.level ? `<span class="chip lv-${p.level}">${LV[p.level]}</span>` : '');
  const gkChip = (p) => (p.position === 'gol' ? '<span class="chip pos" title="Goleiro">🧤</span>' : '');
  const shortName = (t) => t.name.replace(/^Time /, '');
  const fmt = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmtGoalTime = (ms) => `${Math.floor(ms / 60000) + 1}'`;
  const score = (m, teamId) => m.goals.filter((g) => g.teamId === teamId).length;

  function remainingMs() {
    const m = state.session.match;
    const total = state.config.matchSeconds * 1000;
    const el = m.elapsedMs + (m.startedAt ? Date.now() + offset - m.startedAt : 0);
    return Math.max(0, total - el);
  }

  function adminButtons(p) {
    return isAdmin() ? `<button class="btn icon sm" title="Não vai jogar / saiu: vai para o fim da fila" data-act="back" data-id="${p.id}">↧</button>
      <button class="btn icon sm danger" title="Tirar do futebol" data-act="remove" data-id="${p.id}">✕</button>` : '';
  }

  // ---------- views ----------

  function viewLanding() {
    return `<section class="card"><h2>Entrar na pelada</h2>
        <p class="muted">${code ? esc(state.message || '') + ' ' : ''}Digite o código que o organizador passou. O ranking pode ser visto sem código, na aba Ranking.</p>
        <form id="codeForm" class="row"><input class="search grow" name="code" placeholder="Código (ex.: K7X2M)" autocapitalize="characters" autocomplete="off" value="${esc(code)}">
        <button class="btn primary">Entrar</button></form></section>
      <section class="card"><h2>👑 Sou o administrador</h2>
        <form id="loginForm" class="row"><input class="search grow" name="password" type="password" placeholder="Senha do admin" autocomplete="current-password">
        <button class="btn">Entrar</button></form></section>`;
  }

  function viewNoPelada() {
    return `<section class="card center"><h2>Nenhuma pelada em andamento</h2>
      <p class="muted">Ao iniciar, o sistema gera um código para os jogadores acompanharem pelo celular.</p>
      <button class="btn primary big" data-act="startpelada">▶ Iniciar pelada</button></section>`;
  }

  function codeBanner() {
    return isAdmin() ? `<div class="card row spread"><div><div class="muted">Código para os espectadores</div><div class="code">${esc(state.session.code || '—')}</div></div>
      <button class="btn sm" data-act="copycode">Copiar</button></div>` : '';
  }

  function viewLobby() {
    const s = state.session;
    const ts = state.config.teamSize;
    const list = s.arrivals.map(player).filter(Boolean).map((p, i) => `
      <li><span class="muted">${i + 1}.</span><span class="nm">${esc(p.name)}</span>${gkChip(p)}
        ${adminButtons(p)}</li>`).join('');
    const missing = Math.max(0, ts * 2 - s.arrivals.length);
    return `${codeBanner()}<section class="card">
      <h2>Chegada dos jogadores (${s.arrivals.length})</h2>
      <p class="muted">Os ${ts * 2} primeiros a chegar jogam a primeira partida: eles são sorteados em 2 times equilibrados. Goleiro é só informação do cadastro e não entra na pelada. Quem chegar depois espera na fila, por ordem de chegada.</p>
      <ul class="plist">${list || '<li class="empty">Ninguém chegou ainda</li>'}</ul>
      ${isAdmin() ? `<div class="row wrap" style="margin-top:12px">
        <button class="btn" data-act="arrive">＋ Jogador chegou</button>
        <button class="btn primary grow" data-act="draw" ${missing ? 'disabled' : ''}>🎲 ${missing ? `Faltam ${missing} para sortear` : 'Sortear times'}</button></div>` : '<p class="muted center">Aguardando o sorteio…</p>'}
    </section>`;
  }

  // selos do ranking: coroa (mais participações), bola de ouro (mais gols) e chuteira de ouro (mais assistências)
  function badges(id) {
    const rows = state.ranking || [];
    const r = rows.find((x) => x.id === id);
    if (!r) return '';
    const top = (f) => Math.max(0, ...rows.map(f));
    let html = '';
    if (top((x) => x.goals + x.assists) > 0 && r.goals + r.assists === top((x) => x.goals + x.assists)) html += '<span class="bdg crown" title="Mais participações em gols">👑</span>';
    if (top((x) => x.goals) > 0 && r.goals === top((x) => x.goals)) html += '<span class="bdg gold" title="Bola de ouro: artilheiro">⚽</span>';
    if (top((x) => x.assists) > 0 && r.assists === top((x) => x.assists)) html += '<span class="bdg gold" title="Chuteira de ouro: mais assistências">👟</span>';
    return html;
  }

  function tiebreakBox(a, b, mandatory, bothOut) {
    const pick = (t, cls) => `<button class="btn ${cls}" style="border-color:${t.color}" data-act="nextwin" data-team="${t.id}"><span class="dot" style="--tc:${t.color}"></span> ${esc(shortName(t))} ganhou</button>`;
    return mandatory
      ? `<div class="banner">🤝 ${bothOut
        ? 'Empate com muita gente esperando: os dois times saem. Defina qual time ganhou: ele entra na fila primeiro, na ordem em que estava, e o outro time vem depois. Entram o próximo time e o time de ré.'
        : 'Empate! Defina qual time ganhou. O time que perder vai para o fim da fila e completa o time de ré.'}</div>
         <div class="controls">${pick(a, 'big')}${pick(b, 'big')}</div>`
      : `<div class="banner">🤝 Empate: sai o time desafiante.</div>
         <div class="controls"><button class="btn primary big" data-act="next">Próxima partida ▶</button></div>
         <div class="controls"><span class="muted">ou defina o vencedor:</span>${pick(a, 'sm')}${pick(b, 'sm')}</div>`;
  }

  function lineup(t, role) {
    const ts = state.config.teamSize;
    const items = t.players.map(player).filter(Boolean).map((p) => `
      <li><span class="nm">${badges(p.id)}${esc(p.name)}</span>${gkChip(p)}${adminButtons(p)}</li>`).join('');
    return `<div class="lineup" style="--tc:${t.color}">
      <div class="lh"><span class="dot"></span><b>${esc(shortName(t))}</b><span class="cnt ${t.players.length < ts ? 'warn' : ''}">${t.players.length}/${ts}</span></div>
      <ul class="plist">${items || '<li class="empty">Sem jogadores</li>'}</ul></div>`;
  }

  function eventList(m, teams) {
    const rows = m.goals.map((g) => `<li class="ev" style="--tc:${(teams.find((t) => t.id === g.teamId) || {}).color}">
      <span class="ev-min">${fmtGoalTime(g.ms)}</span><span class="ev-ball">⚽</span>
      <div class="ev-main"><div><b>${esc(g.scorerName)}</b> <span class="ev-team">${esc(g.teamName.replace(/^Time /, ''))}</span></div>
        <div class="ev-assist ${g.assistName ? '' : 'none'}">${g.assistName ? `🅰 Assistência: <b>${esc(g.assistName)}</b>` : 'Sem assistência'}</div></div>
      ${isAdmin() ? `<button class="btn icon sm danger" title="Desfazer gol" data-act="undo" data-id="${g.id}">↶</button>` : ''}</li>`).join('');
    return rows ? `<ul class="events">${rows}</ul>` : '';
  }

  function viewPitch() {
    const s = state.session;
    const m = s.match;
    const [a, b] = s.teams;
    const cfg = state.config;
    if (!a || !b) {
      return `<section class="card center"><h2>Faltam times</h2><p class="muted">Marque a chegada de mais jogadores.</p>
        ${isAdmin() ? '<button class="btn" data-act="arrive">＋ Jogador chegou</button>' : ''}</section>`;
    }
    const sa = score(m, a.id);
    const sb = score(m, b.id);
    const live = m.status === 'running' || m.status === 'paused';
    const label = { idle: 'Aguardando início', running: 'Ao vivo', paused: 'Pausado', finished: 'Fim de jogo' }[m.status];
    const reason = { gols: 'por gols', tempo: 'por tempo', manual: 'encerrada pelo árbitro' }[m.reason] || '';
    const draw = m.status === 'finished' && sa === sb;
    const winner = m.status === 'finished' ? (sa > sb ? a : sb > sa ? b : null) : null;
    const full = a.players.length >= cfg.teamSize && b.players.length >= cfg.teamSize;

    const goalBtn = (t) => (isAdmin() && live
      ? `<button class="goalbtn" style="--tc:${t.color}" data-act="goal" data-team="${t.id}">⚽ Gol ${esc(shortName(t))}</button>` : '<span></span>');

    const buttons = !isAdmin() ? '' : {
      idle: `<button class="btn primary big" data-act="start" ${full ? '' : 'disabled'}>▶ Iniciar partida</button>${full ? '' : '<div class="muted center grow-all">Cada time precisa de ' + cfg.teamSize + ' jogadores. Marque a chegada de mais gente.</div>'}`,
      running: '<button class="btn big" data-act="pausematch">⏸ Pausar</button><button class="btn danger big" data-act="finish">⏹ Encerrar</button>',
      paused: '<button class="btn primary big" data-act="resume">▶ Retomar</button><button class="btn danger big" data-act="finish">⏹ Encerrar</button>',
      finished: draw ? '' : '<button class="btn primary big" data-act="next">Próxima partida ▶</button>',
    }[m.status];

    let result = '';
    if (m.status === 'finished') {
      if (draw) result = isAdmin() ? tiebreakBox(a, b, s.needsTiebreak || s.bothOut, s.bothOut) : '<div class="banner">🤝 Empate! O organizador vai definir quem segue.</div>';
      else result = `<div class="banner">🏆 ${esc(winner.name)} venceu e fica em campo</div>`;
    }

    return `<section class="pitch">
      <div class="pitch-head"><span class="live-tag ${m.status}"><i></i>${label}${m.status === 'finished' && reason ? ' · ' + reason : ''}</span>
        <span class="rule">1º a ${cfg.goalsToWin} gols ou ${Math.round(cfg.matchSeconds / 60)} min</span></div>
      <div class="scorebug">
        <div class="sb-side left" style="--tc:${a.color}"><span class="sb-name">${esc(shortName(a))}</span><span class="sb-score">${sa}</span></div>
        <div class="sb-clock"><span id="timer">${fmt(remainingMs())}</span></div>
        <div class="sb-side right" style="--tc:${b.color}"><span class="sb-score">${sb}</span><span class="sb-name">${esc(shortName(b))}</span></div>
      </div>
      ${isAdmin() && live ? `<div class="goalrow">${goalBtn(a)}${goalBtn(b)}</div>` : ''}
      ${result}
      <div class="controls">${buttons}</div>
      ${eventList(m, s.teams)}
      <div class="lineups">${lineup(a)}${lineup(b)}</div>
    </section>`;
  }

  function viewBench() {
    const s = state.session;
    const ts = state.config.teamSize;
    const chunks = [];
    for (let i = 0; i < s.queue.length; i += ts) chunks.push(s.queue.slice(i, i + ts));
    const label = (i) => ['Próximo time', 'Time de ré', ''][i] || `Fila ${i + 1}`;
    let n = 0;
    const body = chunks.map((ids, i) => `<div class="chunk ${i === 0 ? 'next' : ''}">
      <div class="lh"><b>${label(i)}</b>${i === 0 ? '<span class="role">entra na próxima partida</span>' : ''}
        <span class="cnt ${ids.length < ts ? 'warn' : ''}">${ids.length}/${ts}</span></div>
      <ul class="plist">${ids.map((id) => {
    const p = player(id);
    n++;
    return p ? `<li><span class="pos-n">${n}</span><span class="nm">${badges(p.id)}${esc(p.name)}</span>${gkChip(p)}${adminButtons(p)}</li>` : '';
  }).join('')}</ul></div>`).join('');
    return `<section class="bench"><div class="bench-head"><h2>⏳ Fila de espera</h2><span class="muted">por ordem de chegada</span></div>
      ${body || '<p class="empty">Ninguém esperando. Quem chegar entra aqui.</p>'}</section>`;
  }

  function viewGame() {
    const s = state.session;
    if (!s || s.status === 'none') return isAdmin() ? viewNoPelada() : viewLanding();
    if (s.status === 'lobby') return viewLobby();
    return `${codeBanner()}${viewPitch()}${viewBench()}
      ${isAdmin() ? `<div class="row wrap">
        <button class="btn grow" data-act="arrive">＋ Jogador chegou</button>
        ${s.matchesPlayed === 0 && s.match.status === 'idle' ? '<button class="btn" data-act="redraw">🔄 Refazer sorteio</button>' : ''}</div>` : ''}`;
  }

  const RANKS = { goals: ['⚽ Gols', 'goals'], assists: ['🅰 Assist.', 'assists'], part: ['🔥 Particip.', 'part'] };

  function viewRanking() {
    const rows = state.ranking
      .map((r) => ({ ...r, part: r.goals + r.assists }))
      .filter((r) => r[rankBy] > 0)
      .sort((x, y) => y[rankBy] - x[rankBy] || y.goals - x.goals || y.assists - x.assists || x.name.localeCompare(y.name, 'pt-BR'));
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || i + 1;
    const items = rows.map((r, i) => `<li class="rk-row ${i < 3 ? 'top' + (i + 1) : ''}">
      <span class="rk-pos">${medal(i)}</span>
      <span class="rk-name"><span class="rk-n">${badges(r.id)}${esc(r.name)}</span><small>⚽ ${r.goals} gol${r.goals === 1 ? '' : 's'} · 🅰 ${r.assists} assist.</small></span>
      <span class="rk-val">${r[rankBy]}</span></li>`).join('');
    const hint = { goals: 'Total de gols na temporada.', assists: 'Total de assistências na temporada.', part: 'Participações = gols + assistências.' }[rankBy];
    return `<section class="card"><h2>🏆 Ranking · temporada ${state.season}</h2>
      <div class="seg">${Object.entries(RANKS).map(([k, [l2]]) => `<button data-act="rank" data-by="${k}" class="${rankBy === k ? 'on' : ''}">${l2}</button>`).join('')}</div>
      ${rows.length ? `<ol class="rk">${items}</ol><p class="muted" style="margin:10px 0 0;font-size:.8rem">${hint}</p>
        <p class="muted" style="margin:6px 0 0;font-size:.78rem"><span class="bdg gold">⚽</span> bola de ouro (mais gols) · <span class="bdg gold">👟</span> chuteira de ouro (mais assistências) · <span class="bdg crown">👑</span> coroa (mais participações)</p>`
        : '<p class="muted center">Ainda sem registros nesta temporada.</p>'}</section>`;
  }

  function playerStatus(p) {
    const s = state.session;
    if (p.position === 'gol') return { key: 'gk', text: 'Goleiro · só informação, não entra na pelada' };
    const t = s.teams.find((x) => x.players.includes(p.id));
    if (t) return { key: 'team', text: `Em campo · ${t.name}` };
    const q = s.queue.indexOf(p.id);
    if (q >= 0) return { key: 'queue', text: `Na fila · ${q + 1}º a entrar` };
    if (s.arrivals.includes(p.id)) return { key: 'lobby', text: `Chegou (${s.arrivals.indexOf(p.id) + 1}º)` };
    return { key: 'out', text: 'Não está no futebol' };
  }

  function viewPlayers() {
    const running = state.session.status !== 'none';
    const rows = state.players.map((p) => {
      const st = playerStatus(p);
      const out = st.key === 'out' || st.key === 'gk';
      const btns = st.key === 'gk' ? '' : out
        ? (running ? `<button class="btn sm primary" data-act="checkin" data-id="${p.id}">Chegou</button>` : '')
        : `<button class="btn sm" data-act="back" data-id="${p.id}">↧ Fim da fila</button><button class="btn sm danger" data-act="remove" data-id="${p.id}">Sair</button>`;
      return `<div class="prow" data-name="${esc(p.name.toLowerCase())}">
        <div class="info"><b>${esc(p.name)}</b> ${gkChip(p)}${levelChip(p)}<div class="st">${esc(running || st.key === 'gk' ? st.text : '')}</div></div>
        ${btns}<button class="btn icon sm" title="Editar" data-act="editplayer" data-id="${p.id}">✏️</button>
        <button class="btn icon sm danger" title="Excluir cadastro" data-act="delplayer" data-id="${p.id}">🗑</button></div>`;
    }).join('');
    return `<section class="card">
      <div class="row spread" style="margin-bottom:10px"><h2 style="margin:0">Jogadores (${state.players.length})</h2>
        <button class="btn primary" data-act="addplayer">＋ Novo</button></div>
      ${running ? '' : '<p class="muted">Inicie uma pelada na aba Jogo para marcar chegadas.</p>'}
      <input class="search" id="search" placeholder="Buscar jogador…" value="${esc(search)}">
      <div id="plist">${rows || '<p class="muted center">Cadastre os jogadores para começar.</p>'}</div></section>`;
  }

  function viewAdmin() {
    const c = state.config;
    return `<section class="card"><h2>Pelada de hoje</h2>
      ${state.session.status === 'none'
        ? '<button class="btn primary" data-act="startpelada">▶ Iniciar pelada</button>'
        : `<p class="muted">Código atual: <b>${esc(state.session.code)}</b>. Ao encerrar, os times e a fila são desmontados e o código deixa de funcionar. Gols e assistências continuam na temporada.</p>
           <button class="btn danger" data-act="endpelada">Encerrar pelada</button>`}</section>
      <section class="card"><h2>Regras da partida</h2>
      <form id="cfg"><div class="field"><label>Duração (segundos)</label><input name="matchSeconds" type="number" value="${c.matchSeconds}"></div>
      <div class="field"><label>Gols para encerrar</label><input name="goalsToWin" type="number" value="${c.goalsToWin}"></div>
      <div class="field"><label>Jogadores por time (com goleiro)</label><input name="teamSize" type="number" value="${c.teamSize}"></div>
      <button class="btn primary">Salvar regras</button></form></section>
      <section class="card"><h2>Temporada ${state.season}</h2>
      <p class="muted">Apaga todos os gols, assistências e o histórico de partidas para começar uma nova temporada. Os jogadores cadastrados são mantidos.</p>
      <button class="btn danger" data-act="resetseason">Começar nova temporada</button></section>`;
  }

  // ---------- render ----------

  function render() {
    if (!state) return;
    const locked = !!state.locked;
    $('#season').textContent = `temporada ${state.season}`;
    $('#sound').textContent = soundOn ? '🔊' : '🔇';
    $('#auth').hidden = locked;
    $('#auth').textContent = isAdmin() ? '👑 Sair' : '↩ Sair';

    const tabs = [['jogo', locked ? '⚽ Entrar' : '⚽ Jogo'], ['ranking', '🏆 Ranking']];
    if (isAdmin()) tabs.push(['jogadores', '👥 Jogadores'], ['admin', '⚙️ Admin']);
    if (!tabs.some(([k]) => k === tab)) tab = 'jogo';
    $('#tabs').innerHTML = tabs.map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('');

    if (!locked && (!state.session || !Array.isArray(state.session.queue) || Array.isArray(state.session.gkQueue)) && tab !== 'ranking') {
      $('#main').innerHTML = `<section class="card"><h2>⚠️ Servidor desatualizado</h2>
        <p class="muted">O servidor está rodando uma versão antiga do sistema. No terminal onde ele está aberto, pare com <b>Ctrl+C</b> e rode <b>npm start</b> de novo (ou use <b>npm run dev</b>, que reinicia sozinho). Seus dados são mantidos.</p></section>`;
      return;
    }
    const views = { jogo: locked ? viewLanding : viewGame, ranking: viewRanking, jogadores: viewPlayers, admin: viewAdmin };
    $('#main').innerHTML = views[tab]();
    applySearch();
  }

  function applySearch() {
    const q = search.trim().toLowerCase();
    document.querySelectorAll('#plist .prow').forEach((r) => { r.hidden = !!q && !r.dataset.name.includes(q); });
  }

  setInterval(() => {
    const el = $('#timer');
    if (!el || !state || state.locked) return;
    const ms = remainingMs();
    el.textContent = fmt(ms);
    el.classList.toggle('low', ms <= 60000 && state.session.match.status === 'running');
    // o tempo acabou: pede o estado para pegar o fim de jogo (o servidor encerra a partida ao ler)
    if (ms === 0 && state.session.match.status === 'running' && Date.now() - lastEndFetch > 2000) {
      lastEndFetch = Date.now();
      fetchState();
    }
  }, 250);

  // ---------- modais de acao ----------

  function playerModal(p) {
    const sheet = openModal(`<h3>${p ? 'Editar jogador' : 'Novo jogador'}</h3>
      <form id="pf"><div class="field"><label>Nome</label><input name="name" maxlength="40" value="${esc(p?.name || '')}" required autofocus></div>
      <div class="field"><label>Nível (só o admin vê)</label><select name="level">${Object.entries(LV).map(([k, v]) => `<option value="${k}" ${p?.level === k || (!p && k === 'medio') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>Posição</label><select name="position"><option value="linha" ${p?.position !== 'gol' ? 'selected' : ''}>Linha</option><option value="gol" ${p?.position === 'gol' ? 'selected' : ''}>Gol</option></select></div>
      <div class="row"><button type="button" class="btn grow" data-act="close">Cancelar</button><button class="btn primary grow">Salvar</button></div></form>`);
    $('form', sheet).onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (await act(p ? 'PUT' : 'POST', p ? `/api/players/${p.id}` : '/api/players', body)) closeModal();
    };
  }

  // gol em dois toques: 1) quem fez o gol  2) quem deu a assistência (ou "sem assistência")
  function goalModal(teamId) {
    const t = state.session.teams.find((x) => x.id === teamId);
    const ps = t.players.map(player).filter(Boolean);
    const grid = (list, act) => `<div class="pgrid">${list.map((p) => `<button type="button" class="pbtn" data-pid="${p.id}" style="--tc:${t.color}">
      <span class="avatar">${esc(p.name.trim()[0] || '?').toUpperCase()}</span><span class="pn">${esc(p.name)}</span>${gkChip(p)}</button>`).join('')}</div>`;
    const head = (icon, title, sub) => `<div class="gm-head" style="--tc:${t.color}"><span class="gm-ball">${icon}</span><div><h3>${title}</h3><div class="muted">${sub}</div></div></div>`;

    const stepScorer = () => {
      const sheet = openModal(`${head('⚽', `Gol do ${esc(shortName(t))}`, 'Quem fez o gol?')}${grid(ps)}
        <button type="button" class="btn" style="width:100%" data-act="close">Cancelar</button>`);
      sheet.querySelectorAll('.pbtn').forEach((b) => { b.onclick = () => stepAssist(player(b.dataset.pid)); });
    };

    const stepAssist = (scorer) => {
      const sheet = openModal(`${head('🅰', `${esc(scorer.name)} marcou!`, 'Quem deu a assistência?')}${grid(ps.filter((p) => p.id !== scorer.id))}
        <button type="button" class="btn big" id="noassist" style="width:100%;margin-top:10px">Sem assistência</button>
        <button type="button" class="btn ghost" id="backstep" style="width:100%;margin-top:6px">← Voltar</button>`);
      const save = async (assist) => {
        if (await post('/api/match/goal', { teamId, scorerId: scorer.id, assistId: assist ? assist.id : null })) {
          closeModal();
          toast(`⚽ Gol de ${scorer.name}${assist ? ` · assistência de ${assist.name}` : ''}`);
        }
      };
      sheet.querySelectorAll('.pbtn').forEach((b) => { b.onclick = () => save(player(b.dataset.pid)); });
      $('#noassist', sheet).onclick = () => save(null);
      $('#backstep', sheet).onclick = stepScorer;
    };
    stepScorer();
  }

  function arriveModal() {
    const s = state.session;
    const here = new Set([...s.arrivals, ...s.queue, ...s.teams.flatMap((t) => t.players)]);
    const free = state.players.filter((p) => !here.has(p.id) && p.position !== 'gol');
    const sheet = openModal(`<h3>Quem chegou?</h3>${free.length ? `
      <input class="search" id="arriveSearch" placeholder="Buscar jogador pelo nome…" autocomplete="off" style="margin-bottom:10px">
      <div class="pick" id="arriveList">${free.map((p) => `
      <label data-act="checkin" data-id="${p.id}" data-keep="1" data-name="${esc(p.name.toLowerCase())}"><span class="grow">${esc(p.name)}</span>${gkChip(p)}</label>`).join('')}</div>
      <p class="muted center" id="arriveEmpty" hidden>Nenhum jogador encontrado.</p>`
      : '<p class="muted">Todos os jogadores cadastrados já estão na pelada.</p>'}
      <button class="btn" style="width:100%" data-act="close">Fechar</button>`);
    const input = $('#arriveSearch', sheet);
    if (!input) return;
    input.focus();
    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      sheet.querySelectorAll('#arriveList label').forEach((l) => {
        l.hidden = !!q && !l.dataset.name.includes(q);
        if (!l.hidden) shown++;
      });
      $('#arriveEmpty', sheet).hidden = shown > 0;
    };
    // Enter marca o primeiro resultado visível
    input.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = [...sheet.querySelectorAll('#arriveList label')].find((l) => !l.hidden);
      if (first) first.click();
    };
  }

  // ---------- eventos ----------

  const pname = (el) => (player(el.dataset.id) || {}).name || 'jogador';
  const actions = {
    close: closeModal,
    sound: () => {
      soundOn = !soundOn;
      keep('pelada_sound', soundOn ? '' : 'off');
      $('#sound').textContent = soundOn ? '🔊' : '🔇';
      if (soundOn) playSound('test');
      toast(soundOn ? 'Som ligado: apito no início e no fim da partida' : 'Som desligado');
    },
    auth: async () => { if (await ask('Sair?', 'Sair')) logout(); },
    tab: (el) => { tab = el.dataset.tab; render(); },
    rank: (el) => { rankBy = el.dataset.by; render(); },
    startpelada: () => post('/api/session/start'),
    endpelada: async () => { if (await ask('Encerrar a pelada? Os times e o código serão apagados.', 'Encerrar')) post('/api/session/end'); },
    copycode: () => { navigator.clipboard?.writeText(state.session.code).then(() => toast('Código copiado'), () => toast(state.session.code)); },
    arrive: arriveModal,
    checkin: async (el) => {
      const ok = await post('/api/session/checkin', { playerId: el.dataset.id });
      if (ok && el.dataset.keep) el.remove(); // no seletor, o jogador some da lista e o modal continua aberto
    },
    draw: () => post('/api/session/draw'),
    redraw: async () => { if (await ask('Desfazer os times e voltar para a lista de chegada?', 'Refazer')) post('/api/session/redraw'); },
    start: () => post('/api/match/start'),
    pausematch: () => post('/api/match/pause'),
    resume: () => post('/api/match/resume'),
    finish: async () => { if (await ask('Encerrar a partida agora?', 'Encerrar')) post('/api/match/finish'); },
    next: () => post('/api/match/next', {}),
    nextwin: (el) => post('/api/match/next', { winnerTeamId: el.dataset.team }),
    goal: (el) => goalModal(el.dataset.team),
    undo: async (el) => { if (await ask('Desfazer este gol?', 'Desfazer')) act('DELETE', `/api/match/goals/${el.dataset.id}`); },
    back: (el) => post(`/api/session/players/${el.dataset.id}/back`),
    remove: async (el) => { if (await ask(`Tirar ${pname(el)} do futebol de hoje?`, 'Tirar')) post(`/api/session/players/${el.dataset.id}/remove`); },
    addplayer: () => playerModal(null),
    editplayer: (el) => playerModal(player(el.dataset.id)),
    delplayer: async (el) => { if (await ask(`Excluir o cadastro de ${pname(el)}? Os gols dele continuam no ranking.`, 'Excluir')) act('DELETE', `/api/players/${el.dataset.id}`); },
    resetseason: async () => { if (await ask('Apagar TODOS os gols, assistências e partidas da temporada?', 'Apagar tudo')) post('/api/season/reset'); },
  };

  document.addEventListener('pointerdown', () => { if (soundOn) audio(); });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') { search = e.target.value; applySearch(); }
  });
  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (!['cfg', 'codeForm', 'loginForm'].includes(f.id)) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    if (f.id === 'cfg') {
      if (await act('PUT', '/api/config', data)) toast('Regras salvas');
    } else if (f.id === 'codeForm') {
      code = String(data.code || '').trim().toUpperCase();
      keep(CODE_KEY, code);
      lastKey = '';
      await refresh();
      if (state && state.locked) toast(state.message, true);
    } else {
      try {
        token = (await api('POST', '/api/login', { password: data.password })).token;
        keep(TOKEN_KEY, token);
        lastKey = '';
        await refresh();
        toast('Modo administrador ativado');
      } catch (err) { toast(err.message, true); }
    }
  });

  refresh();
})();
