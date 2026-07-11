'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager, MAX_SEATS } = require('./game/rooms');
const { applyMove, currentActor, viewFor } = require('./game/engine');
const { chooseMove } = require('./game/bot');
const gamelog = require('./game/gamelog');

const PORT = process.env.PORT || 3000;
const DEFAULT_BOT_DELAY = Number(process.env.BOT_DELAY_MS || 800);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// The card game and the Royal Game of Ur keep fully separate room maps, but
// share one code space: a code can never mean two different rooms, so a join
// attempt in the wrong game can be detected and redirected.
const urRooms = new Map(); // code → ur room state
const rm = new RoomManager({ isCodeTaken: (code) => urRooms.has(code) });

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
    // Pause while nobody is watching — the game resumes with the player.
    if (!r.seats.some((st) => st.socketId)) return;
    const a = currentActor(r.game);
    if (!a) return;
    const s = r.seats[a.player];
    if (!s || !s.isBot) return;
    // Seat temperament + a bit of temperature: bots vary their play.
    const move = chooseMove(r.game, a.player, undefined, {
      style: s.style,
      temp: 0.6,
      rng: Math.random,
    });
    if (!move) return;
    try {
      applyMove(r.game, a.player, move);
    } catch (err) {
      return;
    }
    gamelog.logMove(r, a.player, move);
    emitGame(r);
    driveBots(code);
  }, room.botDelay || DEFAULT_BOT_DELAY);
}

function seatIndexOf(room, socketId) {
  return room.seats.findIndex((s) => s.socketId === socketId);
}

// Broadcasts a player's tentative, unconfirmed card placement (staging an
// attack, placing a defense before Beat) to everyone else at the table —
// purely cosmetic, never touches game state. The room's authoritative
// `game` view is always the source of truth; this just lets opponents watch
// the decision happen live instead of only seeing the final result.
function emitPreview(room, fromSeatIdx, payload) {
  for (let i = 0; i < room.seats.length; i++) {
    if (i === fromSeatIdx) continue;
    const seat = room.seats[i];
    if (seat.socketId) socketOf(seat.socketId)?.emit('preview', { seat: fromSeatIdx, ...payload });
  }
}

