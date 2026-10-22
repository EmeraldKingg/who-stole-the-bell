// Pure game logic for "Who Stole the Bell?" - no networking in here, so it's easy to test.
//
// Players have a stable public `id` (used everywhere in game state), a secret `token` (only ever
// sent to that player, used to rejoin after a dropped connection) and a `socketId` (which changes
// every time they reconnect). Views sent to clients never contain tokens or socket ids.

const crypto = require('crypto');
const world = require('./world');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
// How long the group chat discussion lasts. Override with DISCUSS_SECONDS (the tests use a short one).
const DISCUSS_SECONDS = Number(process.env.DISCUSS_SECONDS) || 59;
const MAX_CHAT_MESSAGES = 200;
// With this many players or more, one Patron is secretly made the Thief's accomplice and holds the bell.
const ACCOMPLICE_MIN_PLAYERS = 5;

// Red herrings: harmless things that look suspicious. Some Patrons get one as a private secret.
// `clue` is the suspicious part, `truth` is the innocent explanation (both are only shown to that player
// until the result screen).
const HERRINGS = [
  { clue: 'You have a shiny object in your pocket.', truth: "It's your house key." },
  { clue: 'You left the table twice to take a phone call.', truth: 'It was your mum checking you were OK.' },
  { clue: 'You were seen pocketing something small.', truth: 'It was a mint from the counter.' },
  { clue: 'You were the last one out of the restaurant.', truth: 'You went back for your jacket.' },
  { clue: 'You hid something under the table.', truth: 'It was your sunglasses.' },
  { clue: 'You tapped the bell once, just to hear it.', truth: "It was still on the table afterwards. You'd swear to it." },
  { clue: 'You were whispering with the waiter.', truth: 'You were asking where the toilets were.' },
  { clue: 'Your bag was heavier on the way out.', truth: 'Leftovers in a takeaway box.' },
  { clue: 'You wandered into the kitchen.', truth: 'You were looking for the toilets (again).' },
  { clue: 'You were fiddling with something metal.', truth: "It's a bracelet with a loose clasp." },
  { clue: 'You laughed far too loudly when the bell went missing.', truth: "You'd just remembered an old joke." },
  { clue: 'You kept glancing at the door.', truth: "You were waiting for a ride that never came." },
];

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they look like 1 and 0
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newPlayer(socketId, name) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    socketId,
    name: cleanName(name),
    connected: true, // false while their phone is offline (shown as "away")
    gone: false, // true once they've been offline longer than the grace period, or left on purpose
  };
}

function createRoom(hostName, socketId) {
  const code = makeCode();
  const host = newPlayer(socketId, hostName);
  const room = {
    code,
    hostId: host.id,
    // 'classic': lobby -> alibi -> discuss -> vote -> result
    // 'map':     lobby -> play (walk around) -> discuss -> vote -> result
    mode: 'classic',
    phase: 'lobby',
    players: [host],
    world: null, // map mode only: positions, bells, closing time (see world.js)
    inputAt: {}, // playerId -> when we last heard which way they want to walk
    lastTick: 0,
    report: null, // map mode: who reported the empty bell stand, and where
    thiefId: null,
    accompliceId: null, // only set with enough players
    herrings: {}, // playerId -> { clue, truth }, for the Patrons who got a red herring
    alibis: {}, // playerId -> text
    chat: [], // { id, playerId, name, text, ts }
    discussEndsAt: null, // ms timestamp, set when the discussion starts
    nextMsgId: 1,
    votes: {}, // voterId -> suspectId
    result: null,
  };
  rooms.set(code, room);
  return { room, player: host };
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 16) || 'Anonymous';
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase().trim());
}

function joinRoom(code, name, socketId) {
  const room = getRoom(code);
  if (!room) return { error: 'Room not found.' };
  if (room.phase !== 'lobby') return { error: 'Game already started.' };
  if (room.players.length >= MAX_PLAYERS) return { error: 'Room is full.' };
  const clean = cleanName(name);
  if (room.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
    return { error: 'That name is taken in this room.' };
  }
  const player = newPlayer(socketId, clean);
  room.players.push(player);
  return { room, player };
}

