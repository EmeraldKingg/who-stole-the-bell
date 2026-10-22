// Map engine rules: movement, walls, doorways, vision, steal and report. Pure logic, no server needed.
const assert = require('assert');
const w = require('./world');

const NOW = 1_000_000;
const fresh = (n = 4) => w.createWorld(Array.from({ length: n }, (_, i) => `p${i}`), NOW);
const place = (world, id, x, y) => {
  world.players[id].x = x;
  world.players[id].y = y;
};
const run = (world, seconds, dt = 0.05) => {
  for (let t = 0; t < seconds; t += dt) w.step(world, dt);
};

// --- The map itself ---------------------------------------------------------------------------------------

(function mapIsSound() {
  for (let i = 0; i < 12; i++) {
    const s = w.spawnPoint(i);
    assert(!w.blockedAt(s.x, s.y), `spawn point ${i} is not inside a wall or table`);
  }

  // Flood-fill from the spawn point: every room and every table must be reachable on foot.
  const CELL = 10;
  const cols = w.WORLD.w / CELL;
  const rows = w.WORLD.h / CELL;
  const seen = new Uint8Array(cols * rows);
  const start = w.spawnPoint(0);
  const queue = [[Math.round(start.x / CELL), Math.round(start.y / CELL)]];
  seen[queue[0][1] * cols + queue[0][0]] = 1;
  const reached = [];
  while (queue.length) {
    const [cx, cy] = queue.pop();
    reached.push([cx * CELL, cy * CELL]);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[ny * cols + nx]) continue;
      if (w.blockedAt(nx * CELL, ny * CELL)) continue;
      seen[ny * cols + nx] = 1;
      queue.push([nx, ny]);
    }
  }
  for (const zone of w.ZONES) {
    const inZone = reached.filter(([x, y]) => w.zoneAt(x, y) === zone.name);
    assert(inZone.length > 50, `${zone.name} can be reached on foot (${inZone.length} cells)`);
  }
  for (const t of w.TABLES) {
    const close = reached.filter(([x, y]) => Math.hypot(x - t.x, y - t.y) <= w.STEAL_RANGE - 5);
    assert(close.length >= 8, `${t.name}: there is room to stand close enough to steal its bell`);
  }
  console.log(`ok   map: spawns are clear, all ${w.ZONES.length} rooms and ${w.TABLES.length} tables reachable on foot`);
})();

// --- Movement ---------------------------------------------------------------------------------------------

(function movement() {
  const world = fresh();
  place(world, 'p0', 800, 700);
  w.setInput(world, 'p0', 1, 0);
  w.step(world, 0.05);
  assert(Math.abs(world.players.p0.x - (800 + w.SPEED * 0.05)) < 1e-9, 'moves speed * dt');

  // Going diagonally is not faster than going straight.
  place(world, 'p1', 800, 700);
  w.setInput(world, 'p1', 1, 1);
  w.step(world, 0.05);
  const moved = Math.hypot(world.players.p1.x - 800, world.players.p1.y - 700);
  assert(Math.abs(moved - w.SPEED * 0.05) < 1e-9, 'diagonal speed is not boosted');

  // A cheating or buggy client can't ask for more speed or send junk.
  w.setInput(world, 'p2', 100, 0);
  assert.strictEqual(world.players.p2.dx, 1, 'oversized input is clamped');
  w.setInput(world, 'p2', NaN, 'x');
  assert.strictEqual(world.players.p2.dx + world.players.p2.dy, 0, 'junk input means standing still');
  w.setInput(world, 'nobody', 1, 0); // unknown player: ignored, no crash
  console.log('ok   movement: speed, diagonals and bad input');
})();

(function walls() {
  // Outer wall
  let world = fresh();
  place(world, 'p0', 60, 700);
  w.setInput(world, 'p0', -1, 0);
  run(world, 3);
  assert(world.players.p0.x >= 24 + w.PLAYER_RADIUS - 1e-9, `stops at the outer wall (x=${world.players.p0.x})`);

  // Interior wall: the kitchen wall at x=100 has no door
  world = fresh();
  place(world, 'p0', 100, 380);
  w.setInput(world, 'p0', 0, 1);
  run(world, 3);
  assert(world.players.p0.y <= 408 - w.PLAYER_RADIUS + 1e-9, `can't walk through a wall (y=${world.players.p0.y})`);

  // ...but the doorway at x 190-310 lets you through
  world = fresh();
  place(world, 'p0', 250, 380);
  w.setInput(world, 'p0', 0, 1);
  run(world, 1.5);
  assert(world.players.p0.y > 450, `walks through a doorway (y=${world.players.p0.y})`);

  // Sliding: pushing diagonally into a wall keeps you moving along it
  world = fresh();
  place(world, 'p0', 100, 380);
  w.setInput(world, 'p0', 1, 1);
  run(world, 0.5);
  assert(world.players.p0.x > 140, `slides along the wall (x=${world.players.p0.x})`);
  assert(world.players.p0.y <= 408 - w.PLAYER_RADIUS + 1e-9, 'and still can not enter it');

  // A lag spike must not let anyone skip through a wall
  world = fresh();
  place(world, 'p0', 100, 390);
  w.setInput(world, 'p0', 0, 1);
  w.step(world, 5);
  assert(world.players.p0.y <= 408 - w.PLAYER_RADIUS + 1e-9, `no tunnelling after a slow tick (y=${world.players.p0.y})`);

  // Tables are solid
  world = fresh();
  place(world, 'p0', 800, 560);
  w.setInput(world, 'p0', -1, 0);
  run(world, 3);
  assert(world.players.p0.x >= 640 + 45 + w.PLAYER_RADIUS - 1e-9, `can't walk through a table (x=${world.players.p0.x})`);
  console.log('ok   walls: outer, interior, doorways, sliding, lag spikes, tables');
})();

