'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager, MAX_SEATS } = require('./game/rooms');
const { applyMove, currentActor, viewFor } = require('./game/engine');
const { chooseMove } = require('./game/bot');

const PORT = process.env.PORT || 3000;
const DEFAULT_BOT_DELAY = Number(process.env.BOT_DELAY_MS || 800);

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
      return;
    }
    emitGame(r);
    driveBots(code);
  }, room.botDelay || DEFAULT_BOT_DELAY);
}

function seatIndexOf(room, socketId) {
  return room.seats.findIndex((s) => s.socketId === socketId);
}

// ── Socket handlers ───────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, lang, botDelayMs } = {}) => {
    const existing = rm.findRoomBySocket(socket.id);
    if (existing) return socket.emit('errorMsg', 'already_in_room');
    const room = rm.createRoom(socket.id, name, lang || 'hu');
    room.botDelay = Number(botDelayMs) || DEFAULT_BOT_DELAY;
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

  socket.on('singleplayer', ({ name, lang, bots, botDelayMs } = {}) => {
    const existing = rm.findRoomBySocket(socket.id);
    if (existing) return socket.emit('errorMsg', 'already_in_room');
    const room = rm.createRoom(socket.id, name, lang || 'hu', { single: true });
    room.botDelay = Number(botDelayMs) || DEFAULT_BOT_DELAY;
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

  socket.on('rejoin', ({ code, oldSid } = {}) => {
    let room = rm.getRoom(String(code || '').trim().toUpperCase());
    if (!room) return socket.emit('errorMsg', 'no_room');
    const seat = rm.rejoinRoom(room, socket.id, oldSid);
    if (!seat) {
      const res = rm.joinRoom(room.code, socket.id, '');
      if (res.error) return socket.emit('errorMsg', res.error);
      room = res.room;
    }
    socket.emit('rejoined', { code: room.code });
    if (room.started) emitGame(room);
    else emitLobby(room);
    if (room.started) driveBots(room.code);
  });
});

// ── Royal Game of Ur namespace ──────────────────────────────────────────

const urEngine = require('./game/ur/engine');
const urBot = require('./game/ur/bot');

const urIo = io.of('/ur');
const urRooms = new Map(); // code → ur room state

function urMakeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; }
  while (urRooms.has(code));
  return code;
}

function urEmitGame(room) {
  if (!room.game) return;
  for (const seat of room.seats) {
    if (seat.socketId) {
      const s = urIo.sockets.sockets.get(seat.socketId);
      if (s) s.emit('game', { view: urEngine.viewFor(room.game, seat.playerIdx) });
    }
  }
}

function urEmitLobby(room) {
  const payload = {
    code: room.code,
    hostId: room.hostId,
    seats: room.seats.map((s) => ({
      sid: s.socketId,
      name: s.name,
      isBot: s.isBot,
      connected: true,
    })),
  };
  for (const seat of room.seats) {
    if (seat.socketId) {
      const s = urIo.sockets.sockets.get(seat.socketId);
      if (s) s.emit('lobby', payload);
    }
  }
}

function urDriveBots(code) {
  const room = urRooms.get(code);
  if (!room || !room.game || room.game.phase === 'over') return;
  const actor = urEngine.currentActor(room.game);
  if (!actor) return;
  const seat = room.seats[actor.player];
  if (!seat || !seat.isBot) return;

  setTimeout(() => {
    const r = urRooms.get(code);
    if (!r || !r.game || r.game.phase === 'over') return;
    const a = urEngine.currentActor(r.game);
    if (!a) return;
    const s = r.seats[a.player];
    if (!s || !s.isBot) return;

    if (r.game.phase === 'roll') {
      r.game.lastRoll = urEngine.rollDice(Math.random);
      const moves = urEngine.legalMoves(r.game, a.player, r.game.lastRoll);
      if (moves.length === 0) {
        r.game.turn = 1 - r.game.turn;
        r.game.phase = 'roll';
        r.game.lastRoll = null;
        urEmitGame(r);
        urDriveBots(code);
        return;
      }
      r.game.phase = 'move';
      urEmitGame(r);
      urDriveBots(code);
      return;
    }

    if (r.game.phase === 'move') {
      const move = urBot.chooseMove(r.game, a.player);
      if (!move) { urDriveBots(code); return; }
      try { urEngine.applyMove(r.game, a.player, move); } catch (e) { /* skip */ }
      urEmitGame(r);
      urDriveBots(code);
    }
  }, room.botDelay || 700);
}

