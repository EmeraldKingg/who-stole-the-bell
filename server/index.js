const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// In production, serve the built React client.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Express 5 syntax for "everything else" (a bare '*' no longer works).
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// How long a dropped player keeps their seat before the game treats them as gone.
// Override with GRACE_SECONDS (the tests use a short one).
const GRACE_MS = (Number(process.env.GRACE_SECONDS) || 60) * 1000;

// One timer per room: when the discussion clock runs out, the server moves everyone to voting.
// The server owns the clock so a player closing their tab can't freeze the game.
const timers = new Map();
// One timer per dropped player: when it fires without them coming back, they count as gone.
const graceTimers = new Map();
const graceKey = (code, playerId) => `${code}:${playerId}`;

function clearGrace(code, playerId) {
  const key = graceKey(code, playerId);
  clearTimeout(graceTimers.get(key));
  graceTimers.delete(key);
}

function clearRoomTimers(code) {
  const t = timers.get(code);
  if (t) clearTimeout(t.handle);
  timers.delete(code);
  for (const key of [...graceTimers.keys()]) {
    if (key.startsWith(`${code}:`)) {
      clearTimeout(graceTimers.get(key));
      graceTimers.delete(key);
    }
  }
}

function scheduleGrace(code, playerId) {
  clearGrace(code, playerId);
  const handle = setTimeout(() => {
    graceTimers.delete(graceKey(code, playerId));
    const room = game.getRoom(code);
    if (!room) return;
    const result = game.expirePlayer(room, playerId);
    if (result.deleted) clearRoomTimers(code);
    else broadcast(room);
  }, GRACE_MS);
  graceTimers.set(graceKey(code, playerId), handle);
}

function syncTimer(room) {
  const existing = timers.get(room.code);
  if (room.phase !== 'discuss') {
    if (existing) {
      clearTimeout(existing.handle);
      timers.delete(room.code);
    }
    return;
  }
  // Already watching this exact deadline.
  if (existing && existing.endsAt === room.discussEndsAt) return;
  if (existing) clearTimeout(existing.handle);
  const delay = Math.max(0, room.discussEndsAt - Date.now());
  const handle = setTimeout(() => {
    timers.delete(room.code);
    const live = game.getRoom(room.code);
    if (live && live.phase === 'discuss') {
      game.startVote(live);
      broadcast(live);
    }
  }, delay);
  timers.set(room.code, { handle, endsAt: room.discussEndsAt });
}

function broadcast(room) {
  syncTimer(room);
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', game.viewFor(room, p.id));
  }
}

io.on('connection', (socket) => {
  let currentCode = null;
  let playerId = null;

  const reply = (cb, payload) => typeof cb === 'function' && cb(payload);

  // The seat this socket currently owns, or null if it has been replaced by a newer connection.
  const mySeat = () => {
    const room = currentCode && game.getRoom(currentCode);
    const player = room && room.players.find((p) => p.id === playerId);
    return player && player.socketId === socket.id ? { room, player } : null;
  };

  socket.on('create', ({ name } = {}, cb) => {
    if (currentCode) return reply(cb, { ok: false, error: 'Leave your current table first.' });
    const { room, player } = game.createRoom(name, socket.id);
    currentCode = room.code;
    playerId = player.id;
    broadcast(room);
    // The token is private: it goes only to this player, who keeps it to rejoin after a dropped connection.
    reply(cb, { ok: true, code: room.code, token: player.token });
  });

  socket.on('join', ({ code, name } = {}, cb) => {
    if (currentCode) return reply(cb, { ok: false, error: 'Leave your current table first.' });
    const result = game.joinRoom(code, name, socket.id);
    if (result.error) return reply(cb, { ok: false, error: result.error });
    currentCode = result.room.code;
    playerId = result.player.id;
    broadcast(result.room);
    reply(cb, { ok: true, code: result.room.code, token: result.player.token });
  });

  socket.on('rejoin', ({ code, token } = {}, cb) => {
    const result = game.rejoin(code, token, socket.id);
    if (result.error) return reply(cb, { ok: false, error: result.error });
    // If the same player is still connected somewhere else (another tab), that connection is replaced.
    if (result.previousSocketId && result.previousSocketId !== socket.id) {
      io.sockets.sockets.get(result.previousSocketId)?.disconnect(true);
    }
    clearGrace(result.room.code, result.player.id);
    currentCode = result.room.code;
    playerId = result.player.id;
    broadcast(result.room);
    reply(cb, { ok: true, code: result.room.code });
  });

  socket.on('leave', (_payload, cb) => {
    const seat = mySeat();
    if (seat) {
      clearGrace(seat.room.code, seat.player.id);
      const result = game.leavePlayer(seat.room, seat.player.id);
      if (result.deleted) clearRoomTimers(seat.room.code);
      else broadcast(seat.room);
    }
    currentCode = null;
    playerId = null;
    reply(cb, { ok: true });
  });

  // One handler wrapper for the in-room actions.
  const action = (event, fn) =>
    socket.on(event, (payload, cb) => {
      const seat = mySeat();
      if (!seat) return reply(cb, { ok: false, error: 'Room not found.' });
      const result = fn(seat.room, payload || {});
      if (result.error) return reply(cb, { ok: false, error: result.error });
      broadcast(seat.room);
      reply(cb, { ok: true });
    });

  action('start', (room) => game.startGame(room, playerId));
  action('alibi', (room, { text }) => game.submitAlibi(room, playerId, text));
  action('advance', (room) => game.advance(room, playerId));
  action('chat', (room, { text }) => game.sendChat(room, playerId, text));
  action('vote', (room, { suspectId }) => game.castVote(room, playerId, suspectId));
  action('finishVote', (room) => game.forceFinish(room, playerId));
  action('playAgain', (room) => game.backToLobby(room, playerId));

  socket.on('disconnect', () => {
    const seat = mySeat();
    // No seat means this connection was already replaced by a newer one, or the player left on purpose.
    if (!seat) return;
    game.disconnectPlayer(seat.room, seat.player.id);
    broadcast(seat.room);
    scheduleGrace(seat.room.code, seat.player.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Who Stole the Bell? server on :${PORT}`));
