// Role and red-herring rules, checked over many random games. Pure logic, no server needed.
const assert = require('assert');
const g = require('./game');

function newGame(n) {
  const { room, player: host } = g.createRoom('P0', 's0');
  const players = [host];
  for (let i = 1; i < n; i++) players.push(g.joinRoom(room.code, `P${i}`, `s${i}`).player);
  assert((g.startGame(room, host.id)).room, `start with ${n} players`);
  return { room, host, players };
}

let games = 0;
for (let n = 3; n <= 12; n++) {
  for (let rep = 0; rep < 60; rep++) {
    const { room, players } = newGame(n);
    games++;
    const views = Object.fromEntries(players.map((p) => [p.id, g.viewFor(room, p.id)]));
    const byRole = (r) => players.filter((p) => views[p.id].role === r);
    const thieves = byRole('thief');
    const accomplices = byRole('accomplice');
    const patrons = byRole('patron');
    const label = `${n} players`;

    // Roles: exactly one Thief; an accomplice only with 5+ players; everyone else is a Patron.
    assert.strictEqual(thieves.length, 1, `${label}: one thief`);
    assert.strictEqual(accomplices.length, n >= 5 ? 1 : 0, `${label}: accomplice only with 5+ players`);
    assert.strictEqual(thieves.length + accomplices.length + patrons.length, n, `${label}: everyone has a role`);
    assert.strictEqual(room.thiefId, thieves[0].id);

    // The Thief and accomplice know each other. Nobody else gets a partner.
    if (n >= 5) {
      assert.strictEqual(views[thieves[0].id].partner.id, accomplices[0].id, `${label}: thief knows accomplice`);
      assert.strictEqual(views[accomplices[0].id].partner.id, thieves[0].id, `${label}: accomplice knows thief`);
    } else {
      assert.strictEqual(views[thieves[0].id].partner, null, `${label}: no partner without an accomplice`);
    }
    for (const p of patrons) assert.strictEqual(views[p.id].partner, null, `${label}: patrons get no partner`);

    // Everyone is told whether there's an accomplice, and that's all.
    for (const p of players) assert.strictEqual(views[p.id].hasAccomplice, n >= 5);

    // Red herrings: only Patrons, about half of them, all different.
    const secretHolders = players.filter((p) => views[p.id].secret);
    assert(secretHolders.every((p) => views[p.id].role === 'patron'), `${label}: only patrons get secrets`);
    assert.strictEqual(secretHolders.length, Math.ceil(patrons.length / 2), `${label}: half the patrons get a secret`);
    const clues = secretHolders.map((p) => views[p.id].secret.clue);
    assert.strictEqual(new Set(clues).size, clues.length, `${label}: no two players share a secret`);
    assert(secretHolders.every((p) => views[p.id].secret.truth), `${label}: secret includes the innocent truth`);

    // Nothing about hidden roles leaks into other players' views before the result.
    for (const p of players) {
      const v = views[p.id];
      assert(!('thiefId' in v) && !('accompliceId' in v) && v.result === null, 'no role ids in the view');
      const others = players.filter((o) => o.id !== p.id && views[o.id].secret);
      const text = JSON.stringify(v);
      for (const o of others) assert(!text.includes(views[o.id].secret.clue), "someone else's secret leaked");
    }
  }
}
console.log(`ok   roles and secrets hold across ${games} random games (3-12 players)`);

// Winning: Patrons need the Thief. Voting out the accomplice is not enough.
(function winRules() {
  const { room, players } = newGame(6);
  const accomplice = players.find((p) => p.id === room.accompliceId);
  const thief = players.find((p) => p.id === room.thiefId);
  assert(g.advance(room, room.hostId).room, 'to discussion');
  assert(g.advance(room, room.hostId).room, 'to vote');

  // Everyone except the accomplice votes for the accomplice; the accomplice votes for someone else.
  for (const p of players) {
    const target = p.id === accomplice.id ? players.find((x) => x.id !== accomplice.id) : accomplice;
    assert(g.castVote(room, p.id, target.id).room);
  }
  assert.strictEqual(room.phase, 'result');
  assert.strictEqual(room.result.accusedId, accomplice.id);
  assert.strictEqual(room.result.winner, 'thief', 'voting out the accomplice: Thief team wins');
  assert.strictEqual(room.result.accompliceId, accomplice.id, 'result reveals the accomplice');
  assert.strictEqual(room.result.thiefId, thief.id, 'result reveals the thief');
  assert(room.result.herrings.length > 0, 'result reveals the red herrings');
  const view = g.viewFor(room, players[0].id);
  assert.strictEqual(view.result.accompliceId, accomplice.id);
  console.log('ok   voting out the accomplice is not enough for the Patrons');
})();

(function patronsWin() {
  const { room, players } = newGame(6);
  g.advance(room, room.hostId);
  g.advance(room, room.hostId);
  for (const p of players) {
    const target = p.id === room.thiefId ? players.find((x) => x.id !== p.id) : players.find((x) => x.id === room.thiefId);
    g.castVote(room, p.id, target.id);
  }
  assert.strictEqual(room.result.winner, 'patrons', 'voting out the Thief: Patrons win');
  console.log('ok   voting out the Thief wins for the Patrons');
})();

// A new round reshuffles everything and wipes the old roles.
(function playAgain() {
  const { room, host } = newGame(7);
  room.phase = 'result';
  assert(g.backToLobby(room, host.id).room);
  assert.strictEqual(room.thiefId, null);
  assert.strictEqual(room.accompliceId, null);
  assert.deepStrictEqual(room.herrings, {});
  assert.strictEqual(g.viewFor(room, host.id).role, null, 'no role in the lobby');
  assert(g.startGame(room, host.id).room, 'second round starts');
  assert(room.thiefId && room.accompliceId);
  console.log('ok   a new round starts from a clean slate');
})();

console.log('All role checks passed.');
