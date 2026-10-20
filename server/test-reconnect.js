// Reconnect scenarios: dropped phones, rejoining with a token, grace-period expiry, host handover.
// Run via `npm test` (run-tests.js starts a server with DISCUSS_SECONDS=2 and GRACE_SECONDS=2).
const { io } = require('socket.io-client');
const assert = require('assert');

const URL = process.env.URL || 'http://localhost:3001';
const GRACE = (Number(process.env.GRACE_SECONDS) || 2) * 1000; // must match the server's GRACE_SECONDS
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const opened = [];

function open() {
  return new Promise((resolve) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true });
    const c = { socket, view: null, id: null, token: null, code: null, name: null };
    socket.on('state', (v) => (c.view = v));
    c.emit = (event, payload) => new Promise((res) => socket.emit(event, payload, res));
    socket.on('connect', () => resolve(c));
    opened.push(c);
  });
}

async function host(name) {
  const c = await open();
  const r = await c.emit('create', { name });
  assert(r.ok && r.token, 'create returns a token');
  Object.assign(c, { code: r.code, token: r.token, name });
  return c;
}

async function join(code, name) {
  const c = await open();
  const r = await c.emit('join', { code, name });
  assert(r.ok && r.token, `join ok for ${name}`);
  Object.assign(c, { code, token: r.token, name });
  return c;
}

// Host + (names.length - 1) joiners, all in the lobby.
async function table(names) {
  const h = await host(names[0]);
  const rest = [];
  for (const n of names.slice(1)) rest.push(await join(h.code, n));
  const all = [h, ...rest];
  await wait(150);
  for (const c of all) c.id = c.view.meId;
  return all;
}

// A fresh connection that claims an old seat using the saved token.
async function comeBack(old) {
  const c = await open();
  const r = await c.emit('rejoin', { code: old.code, token: old.token });
  Object.assign(c, { code: old.code, token: old.token, name: old.name, id: old.id });
  await wait(150);
  return { c, r };
}

const seat = (viewer, target) => viewer.view.players.find((p) => p.id === target.id);

