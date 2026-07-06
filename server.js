'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager, MAX_SEATS } = require('./game/rooms');
const { applyMove, currentActor, viewFor } = require('./game/engine');
const { chooseMove } = require('./game/bot');

const PORT = process.env.PORT || 3000;
// Long enough that the client's flying-card animation for one bot move always
// finishes before the next bot move's view update arrives and re-renders.
const BOT_DELAY = Number(process.env.BOT_DELAY_MS || 1600); // ms between bot moves

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const rm = new RoomManager();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ── Emitting helpers ──────────────────────────────────────────────────────

function socketOf(id) {
  return io.sockets.sockets.get(id);
}

function lobbyPayload(room) {
  return {
    code: room.code,
    lang: room.lang,
    hostId: room.hostId,
    single: room.single,
    maxSeats: MAX_SEATS,
    started: room.started,
    seats: room.seats.map((s) => ({
      id: s.id,
      sid: s.socketId, // used client-side to identify "you" / host
      name: s.name,
      isBot: s.isBot,
      connected: s.connected !== false,
      isHost: s.socketId === room.hostId,
    })),
  };
}

function emitLobby(room) {
  const payload = lobbyPayload(room);
  for (const seat of room.seats) {
    if (seat.socketId) socketOf(seat.socketId)?.emit('lobby', payload);
  }
}

function emitGame(room) {
  if (!room.game) return;
  for (let i = 0; i < room.seats.length; i++) {
    const seat = room.seats[i];
    if (!seat.socketId) continue;
    socketOf(seat.socketId)?.emit('game', {
      code: room.code,
      lang: room.lang,
      view: viewFor(room.game, i),
    });
  }
}

// Drive consecutive bot turns with a small delay for readability.
function driveBots(code) {
  const room = rm.getRoom(code);
  if (!room || !room.game || room.game.phase === 'over') return;
  const actor = currentActor(room.game);
  if (!actor) return;
  const seat = room.seats[actor.player];
  if (!seat || !seat.isBot) return; // it's a human's turn — wait

  setTimeout(() => {
    const r = rm.getRoom(code);
    if (!r || !r.game || r.game.phase === 'over') return;
    const a = currentActor(r.game);
    if (!a) return;
    const s = r.seats[a.player];
    if (!s || !s.isBot) return;
    const move = chooseMove(r.game, a.player);
    if (!move) return;
    try {
      applyMove(r.game, a.player, move);
    } catch (err) {
      // A bot should never make an illegal move; bail out safely if it does.
      return;
    }
    emitGame(r);
    driveBots(code);
  }, BOT_DELAY);
}

function seatIndexOf(room, socketId) {
  return room.seats.findIndex((s) => s.socketId === socketId);
}

// ── Socket handlers ───────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, lang } = {}) => {
    const existing = rm.findRoomBySocket(socket.id);
    if (existing) return socket.emit('errorMsg', 'already_in_room');
    const room = rm.createRoom(socket.id, name, lang || 'hu');
    socket.emit('joined', { code: room.code });
    emitLobby(room);
  });

  socket.on('joinRoom', ({ code, name } = {}) => {
    const clean = String(code || '').trim().toUpperCase();
    const res = rm.joinRoom(clean, socket.id, name);
    if (res.error) return socket.emit('errorMsg', res.error);
    socket.emit('joined', { code: res.room.code });
    emitLobby(res.room);
  });

  socket.on('singleplayer', ({ name, lang, bots } = {}) => {
    const existing = rm.findRoomBySocket(socket.id);
    if (existing) return socket.emit('errorMsg', 'already_in_room');
    const room = rm.createRoom(socket.id, name, lang || 'hu', { single: true });
    const botCount = Math.min(Math.max(Number(bots) || 1, 1), MAX_SEATS - 1);
    for (let i = 0; i < botCount; i++) rm.addBot(room);
    rm.startGame(room);
    socket.emit('joined', { code: room.code });
    emitGame(room);
    driveBots(room.code);
  });

  socket.on('addBot', () => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    const res = rm.addBot(room);
    if (res.error) return socket.emit('errorMsg', res.error);
    emitLobby(room);
  });

  socket.on('removeSeat', ({ seatId } = {}) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    const res = rm.removeSeat(room, seatId);
    if (res.error) return socket.emit('errorMsg', res.error);
    emitLobby(room);
  });

  socket.on('setLang', ({ lang } = {}) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    room.lang = lang === 'en' ? 'en' : 'hu';
    if (room.started) emitGame(room);
    else emitLobby(room);
  });

  socket.on('startGame', () => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    const res = rm.startGame(room);
    if (res.error) return socket.emit('errorMsg', res.error);
    emitGame(room);
    driveBots(room.code);
  });

  socket.on('move', ({ move } = {}) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || !room.game) return;
    const seatIdx = seatIndexOf(room, socket.id);
    if (seatIdx === -1) return;
    try {
      applyMove(room.game, seatIdx, move);
    } catch (err) {
      return socket.emit('errorMsg', String(err.message || err).replace('illegal:', ''));
    }
    emitGame(room);
    driveBots(room.code);
  });

  socket.on('rematch', () => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    if (!room.game || room.game.phase !== 'over') return;
    rm.resetGame(room);
    const res = rm.startGame(room);
    if (res.error) return socket.emit('errorMsg', res.error);
    emitGame(room);
    driveBots(room.code);
  });

  socket.on('leaveRoom', () => {
    const info = rm.handleDisconnect(socket.id);
    if (info && info.room && !info.ended) {
      if (info.room.started) emitGame(info.room);
      else emitLobby(info.room);
      if (info.room.started) driveBots(info.room.code);
    }
    socket.emit('leftRoom');
  });

  socket.on('disconnect', () => {
    const info = rm.handleDisconnect(socket.id);
    if (info && info.room && !info.ended) {
      if (info.room.started) {
        emitGame(info.room);
        driveBots(info.room.code);
      } else {
        emitLobby(info.room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Bürge / Hühü server running on http://localhost:${PORT}`);
});
