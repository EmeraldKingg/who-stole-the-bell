// Map mode inside a room: mode switch, walking, stealing, reporting into the vote, closing time.
// Pure logic, no server needed (the clock is passed in, so nothing here waits).
const assert = require('assert');
const g = require('./game');
const world = require('./world');

function newMapGame(n = 5) {
  const { room, player: host } = g.createRoom('P0', 's0');
  const players = [host];
  for (let i = 1; i < n; i++) players.push(g.joinRoom(room.code, `P${i}`, `s${i}`).player);
  assert(g.setMode(room, host.id, 'map').room, 'host can pick map mode');
  assert(g.startGame(room, host.id).room, 'map game starts');
  const thief = players.find((p) => p.id === room.thiefId);
  const patrons = players.filter((p) => p.id !== room.thiefId);
  return { room, host, players, thief, patrons };
}
const place = (room, id, x, y) => {
  room.world.players[id].x = x;
  room.world.players[id].y = y;
};
const T1 = world.TABLES.find((t) => t.id === 'T1');
const T2 = world.TABLES.find((t) => t.id === 'T2');

(function modeSwitch() {
  const { room, player: host } = g.createRoom('Host', 'sh');
  const guest = g.joinRoom(room.code, 'Guest', 'sg').player;
  assert.strictEqual(room.mode, 'classic', 'classic is the default');
  assert.strictEqual(g.viewFor(room, host.id).mode, 'classic');
  assert(g.setMode(room, guest.id, 'map').error, 'only the host picks the mode');
  assert(g.setMode(room, host.id, 'nonsense').error, 'unknown modes are refused');
  assert(g.setMode(room, host.id, 'map').room);
  assert.strictEqual(g.viewFor(room, guest.id).mode, 'map', 'everyone sees the mode');
  g.joinRoom(room.code, 'Third', 'st');
  assert(g.startGame(room, host.id).room);
  assert(g.setMode(room, host.id, 'classic').error, 'cannot switch once the game has started');
  assert.strictEqual(room.phase, 'play', 'map mode starts in the play phase, not the alibi phase');
  console.log('ok   mode: classic by default, host-only, lobby-only, map starts in play');
})();

(function classicIsUntouched() {
  const { room, player: host } = g.createRoom('P0', 's0');
  for (let i = 1; i < 4; i++) g.joinRoom(room.code, `P${i}`, `s${i}`);
  assert(g.startGame(room, host.id).room);
  assert.strictEqual(room.phase, 'alibi', 'classic still starts with alibis');
  assert.strictEqual(room.world, null, 'and has no world');
  assert.strictEqual(g.worldFor(room, host.id), null, 'no world snapshots in classic');
  console.log('ok   classic mode is unchanged');
})();

(function startingAMapGame() {
  const { room, players, thief } = newMapGame(6);
  assert.strictEqual(Object.keys(room.world.players).length, 6, 'everyone is in the restaurant');
  for (const p of players) {
    const pos = room.world.players[p.id];
    assert(!world.blockedAt(pos.x, pos.y), 'nobody spawns inside a wall');
  }
  assert(thief && g.viewFor(room, thief.id).role === 'thief', 'roles are assigned as usual');
  assert(room.world.endsAt > Date.now(), 'closing time is in the future');
  console.log('ok   starting: everyone spawns in the open, roles assigned, closing time set');
})();

