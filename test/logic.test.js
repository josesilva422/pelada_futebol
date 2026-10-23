'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic');

function setup(spec) {
  const db = L.defaultDb();
  L.startPelada(db);
  spec.forEach(([name, level, position]) => L.addPlayer(db, { name, level, position: position || 'linha' }));
  return db;
}
const byName = (db, n) => db.players.find((p) => p.name === n);
const nameOf = (db, id) => db.players.find((p) => p.id === id).name;
const names = (db, ids) => ids.map((id) => nameOf(db, id));
const arriveAll = (db, order) => order.forEach((n) => L.arrive(db, byName(db, n).id));
const strength = (db, t) => t.players.reduce((s, id) => s + L.LEVELS[db.players.find((p) => p.id === id).level], 0);

const TEN = [
  ['A', 'bom'], ['B', 'bom'], ['C', 'bom'], ['D', 'medio'], ['E', 'medio'], ['F', 'medio'], ['G', 'medio'], ['H', 'fraco'], ['I', 'fraco'], ['J', 'fraco'],
];
const tenNames = TEN.map((t) => t[0]);
const nNames = (n) => Array.from({ length: n }, (_, i) => `N${i + 1}`);
const extraSpec = (n) => nNames(n).map((name) => [name, 'medio']);

// pelada com 10 sorteados + `extra` na fila, partida já iniciada
function started(extra = 5) {
  const db = setup([...TEN, ...extraSpec(extra)]);
  arriveAll(db, [...tenNames, ...nNames(extra)]);
  L.draw(db);
  L.startMatch(db, 1000);
  return db;
}

test('sorteio inicial: 2 times de 5 com força equilibrada, nas cores laranja e verde', () => {
  for (let i = 0; i < 30; i++) {
    const db = setup(TEN);
    arriveAll(db, tenNames);
    L.draw(db);
    const [a, b] = db.session.teams;
    assert.equal(a.players.length, 5);
    assert.equal(b.players.length, 5);
    assert.ok(Math.abs(strength(db, a) - strength(db, b)) <= 1);
    assert.deepEqual([a.color, b.color].sort(), ['#27ae60', '#f2994a']);
  }
});

test('sorteio só com os 10 primeiros; os demais viram a fila por ordem de chegada, sem cor/time', () => {
  const db = setup([...TEN, ...extraSpec(7)]);
  arriveAll(db, [...tenNames, ...nNames(7)]);
  L.draw(db);
  assert.equal(db.session.teams.length, 2);
  assert.deepEqual(names(db, db.session.queue), nNames(7));
});

test('menos de 10 jogadores: não sorteia', () => {
  const db = setup(TEN.slice(0, 9));
  arriveAll(db, tenNames.slice(0, 9));
  assert.throws(() => L.draw(db), /10 jogadores/);
});

test('goleiro é só informação: não pode ser marcado como chegada e nunca entra em sorteio, time ou fila', () => {
  const db = setup([['Gol1', 'bom', 'gol'], ...TEN]);
  assert.throws(() => L.arrive(db, byName(db, 'Gol1').id), /Goleiro/);
  arriveAll(db, tenNames);
  L.draw(db);
  assert.ok(!db.session.teams.flatMap((t) => names(db, t.players)).includes('Gol1'));
  assert.throws(() => L.arrive(db, byName(db, 'Gol1').id), /Goleiro/);
  assert.equal(db.session.queue.length, 0);
});

test('mudar jogador para goleiro o tira da pelada', () => {
  const db = setup([...TEN, ...extraSpec(2)]);
  arriveAll(db, [...tenNames, 'N1', 'N2']);
  L.draw(db);
  const id = byName(db, 'N1').id;
  L.updatePlayer(db, id, { name: 'N1', level: 'medio', position: 'gol' });
  assert.deepEqual(names(db, db.session.queue), ['N2']);
});