// ── Socket handlers ───────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, lang, botDelayMs, clientId } = {}) => {
    const existing = rm.findRoomBySocket(socket.id);
    if (existing) return socket.emit('errorMsg', 'already_in_room');
    rm.forgetClient(clientId); // starting fresh abandons any stale seat
    const room = rm.createRoom(socket.id, clientId, name, lang || 'hu');
    room.botDelay = Number(botDelayMs) || DEFAULT_BOT_DELAY;
    socket.emit('joined', { code: room.code });
    emitLobby(room);
  });

  socket.on('joinRoom', ({ code, name, clientId } = {}) => {
    const clean = String(code || '').trim().toUpperCase();
    rm.forgetClient(clientId);
    const res = rm.joinRoom(clean, socket.id, clientId, name);
    if (res.error) {
      if (res.error === 'no_room' && urRooms.has(clean)) {
        return socket.emit('wrongGame', { game: 'ur', code: clean });
      }
      return socket.emit('errorMsg', res.error);
    }
    socket.emit('joined', { code: res.room.code });
    emitLobby(res.room);
  });

  socket.on('singleplayer', ({ name, lang, bots, botDelayMs, clientId } = {}) => {
    const existing = rm.findRoomBySocket(socket.id);
    if (existing) return socket.emit('errorMsg', 'already_in_room');
    rm.forgetClient(clientId);
    const room = rm.createRoom(socket.id, clientId, name, lang || 'hu', { single: true });
    room.botDelay = Number(botDelayMs) || DEFAULT_BOT_DELAY;
    const botCount = Math.min(Math.max(Number(bots) || 1, 1), MAX_SEATS - 1);
    for (let i = 0; i < botCount; i++) rm.addBot(room);
    rm.startGame(room);
    gamelog.logStart(room);
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
    gamelog.logStart(room);
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
    gamelog.logMove(room, seatIdx, move);
    emitGame(room);
    driveBots(room.code);
  });

  // Live preview of an in-progress (not yet confirmed) attack stage or
  // defense placement. Validated against the actual current attacker/
  // defender so a stray or stale event can't spoof another player's turn;
  // otherwise trusted as-is since it never mutates game state.
  socket.on('preview', (payload) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || !room.game) return;
    const seatIdx = seatIndexOf(room, socket.id);
    if (seatIdx === -1) return;
    const g = room.game;
    const type = payload && payload.type;
    if (type === 'attack') {
      if (g.phase !== 'attack' || g.attacker !== seatIdx) return;
      const cards = Array.isArray(payload.cards)
        ? payload.cards.filter((c) => typeof c === 'string').slice(0, 5)
        : [];
      emitPreview(room, seatIdx, { type: 'attack', cards });
    } else if (type === 'defense') {
      if (g.phase !== 'defense' || g.defender !== seatIdx) return;
      const slots = Array.isArray(payload.slots)
        ? payload.slots
          .filter((s) => s && Number.isInteger(s.slot) && typeof s.card === 'string')
          .slice(0, 5)
        : [];
      emitPreview(room, seatIdx, { type: 'defense', slots });
    }
  });

  socket.on('rematch', () => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    if (!room.game || room.game.phase !== 'over') return;
    rm.resetGame(room);
    const res = rm.startGame(room);
    if (res.error) return socket.emit('errorMsg', res.error);
    gamelog.logStart(room);
    emitGame(room);
    driveBots(room.code);
  });

  socket.on('leaveRoom', () => {
    const info = rm.leaveRoom(socket.id);
    if (info && info.room && !info.ended) {
      if (info.room.started) emitGame(info.room);
      else emitLobby(info.room);
      if (info.room.started) driveBots(info.room.code);
    }
    socket.emit('leftRoom');
  });

  socket.on('disconnect', () => {
    const info = rm.handleDisconnect(socket.id);
    if (info && info.room && !info.paused) {
      if (info.room.started) {
        emitGame(info.room);
        driveBots(info.room.code);
      } else {
        emitLobby(info.room);
      }
    }
  });

  // Deliberate exit (switching games): give up every seat this browser
  // holds in BOTH games so resume won't drag it back.
  socket.on('abandon', ({ clientId } = {}) => {
    const info = rm.leaveRoom(socket.id);
    if (info && info.room && !info.ended) {
      if (info.room.started) {
        emitGame(info.room);
        driveBots(info.room.code);
      } else {
        emitLobby(info.room);
      }
    }
    rm.forgetClient(clientId);
    urForgetClient(clientId);
  });

  // A returning browser: reattach it to whatever seat its clientId holds —
  // singleplayer, waiting lobby or a live game — or point it at the other
  // game if that's where its room lives.
  socket.on('resume', ({ clientId } = {}) => {
    const res = rm.resumeClient(clientId, socket.id);
    if (!res) {
      if (urFindSeatByClient(clientId)) {
        socket.emit('resumeElsewhere', { game: 'ur' });
      }
      return; // nothing to resume — stay quiet
    }
    const room = res.room;
    socket.emit('resumed', { code: room.code });
    if (room.started) {
      emitGame(room);
      driveBots(room.code);
    } else {
      emitLobby(room);
    }
  });
});

// ── Royal Game of Ur namespace ──────────────────────────────────────────

const urEngine = require('./game/ur/engine');
const urBot = require('./game/ur/bot');

const urIo = io.of('/ur');

function urMakeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; }
  while (urRooms.has(code) || rm.getRoom(code));
  return code;
}

function urEmitGame(room) {
  if (!room.game) return;
  for (const seat of room.seats) {
    if (seat.socketId) {
      const s = urIo.sockets.get(seat.socketId);
      if (s) {
        try { s.emit('game', { view: urEngine.viewFor(room.game, seat.playerIdx) }); } catch (e) { /* skip */ }
      }
    }
  }
}

function urEmitRoll(room, player, roll) {
  for (const seat of room.seats) {
    if (seat.socketId) {
      const s = urIo.sockets.get(seat.socketId);
      if (s) {
        try { s.emit('rolled', { player, roll }); } catch (e) { /* skip */ }
      }
    }
  }
}

function urEmitLobby(room) {
  const payload = {
    code: room.code,
    hostId: room.hostId,
    mode: room.mode || 'finkel',
    seats: room.seats.map((s) => ({
      sid: s.socketId,
      name: s.name,
      isBot: s.isBot,
      connected: true,
    })),
  };
  for (const seat of room.seats) {
    if (seat.socketId) {
      const s = urIo.sockets.get(seat.socketId);
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
    // Pause while nobody is watching — resumes with the player.
    if (!r.seats.some((st) => st.socketId)) return;
    const a = urEngine.currentActor(r.game);
    if (!a) return;
    const s = r.seats[a.player];
    if (!s || !s.isBot) return;

    if (r.game.phase === 'roll') {
      r.game.lastRoll = urEngine.rollFor(r.game, Math.random);
      urEmitRoll(r, a.player, r.game.lastRoll);
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
      let move;
      try { move = urBot.chooseMove(r.game, a.player); } catch (e) { move = null; }
      if (!move) {
        r.game.turn = 1 - r.game.turn;
        r.game.phase = 'roll';
        r.game.lastRoll = null;
        urEmitGame(r);
        urDriveBots(code);
        return;
      }
      try { urEngine.applyMove(r.game, a.player, move); } catch (e) { /* skip */ }
      urEmitGame(r);
      urDriveBots(code);
    }
  }, room.botDelay || 1100);
}

