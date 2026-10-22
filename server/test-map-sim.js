// Map mode over real sockets: walking is server-controlled, snapshots stream, a bot walks to a table,
// steals the bell and gets reported into the discussion, and closing time ends the round.
// Run via `npm test` (run-tests.js starts a server with NIGHT_SECONDS=8, STEAL_LOCKOUT_SECONDS=0, DISCUSS_SECONDS=2).
const { io } = require('socket.io-client');
const assert = require('assert');

const URL = process.env.URL || 'http://localhost:3001';
const SPEED = 170; // must match world.js
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const opened = [];

function open() {
  return new Promise((resolve) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true });
    const c = { socket, view: null, world: null, worlds: 0, lastWorldAt: 0, id: null, name: null };
    socket.on('state', (v) => (c.view = v));
    socket.on('world', (w) => {
      c.world = w;
      c.worlds++;
      c.lastWorldAt = Date.now();
    });
    c.emit = (event, payload) => new Promise((res) => socket.emit(event, payload, res));
    c.input = (dx, dy) => socket.emit('input', { dx, dy });
    socket.on('connect', () => resolve(c));
    opened.push(c);
  });
}

// A table of `n` players in map mode, already started (so the clock is running).
async function startedMapTable(n) {
  const host = await open();
  host.name = 'P0';
  const created = await host.emit('create', { name: 'P0' });
  assert(created.ok);
  const all = [host];
  for (let i = 1; i < n; i++) {
    const c = await open();
    c.name = `P${i}`;
    assert((await c.emit('join', { code: created.code, name: c.name })).ok);
    all.push(c);
  }
  await wait(100);
  all.forEach((c) => (c.id = c.view.meId));
  assert((await host.emit('mode', { mode: 'map' })).ok, 'host picks map mode');
  await wait(100);
  assert((await host.emit('start')).ok, 'map game starts');
  await wait(250);
  return all;
}

// Walk a player to a point, slowing down near it so they don't overshoot. Resends input every tick.
async function walkTo(c, tx, ty, maxMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const me = c.world && c.world.me;
    if (me) {
      const dx = tx - me.x;
      const dy = ty - me.y;
      const d = Math.hypot(dx, dy);
      if (d < 8) {
        c.input(0, 0);
        return true;
      }
      const k = Math.min(1, d / 40) / d;
      c.input(dx * k, dy * k);
    }
    await wait(50);
  }
  c.input(0, 0);
  return false;
}

const T1 = { x: 640, y: 560 }; // Table 1 (see world.js)