(function walking() {
  const { room, patrons } = newMapGame();
  const p = patrons[0];
  const t0 = room.lastTick;
  const x0 = room.world.players[p.id].x;
  g.setInput(room, p.id, 1, 0, t0);
  g.tickWorld(room, t0 + 50);
  assert(room.world.players[p.id].x > x0, 'input moves a player');

  // Silent for too long: they stop (a missed key-up must not leave anyone running forever).
  const x1 = room.world.players[p.id].x;
  g.tickWorld(room, t0 + 5000);
  assert.strictEqual(room.world.players[p.id].x, x1, 'stale input is ignored');

  // Offline players stand still.
  g.setInput(room, p.id, 1, 0, t0 + 5000);
  p.connected = false;
  g.tickWorld(room, t0 + 5050);
  assert.strictEqual(room.world.players[p.id].x, x1, 'offline players do not walk');
  p.connected = true;

  g.setInput(room, p.id, 1, 0, t0 + 6000);
  g.tickWorld(room, t0 + 6050);
  assert(room.world.players[p.id].x > x1, 'and walk again once back');

  // Input outside the play phase is ignored.
  const other = newMapGame();
  other.room.phase = 'vote';
  g.setInput(other.room, other.patrons[0].id, 1, 0);
  assert.strictEqual(other.room.world.players[other.patrons[0].id].dx, 0, 'no walking while voting');
  console.log('ok   walking: moves, stops on stale input, offline players stand still');
})();

(function stealingAndReporting() {
  const { room, host, thief, patrons } = newMapGame(5);
  const [a, b] = patrons;

  // A Patron cannot steal, wherever they stand.
  place(room, a.id, T1.x + 60, T1.y);
  assert(g.stealBell(room, a.id).error, 'a Patron cannot steal');
  assert.strictEqual(room.world.bells.T1, true);

  // The Thief must be close.
  place(room, thief.id, 800, 700);
  assert(g.stealBell(room, thief.id).error, 'the Thief must be next to a bell');

  // Nothing to report while every bell is in place.
  place(room, a.id, T2.x + 60, T2.y);
  assert(g.reportBell(room, a.id).error, 'nothing to report yet');
  assert.strictEqual(room.phase, 'play');

  // The Thief steals T2's bell.
  place(room, thief.id, T2.x - 60, T2.y);
  assert(g.stealBell(room, thief.id).room, 'the Thief steals');
  assert.strictEqual(room.world.bells.T2, false);
  assert.strictEqual(g.worldFor(room, thief.id).carrying, true, 'the Thief knows');
  assert.strictEqual(g.worldFor(room, a.id).carrying, false, 'nobody else is told who has it');
  assert.strictEqual(g.worldFor(room, a.id).bells.T2, false, 'but a passer-by sees the empty stand');

  // Far away: cannot report. Close: can.
  place(room, b.id, 800, 800);
  assert(g.reportBell(room, b.id).error, 'cannot report from across the room');
  assert.strictEqual(room.phase, 'play');

  g.setInput(room, b.id, 1, 0);
  const res = g.reportBell(room, a.id);
  assert(res.room, 'a Patron at the empty stand can report it');
  assert.strictEqual(room.phase, 'discuss', 'a report calls the discussion');
  assert(room.discussEndsAt > Date.now(), 'with a countdown');
  assert.strictEqual(room.world.players[b.id].dx, 0, 'everyone stops walking');
  const view = g.viewFor(room, host.id);
  assert.strictEqual(view.report.tableName, 'Table 2');
  assert.strictEqual(view.report.byName, a.name);
  assert(!('thiefId' in view), 'the report does not reveal the Thief');
  assert.strictEqual(g.worldFor(room, a.id), null, 'no more walking snapshots during the discussion');
  assert(g.sendChat(room, a.id, 'who was by table 2?').room, 'chat is open in the discussion');

  // Then the usual vote. Everyone votes for the Thief: Patrons win.
  assert(g.advance(room, room.hostId).room, 'host ends the discussion');
  assert.strictEqual(room.phase, 'vote');
  const all = [thief, ...patrons];
  for (const p of all) {
    const target = p.id === thief.id ? patrons[0] : thief;
    assert(g.castVote(room, p.id, target.id).room);
  }
  assert.strictEqual(room.phase, 'result');
  assert.strictEqual(room.result.winner, 'patrons');
  assert.strictEqual(room.result.reason, 'vote');
  console.log('ok   steal and report: only the Thief steals, only near a bell; report leads to discussion and vote');
})();