// Seats (possibly disconnected) held by a returning client, across UR rooms.
function urFindSeatByClient(clientId) {
  if (!clientId) return null;
  for (const [code, room] of urRooms) {
    const seat = room.seats.find((s) => s.clientId === clientId && !s.socketId);
    if (seat) return { code, room, seat };
  }
  return null;
}

// Starting fresh abandons any stale UR seat this client still holds.
function urForgetClient(clientId) {
  if (!clientId) return;
  for (const [code, room] of urRooms) {
    const seat = room.seats.find((s) => s.clientId === clientId && !s.socketId);
    if (!seat) continue;
    if (room.game) {
      seat.clientId = null;
      seat.isBot = true;
      if (room.game.players[seat.playerIdx]) room.game.players[seat.playerIdx].isBot = true;
    } else {
      room.seats = room.seats.filter((s) => s !== seat);
      room.seats.forEach((s, i) => { s.playerIdx = i; });
    }
    if (!room.seats.some((s) => s.socketId)) {
      if (room.seats.length === 0) urRooms.delete(code);
      else if (!room.emptySince) room.emptySince = Date.now();
    }
  }
}

urIo.on('connection', (socket) => {
  function urSeatIdx(room) {
    return room.seats.findIndex((s) => s.socketId === socket.id);
  }

  function urCleanMode(mode) {
    return urEngine.MODES[mode] ? mode : 'finkel';
  }

  socket.on('createRoom', ({ name, botDelayMs, mode, clientId } = {}) => {
    urForgetClient(clientId);
    const code = urMakeCode();
    const room = {
      code,
      hostId: socket.id,
      hostClientId: clientId || null,
      mode: urCleanMode(mode),
      botDelay: Number(botDelayMs) || 1100,
      seats: [{ name: name || 'Player', isBot: false, socketId: socket.id, clientId: clientId || null, playerIdx: 0 }],
      game: null,
      emptySince: null,
    };
    urRooms.set(code, room);
    socket.emit('joined', { code });
    urEmitLobby(room);
  });

  socket.on('joinRoom', ({ code, name, clientId } = {}) => {
    urForgetClient(clientId);
    const clean = String(code || '').trim().toUpperCase();
    const room = urRooms.get(clean);
    if (!room) {
      const cardRoom = rm.getRoom(clean);
      if (cardRoom && !cardRoom.single) {
        return socket.emit('wrongGame', { game: 'cards', code: clean });
      }
      return socket.emit('errorMsg', 'Room not found');
    }
    if (room.seats.length >= 2) return socket.emit('errorMsg', 'Room full');
    if (room.game) return socket.emit('errorMsg', 'Game in progress');
    room.seats.push({ name: name || 'Player', isBot: false, socketId: socket.id, clientId: clientId || null, playerIdx: 1 });
    room.emptySince = null;
    socket.emit('joined', { code: clean });
    urEmitLobby(room);
  });

  socket.on('singleplayer', ({ name, botDelayMs, mode, clientId } = {}) => {
    urForgetClient(clientId);
    const code = urMakeCode();
    const cleanMode = urCleanMode(mode);
    const room = {
      code,
      hostId: socket.id,
      hostClientId: clientId || null,
      mode: cleanMode,
      botDelay: Number(botDelayMs) || 1100,
      seats: [
        { name: name || 'You', isBot: false, socketId: socket.id, clientId: clientId || null, playerIdx: 0 },
        { name: 'Bot', isBot: true, socketId: null, clientId: null, playerIdx: 1 },
      ],
      game: urEngine.createGame(
        [{ id: 'p0', name: name || 'You', isBot: false }, { id: 'p1', name: 'Bot', isBot: true }],
        undefined,
        cleanMode
      ),
      emptySince: null,
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
    })), undefined, room.mode);
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

    room.game.lastRoll = urEngine.rollFor(room.game, Math.random);
    urEmitRoll(room, si, room.game.lastRoll);
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
      return m.dest !== undefined && urEngine.positionOf(room.game, si, m.dest) === destPos;
    });
    if (!move) return socket.emit('errorMsg', 'Invalid move');

    try { urEngine.applyMove(room.game, si, move); } catch (e) {
      return socket.emit('errorMsg', String(e.message));
    }
    urEmitGame(room);
    urDriveBots(room.code);
  });

  // Explicit leave: the seat is given up for good — bot takes over mid-game
  // (no resume claim), lobby seat is removed, empty rooms die immediately.
  function urLeave(socketId) {
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.seats.some((s) => s.socketId === socketId));
    if (!entry) return;
    const [code, room] = entry;
    const seat = room.seats.find((s) => s.socketId === socketId);
    if (seat) {
      seat.socketId = null;
      seat.clientId = null;
      if (room.game) {
        seat.isBot = true;
        if (room.game.players[seat.playerIdx]) room.game.players[seat.playerIdx].isBot = true;
      }
    }
    if (!room.seats.some((s) => s.socketId)) {
      urRooms.delete(code);
      return;
    }
    if (room.hostId === socketId) {
      const next = room.seats.find((s) => s.socketId);
      room.hostId = next.socketId;
      room.hostClientId = next.clientId || null;
    }
    if (room.game) {
      urEmitGame(room);
      urDriveBots(code);
    } else {
      room.seats = room.seats.filter((s) => s.socketId);
      room.seats.forEach((s, i) => { s.playerIdx = i; });
      urEmitLobby(room);
    }
  }

  // Connection dropped: keep the player's place. With another human still
  // connected a bot fills in (game) or the seat is freed (lobby); with
  // nobody left the room simply pauses and waits out the grace period.
  function urDisconnect(socketId) {
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.seats.some((s) => s.socketId === socketId));
    if (!entry) return;
    const [code, room] = entry;
    const seat = room.seats.find((s) => s.socketId === socketId);
    if (!seat) return;
    seat.socketId = null;

    const othersConnected = room.seats.some((s) => s.socketId);
    if (!othersConnected) {
      room.emptySince = Date.now();
      return; // paused — bots stop via the urDriveBots guard
    }

    if (room.hostId === socketId) {
      const next = room.seats.find((s) => s.socketId);
      room.hostId = next.socketId;
      room.hostClientId = next.clientId || null;
    }
    if (room.game) {
      seat.isBot = true;
      if (room.game.players[seat.playerIdx]) room.game.players[seat.playerIdx].isBot = true;
      urEmitGame(room);
      urDriveBots(code);
    } else {
      room.seats = room.seats.filter((s) => s.socketId);
      room.seats.forEach((s, i) => { s.playerIdx = i; });
      urEmitLobby(room);
    }
  }

  socket.on('leaveRoom', () => {
    urLeave(socket.id);
    socket.emit('leftRoom');
  });

  // Deliberate exit (switching games): drop every seat in both games.
  socket.on('abandon', ({ clientId } = {}) => {
    urLeave(socket.id);
    urForgetClient(clientId);
    rm.forgetClient(clientId);
  });

  socket.on('resume', ({ clientId } = {}) => {
    const found = urFindSeatByClient(clientId);
    if (!found) {
      const cardRoom = rm.findRoomByClient(clientId);
      if (cardRoom && cardRoom.seats.some((s) => s.clientId === clientId && !s.socketId)) {
        socket.emit('resumeElsewhere', { game: 'cards' });
      }
      return;
    }
    const { code, room, seat } = found;
    seat.socketId = socket.id;
    if (seat.isBot) {
      seat.isBot = false;
      if (room.game && room.game.players[seat.playerIdx]) {
        room.game.players[seat.playerIdx].isBot = false;
      }
    }
    if (room.hostClientId === clientId || !room.seats.some((s) => s.socketId === room.hostId)) {
      room.hostId = socket.id;
      if (!room.hostClientId) room.hostClientId = clientId;
    }
    room.emptySince = null;
    socket.emit('resumed', { code });
    if (room.game) {
      urEmitGame(room);
      urDriveBots(code);
    } else {
      urEmitLobby(room);
    }
  });

  socket.on('rematch', () => {
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.hostId === socket.id);
    if (!entry) return;
    const room = entry[1];
    if (!room.game || room.game.phase !== 'over') return;
    room.game = urEngine.createGame(room.seats.map((s, i) => ({
      id: 'p' + i, name: s.name, isBot: s.isBot,
    })), undefined, room.mode);
    urEmitGame(room);
    urDriveBots(entry[0]);
  });

  socket.on('disconnect', () => {
    urDisconnect(socket.id);
  });
});

// Sweep rooms nobody has come back to within the grace period.
setInterval(() => {
  rm.sweep();
  const now = Date.now();
  for (const [code, room] of urRooms) {
    if (!room.seats.some((s) => s.socketId)) {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince > 15 * 60 * 1000) urRooms.delete(code);
    }
  }
}, 60 * 1000);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

server.listen(PORT, () => {
  console.log(`Bürge / Hühü server running on http://localhost:${PORT}`);
});