const scenarios = {
  async 'mode, start, snapshots and walking'() {
    const host = await open();
    const created = await host.emit('create', { name: 'Host' });
    const g1 = await open();
    const g2 = await open();
    assert((await g1.emit('join', { code: created.code, name: 'G1' })).ok);
    assert((await g2.emit('join', { code: created.code, name: 'G2' })).ok);
    await wait(100);
    assert.strictEqual(host.view.mode, 'classic', 'tables start in classic mode');
    assert.strictEqual((await g1.emit('mode', { mode: 'map' })).ok, false, 'only the host picks the mode');
    assert((await host.emit('mode', { mode: 'map' })).ok);
    await wait(100);
    assert([host, g1, g2].every((c) => c.view.mode === 'map'), 'everyone sees the mode');
    assert.strictEqual(host.worlds, 0, 'no world snapshots in the lobby');

    assert((await host.emit('start')).ok);
    await wait(500);
    assert.strictEqual(host.view.phase, 'play', 'map mode goes straight to the play phase');
    assert(host.worlds >= 5, `snapshots stream while playing (got ${host.worlds} in ~0.5s)`);
    const snap = host.world;
    assert(snap.me && Array.isArray(snap.others) && snap.where && snap.endsAt > snap.now, 'snapshot has what the screen needs');
    assert.strictEqual(snap.others.length, 2, 'players who are close and in sight are listed');
    assert(!/thief|role|accomplice|token|socket/i.test(JSON.stringify(snap)), 'a snapshot says nothing about roles');

    // Walking: the server moves you at its own speed.
    const before = { ...g1.world.me };
    g1.input(0, -1);
    await wait(600);
    g1.input(0, 0);
    await wait(150);
    const moved = before.y - g1.world.me.y;
    assert(moved > 60 && moved < 140, `walked up about ${Math.round(SPEED * 0.6)}px (got ${Math.round(moved)}px)`);
    assert(Math.abs(g1.world.me.x - before.x) < 2, 'and not sideways');
    const stopped = { ...g1.world.me };
    await wait(250);
    assert.strictEqual(g1.world.me.y, stopped.y, 'stops when told to');

    // A cheating client asking for a huge step is still held to the speed limit.
    const b2 = { ...g2.world.me };
    g2.input(1e6, 1e6);
    await wait(500);
    g2.input(0, 0);
    const d2 = Math.hypot(g2.world.me.x - b2.x, g2.world.me.y - b2.y);
    assert(d2 < SPEED * 0.5 * 1.35, `speed is capped (moved ${Math.round(d2)}px in ~0.5s)`);
    g2.input(NaN, 'x'); // junk is harmless
  },

  async 'a walked-in theft: steal at a table, get reported, discussion starts'() {
    const all = await startedMapTable(4);
    const thief = all.find((c) => c.view.role === 'thief');
    const [reporter, bystander] = all.filter((c) => c !== thief);

    // Patrons can't steal, wherever they stand.
    assert.strictEqual((await reporter.emit('steal')).ok, false, 'a Patron cannot steal');

    assert(await walkTo(thief, T1.x + 60, T1.y), 'thief walks to Table 1');
    await wait(100);
    assert.strictEqual(thief.world.hint.steal, 'T1', 'the Thief is offered the steal at the table');
    assert.strictEqual(thief.world.bells.T1, true, 'the bell is on its stand');
    assert((await thief.emit('steal')).ok, 'the Thief steals the bell');
    await wait(150);
    assert.strictEqual(thief.world.carrying, true, 'the Thief knows they have it');

    // The reporter walks up and sees the empty stand.
    assert(await walkTo(reporter, T1.x + 70, T1.y + 50), 'a Patron walks up to Table 1');
    await wait(150);
    assert.strictEqual(reporter.world.bells.T1, false, 'the Patron sees the empty stand');
    assert.strictEqual(reporter.world.carrying, false, 'and is not told who has the bell');
    assert.strictEqual(reporter.world.hint.report, 'T1', 'and is offered the report');

    assert.strictEqual((await bystander.emit('report')).ok, false, 'someone far away cannot report it');
    assert.strictEqual(all[0].view.phase, 'play', 'still walking around');

    assert((await reporter.emit('report')).ok, 'the Patron reports it');
    await wait(250);
    for (const c of all) {
      assert.strictEqual(c.view.phase, 'discuss', `${c.name} is in the discussion`);
      assert.strictEqual(c.view.report.tableName, 'Table 1');
      assert.strictEqual(c.view.report.byName, reporter.name);
      assert(c.view.discussEndsAt > c.view.serverNow, 'with a countdown');
    }
    const lastWorld = Date.now();
    await wait(300);
    assert(all.every((c) => c.lastWorldAt < lastWorld), 'no more walking snapshots once the discussion starts');
    assert((await reporter.emit('chat', { text: 'the bell at table 1 is gone' })).ok, 'chat is open');
    await wait(2500); // DISCUSS_SECONDS=2 on the test server
    assert.strictEqual(all[0].view.phase, 'vote', 'then the vote, as in classic mode');
  },

  async 'closing time: nothing stolen means the Patrons win'() {
    const all = await startedMapTable(3);
    const t0 = Date.now();
    while (all[0].view.phase === 'play' && Date.now() - t0 < 14000) await wait(200);
    for (const c of all) {
      assert.strictEqual(c.view.phase, 'result', 'the night ends on its own');
      assert.strictEqual(c.view.result.winner, 'patrons');
      assert.strictEqual(c.view.result.reason, 'nothing');
      assert(c.view.result.thiefId, 'and the Thief is revealed');
    }
  },

  async 'closing time: a bell was stolen and nobody caught the Thief, so the Thief wins'() {
    const all = await startedMapTable(3);
    const thief = all.find((c) => c.view.role === 'thief');
    assert(await walkTo(thief, T1.x + 60, T1.y), 'thief walks to Table 1');
    assert((await thief.emit('steal')).ok);
    const t0 = Date.now();
    while (all[0].view.phase === 'play' && Date.now() - t0 < 14000) await wait(200);
    for (const c of all) {
      assert.strictEqual(c.view.phase, 'result');
      assert.strictEqual(c.view.result.winner, 'thief');
      assert.strictEqual(c.view.result.reason, 'closing');
    }
  },

  async 'a lost key-up cannot leave someone running forever'() {
    const all = await startedMapTable(3);
    const p = all[1];
    p.input(0, -1); // sent once, never repeated, never cancelled
    await wait(2200); // longer than the server's 1.5s silence limit
    const a = { ...p.world.me };
    await wait(400);
    assert.strictEqual(p.world.me.y, a.y, 'they have stopped by themselves');
    assert(p.world.me.y < 700, 'after having walked for a while');
  },
};

(async () => {
  await Promise.all(
    Object.entries(scenarios).map(async ([name, fn]) => {
      try {
        await fn();
        console.log(`ok   ${name}`);
      } catch (e) {
        e.message = `[${name}] ${e.message}`;
        throw e;
      }
    }),
  );
  console.log('All map-mode socket checks passed.');
  opened.forEach((c) => c.socket.close());
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