(function wrongVoteLetsTheThiefWin() {
  const { room, thief, patrons } = newMapGame(5);
  place(room, thief.id, T1.x + 60, T1.y);
  g.stealBell(room, thief.id);
  place(room, patrons[0].id, T1.x - 60, T1.y);
  g.reportBell(room, patrons[0].id);
  g.advance(room, room.hostId);
  for (const p of [thief, ...patrons]) g.castVote(room, p.id, p.id === patrons[1].id ? patrons[2].id : patrons[1].id);
  assert.strictEqual(room.result.winner, 'thief', 'voting out an innocent lets the Thief win');
  console.log('ok   a wrong vote still lets the Thief win');
})();

(function closingTime() {
  // Bell stolen, nobody caught the Thief: the Thief wins at closing time.
  let { room, thief } = newMapGame(5);
  place(room, thief.id, T1.x + 60, T1.y);
  g.stealBell(room, thief.id);
  g.tickWorld(room, room.world.endsAt - 1000);
  assert.strictEqual(room.phase, 'play', 'still going before closing');
  g.tickWorld(room, room.world.endsAt + 1);
  assert.strictEqual(room.phase, 'result');
  assert.strictEqual(room.result.winner, 'thief');
  assert.strictEqual(room.result.reason, 'closing');
  assert.strictEqual(room.result.thiefId, thief.id, 'the result reveals the Thief');

  // Nothing stolen by closing: the Patrons win.
  ({ room } = newMapGame(5));
  g.tickWorld(room, room.world.endsAt + 1);
  assert.strictEqual(room.result.winner, 'patrons');
  assert.strictEqual(room.result.reason, 'nothing');

  // Stealing is locked in the last stretch before closing.
  ({ room, thief } = newMapGame(5));
  place(room, thief.id, T1.x + 60, T1.y);
  assert(g.stealBell(room, thief.id, room.world.lockoutAt + 1).error, 'too late to steal near closing');
  console.log('ok   closing time: Thief wins if a bell is gone, Patrons win if not, no late steals');
})();

(function thiefLeaves() {
  const { room, thief } = newMapGame(5);
  g.disconnectPlayer(room, thief.id);
  g.expirePlayer(room, thief.id);
  assert.strictEqual(room.world.players[thief.id], undefined, 'the leaver is removed from the restaurant');
  g.tickWorld(room, room.lastTick + 50);
  assert.strictEqual(room.phase, 'result');
  assert.strictEqual(room.result.winner, 'patrons');
  assert.strictEqual(room.result.reason, 'left');
  console.log('ok   if the Thief leaves, the Patrons win');
})();

(function rejoiningWhileWalking() {
  const { room, patrons } = newMapGame(5);
  const p = patrons[0];
  const token = p.token;
  g.disconnectPlayer(room, p.id);
  g.expirePlayer(room, p.id);
  assert.strictEqual(room.world.players[p.id], undefined);
  const res = g.rejoin(room.code, token, 'new-socket');
  assert(res.room, 'a written-off player can rejoin');
  const pos = room.world.players[p.id];
  assert(pos && !world.blockedAt(pos.x, pos.y), 'and is back in the restaurant, in the open');
  assert(g.worldFor(room, p.id), 'and gets snapshots again');
  console.log('ok   rejoining mid-round puts you back in the restaurant');
})();

(function nothingHiddenLeaks() {
  const { room, thief, patrons } = newMapGame(6);
  // Put everyone in one spot where they can all see each other.
  for (const p of [thief, ...patrons]) place(room, p.id, 800 + Math.random() * 40, 700 + Math.random() * 40);
  for (const p of patrons) {
    const snap = g.worldFor(room, p.id);
    const text = JSON.stringify(snap);
    assert.strictEqual(snap.carrying, false);
    assert(!/thief|role|accomplice|token|socket/i.test(text), 'the snapshot says nothing about roles');
    assert.strictEqual(snap.others.length, 5, 'everyone in view is listed, and nothing marks the Thief');
  }
  // The room-level view does not carry the world or anyone's role but your own.
  const view = g.viewFor(room, patrons[0].id);
  assert(!('world' in view) && !('thiefId' in view) && !('positions' in view));
  console.log('ok   nothing in a snapshot or view marks the Thief');
})();

console.log('All map-mode checks passed.');
