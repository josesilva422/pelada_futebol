'use strict';
const crypto = require('crypto');

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const LEVELS = { fraco: 1, medio: 2, bom: 3 };
const POSITIONS = ['gol', 'linha'];
// só os dois times em campo têm cor; quem espera não tem time formado
const PALETTE = [['Laranja', '#f2994a'], ['Verde', '#27ae60']];

const uid = () => crypto.randomBytes(5).toString('hex');
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------- estado inicial ----------

function newMatch() {
  return { id: uid(), status: 'idle', elapsedMs: 0, startedAt: null, teamIds: [], goals: [], reason: null };
}

function newSession() {
  return {
    id: null, // identifica a pelada: liga cada resultado de partida à pelada em que foi jogado
    status: 'none', // none (sem pelada) | lobby (chegada) | active (sorteio feito)
    code: null, // codigo que os espectadores usam para entrar
    arrivals: [], // ordem de chegada, antes do sorteio
    arrivalOrder: [],
    teams: [], // os dois times em campo (cada um com teamSize jogadores)
    queue: [], // fila de espera, por ordem de chegada
    matchesPlayed: 0,
    match: newMatch(),
    lastResult: null,
  };
}

function defaultDb() {
  return {
    secret: crypto.randomBytes(16).toString('hex'),
    season: 1,
    config: { matchSeconds: 420, goalsToWin: 2, teamSize: 5 },
    players: [],
    session: newSession(),
    events: [], // gols/assistencias da temporada
    matches: [], // historico de partidas da temporada
    loginGuard: {}, // tentativas de login erradas por endereço: { [ip]: { fails, until, last } }
  };
}

function normalizeDb(db) {
  const d = defaultDb();
  const out = { ...d, ...db, config: { ...d.config, ...(db.config || {}) }, session: { ...d.session, ...(db.session || {}) } };
  const s = out.session;
  // dados do modelo antigo: times de fila viram jogadores na fila; parados somem
  if (!Array.isArray(s.queue)) s.queue = [];
  if (s.teams.length > 2) {
    s.queue.push(...s.teams.slice(2).flatMap((t) => t.players));
    s.teams = s.teams.slice(0, 2);
  }
  // goleiro é só informação do cadastro: não participa de chegada, times nem fila
  const notGk = (id) => (out.players.find((p) => p.id === id) || {}).position !== 'gol';
  s.arrivals = s.arrivals.filter(notGk);
  s.queue = s.queue.filter(notGk);
  s.teams.forEach((t) => { t.players = t.players.filter(notGk); });
  refill(out);
  if (s.status !== 'none' && !s.id) s.id = uid(); // pelada criada antes de existir o id
  delete s.paused;
  delete s.gkQueue;
  delete s.teamCounter;
  return out;
}

// ---------- jogadores ----------

const playerById = (db, id) => db.players.find((p) => p.id === id);
const isGkId = (db, id) => (playerById(db, id) || {}).position === 'gol';

function cleanPlayer(input, db, ignoreId) {
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new AppError('Informe o nome do jogador');
  if (name.length > 40) throw new AppError('Nome muito longo (máx. 40)');
  if (!(input.level in LEVELS)) throw new AppError('Nível inválido');
  if (!POSITIONS.includes(input.position)) throw new AppError('Posição inválida');
  const dup = db.players.find((p) => p.id !== ignoreId && p.name.toLowerCase() === name.toLowerCase());
  if (dup) throw new AppError('Já existe um jogador com esse nome');
  return { name, level: input.level, position: input.position };
}