const scenarios = {
  async 'drop and return: lobby, role, chat, no leaks, bad tokens'() {
    const [A, B, C] = await table(['Ada', 'Kofi', 'Zed']);

    // Zed's phone drops. Zed shows as away, keeps the seat, and can't be counted as online.
    C.socket.close();
    await wait(150);
    assert.strictEqual(seat(A, C)?.connected, false, 'dropped player is shown as away');
    assert.strictEqual(A.view.players.length, 3, 'dropped player keeps their seat');
    const early = await A.emit('start');
    assert.strictEqual(early.ok, false, 'cannot start with only 2 online');

    // Zed comes back with the saved token: same seat, same id.
    const back = await comeBack(C);
    assert(back.r.ok, 'rejoin ok');
    const C2 = back.c;
    assert.strictEqual(C2.view.meId, C.id, 'same player id after rejoin');
    assert.strictEqual(seat(A, C)?.connected, true, 'back online');
    assert((await A.emit('start')).ok, 'host can start now');
    await wait(150);

    // A role survives a drop.
    const roleBefore = B.view.role;
    assert(roleBefore === 'thief' || roleBefore === 'patron');
    B.socket.close();
    await wait(150);
    const { c: B2, r } = await comeBack(B);
    assert(r.ok);
    assert.strictEqual(B2.view.role, roleBefore, 'role unchanged after rejoin');
    assert.strictEqual(B2.view.phase, 'alibi');

    // The rejoined phone can keep playing.
    assert((await B2.emit('alibi', { text: 'at the bar' })).ok, 'alibi from rejoined phone');
    assert((await A.emit('alibi', { text: 'in the car' })).ok);
    assert((await C2.emit('alibi', { text: 'dancing' })).ok);
    await wait(150);
    assert.strictEqual(A.view.phase, 'discuss');

    // Chat and alibis are restored for someone rejoining mid-discussion.
    assert((await A.emit('chat', { text: 'who left early?' })).ok);
    await wait(100);
    C2.socket.close();
    await wait(100);
    const { c: C3 } = await comeBack(C);
    assert.strictEqual(C3.view.phase, 'discuss');
    assert.strictEqual(C3.view.chat.length, 1, 'chat history restored');
    assert.strictEqual(Object.keys(C3.view.alibis).length, 3, 'alibis restored');

    // Tokens and socket ids never appear in anything sent to players.
    const secrets = [A, B, C].flatMap((p) => [p.token]).concat([A, B2, C3].map((p) => p.socket.id));
    for (const p of [A, B2, C3]) {
      const text = JSON.stringify(p.view);
      for (const s of secrets) assert(!text.includes(s), 'a secret leaked into a player view');
    }

    // Bad token / bad code are refused.
    const stranger = await open();
    assert.strictEqual((await stranger.emit('rejoin', { code: A.code, token: 'nope' })).ok, false, 'bad token');
    assert.strictEqual((await stranger.emit('rejoin', { code: 'ZZZZ', token: A.token })).ok, false, 'bad code');
    assert.strictEqual((await stranger.emit('rejoin', { code: A.code })).ok, false, 'missing token');
  },

  async 'second tab takes over the seat'() {
    const [P1, P2] = await table(['P1', 'P2', 'P3']);
    const { c: P1b, r } = await comeBack(P1); // P1's first connection is still open
    assert(r.ok);
    await wait(300);
    assert.strictEqual(P1.socket.connected, false, 'old connection was closed by the server');
    assert.strictEqual(seat(P2, P1)?.connected, true, 'seat stays online');

    // The old connection closing must not start a grace timer that later kicks the new one out.
    await wait(GRACE + 600);
    assert.strictEqual(seat(P2, P1)?.connected, true, 'still online after the grace period');
    assert((await P1b.emit('start')).ok, 'new connection still owns the host seat');
  },

  async 'vote does not wait forever for a player who dropped'() {
    const [H, X, Y, Z] = await table(['H', 'X', 'Y', 'Z']);
    assert((await H.emit('start')).ok);
    for (const c of [H, X, Y, Z]) await c.emit('alibi', { text: 'somewhere' });
    await wait(100);
    assert((await H.emit('advance')).ok, 'host ends discussion');
    await wait(100);
    assert.strictEqual(H.view.phase, 'vote');

    const pick = (c) => [H, X, Y, Z].find((p) => p !== c).id;
    for (const c of [H, X, Y]) assert((await c.emit('vote', { suspectId: pick(c) })).ok);
    Z.socket.close(); // Z never votes
    await wait(300);
    assert.strictEqual(H.view.phase, 'vote', 'still waiting during the grace period');

    await wait(GRACE + 600);
    assert.strictEqual(H.view.phase, 'result', 'result after the grace period runs out');

    // Z can still come back and see the result.
    const { c: Z2, r } = await comeBack(Z);
    assert(r.ok);
    assert.strictEqual(Z2.view.phase, 'result');
    assert(Z2.view.result, 'result visible to the returning player');
  },

  async 'host seat moves on after the grace period, and the game carries on'() {
    const [H, X, Y, Z] = await table(['H', 'X', 'Y', 'Z']);
    assert((await H.emit('start')).ok);
    await wait(100);
    H.socket.close();
    await wait(300);
    assert.strictEqual(X.view.hostId, H.id, 'host seat is held during the grace period');

    await wait(GRACE + 600);
    assert.notStrictEqual(X.view.hostId, H.id, 'host passed to someone else');
    assert.strictEqual(seat(X, { id: X.view.hostId })?.connected, true, 'new host is online');

    // The remaining players are not stuck waiting for the missing alibi.
    for (const c of [X, Y, Z]) assert((await c.emit('alibi', { text: 'here' })).ok);
    await wait(150);
    assert.strictEqual(X.view.phase, 'discuss', 'game moved on without the missing player');

    // The old host returns as an ordinary player.
    const { c: H2, r } = await comeBack(H);
    assert(r.ok);
    assert.notStrictEqual(H2.view.hostId, H.id, 'old host does not get the host seat back');
    assert.strictEqual((await H2.emit('advance')).ok, false, 'old host has no host powers');
  },

  async 'lobby seat is released after the grace period'() {
    const [A, , C] = await table(['A', 'B', 'C']);
    C.socket.close();
    await wait(GRACE + 600);
    assert.strictEqual(A.view.players.length, 2, 'dropped player removed from the lobby');
    const { r } = await comeBack(C);
    assert.strictEqual(r.ok, false, 'cannot rejoin a released seat');
  },

  async 'leaving on purpose frees the seat immediately'() {
    const [A, B] = await table(['A', 'B', 'C']);
    assert((await B.emit('leave')).ok);
    await wait(150);
    assert.strictEqual(A.view.players.length, 2, 'seat freed right away');
    assert.strictEqual((await comeBack(B)).r.ok, false, 'cannot rejoin after leaving');
  },

  async 'an abandoned room is cleaned up'() {
    const players = await table(['A', 'B', 'C']);
    for (const p of players) p.socket.close();
    await wait(GRACE + 600);
    const { r } = await comeBack(players[0]);
    assert.strictEqual(r.ok, false);
    assert(/no longer exists/.test(r.error), `room is gone (got: ${r.error})`);
  },
};

(async () => {
  await Promise.all(
    Object.entries(scenarios).map(async ([name, fn]) => {
      try {
        await fn.call(scenarios);
        console.log(`ok   ${name}`);
      } catch (e) {
        e.message = `[${name}] ${e.message}`;
        throw e;
      }
    }),
  );
  console.log('All reconnect checks passed.');
  opened.forEach((c) => c.socket.close());
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