test('quem chega depois do sorteio vai para o fim da fila e só sobe se faltar gente em campo', () => {
  const db = setup([...TEN, ...extraSpec(3)]);
  arriveAll(db, tenNames);
  L.draw(db);
  arriveAll(db, ['N1', 'N2']);
  assert.deepEqual(names(db, db.session.queue), ['N1', 'N2']);
  assert.ok(db.session.teams.every((t) => t.players.length === 5));
  L.removePlayer(db, db.session.teams[0].players[0]);
  L.arrive(db, byName(db, 'N3').id);
  assert.deepEqual(names(db, db.session.queue), ['N2', 'N3']);
  assert.ok(names(db, db.session.teams[0].players).includes('N1'));
});

test('não inicia partida com time incompleto; chegada completa o time em campo', () => {
  const db = setup(TEN);
  arriveAll(db, tenNames);
  L.draw(db);
  L.removePlayer(db, db.session.teams[0].players[0]); // fila vazia: ninguém para entrar
  assert.equal(db.session.teams[0].players.length, 4);
  assert.throws(() => L.startMatch(db, 1), /5 jogadores/);
  L.addPlayer(db, { name: 'Novo', level: 'medio', position: 'linha' });
  L.arrive(db, byName(db, 'Novo').id);
  assert.equal(db.session.teams[0].players.length, 5);
  L.startMatch(db, 2);
});

test('quando alguém sai, o primeiro da fila sobe e o time continua com 5', () => {
  const db = started(3);
  const [a] = db.session.teams;
  const leaving = a.players[1];
  L.removePlayer(db, leaving);
  assert.equal(a.players.length, 5);
  assert.ok(!a.players.includes(leaving));
  assert.equal(nameOf(db, a.players[4]), 'N1');
  assert.deepEqual(names(db, db.session.queue), ['N2', 'N3']);
});

test('"fim da fila": quem está em campo vai para o fim e o primeiro da fila entra; na fila só muda de posição', () => {
  const db = started(3);
  const [a] = db.session.teams;
  const pid = a.players[0];
  L.sendToBack(db, pid);
  assert.equal(a.players.length, 5);
  assert.equal(nameOf(db, a.players[4]), 'N1');
  assert.deepEqual(names(db, db.session.queue), ['N2', 'N3', nameOf(db, pid)]);
  L.sendToBack(db, byName(db, 'N2').id);
  assert.deepEqual(names(db, db.session.queue), ['N3', nameOf(db, pid), 'N2']);
});

test('"fim da fila" sem ninguém esperando é recusado', () => {
  const db = started(0);
  assert.throws(() => L.sendToBack(db, db.session.teams[0].players[0]), /ninguém na fila/);
});

test('2 gols encerram; vencedor fica com a cor, perdedor vai para o fim da fila e os 5 primeiros entram na outra cor', () => {
  const db = started(5);
  const [a, b] = db.session.teams;
  const next = db.session.queue.slice(0, 5);
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[1], assistId: a.players[2] }, 2000);
  assert.equal(db.session.match.status, 'running');
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[1] }, 3000);
  assert.equal(db.session.match.reason, 'gols');
  L.nextMatch(db, 4000);
  assert.equal(db.session.teams[0].id, a.id);
  assert.deepEqual(db.session.teams[1].players, next);
  assert.notEqual(db.session.teams[1].color, a.color);
  assert.deepEqual(db.session.queue, b.players);
  assert.equal(db.events.length, 2);
  assert.equal(db.session.match.status, 'idle');
});

test('sem ninguém na fila, os mesmos times jogam de novo', () => {
  const db = started(0);
  const [a, b] = db.session.teams;
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[1] }, 2000);
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[1] }, 3000);
  L.nextMatch(db, 4000);
  assert.deepEqual(db.session.teams.map((t) => t.id), [a.id, b.id]);
});

test('tempo acaba: ganha quem tem mais gols; empate tira o desafiante', () => {
  const db = started(5);
  const [a, b] = db.session.teams;
  L.recordGoal(db, { teamId: b.id, scorerId: b.players[0] }, 5000);
  assert.ok(L.tick(db, 1000 + 7 * 60 * 1000));
  assert.equal(db.session.match.reason, 'tempo');
  L.nextMatch(db, 9e5);
  assert.equal(db.session.teams[0].id, b.id);
  assert.deepEqual(db.session.queue, a.players);

  const db2 = started(5);
  const a2 = db2.session.teams[0];
  L.tick(db2, 1000 + 7 * 60 * 1000);
  L.nextMatch(db2, 9e5);
  assert.equal(db2.session.teams[0].id, a2.id);
});