function addPlayer(db, input) {
  const p = { id: uid(), ...cleanPlayer(input, db) };
  db.players.push(p);
  db.players.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function updatePlayer(db, id, input) {
  const p = playerById(db, id);
  if (!p) throw new AppError('Jogador não encontrado', 404);
  Object.assign(p, cleanPlayer(input, db, id));
  renameInGoals(db, p);
  if (p.position === 'gol') removePlayer(db, id); // goleiro não participa da pelada
  db.players.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

// os gols guardam uma cópia do nome (para sobreviver à exclusão do cadastro): ao renomear, atualiza as cópias
function renameInGoals(db, p) {
  const lists = [db.events, db.session.match.goals, ...db.matches.map((m) => m.goals)];
  if (db.session.lastResult) lists.push(db.session.lastResult.goals);
  lists.forEach((goals) => goals.forEach((g) => {
    if (g.scorerId === p.id) g.scorerName = p.name;
    if (g.assistId === p.id) g.assistName = p.name;
  }));
}

function deletePlayer(db, id) {
  if (!playerById(db, id)) throw new AppError('Jogador não encontrado', 404);
  removePlayer(db, id);
  db.players = db.players.filter((p) => p.id !== id);
}

// ---------- presenca / times / fila ----------

const teamOf = (db, pid) => db.session.teams.find((t) => t.players.includes(pid));

function isPresent(db, pid) {
  const s = db.session;
  return s.arrivals.includes(pid) || s.queue.includes(pid) || !!teamOf(db, pid);
}

function makeTeam(db, playerIds, avoidColor) {
  const [color, hex] = PALETTE.find(([, h]) => h !== avoidColor);
  return { id: uid(), name: `Time ${color}`, color: hex, players: playerIds };
}

// completa os times em campo com o primeiro da fila (quem sai é substituído por quem espera)
function refill(db) {
  const s = db.session;
  s.teams.forEach((t) => {
    while (t.players.length < db.config.teamSize && s.queue.length) t.players.push(s.queue.shift());
  });
}

// se só há um time em campo, o desafiante sai dos primeiros da fila
function ensureChallenger(db) {
  const s = db.session;
  if (s.status === 'active' && s.teams.length === 1 && s.queue.length) {
    s.teams.push(makeTeam(db, s.queue.splice(0, db.config.teamSize), s.teams[0].color));
  }
}

function arrive(db, pid) {
  const s = db.session;
  if (s.status === 'none') throw new AppError('Inicie a pelada antes de marcar chegadas');
  if (!playerById(db, pid)) throw new AppError('Jogador não encontrado', 404);
  if (isGkId(db, pid)) throw new AppError('Goleiro é só informação do cadastro: não entra na pelada');
  if (isPresent(db, pid)) throw new AppError('Jogador já está na pelada');
  if (s.status === 'lobby') return s.arrivals.push(pid);
  // quem chega depois do sorteio sempre entra no fim da fila.
  // Só sobe para um time em campo se faltar gente lá (alguém saiu e a fila estava vazia).
  s.queue.push(pid);
  refill(db);
  ensureChallenger(db);
}

function removePlayer(db, pid) {
  const s = db.session;
  s.arrivals = s.arrivals.filter((id) => id !== pid);
  s.queue = s.queue.filter((id) => id !== pid);
  s.teams.forEach((t) => { t.players = t.players.filter((id) => id !== pid); });
  refill(db);
  ensureChallenger(db);
}

// quem não quer jogar ou saiu da partida vai para o fim da fila; se estava em campo, o próximo da espera entra
function sendToBack(db, pid) {
  const s = db.session;
  if (!isPresent(db, pid)) throw new AppError('Jogador não está na pelada');
  if (s.status === 'lobby') {
    s.arrivals = s.arrivals.filter((id) => id !== pid);
    s.arrivals.push(pid);
    return;
  }
  const team = teamOf(db, pid);
  if (team && !s.queue.length) throw new AppError('Não há ninguém na fila para entrar no lugar');
  s.queue = s.queue.filter((id) => id !== pid);
  if (team) team.players = team.players.filter((id) => id !== pid);
  s.queue.push(pid);
  refill(db);
}

// ---------- sorteio equilibrado ----------

// Divide os jogadores em k times deixando a diferença de força (fraco=1, médio=2, bom=3) a menor possível.
function balancedDraw(players, k) {
  const baseSizes = Array.from({ length: k }, (_, i) => Math.floor(players.length / k) + (i < players.length % k ? 1 : 0));
  let best = null;
  let bestScore = Infinity;
  let ties = 0;

  for (let attempt = 0; attempt < 2000; attempt++) {
    const sizes = shuffle(baseSizes);
    const rest = shuffle(players);
    const teams = sizes.map((n) => rest.splice(0, n));

    const avg = teams.map((t) => t.reduce((s, p) => s + LEVELS[p.level], 0) / t.length);
    const count = (lv) => teams.map((t) => t.filter((p) => p.level === lv).length);
    const spread = (xs) => Math.max(...xs) - Math.min(...xs);
    const score = spread(avg) * 100 + spread(count('bom')) * 10 + spread(count('fraco'));

    if (score < bestScore - 1e-9) { best = teams; bestScore = score; ties = 1; }
    else if (Math.abs(score - bestScore) < 1e-9 && crypto.randomInt(++ties) === 0) best = teams;
  }
  return best;
}

// Sorteio inicial: os primeiros a chegar (2 times completos) são sorteados em 2 times equilibrados;
// quem chegou depois forma a fila, por ordem de chegada.
function draw(db) {
  const s = db.session;
  const ts = db.config.teamSize;
  if (s.status !== 'lobby') throw new AppError('O sorteio já foi feito');
  const all = s.arrivals.map((id) => playerById(db, id)).filter(Boolean);
  if (all.length < ts * 2) throw new AppError(`São necessários ${ts * 2} jogadores para sortear (chegaram ${all.length})`);
  const [a, b] = balancedDraw(all.slice(0, ts * 2), 2);
  const first = makeTeam(db, a.map((p) => p.id));
  s.teams = [first, makeTeam(db, b.map((p) => p.id), first.color)];
  s.queue = all.slice(ts * 2).map((p) => p.id);
  s.arrivalOrder = s.arrivals.slice();
  s.arrivals = [];
  s.status = 'active';
}

function redraw(db) {
  const s = db.session;
  if (s.status !== 'active' || s.matchesPlayed > 0 || s.match.status !== 'idle') {
    throw new AppError('Só é possível refazer o sorteio antes da primeira partida começar');
  }
  const here = [...s.teams.flatMap((t) => t.players), ...s.queue];
  const ordered = s.arrivalOrder.filter((id) => here.includes(id));
  s.arrivals = [...ordered, ...here.filter((id) => !ordered.includes(id))];
  s.teams = [];
  s.queue = [];
  s.status = 'lobby';
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function startPelada(db) {
  if (db.session.status !== 'none') throw new AppError('Já existe uma pelada em andamento');
  db.session = newSession();
  db.session.id = uid();
  db.session.status = 'lobby';
  db.session.code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
}

function endPelada(db) {
  db.session = newSession();
}

// ---------- partida ----------

const totalMs = (db) => db.config.matchSeconds * 1000;

function elapsed(db, now) {
  const m = db.session.match;
  return Math.min(totalMs(db), m.elapsedMs + (m.startedAt ? now - m.startedAt : 0));
}

const score = (m, teamId) => m.goals.filter((g) => g.teamId === teamId).length;

function freezeClock(db, now) {
  const m = db.session.match;
  m.elapsedMs = elapsed(db, now);
  m.startedAt = null;
}

function startMatch(db, now) {
  const s = db.session;
  const ts = db.config.teamSize;
  if (s.status !== 'active') throw new AppError('Faça o sorteio antes de iniciar');
  if (s.match.status !== 'idle') throw new AppError('A partida já foi iniciada');
  const [a, b] = s.teams;
  if (!a || !b || a.players.length < ts || b.players.length < ts) {
    const missing = (ts - (a ? a.players.length : 0)) + (ts - (b ? b.players.length : 0));
    throw new AppError(`Cada time precisa ter ${ts} jogadores. Faltam ${missing}: marque a chegada de mais jogadores`);
  }
  Object.assign(s.match, { status: 'running', startedAt: now, teamIds: [a.id, b.id] });
}

function pauseMatch(db, now) {
  const m = db.session.match;
  if (m.status !== 'running') throw new AppError('A partida não está rolando');
  freezeClock(db, now);
  m.status = 'paused';
}

function resumeMatch(db, now) {
  const m = db.session.match;
  if (m.status !== 'paused') throw new AppError('A partida não está pausada');
  if (m.elapsedMs >= totalMs(db)) throw new AppError('O tempo já acabou, encerre a partida');
  m.startedAt = now;
  m.status = 'running';
}

function finishMatch(db, reason, now) {
  const m = db.session.match;
  if (m.status !== 'running' && m.status !== 'paused') throw new AppError('Não há partida em andamento');
  freezeClock(db, now);
  m.status = 'finished';
  m.reason = reason; // gols | tempo | manual
}

// o servidor chama a cada instante: encerra por tempo quando acabar
function tick(db, now) {
  const m = db.session.match;
  if (m.status === 'running' && elapsed(db, now) >= totalMs(db)) {
    finishMatch(db, 'tempo', now);
    return true;
  }
  return false;
}

// requestId (gerado pelo celular a cada gol) torna o pedido idempotente: um duplo toque ou uma nova
// tentativa depois de falha de rede não registra o mesmo gol duas vezes. Devolve false se já estava registrado.
function recordGoal(db, { teamId, scorerId, assistId, requestId }, now) {
  const s = db.session;
  const m = s.match;
  const rid = /^[A-Za-z0-9_-]{6,40}$/.test(requestId || '') ? requestId : null;
  if (rid && m.goals.some((g) => g.rid === rid)) return false;
  tick(db, now);
  if (m.status !== 'running' && m.status !== 'paused') throw new AppError('Não há partida em andamento');
  const team = s.teams.find((t) => t.id === teamId);
  if (!team) throw new AppError('Time inválido');
  if (!team.players.includes(scorerId)) throw new AppError('Quem fez o gol precisa estar no time');
  if (assistId) {
    if (assistId === scorerId) throw new AppError('Quem fez o gol não pode dar a assistência');
    if (!team.players.includes(assistId)) throw new AppError('Quem deu a assistência precisa estar no time');
  }
  const scorer = playerById(db, scorerId);
  const assist = assistId ? playerById(db, assistId) : null;
  const goal = {
    id: uid(), teamId, teamName: team.name, ms: elapsed(db, now),
    scorerId, scorerName: scorer.name, assistId: assist ? assist.id : null, assistName: assist ? assist.name : null,
    ...(rid ? { rid } : {}),
  };
  m.goals.push(goal);
  db.events.push({ ...goal, matchId: m.id, season: db.season, at: now });
  if (score(m, teamId) >= db.config.goalsToWin) finishMatch(db, 'gols', now);
}

function undoGoal(db, goalId) {
  const m = db.session.match;
  const goal = m.goals.find((g) => g.id === goalId);
  if (!goal) throw new AppError('Gol não encontrado', 404);
  m.goals = m.goals.filter((g) => g.id !== goalId);
  db.events = db.events.filter((e) => e.id !== goalId);
  if (m.status === 'finished' && m.reason === 'gols' && score(m, goal.teamId) < db.config.goalsToWin) {
    m.status = 'paused';
    m.reason = null;
  }
}

function matchWinner(db) {
  const s = db.session;
  const [a, b] = s.teams;
  const sa = score(s.match, a.id);
  const sb = score(s.match, b.id);
  return sa > sb ? a : sb > sa ? b : null;
}

// Empate com o próximo time completo e até 3 jogadores a mais na espera (time de ré incompleto):
// o admin precisa definir quem ganhou. O time que perde entra no fim da fila e,
// por ordem, seus primeiros jogadores completam o time de ré.
function needsTiebreak(db) {
  const s = db.session;
  const m = s.match;
  if (m.status !== 'finished' || s.teams.length !== 2) return false;
  const [a, b] = s.teams;
  const extra = s.queue.length - db.config.teamSize;
  return score(m, a.id) === score(m, b.id) && extra >= 1 && extra <= 3;
}

// fim de jogo empatado com 8+ esperando (próximo time + 3 no time de ré): os dois times saem
// (quem vence, mesmo por 1 gol, fica em campo)
function needsBothOut(db) {
  const s = db.session;
  if (s.match.status !== 'finished' || s.teams.length !== 2) return false;
  const [a, b] = s.teams;
  return score(s.match, a.id) === score(s.match, b.id) && s.queue.length >= db.config.teamSize + 3;
}

// fim de jogo: quem ganha fica, o perdedor vai para o fim da fila e os primeiros da espera entram.
// Em empate sai o desafiante (posição 2), a não ser que o admin defina o vencedor.
function nextMatch(db, now, winnerTeamId) {
  const s = db.session;
  if (s.match.status !== 'finished') throw new AppError('A partida ainda não terminou');
  const [a, b] = s.teams;
  const tiebreak = needsTiebreak(db);
  let winner = matchWinner(db);
  if (!winner && winnerTeamId) {
    winner = [a, b].find((t) => t.id === winnerTeamId);
    if (!winner) throw new AppError('Time inválido');
  }
  if (!winner && (tiebreak || needsBothOut(db))) throw new AppError('Empate: defina qual time ganhou');
  const stay = winner || a;
  const leave = stay === a ? b : a;
  // players (nomes) e playerIds andam juntos, na mesma ordem: o ranking usa os ids para contar jogos e vitórias
  const snap = (t) => {
    const named = t.players.map((id) => [id, (playerById(db, id) || {}).name]).filter(([, name]) => name);
    return { id: t.id, name: t.name, color: t.color, players: named.map(([, name]) => name), playerIds: named.map(([id]) => id) };
  };

  s.lastResult = {
    id: s.match.id, sessionId: s.id, endedAt: now, reason: s.match.reason, season: db.season,
    teamA: snap(a), teamB: snap(b), scoreA: score(s.match, a.id), scoreB: score(s.match, b.id),
    winner: winner ? winner.name : null, goals: s.match.goals,
  };
  db.matches.unshift(s.lastResult);
  s.matchesPlayed++;

  // empate com 8+ jogadores esperando: os dois times saem. Os 5 primeiros da fila entram como
  // time e os 5 seguintes como time de ré. Quem saiu entra na fila logo depois do último que esperava, na ordem
  // em que estava: primeiro o time definido como vencedor, depois o outro. Eles completam o time de ré se faltar.
  if (needsBothOut(db)) {
    s.queue.push(...stay.players, ...leave.players);
    const first = makeTeam(db, s.queue.splice(0, db.config.teamSize));
    s.teams = [first, makeTeam(db, s.queue.splice(0, db.config.teamSize), first.color)];
    s.match = newMatch();
    return;
  }

  s.teams = [stay];
  refill(db); // se faltava gente no time que fica, a espera completa
  if (!s.queue.length) {
    s.teams.push(leave); // ninguém esperando: os mesmos times jogam de novo
  } else {
    s.queue.push(...leave.players); // quem perdeu volta para o fim da fila
    ensureChallenger(db);
  }
  s.match = newMatch();
}

// ---------- config / temporada ----------

function setConfig(db, input) {
  const num = (v, min, max, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${label} deve ser um número entre ${min} e ${max}`);
    return n;
  };
  const next = {
    matchSeconds: num(input.matchSeconds, 30, 3600, 'Duração (segundos)'),
    goalsToWin: num(input.goalsToWin, 1, 20, 'Gols para encerrar'),
    teamSize: num(input.teamSize, 2, 11, 'Jogadores por time'),
  };
  if (db.session.status === 'active' && next.teamSize !== db.config.teamSize) {
    throw new AppError('Mude o número de jogadores por time antes de sortear os times');
  }
  if (db.session.match.status === 'running' || db.session.match.status === 'paused') {
    throw new AppError('Não é possível mudar as regras com a partida em andamento');
  }
  Object.assign(db.config, next);
}

function resetSeason(db) {
  db.events = [];
  db.matches = [];
  db.session.lastResult = null;
  db.season++;
}

// ---------- estado publico ----------

// quem jogou cada partida da temporada e se venceu (pelo placar: o empate que o admin desempata não conta como vitória)
function appearances(db) {
  const out = [];
  db.matches.forEach((m) => {
    if (!m.teamA || !m.teamB) return;
    [[m.teamA, m.scoreA, m.scoreB], [m.teamB, m.scoreB, m.scoreA]].forEach(([team, mine, theirs]) => {
      // partidas gravadas antes de existir playerIds: acha o jogador pelo nome (únicos no cadastro)
      const people = team.playerIds
        ? team.playerIds.map((id, i) => ({ id, name: team.players[i] }))
        : team.players.map((name) => ({ id: (db.players.find((p) => p.name === name) || {}).id, name })).filter((p) => p.id);
      people.forEach((p) => out.push({ ...p, win: mine > theirs }));
    });
  });
  return out;
}

function ranking(db) {
  const map = new Map();
  // nome atual do cadastro; a cópia gravada no gol só vale se o jogador foi excluído
  const nameOf = (id, saved) => (playerById(db, id) || {}).name || saved;
  const row = (id, saved) => {
    if (!map.has(id)) map.set(id, { id, name: nameOf(id, saved), goals: 0, assists: 0, games: 0, wins: 0 });
    return map.get(id);
  };
  db.events.forEach((e) => {
    row(e.scorerId, e.scorerName).goals++;
    if (e.assistId) row(e.assistId, e.assistName).assists++;
  });
  appearances(db).forEach((a) => {
    const r = row(a.id, a.name);
    r.games++;
    if (a.win) r.wins++;
  });
  return [...map.values()];
}

const publicPlayers = (db) => db.players.map(({ id, name, position }) => ({ id, name, position }));

// resultados das partidas da pelada em andamento, da mais recente para a mais antiga
const RESULTS_LIMIT = 30;
function results(db) {
  const s = db.session;
  if (!s.id) return [];
  return db.matches.filter((m) => m.sessionId === s.id).slice(0, RESULTS_LIMIT).map((m) => ({
    id: m.id,
    endedAt: m.endedAt,
    reason: m.reason,
    teamA: { id: m.teamA.id, name: m.teamA.name, color: m.teamA.color },
    teamB: { id: m.teamB.id, name: m.teamB.name, color: m.teamB.color },
    scoreA: m.scoreA,
    scoreB: m.scoreB,
    winner: m.winner,
    goals: m.goals.map((g) => ({ id: g.id, teamId: g.teamId, scorerName: g.scorerName, assistName: g.assistName, ms: g.ms })),
  }));
}

// admin vê tudo (inclusive o nível dos jogadores); espectador vê a pelada só com o código,
// mas o ranking é público
function viewState(db, now, { admin, code }) {
  const s = db.session;
  const common = { now, admin, season: db.season, ranking: ranking(db) };
  if (!admin) {
    if (s.status === 'none') return { ...common, locked: true, message: 'Nenhuma pelada em andamento no momento.' };
    if (String(code || '').trim().toUpperCase() !== s.code) return { ...common, locked: true, message: 'Código inválido ou pelada encerrada.' };
  }
  return {
    ...common,
    config: db.config,
    players: admin ? db.players : publicPlayers(db),
    session: {
      status: s.status,
      code: admin ? s.code : undefined,
      arrivals: s.arrivals,
      teams: s.teams,
      queue: s.queue,
      matchesPlayed: s.matchesPlayed,
      match: s.match,
      needsTiebreak: needsTiebreak(db),
      bothOut: needsBothOut(db),
    },
    results: results(db),
  };
}

module.exports = {
  AppError, LEVELS, defaultDb, normalizeDb, balancedDraw,
  addPlayer, updatePlayer, deletePlayer,
  arrive, removePlayer, sendToBack,
  startPelada, endPelada, draw, redraw,
  startMatch, pauseMatch, resumeMatch, finishMatch, tick, recordGoal, undoGoal, nextMatch,
  setConfig, resetSeason, viewState,
};