// A player whose phone dropped comes back with their token and gets the same seat (same id, same role).
function rejoin(code, token, socketId) {
  const room = getRoom(code);
  if (!room) return { error: 'That table no longer exists.' };
  const wanted = String(token || '');
  const player = wanted && room.players.find((p) => p.token === wanted);
  if (!player) return { error: 'Your seat at that table is gone.' };
  const previousSocketId = player.socketId;
  player.socketId = socketId;
  player.connected = true;
  player.gone = false;
  // Back during a walk-around round after being written off: put them back in the restaurant.
  if (room.world && !room.world.players[player.id]) {
    const s = world.spawnPoint(room.players.indexOf(player));
    room.world.players[player.id] = { x: s.x, y: s.y, face: 0, dx: 0, dy: 0 };
  }
  return { room, player, previousSocketId };
}

// Phone went offline. They keep their seat; the server decides later (expirePlayer) if they're really gone.
function disconnectPlayer(room, playerId) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return;
  p.connected = false;
  p.socketId = null;
}

// Called when the grace period runs out. Does nothing if the player already came back.
function expirePlayer(room, playerId) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p || p.connected) return { deleted: false };
  p.gone = true;
  if (room.world) delete room.world.players[playerId]; // no motionless ghost left standing in the restaurant
  if (room.phase === 'lobby') room.players = room.players.filter((x) => x.id !== playerId);

  if (room.players.every((x) => x.gone)) {
    rooms.delete(room.code);
    return { deleted: true };
  }
  if (room.hostId === playerId) {
    const next = room.players.find((x) => !x.gone && x.connected) || room.players.find((x) => !x.gone);
    if (next) room.hostId = next.id;
  }
  // The game may have been waiting on this player.
  checkProgress(room);
  return { deleted: false };
}

// Leaving on purpose skips the grace period.
function leavePlayer(room, playerId) {
  disconnectPlayer(room, playerId);
  return expirePlayer(room, playerId);
}

// Move on automatically once everyone who is still in the game has done their part.
function checkProgress(room) {
  const active = room.players.filter((p) => !p.gone);
  if (active.length === 0) return;
  if (room.phase === 'alibi' && active.every((p) => room.alibis[p.id])) startDiscussion(room);
  else if (room.phase === 'vote' && active.every((p) => room.votes[p.id])) finishVote(room);
}

function startGame(room, requesterId) {
  if (requesterId !== room.hostId) return { error: 'Only the host can start.' };
  if (room.phase !== 'lobby' && room.phase !== 'result') return { error: 'Game already running.' };
  const live = room.players.filter((p) => p.connected && !p.gone);
  if (live.length < MIN_PLAYERS) return { error: `Need at least ${MIN_PLAYERS} players online.` };
  resetRound(room);

  // Everyone is shuffled once, then handed out in order: Thief, (accomplice), then Patrons.
  const order = shuffled(live);
  const thief = order.shift();
  room.thiefId = thief.id;
  if (live.length >= ACCOMPLICE_MIN_PLAYERS) room.accompliceId = order.shift().id;

  // About half of the remaining Patrons get a different red herring each.
  const withSecret = order.slice(0, Math.ceil(order.length / 2));
  const herrings = shuffled(HERRINGS);
  withSecret.forEach((p, i) => {
    room.herrings[p.id] = herrings[i % herrings.length];
  });

  if (room.mode === 'map') {
    const now = Date.now();
    room.world = world.createWorld(room.players.filter((p) => !p.gone).map((p) => p.id), now);
    room.lastTick = now;
    room.phase = 'play';
  } else {
    room.phase = 'alibi';
  }
  return { room };
}

// The host picks how this table is played, before the game starts.
function setMode(room, requesterId, mode) {
  if (requesterId !== room.hostId) return { error: 'Only the host can do that.' };
  if (room.phase !== 'lobby') return { error: 'Pick a mode before the game starts.' };
  if (mode !== 'classic' && mode !== 'map') return { error: 'Unknown mode.' };
  room.mode = mode;
  return { room };
}

function resetRound(room) {
  room.world = null;
  room.inputAt = {};
  room.report = null;
  room.thiefId = null;
  room.accompliceId = null;
  room.herrings = {};
  room.alibis = {};
  room.votes = {};
  room.chat = [];
  room.nextMsgId = 1;
  room.discussEndsAt = null;
  room.result = null;
}

function submitAlibi(room, playerId, text) {
  if (room.phase !== 'alibi') return { error: 'Not the alibi phase.' };
  if (!room.players.some((p) => p.id === playerId)) return { error: 'Not in this room.' };
  const clean = String(text || '').trim().slice(0, 140);
  if (!clean) return { error: 'Write something.' };
  room.alibis[playerId] = clean;
  checkProgress(room);
  return { room };
}