test('pausar congela o relógio e retomar continua de onde parou', () => {
  const db = started();
  L.pauseMatch(db, 61000); // 60s jogados
  assert.equal(L.tick(db, 1e9), false);
  L.resumeMatch(db, 100000);
  assert.equal(L.tick(db, 100000 + 6 * 60 * 1000 - 1), false);
  assert.equal(L.tick(db, 100000 + 6 * 60 * 1000), true);
});

test('desfazer o gol decisivo reabre a partida; regras de gol', () => {
  const db = started();
  const [a, b] = db.session.teams;
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[0] }, 2000);
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[0] }, 3000);
  assert.equal(db.session.match.status, 'finished');
  L.undoGoal(db, db.session.match.goals[1].id);
  assert.equal(db.session.match.status, 'paused');
  assert.equal(db.events.length, 1);
  assert.throws(() => L.recordGoal(db, { teamId: a.id, scorerId: b.players[0] }, 4000), /no time/);
  assert.throws(() => L.recordGoal(db, { teamId: a.id, scorerId: a.players[0], assistId: a.players[0] }, 4000), /assistência/);
});

test('ranking soma gols e assistências; nova temporada limpa tudo', () => {
  const db = started();
  const [a] = db.session.teams;
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[0], assistId: a.players[1] }, 2000);
  const r = L.viewState(db, 3000, { admin: true }).ranking;
  assert.equal(r.find((x) => x.id === a.players[0]).goals, 1);
  assert.equal(r.find((x) => x.id === a.players[1]).assists, 1);
  L.resetSeason(db);
  assert.equal(L.viewState(db, 3000, { admin: true }).ranking.length, 0);
  assert.equal(db.season, 2);
});

test('código: espectador só vê a pelada com o código certo e sem nível; ranking é público', () => {
  const db = L.defaultDb();
  const locked = L.viewState(db, 1, { admin: false, code: 'X' });
  assert.equal(locked.locked, true);
  assert.ok(Array.isArray(locked.ranking));
  L.startPelada(db);
  L.addPlayer(db, { name: 'Zé', level: 'bom', position: 'linha' });
  const code = db.session.code;
  assert.match(code, /^[A-Z2-9]{5}$/);
  const wrong = L.viewState(db, 1, { admin: false, code: 'ERRADO' });
  assert.equal(wrong.locked, true);
  assert.equal(wrong.session, undefined);
  const v = L.viewState(db, 1, { admin: false, code: code.toLowerCase() });
  assert.equal(v.locked, undefined);
  assert.equal(v.players[0].level, undefined);
  assert.equal(L.viewState(db, 1, { admin: true }).players[0].level, 'bom');
  L.endPelada(db);
  assert.equal(L.viewState(db, 1, { admin: false, code }).locked, true);
});

function drawn(extra) {
  const db = started(extra);
  L.finishMatch(db, 'manual', 5000); // 0 x 0
  return db;
}

test('empate com próximo time completo e até 3 na fila de ré: admin define o vencedor; perdedor completa o ré', () => {
  const db = drawn(7); // fila: próximo (5) + ré (2); com 8 esperando os dois times saem
  const [a, b] = db.session.teams;
  assert.equal(L.viewState(db, 1, { admin: true }).session.needsTiebreak, true);
  assert.throws(() => L.nextMatch(db, 6000), /defina/);
  const q = db.session.queue.slice();
  L.nextMatch(db, 6000, a.id);
  assert.equal(db.session.teams[0].id, a.id);
  assert.deepEqual(db.session.teams[1].players, q.slice(0, 5));
  // ré (3) é completado pelos primeiros do time que perdeu, na ordem
  assert.deepEqual(db.session.queue, [...q.slice(5), ...b.players]);
});

