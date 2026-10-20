// Pure game logic for "Who Stole the Bell?" - no networking in here, so it's easy to test.
//
// Players have a stable public `id` (used everywhere in game state), a secret `token` (only ever
// sent to that player, used to rejoin after a dropped connection) and a `socketId` (which changes
// every time they reconnect). Views sent to clients never contain tokens or socket ids.

const crypto = require('crypto');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
// How long the group chat discussion lasts. Override with DISCUSS_SECONDS (the tests use a short one).
const DISCUSS_SECONDS = Number(process.env.DISCUSS_SECONDS) || 59;
const MAX_CHAT_MESSAGES = 200;

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
    phase: 'lobby', // lobby -> alibi -> discuss -> vote -> result
    players: [host],
    thiefId: null,
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
  const thief = live[Math.floor(Math.random() * live.length)];
  room.thiefId = thief.id;
  resetRound(room);
  room.phase = 'alibi';
  return { room };
}

function resetRound(room) {
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

function finishVote(room) {
  const tally = {};
  for (const suspectId of Object.values(room.votes)) {
    tally[suspectId] = (tally[suspectId] || 0) + 1;
  }
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter((id) => tally[id] === max);
  // A tie or no votes means nobody is cleanly caught, so the Thief walks.
  const accusedId = top.length === 1 ? top[0] : null;
  room.result = {
    accusedId,
    thiefId: room.thiefId,
    tally,
    winner: accusedId === room.thiefId ? 'patrons' : 'thief',
    tie: top.length > 1,
  };
  room.phase = 'result';
}

function backToLobby(room, requesterId) {
  if (requesterId !== room.hostId) return { error: 'Only the host can do that.' };
  room.phase = 'lobby';
  room.players = room.players.filter((p) => !p.gone);
  room.thiefId = null;
  resetRound(room);
  return { room };
}

// What a specific player is allowed to see. The Thief's identity stays secret until the result.
function viewFor(room, playerId) {
  const me = room.players.find((p) => p.id === playerId);
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    meId: playerId,
    role: room.phase === 'lobby' || !me ? null : playerId === room.thiefId ? 'thief' : 'patron',
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
  MIN_PLAYERS,
};