function startDiscussion(room, now = Date.now()) {
  room.phase = 'discuss';
  room.discussEndsAt = now + DISCUSS_SECONDS * 1000;
}

function startVote(room) {
  room.phase = 'vote';
  room.discussEndsAt = null;
}

// Host moves the game along: alibi -> discussion, or discussion -> vote.
function advance(room, requesterId) {
  if (requesterId !== room.hostId) return { error: 'Only the host can do that.' };
  if (room.phase === 'alibi') startDiscussion(room);
  else if (room.phase === 'discuss') startVote(room);
  else return { error: 'Nothing to skip right now.' };
  return { room };
}

function sendChat(room, playerId, text) {
  if (room.phase !== 'discuss' && room.phase !== 'vote') return { error: 'Chat is closed right now.' };
  const me = room.players.find((p) => p.id === playerId);
  if (!me) return { error: 'Not in this room.' };
  const clean = String(text || '').trim().slice(0, 200);
  if (!clean) return { error: 'Write something.' };
  room.chat.push({ id: room.nextMsgId++, playerId, name: me.name, text: clean, ts: Date.now() });
  if (room.chat.length > MAX_CHAT_MESSAGES) room.chat.shift();
  return { room };
}

function castVote(room, voterId, suspectId) {
  if (room.phase !== 'vote') return { error: 'Not the voting phase.' };
  if (!room.players.some((p) => p.id === voterId)) return { error: 'Not in this room.' };
  if (!room.players.some((p) => p.id === suspectId)) return { error: 'Unknown suspect.' };
  if (voterId === suspectId) return { error: "You can't vote for yourself." };
  room.votes[voterId] = suspectId;
  checkProgress(room);
  return { room };
}

function forceFinish(room, requesterId) {
  if (requesterId !== room.hostId) return { error: 'Only the host can do that.' };
  if (room.phase !== 'vote') return { error: 'Not the voting phase.' };
  finishVote(room);
  return { room };
}

// ---- Map mode: walking around the restaurant -----------------------------------------------------------

// Someone who hasn't sent a direction for this long stops walking, so a lost "key up" can't leave
// them running into a wall forever.
const INPUT_STALE_MS = 1500;

function setInput(room, playerId, dx, dy, now = Date.now()) {
  if (room.phase !== 'play' || !room.world) return;
  world.setInput(room.world, playerId, dx, dy);
  room.inputAt[playerId] = now;
}

function stealBell(room, playerId, now = Date.now()) {
  if (room.phase !== 'play' || !room.world) return { error: 'Nothing to steal right now.' };
  const result = world.steal(room.world, playerId, playerId === room.thiefId, now);
  return result.error ? result : { room };
}

// Walking up to an empty bell stand and reporting it calls everyone together: discussion, then the vote.
function reportBell(room, playerId, now = Date.now()) {
  if (room.phase !== 'play' || !room.world) return { error: 'Nothing to report right now.' };
  const result = world.report(room.world, playerId, now);
  if (result.error) return result;
  const table = world.TABLES.find((t) => t.id === result.table);
  room.report = { byId: playerId, tableName: table ? table.name : 'a table' };
  for (const p of Object.values(room.world.players)) {
    p.dx = 0;
    p.dy = 0;
  }
  startDiscussion(room, now);
  return { room };
}

// Called many times a second while a map round is on: moves everyone, then checks for closing time.
function tickWorld(room, now = Date.now()) {
  if (room.phase !== 'play' || !room.world) return;
  const w = room.world;
  for (const p of room.players) {
    const wp = w.players[p.id];
    if (!wp) continue;
    // Offline or silent players stand still.
    if (p.gone || !p.connected || now - (room.inputAt[p.id] || 0) > INPUT_STALE_MS) {
      wp.dx = 0;
      wp.dy = 0;
    }
  }
  const dt = (now - room.lastTick) / 1000;
  room.lastTick = now;
  world.step(w, dt);

  const thief = room.players.find((p) => p.id === room.thiefId);
  if (!thief || thief.gone) return endRound(room, { winner: 'patrons', reason: 'left' });
  if (now >= w.endsAt) {
    // Closing time. If a bell went missing and nobody caught the Thief, the Thief wins.
    const stolen = !!w.stolenTable;
    endRound(room, { winner: stolen ? 'thief' : 'patrons', reason: stolen ? 'closing' : 'nothing' });
  }
}

