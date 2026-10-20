'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic');

// 10 jogadores em campo + `waiting` na fila, partida iniciada
function started(waiting) {
  const db = L.defaultDb();
  L.startPelada(db);
  const total = 10 + waiting;
  for (let i = 1; i <= total; i++) L.addPlayer(db, { name: `P${String(i).padStart(2, '0')}`, level: 'medio', position: 'linha' });
  db.players.forEach((p) => L.arrive(db, p.id));
  L.draw(db);
  L.startMatch(db, 1000);
  return db;
}
const win = (db, team) => {
  L.recordGoal(db, { teamId: team.id, scorerId: team.players[0] }, 2000);
  L.recordGoal(db, { teamId: team.id, scorerId: team.players[0] }, 3000);
};

test('com 8 ou mais esperando, quem vence fica em campo (mesmo por 1 gol)', () => {
  for (const goals of [1, 2]) {
    const db = started(9);
    const [a, b] = db.session.teams;
    const q = db.session.queue.slice();
    L.recordGoal(db, { teamId: a.id, scorerId: a.players[0] }, 2000);
    if (goals === 2) L.recordGoal(db, { teamId: a.id, scorerId: a.players[0] }, 3000);
    else L.finishMatch(db, 'tempo', 5000);
    assert.equal(L.viewState(db, 1, { admin: true }).session.bothOut, false);
    L.nextMatch(db, 6000);
    assert.equal(db.session.teams[0].id, a.id);
    assert.deepEqual(db.session.teams[1].players, q.slice(0, 5));
    assert.deepEqual(db.session.queue, [...q.slice(5), ...b.players]);
  }
});

test('empate com 8 ou mais esperando: os dois times saem; entram o próximo time e o time de ré, completado por quem saiu', () => {
  const db = started(9);
  const [a, b] = db.session.teams;
  const q = db.session.queue.slice();
  L.finishMatch(db, 'manual', 5000); // 0 x 0
  assert.equal(L.viewState(db, 1, { admin: true }).session.bothOut, true);
  assert.throws(() => L.nextMatch(db, 6000), /defina/); // o vencedor precisa ser definido
  L.nextMatch(db, 6000, a.id); // a é definido vencedor
  const [t1, t2] = db.session.teams;
  assert.deepEqual(t1.players, q.slice(0, 5)); // próximo time
  assert.deepEqual(t2.players, [...q.slice(5), a.players[0]]); // time de ré (4) completado pelo primeiro do time vencedor
  assert.notEqual(t1.color, t2.color);
  assert.ok(![a.id, b.id].includes(t1.id) && ![a.id, b.id].includes(t2.id));
  // fila: logo depois do último que esperava entra o time vencedor (na ordem), depois o outro time
  assert.deepEqual(db.session.queue, [...a.players.slice(1), ...b.players]);
});

test('empate com 8 esperando: os dois times saem; com 7 ainda não', () => {
  const db8 = started(8);
  L.finishMatch(db8, 'manual', 5000);
  assert.equal(L.viewState(db8, 1, { admin: true }).session.bothOut, true);
  const db7 = started(7);
  L.finishMatch(db7, 'manual', 5000);
  assert.equal(L.viewState(db7, 1, { admin: true }).session.bothOut, false);
  assert.equal(L.viewState(db7, 1, { admin: true }).session.needsTiebreak, true);
});

test('com 8 esperando, quem ganha fica, o próximo entra no lugar do perdedor e o perdedor vai para o fim', () => {
  const db = started(8);
  const [a, b] = db.session.teams;
  const q = db.session.queue.slice();
  win(db, a);
  assert.equal(L.viewState(db, 1, { admin: true }).session.bothOut, false);
  L.nextMatch(db, 4000);
  assert.equal(db.session.teams[0].id, a.id);
  assert.deepEqual(db.session.teams[1].players, q.slice(0, 5));
  assert.deepEqual(db.session.queue, [...q.slice(5), ...b.players]);
});

test('com 9+ esperando e empate, os dois times saem também', () => {
  const db = started(10);
  L.finishMatch(db, 'manual', 5000);
  const [a, b] = db.session.teams;
  const q = db.session.queue.slice();
  L.nextMatch(db, 6000, b.id); // b definido vencedor: entra na fila primeiro
  assert.deepEqual(db.session.teams[0].players, q.slice(0, 5));
  assert.deepEqual(db.session.teams[1].players, q.slice(5, 10));
  assert.deepEqual(db.session.queue, [...b.players, ...a.players]);
});

test('nova temporada: só jogadores e configurações permanecem', () => {
  const db = L.defaultDb();
  L.addPlayer(db, { name: 'Ana', level: 'bom', position: 'linha' });
  L.setConfig(db, { matchSeconds: 600, goalsToWin: 3, teamSize: 5 });
  db.events.push({ id: 'e', scorerId: 'x', scorerName: 'X', season: 1 });
  db.matches.push({ id: 'm' });
  L.resetSeason(db);
  assert.equal(db.events.length, 0);
  assert.equal(db.matches.length, 0);
  assert.equal(db.players.length, 1);
  assert.equal(db.config.matchSeconds, 600);
  assert.equal(L.viewState(db, 1, { admin: true }).ranking.length, 0);
});