urIo.on('connection', (socket) => {
  function urSeatIdx(room) {
    return room.seats.findIndex((s) => s.socketId === socket.id);
  }

  socket.on('createRoom', ({ name, botDelayMs } = {}) => {
    const code = urMakeCode();
    const room = {
      code,
      hostId: socket.id,
      botDelay: Number(botDelayMs) || 700,
      seats: [{ name: name || 'Player', isBot: false, socketId: socket.id, playerIdx: 0 }],
      game: null,
    };
    urRooms.set(code, room);
    socket.emit('joined', { code });
    urEmitLobby(room);
  });

  socket.on('joinRoom', ({ code, name } = {}) => {
    const room = urRooms.get(String(code || '').trim().toUpperCase());
    if (!room) return socket.emit('errorMsg', 'Room not found');
    if (room.seats.length >= 2) return socket.emit('errorMsg', 'Room full');
    if (room.game) return socket.emit('errorMsg', 'Game in progress');
    room.seats.push({ name: name || 'Player', isBot: false, socketId: socket.id, playerIdx: 1 });
    socket.emit('joined', { code });
    urEmitLobby(room);
  });

  socket.on('singleplayer', ({ name, botDelayMs } = {}) => {
    const code = urMakeCode();
    const room = {
      code,
      hostId: socket.id,
      botDelay: Number(botDelayMs) || 700,
      seats: [
        { name: name || 'You', isBot: false, socketId: socket.id, playerIdx: 0 },
        { name: 'Bot', isBot: true, socketId: null, playerIdx: 1 },
      ],
      game: urEngine.createGame([{ id: 'p0', name: name || 'You', isBot: false }, { id: 'p1', name: 'Bot', isBot: true }]),
    };
    urRooms.set(code, room);
    socket.emit('joined', { code });
    urEmitGame(room);
    urDriveBots(code);
  });

  socket.on('startGame', () => {
    const room = urRooms.get([...urRooms.entries()].find(([, r]) => r.hostId === socket.id)?.[0]);
    if (!room || room.hostId !== socket.id) return;
    if (room.seats.length < 2) return socket.emit('errorMsg', 'Need 2 players');
    room.game = urEngine.createGame(room.seats.map((s, i) => ({
      id: 'p' + i, name: s.name, isBot: s.isBot,
    })));
    urEmitGame(room);
    urDriveBots(room.code);
  });

  socket.on('roll', () => {
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.seats.some((s) => s.socketId === socket.id));
    if (!entry) return;
    const room = entry[1];
    const si = urSeatIdx(room);
    if (si === -1 || room.game.turn !== si || room.game.phase !== 'roll') return;

    room.game.lastRoll = urEngine.rollDice(Math.random);
    const moves = urEngine.legalMoves(room.game, si, room.game.lastRoll);
    if (moves.length === 0) {
      room.game.turn = 1 - room.game.turn;
      room.game.phase = 'roll';
      room.game.lastRoll = null;
    } else {
      room.game.phase = 'move';
    }
    urEmitGame(room);
    urDriveBots(room.code);
  });

  socket.on('move', ({ piece, destPos }) => {
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.seats.some((s) => s.socketId === socket.id));
    if (!entry) return;
    const room = entry[1];
    const si = urSeatIdx(room);
    if (si === -1 || room.game.turn !== si || room.game.phase !== 'move') return;

    // Find the move: need to match piece index and destination
    const moves = urEngine.legalMoves(room.game, si, room.game.lastRoll);
    const move = moves.find((m) => {
      if (m.piece !== piece) return false;
      if (m.action === 'bearOff') return destPos === -1; // bear off
      return m.dest !== undefined && urEngine.positionOf(si, m.dest) === destPos;
    });
    if (!move) return socket.emit('errorMsg', 'Invalid move');

    try { urEngine.applyMove(room.game, si, move); } catch (e) {
      return socket.emit('errorMsg', String(e.message));
    }
    urEmitGame(room);
    urDriveBots(room.code);
  });

  socket.on('leaveRoom', () => {
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.seats.some((s) => s.socketId === socket.id));
    if (!entry) return socket.emit('leftRoom');
    const room = entry[1];
    const seat = room.seats.find((s) => s.socketId === socket.id);
    if (seat) seat.isBot = true;
    urRooms.delete(entry[0]);
    socket.emit('leftRoom');
  });

  socket.on('rematch', () => {
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.hostId === socket.id);
    if (!entry) return;
    const room = entry[1];
    if (!room.game || room.game.phase !== 'over') return;
    room.game = urEngine.createGame(room.seats.map((s, i) => ({
      id: 'p' + i, name: s.name, isBot: s.isBot,
    })));
    urEmitGame(room);
    urDriveBots(entry[0]);
  });

  socket.on('disconnect', () => {
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.seats.some((s) => s.socketId === socket.id));
    if (!entry) return;
    const room = entry[1];
    const seat = room.seats.find((s) => s.socketId === socket.id);
    if (seat) { seat.isBot = true; seat.socketId = null; }
    if (!room.seats.some((s) => s.socketId)) {
      urRooms.delete(entry[0]);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Bürge / Hühü server running on http://localhost:${PORT}`);
});