// Everything one player is allowed to know about the restaurant right now (null if not walking around).
function worldFor(room, playerId, now = Date.now()) {
  if (room.phase !== 'play' || !room.world) return null;
  const snap = world.snapshotFor(room.world, playerId, playerId === room.thiefId, now);
  return snap && { ...snap, now };
}

function finishVote(room) {
  const tally = {};
  for (const suspectId of Object.values(room.votes)) {
    tally[suspectId] = (tally[suspectId] || 0) + 1;
  }
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter((id) => tally[id] === max);
  // A tie or no votes means nobody is cleanly caught, so the Thief walks.
  const accusedId = top.length === 1 ? top[0] : null;
  endRound(room, {
    accusedId,
    tally,
    winner: accusedId === room.thiefId ? 'patrons' : 'thief',
    tie: top.length > 1,
    reason: 'vote',
  });
}

// Builds the result screen's data and ends the round. `reason` says how it ended:
//   'vote'    the table voted
//   'closing' a bell was stolen and nobody caught the Thief by closing time (map mode)
//   'nothing' the Thief never stole anything before closing (map mode)
//   'left'    the Thief walked out (map mode)
function endRound(room, { accusedId = null, tally = {}, winner, tie = false, reason }) {
  room.result = {
    accusedId,
    thiefId: room.thiefId,
    accompliceId: room.accompliceId,
    herrings: Object.entries(room.herrings).map(([playerId, h]) => ({ playerId, clue: h.clue, truth: h.truth })),
    tally,
    winner,
    tie,
    reason,
  };
  room.phase = 'result';
  room.discussEndsAt = null;
}

function backToLobby(room, requesterId) {
  if (requesterId !== room.hostId) return { error: 'Only the host can do that.' };
  room.phase = 'lobby';
  room.players = room.players.filter((p) => !p.gone);
  resetRound(room);
  return { room };
}

// What a specific player is allowed to see. The Thief's identity stays secret until the result.
function viewFor(room, playerId) {
  const me = room.players.find((p) => p.id === playerId);
  const inGame = room.phase !== 'lobby' && !!me;

  // The Thief and the accomplice know each other. Nobody else is told who they are.
  let partner = null;
  if (inGame && room.accompliceId && (playerId === room.thiefId || playerId === room.accompliceId)) {
    const other = room.players.find((p) => p.id === (playerId === room.thiefId ? room.accompliceId : room.thiefId));
    if (other) partner = { id: other.id, name: other.name };
  }

  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    meId: playerId,
    role: !inGame ? null : playerId === room.thiefId ? 'thief' : playerId === room.accompliceId ? 'accomplice' : 'patron',
    partner,
    // Everyone is told there's an accomplice this round (it follows from the player count), but not who.
    hasAccomplice: inGame && !!room.accompliceId,
    secret: inGame ? room.herrings[playerId] || null : null, // your own red herring, if you got one
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      hasAlibi: !!room.alibis[p.id],
      hasVoted: !!room.votes[p.id],
    })),
    // Alibis are revealed once the discussion starts, so everyone has something to pick apart.
    alibis: ['discuss', 'vote', 'result'].includes(room.phase) ? room.alibis : {},
    chat: ['discuss', 'vote', 'result'].includes(room.phase) ? room.chat : [],
    discussEndsAt: room.phase === 'discuss' ? room.discussEndsAt : null,
    serverNow: Date.now(), // lets the client correct for its clock being off
    myVote: room.votes[playerId] || null,
    result: room.phase === 'result' ? room.result : null,
    minPlayers: MIN_PLAYERS,
    mode: room.mode,
    // Map mode: who reported the empty bell stand (shown once the discussion starts).
    report: room.report
      ? { byId: room.report.byId, byName: room.players.find((p) => p.id === room.report.byId)?.name ?? 'Someone', tableName: room.report.tableName }
      : null,
  };
}

module.exports = {
  rooms,
  createRoom,
  joinRoom,
  rejoin,
  disconnectPlayer,
  expirePlayer,
  leavePlayer,
  getRoom,
  startGame,
  submitAlibi,
  advance,
  startVote,
  sendChat,
  castVote,
  forceFinish,
  backToLobby,
  viewFor,
  setMode,
  setInput,
  stealBell,
  reportBell,
  tickWorld,
  worldFor,
  MIN_PLAYERS,
};