test('empate sem a situação especial: sai o desafiante, ou o admin escolhe', () => {
  const db = drawn(5);
  const [a, b] = db.session.teams;
  assert.equal(L.viewState(db, 1, { admin: true }).session.needsTiebreak, false);
  L.nextMatch(db, 6000, b.id);
  assert.equal(db.session.teams[0].id, b.id);
  assert.deepEqual(db.session.queue, a.players);
});

test('dados antigos: times de fila viram fila e goleiros saem de tudo', () => {
  const old = L.defaultDb();
  old.players = [
    { id: '1', name: 'a', level: 'bom', position: 'linha' }, { id: '2', name: 'b', level: 'bom', position: 'linha' },
    { id: '3', name: 'c', level: 'bom', position: 'linha' }, { id: '4', name: 'd', level: 'bom', position: 'linha' },
    { id: '5', name: 'e', level: 'bom', position: 'linha' }, { id: 'g', name: 'g', level: 'bom', position: 'gol' },
  ];
  Object.assign(old.session, {
    status: 'active', paused: ['9'], gkQueue: ['g'],
    teams: [{ id: 'a', players: ['1', 'g'] }, { id: 'b', players: ['2'] }, { id: 'c', players: ['3', '4'] }, { id: 'd', players: ['5'] }],
  });
  delete old.session.queue;
  const db = L.normalizeDb(old);
  assert.equal(db.session.teams.length, 2);
  assert.ok(db.session.teams.every((t) => !t.players.includes('g')));
  assert.equal(db.session.gkQueue, undefined);
  assert.equal(db.session.teams.flatMap((t) => t.players).length + db.session.queue.length, 5);
});

test('gol com requestId é idempotente: duplo toque ou nova tentativa não registra duas vezes', () => {
  const db = started(0);
  const [a] = db.session.teams;
  const goal = { teamId: a.id, scorerId: a.players[0], requestId: 'abc123def456' };
  assert.notEqual(L.recordGoal(db, goal, 2000), false);
  assert.equal(L.recordGoal(db, goal, 2100), false); // repetido: nada a gravar
  assert.equal(db.session.match.goals.length, 1);
  assert.equal(db.events.length, 1);

  // outro gol (requestId diferente) conta e, com 2 gols, a partida acaba
  L.recordGoal(db, { ...goal, requestId: 'outro123456' }, 3000);
  assert.equal(db.session.match.status, 'finished');
  // repetir o pedido depois do fim de jogo não dá erro nem duplica
  assert.equal(L.recordGoal(db, { ...goal, requestId: 'outro123456' }, 3100), false);
  assert.equal(db.session.match.goals.length, 2);
});

test('requestId inválido é ignorado (sem idempotência), como um pedido antigo sem o campo', () => {
  const db = started(0);
  const [a] = db.session.teams;
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[0], requestId: '!' }, 2000);
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[1] }, 2100);
  assert.equal(db.session.match.goals.length, 2);
  assert.equal(db.session.match.goals[0].rid, undefined);
});

test('renomear o jogador atualiza o nome no ranking, nos gols da partida e no histórico', () => {
  const db = started(0);
  const [a] = db.session.teams;
  const pid = a.players[0];
  const p = db.players.find((x) => x.id === pid);
  L.recordGoal(db, { teamId: a.id, scorerId: pid, assistId: a.players[1] }, 2000);
  L.finishMatch(db, 'manual', 3000);
  L.nextMatch(db, 4000);
  L.updatePlayer(db, pid, { name: 'Novo Nome', level: p.level, position: p.position });

  const st = L.viewState(db, 1, { admin: true });
  assert.equal(st.ranking.find((r) => r.id === pid).name, 'Novo Nome');
  assert.equal(db.events[0].scorerName, 'Novo Nome');
  assert.equal(db.matches[0].goals[0].scorerName, 'Novo Nome');
  assert.equal(db.session.lastResult.goals[0].scorerName, 'Novo Nome');

  // cópias antigas e desatualizadas também não vazam para o ranking
  db.events[0].scorerName = 'Nome Velho';
  assert.equal(L.viewState(db, 1, { admin: true }).ranking.find((r) => r.id === pid).name, 'Novo Nome');
  // se o cadastro for excluído, vale o nome guardado no gol
  L.deletePlayer(db, pid);
  assert.equal(L.viewState(db, 1, { admin: true }).ranking.find((r) => r.id === pid).name, 'Nome Velho');
});

