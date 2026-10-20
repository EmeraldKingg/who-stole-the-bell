// Simulates a full game with 4 clients against a running server.
// Usage: DISCUSS_SECONDS=2 node index.js (in one terminal), then node test-sim.js
// (DISCUSS_SECONDS keeps the discussion short so the timer check doesn't take two minutes.)
const { io } = require('socket.io-client');
const assert = require('assert');

const URL = process.env.URL || 'http://localhost:3001';
const names = ['Ada', 'Kofi', 'Zed', 'Mimi'];

function client(name) {
  const socket = io(URL, { transports: ['websocket'] });
  const c = { name, socket, view: null };
  socket.on('state', (v) => (c.view = v));
  c.emit = (event, payload) => new Promise((res) => socket.emit(event, payload, res));
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const clients = names.map(client);
  await wait(300);
  const [host, ...rest] = clients;

  const created = await host.emit('create', { name: host.name });
  assert(created.ok && created.code.length === 4, 'room created');

  // Error paths
  assert.strictEqual((await rest[0].emit('join', { code: 'ZZZZ', name: 'X' })).ok, false, 'bad code rejected');
  for (const c of rest) assert((await c.emit('join', { code: created.code, name: c.name })).ok, 'join ok');
  assert.strictEqual((await rest[0].emit('join', { code: created.code, name: 'ada' })).ok, false, 'dupe name rejected');
  await wait(100);
  assert.strictEqual(host.view.players.length, 4);

  assert.strictEqual((await rest[0].emit('start')).ok, false, 'non-host cannot start');
  assert((await host.emit('start')).ok, 'host starts');
  await wait(100);

  // Exactly one thief, and nobody can see who it is.
  const roles = clients.map((c) => c.view.role);
  assert.strictEqual(roles.filter((r) => r === 'thief').length, 1, 'exactly one thief');
  assert.strictEqual(roles.filter((r) => r === 'patron').length, 3, 'three patrons');
  assert(clients.every((c) => c.view.result === null), 'no result leaked');
  assert(clients.every((c) => !('thiefId' in c.view)), 'thief id not in view');
  assert(clients.every((c) => Object.keys(c.view.alibis).length === 0), 'alibis hidden during alibi phase');

  // Chat is closed before the discussion starts.
  assert.strictEqual((await host.emit('chat', { text: 'too early' })).ok, false, 'chat closed during alibi');

  // Alibis: when the last one lands the discussion starts (with a countdown).
  for (const c of clients) assert((await c.emit('alibi', { text: `${c.name} was at the bar` })).ok);
  await wait(100);
  assert.strictEqual(host.view.phase, 'discuss', 'auto-advance to discussion');
  assert.strictEqual(Object.keys(host.view.alibis).length, 4, 'alibis revealed');
  const endsAt = host.view.discussEndsAt;
  assert(endsAt > host.view.serverNow, 'countdown deadline is in the future');
  assert(clients.every((c) => c.view.discussEndsAt === endsAt), 'everyone shares the same deadline');

  // Chat: delivered to everyone, validated, and only the host can skip ahead.
  assert((await rest[0].emit('chat', { text: 'Kofi, you left early' })).ok, 'chat sent');
  assert.strictEqual((await rest[1].emit('chat', { text: '   ' })).ok, false, 'empty chat rejected');
  assert((await rest[1].emit('chat', { text: 'x'.repeat(500) })).ok, 'long chat accepted but trimmed');
  await wait(100);
  assert(clients.every((c) => c.view.chat.length === 2), 'chat reaches everyone');
  assert.strictEqual(host.view.chat[0].text, 'Kofi, you left early');
  assert.strictEqual(host.view.chat[1].text.length, 200, 'chat trimmed to 200 chars');
  assert.strictEqual((await rest[0].emit('advance')).ok, false, 'non-host cannot skip discussion');

  // The server's timer (DISCUSS_SECONDS) moves everyone to voting on its own.
  assert.strictEqual(host.view.phase, 'discuss', 'still discussing before the timer ends');
  await wait(Math.max(0, endsAt - Date.now()) + 400);
  assert.strictEqual(host.view.phase, 'vote', 'timer auto-advances to vote');
  assert(clients.every((c) => c.view.discussEndsAt === null), 'deadline cleared after discussion');
  assert((await host.emit('chat', { text: 'still can talk while voting' })).ok, 'chat open during vote');

  // Self-vote rejected
  assert.strictEqual((await host.emit('vote', { suspectId: host.socket.id })).ok, false, 'self vote rejected');

  // Everyone votes for the thief -> patrons win.
  const thief = clients.find((c) => c.view.role === 'thief');
  for (const c of clients) {
    const target = c === thief ? clients.find((x) => x !== thief) : thief;
    assert((await c.emit('vote', { suspectId: target.socket.id })).ok, 'vote ok');
  }
  await wait(100);
  assert.strictEqual(host.view.phase, 'result');
  assert.strictEqual(host.view.result.winner, 'patrons');
  assert.strictEqual(host.view.result.thiefId, thief.socket.id);

  // Play again, then force a tie to check the Thief-walks rule.
  assert((await host.emit('playAgain')).ok);
  await wait(100);
  assert.strictEqual(host.view.phase, 'lobby');
  assert((await host.emit('start')).ok);
  await wait(100);
  for (const c of clients) await c.emit('alibi', { text: 'somewhere' });
  await wait(100);
  assert.strictEqual(host.view.phase, 'discuss');
  assert.strictEqual(host.view.chat.length, 0, 'chat cleared for the new round');
  assert((await host.emit('advance')).ok, 'host ends discussion early');
  await wait(100);
  assert.strictEqual(host.view.phase, 'vote');
  // 2 votes for client[0]... build a 2-2 tie: A,B -> C ; C,D -> A  (A voting for C, B for C, C for A, D for A)
  const [A, B, C, D] = clients;
  await A.emit('vote', { suspectId: C.socket.id });
  await B.emit('vote', { suspectId: C.socket.id });
  await C.emit('vote', { suspectId: A.socket.id });
  await D.emit('vote', { suspectId: A.socket.id });
  await wait(100);
  assert.strictEqual(host.view.phase, 'result');
  assert.strictEqual(host.view.result.tie, true, 'tie detected');
  assert.strictEqual(host.view.result.winner, 'thief', 'thief wins on a tie');

  console.log('All checks passed.');
  clients.forEach((c) => c.socket.close());
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
