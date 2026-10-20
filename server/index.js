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

// One timer per room: when the discussion clock runs out, the server moves everyone to voting.
// The server owns the clock so a player closing their tab can't freeze the game.
const timers = new Map();

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
    io.to(p.id).emit('state', game.viewFor(room, p.id));
  }
}

io.on('connection', (socket) => {
  let currentCode = null;

  const reply = (cb, payload) => typeof cb === 'function' && cb(payload);

  socket.on('create', ({ name }, cb) => {
    const room = game.createRoom(socket.id, name);
    currentCode = room.code;
    socket.join(socket.id); // personal channel for private state
    broadcast(room);
    reply(cb, { ok: true, code: room.code });
  });

  socket.on('join', ({ code, name }, cb) => {
    const result = game.joinRoom(code, socket.id, name);
    if (result.error) return reply(cb, { ok: false, error: result.error });
    currentCode = result.room.code;
    socket.join(socket.id);
    broadcast(result.room);
    reply(cb, { ok: true, code: result.room.code });
  });

  // One handler wrapper for the in-room actions.
  const action = (event, fn) =>
    socket.on(event, (payload, cb) => {
      const room = game.getRoom(currentCode);
      if (!room) return reply(cb, { ok: false, error: 'Room not found.' });
      const result = fn(room, payload || {});
      if (result.error) return reply(cb, { ok: false, error: result.error });
      broadcast(room);
      reply(cb, { ok: true });
    });

  action('start', (room) => game.startGame(room, socket.id));
  action('alibi', (room, { text }) => game.submitAlibi(room, socket.id, text));
  action('advance', (room) => game.advance(room, socket.id));
  action('chat', (room, { text }) => game.sendChat(room, socket.id, text));
  action('vote', (room, { suspectId }) => game.castVote(room, socket.id, suspectId));
  action('finishVote', (room) => game.forceFinish(room, socket.id));
  action('playAgain', (room) => game.backToLobby(room, socket.id));

  socket.on('disconnect', () => {
    const room = game.getRoom(currentCode);
    if (!room) return;
    game.removePlayer(room, socket.id);
    if (game.getRoom(currentCode)) {
      broadcast(room);
    } else {
      // Room was deleted because everyone left; stop its timer too.
      const t = timers.get(currentCode);
      if (t) clearTimeout(t.handle);
      timers.delete(currentCode);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Who Stole the Bell? server on :${PORT}`));