test('resultados: cada pelada mostra só as suas partidas, sem expor times com nomes dos jogadores', () => {
  const db = started(5);
  const [a, b] = db.session.teams;
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[0], assistId: a.players[1] }, 2000);
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[0] }, 3000);
  assert.deepEqual(L.viewState(db, 1, { admin: true }).results, []); // ainda não confirmou o fim de jogo
  L.nextMatch(db, 4000);

  const st = L.viewState(db, 1, { admin: false, code: db.session.code });
  assert.equal(st.results.length, 1);
  const r = st.results[0];
  assert.deepEqual([r.scoreA, r.scoreB, r.winner, r.reason], [2, 0, a.name, 'gols']);
  assert.deepEqual([r.teamA.id, r.teamB.id], [a.id, b.id]);
  assert.equal(r.teamA.players, undefined);
  assert.equal(r.goals.length, 2);
  assert.equal(r.goals[0].assistName, db.players.find((p) => p.id === a.players[1]).name);
  assert.equal(L.viewState(db, 1, { admin: false, code: 'ERRADO' }).results, undefined); // sem código, nada

  // nova pelada: a lista recomeça (as partidas continuam na temporada)
  L.endPelada(db);
  L.startPelada(db);
  assert.deepEqual(L.viewState(db, 1, { admin: true }).results, []);
  assert.equal(db.matches.length, 1);
});

test('pelada guardada antes de existir o id da pelada ganha um id ao carregar', () => {
  const db = started(0);
  db.session.id = null;
  assert.ok(L.normalizeDb(db).session.id);
  assert.equal(L.normalizeDb(L.defaultDb()).session.id, null); // sem pelada, sem id
});

test('ranking traz jogos e vitórias: vitória só pelo placar, empate desempatado não conta, quem esperou não joga', () => {
  const db = started(5);
  const [a, b] = db.session.teams;
  const waiting = db.session.queue.slice();
  const rank = (id) => L.viewState(db, 1, { admin: true }).ranking.find((r) => r.id === id);

  // partida 1: o time a vence por 2 x 0
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[0] }, 2000);
  L.recordGoal(db, { teamId: a.id, scorerId: a.players[1], assistId: a.players[0] }, 3000);
  L.nextMatch(db, 4000);
  a.players.forEach((id) => assert.deepEqual([rank(id).games, rank(id).wins], [1, 1]));
  b.players.forEach((id) => assert.deepEqual([rank(id).games, rank(id).wins], [1, 0]));
  assert.equal(rank(a.players[0]).goals, 1);
  waiting.forEach((id) => assert.equal(rank(id), undefined)); // ainda não entraram em campo

  // partida 2: 0 x 0 e o admin define que o time a segue; o empate não vira vitória
  const [stay, challenger] = db.session.teams;
  assert.equal(stay.id, a.id);
  L.startMatch(db, 5000);
  L.finishMatch(db, 'manual', 6000);
  L.nextMatch(db, 7000, a.id);
  a.players.forEach((id) => assert.deepEqual([rank(id).games, rank(id).wins], [2, 1]));
  challenger.players.forEach((id) => assert.deepEqual([rank(id).games, rank(id).wins], [1, 0]));

  // partidas antigas (sem playerIds) são achadas pelo nome
  const legacy = JSON.parse(JSON.stringify(db));
  legacy.matches.forEach((m) => { delete m.teamA.playerIds; delete m.teamB.playerIds; });
  assert.deepEqual(L.viewState(legacy, 1, { admin: true }).ranking, L.viewState(db, 1, { admin: true }).ranking);

  // quem teve o cadastro excluído continua com o nome gravado na partida
  const gone = a.players[2];
  const goneName = db.players.find((p) => p.id === gone).name;
  L.deletePlayer(db, gone);
  assert.equal(rank(gone).name, goneName);
  assert.equal(rank(gone).games, 2);

  // nova temporada zera tudo
  L.resetSeason(db);
  assert.equal(L.viewState(db, 1, { admin: true }).ranking.length, 0);
});