// --- Vision -----------------------------------------------------------------------------------------------

(function vision() {
  assert(w.canSeePoint(560, 700, 760, 700), 'same room, close: visible');
  assert(!w.canSeePoint(480 + 30, 700, 480 + 30 + w.VISION + 10, 700), 'too far: hidden');
  assert(!w.canSeePoint(100, 380, 100, 460), 'close but a wall in between: hidden');
  assert(w.canSeePoint(250, 380, 250, 460), 'through a doorway: visible');
  assert(w.canSeePoint(560, 560, 720, 560), 'tables and furniture do not block sight');

  const world = fresh(3);
  place(world, 'p0', 560, 700);
  place(world, 'p1', 700, 700); // close, same room
  place(world, 'p2', 100, 460); // far, other room
  const snap = w.snapshotFor(world, 'p0', false, NOW);
  assert.deepStrictEqual(snap.others.map((o) => o.id), ['p1'], 'only players you can see are sent');
  assert(!JSON.stringify(snap).includes('p2'), 'hidden players do not appear anywhere in the snapshot');
  assert(snap.where === 'Dining Room', 'reports the room you are in');
  assert('T1' in snap.bells && !('P1' in snap.bells), 'only the bell stands in view are reported');
  assert(!('dx' in snap.others[0]), "other players' raw input is not sent");
  console.log('ok   vision: range, walls, doorways, furniture, and nothing hidden leaks into snapshots');
})();

// --- Stealing and reporting ---------------------------------------------------------------------------------

(function stealing() {
  const world = fresh();
  const t1 = w.TABLES.find((t) => t.id === 'T1');

  place(world, 'p0', t1.x + 60, t1.y);
  assert(w.steal(world, 'p0', false, NOW).error, 'a Patron cannot steal');
  assert.strictEqual(world.bells.T1, true, 'and nothing was taken');

  place(world, 'p0', 800, 700);
  assert(w.steal(world, 'p0', true, NOW).error, 'the Thief must be next to a bell');

  place(world, 'p0', t1.x + 60, t1.y);
  assert.strictEqual(w.snapshotFor(world, 'p0', true, NOW).hint.steal, 'T1', 'the Thief is offered the steal');
  assert.strictEqual(w.snapshotFor(world, 'p1', false, NOW).hint.steal, null, 'Patrons are never offered it');

  const res = w.steal(world, 'p0', true, NOW);
  assert(res.ok && res.table === 'T1', 'the Thief steals the bell');
  assert.strictEqual(world.bells.T1, false, 'the stand is empty');
  assert.strictEqual(world.stolenBy, 'p0');
  assert(w.steal(world, 'p0', true, NOW).error, 'only one bell can be taken');
  assert.strictEqual(w.snapshotFor(world, 'p0', true, NOW).carrying, true, 'the Thief knows they are carrying it');
  assert.strictEqual(w.snapshotFor(world, 'p0', false, NOW).carrying, false, 'nobody else is told who carries it');

  // The empty stand is visible to anyone who can see the table
  place(world, 'p1', t1.x + 150, t1.y); // (150px to the left would put them inside the wall at x=480)
  assert.strictEqual(w.snapshotFor(world, 'p1', false, NOW).bells.T1, false, 'passers-by can see the empty stand');
  place(world, 'p2', 100, 460);
  assert(!('T1' in w.snapshotFor(world, 'p2', false, NOW).bells), 'but not from another room');

  // Closing time: no stealing after the lockout
  const late = fresh();
  place(late, 'p0', t1.x + 60, t1.y);
  late.lockoutAt = NOW - 1;
  assert(w.steal(late, 'p0', true, NOW).error, 'the Thief cannot steal once the restaurant is closing');
  console.log('ok   stealing: only the Thief, only near a bell, only once, not at closing time');
})();

(function reporting() {
  const world = fresh();
  const t2 = w.TABLES.find((t) => t.id === 'T2');
  place(world, 'p0', t2.x + 60, t2.y);
  assert(w.report(world, 'p0', NOW).error, 'nothing to report while every bell is in place');

  place(world, 'p1', t2.x - 60, t2.y);
  w.steal(world, 'p1', true, NOW);
  assert.strictEqual(w.snapshotFor(world, 'p0', false, NOW).hint.report, 'T2', 'standing at the empty stand offers a report');
  const ok = w.report(world, 'p0', NOW);
  assert(ok.ok && ok.table === 'T2', 'a Patron can report the empty stand');

  place(world, 'p0', 800, 700);
  assert(w.report(world, 'p0', NOW).error, 'far from the stand: cannot report');
  assert.strictEqual(w.snapshotFor(world, 'p0', false, NOW).hint.report, null);
  console.log('ok   reporting: only at an empty stand, only when close');
})();

(function timing() {
  const world = w.createWorld(['a', 'b'], NOW);
  assert.strictEqual(world.endsAt, NOW + w.NIGHT_SECONDS * 1000, 'night length comes from NIGHT_SECONDS');
  assert(world.lockoutAt <= world.endsAt, 'lockout is not after closing');
  console.log('ok   timing');
})();

console.log('All world checks passed.');
