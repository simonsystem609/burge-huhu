'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { RoomManager, MAX_SEATS } = require('./game/rooms');
const { applyMove, currentActor, viewFor } = require('./game/engine');
const { chooseMove } = require('./game/bot');
const { isCardId } = require('./game/deck');
const { createKeyedScheduler } = require('./game/keyed-scheduler');
const {
  issueSeatToken,
  verifySeatToken,
  rotateSeatToken,
  clearSeatToken,
} = require('./game/resume-auth');
const gamelog = require('./game/gamelog');
const {
  onObjectEvent,
  socketRateLimiter,
  socketAndIpRateLimiter,
  validateName,
  validateClientId,
} = require('./game/security');

const PORT = process.env.PORT || 3000;

function clampedNumber(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const BOT_DELAY_MIN = 100;
const BOT_DELAY_MAX = 10000;
// Also used to clamp the client-supplied botDelayMs on every createRoom/
// singleplayer/findMatch path (both namespaces) — without this, a client
// could set an effectively-zero delay and turn driveBots' recursive
// setTimeout into a tight busy loop.
function clampBotDelay(val, fallback) {
  return clampedNumber(val, fallback, BOT_DELAY_MIN, BOT_DELAY_MAX);
}

const DEFAULT_BOT_DELAY = clampBotDelay(process.env.BOT_DELAY_MS, 800);
const MAX_ROOMS = clampedNumber(process.env.MAX_ROOMS, 500, 1, 5000);

// Set ALLOWED_ORIGIN on the host (e.g. https://your-app.onrender.com, comma-
// separated for more than one) to restrict cross-origin socket connections.
// Locally (not on Render, nothing configured) this stays permissive so
// `npm run dev` needs no setup. In production an explicit ALLOWED_ORIGIN
// always wins; if it's missing we still fail closed to the one known
// deployment origin instead of '*', so a forgotten env var can never reopen
// this to every site on the internet.
const KNOWN_PRODUCTION_ORIGIN = 'https://burge-huhu.onrender.com';
const IS_PRODUCTION = !!process.env.RENDER;
const configuredOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
if (IS_PRODUCTION && !configuredOrigins) {
  console.error(
    `ALLOWED_ORIGIN is not set; defaulting to ${KNOWN_PRODUCTION_ORIGIN}. ` +
    'Set ALLOWED_ORIGIN explicitly (Render dashboard → Environment) to confirm this.'
  );
}
const ALLOWED_ORIGIN = configuredOrigins || (IS_PRODUCTION ? [KNOWN_PRODUCTION_ORIGIN] : '*');

// Origin-header allowlist check shared by both the CORS response (covers the
// HTTP polling transport/preflight) and allowRequest below (covers the raw
// WebSocket upgrade, which CORS headers don't gate at all).
function originAllowed(origin) {
  if (!origin) return true; // non-browser clients send no Origin; blocking them adds no real defense
  if (ALLOWED_ORIGIN === '*') return true;
  return ALLOWED_ORIGIN.includes(origin);
}

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN },
  allowRequest: (req, callback) => callback(null, originAllowed(req.headers.origin)),
  // Every real payload here (a move, a roll, a short preview) is well under
  // 1KB; Socket.IO's 1MB default is far more than this app ever needs.
  maxHttpBufferSize: 8 * 1024,
});

// The card game and the Royal Game of Ur keep fully separate room maps, but
// share one code space: a code can never mean two different rooms, so a join
// attempt in the wrong game can be detected and redirected.
const urRooms = new Map(); // code → ur room state
const rm = new RoomManager({ isCodeTaken: (code) => urRooms.has(code) });

// Matchmaking waiting rooms — one queue per game. Each entry is a player who
// pressed "Find match" and is waiting for another; the next searcher pairs
// with the head of the queue into a fresh 2-player game.
const cardQueue = []; // [{ socketId, clientId, name, lang, botDelayMs }]
const urQueue = [];   // [{ socketId, clientId, name, botDelayMs, mode }]
const cardBotScheduler = createKeyedScheduler();
const urBotScheduler = createKeyedScheduler();

function dequeue(queue, socketId) {
  let changed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].socketId !== socketId) continue;
    queue.splice(i, 1);
    changed = true;
  }
  if (changed) emitMatchCount(queue);
  return changed;
}

function enqueueMatch(queue, entry) {
  queue.push(entry);
  emitMatchCount(queue);
}

function totalRoomCount() {
  return rm.rooms.size + urRooms.size;
}

function urFindRoomBySocket(socketId) {
  for (const room of urRooms.values()) {
    if (room.seats.some((s) => s.socketId === socketId)) return room;
  }
  return null;
}

// Behind Render's (or any) reverse proxy, req.ip / socket.handshake.address
// only reflect the real client IP if we trust X-Forwarded-For.
app.set('trust proxy', 1);

// Engine.IO's handshake.address is the raw TCP peer, i.e. the proxy in
// front of us, not the browser — `trust proxy` above only affects Express's
// own req.ip, not Socket.IO. Render's edge does not append to a client-
// supplied X-Forwarded-For like a generic reverse proxy chain; it overwrites
// the header and always places the real client address FIRST (confirmed by
// Render staff: https://feedback.render.com/features/p/send-the-correct-xforwardedfor).
// So on this host the first entry is the trustworthy one, not the last.
function clientIp(handshake) {
  const fwd = handshake.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[0];
  }
  return handshake.address;
}

// New connections stay strictly per-IP. Actions use an independent per-socket
// burst cap plus a much looser per-IP ceiling: normal players behind one NAT
// no longer consume one another's burst quota, while reconnecting cannot reset
// the larger abuse budget.
const connectionLimiter = socketRateLimiter(30, 60 * 1000); // 30 new sockets / IP / min
// A socket gets the normal burst; the shared IP gets five sockets' worth.
const roomActionLimiter = socketAndIpRateLimiter(10, 50, 30 * 1000);
// Gameplay events (move/roll/preview) are far more frequent than room
// actions in normal play (a preview fires on every card click), so this is
// deliberately much looser — it's a spam backstop, not a normal-play cap.
// The IP ceiling supports ten simultaneous normal-play socket bursts.
const gameActionLimiter = socketAndIpRateLimiter(60, 600, 10 * 1000);

function connectionGuard(socket, next) {
  if (!connectionLimiter(clientIp(socket.handshake))) {
    return next(new Error('rate_limited'));
  }
  next();
}
io.use(connectionGuard);
// urIo.use(connectionGuard) is wired in below, once the /ur namespace exists.

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      scriptSrc: ['\'self\''],
      styleSrc: ['\'self\'', '\'unsafe-inline\''],
      imgSrc: ['\'self\'', 'data:'],
      connectSrc: ['\'self\''],
      fontSrc: ['\'self\''],
      objectSrc: ['\'none\''],
      baseUri: ['\'self\''],
      formAction: ['\'self\''],
    },
  },
}));

// Static assets and the health check are cheap and same-origin; this is just
// a backstop against basic HTTP flooding, not the main defense (that's the
// per-socket-event limiter below — most of this app's traffic is WebSocket,
// not HTTP).
app.use(rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));

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

  cardBotScheduler.schedule(room, room.botDelay || DEFAULT_BOT_DELAY, () => {
    const r = rm.getRoom(code);
    if (r !== room || !r.game || r.game.phase === 'over') return;
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
  });
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

function leaveCardSocket(socketId) {
  const info = rm.leaveRoom(socketId);
  if (info && info.room && !info.ended) {
    if (info.room.started) {
      emitGame(info.room);
      driveBots(info.room.code);
    } else {
      emitLobby(info.room);
    }
  }
  return info;
}

// ── Socket handlers ───────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.emit('matchCount', { count: cardQueue.length });

  onObjectEvent(socket, 'createRoom', ({ name, lang, botDelayMs, clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    const existing = rm.findRoomBySocket(socket.id);
    if (existing) return socket.emit('errorMsg', 'already_in_room');
    if (totalRoomCount() >= MAX_ROOMS) return socket.emit('errorMsg', 'server_full');
    name = validateName(name);
    clientId = validateClientId(clientId);
    if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
    dequeue(cardQueue, socket.id);
    releaseClientMemberships(clientId);
    const room = rm.createRoom(socket.id, clientId, name, lang || 'hu');
    room.botDelay = clampBotDelay(botDelayMs, DEFAULT_BOT_DELAY);
    socket.emit('joined', { code: room.code, resumeToken: issueSeatToken(room.seats[0]) });
    emitLobby(room);
  });

  onObjectEvent(socket, 'joinRoom', ({ code, name, clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    if (rm.findRoomBySocket(socket.id)) return socket.emit('errorMsg', 'already_in_room');
    const clean = String(code || '').trim().toUpperCase().slice(0, 8);
    name = validateName(name);
    clientId = validateClientId(clientId);
    const targetRoom = rm.getRoom(clean);
    if (!targetRoom) {
      if (urRooms.has(clean)) return socket.emit('wrongGame', { game: 'ur', code: clean });
      return socket.emit('errorMsg', 'no_room');
    }
    const targetSeat = clientId ? targetRoom.seats.find((seat) => seat.clientId === clientId) : null;
    if (targetSeat) {
      if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
      return resumeCardClaim(socket, clientId, targetRoom, targetSeat);
    }
    if (targetRoom.single) return socket.emit('errorMsg', 'no_room');
    if (targetRoom.started) return socket.emit('errorMsg', 'in_progress');
    if (targetRoom.seats.filter((s) => s.socketId || s.isBot).length >= MAX_SEATS) {
      return socket.emit('errorMsg', 'full');
    }
    if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
    dequeue(cardQueue, socket.id);
    releaseClientMemberships(clientId);
    const res = rm.joinRoom(clean, socket.id, clientId, name);
    if (res.error) {
      return socket.emit('errorMsg', res.error);
    }
    const seat = res.room.seats.find((s) => s.socketId === socket.id);
    socket.emit('joined', { code: res.room.code, resumeToken: seat ? issueSeatToken(seat) : undefined });
    emitLobby(res.room);
  });

  onObjectEvent(socket, 'singleplayer', ({ name, lang, bots, botDelayMs, clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    const existing = rm.findRoomBySocket(socket.id);
    if (existing) return socket.emit('errorMsg', 'already_in_room');
    if (totalRoomCount() >= MAX_ROOMS) return socket.emit('errorMsg', 'server_full');
    name = validateName(name);
    clientId = validateClientId(clientId);
    if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
    dequeue(cardQueue, socket.id);
    releaseClientMemberships(clientId);
    const room = rm.createRoom(socket.id, clientId, name, lang || 'hu', { single: true });
    room.botDelay = clampBotDelay(botDelayMs, DEFAULT_BOT_DELAY);
    const botCount = Math.min(Math.max(Number(bots) || 1, 1), MAX_SEATS - 1);
    for (let i = 0; i < botCount; i++) rm.addBot(room);
    rm.startGame(room);
    gamelog.logStart(room);
    socket.emit('joined', { code: room.code, resumeToken: issueSeatToken(room.seats[0]) });
    emitGame(room);
    driveBots(room.code);
  });

  // Matchmaking: pair with another searching player into a fresh 2-player
  // game, or wait in the queue until one arrives.
  onObjectEvent(socket, 'findMatch', ({ name, lang, botDelayMs, clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    if (rm.findRoomBySocket(socket.id)) return socket.emit('errorMsg', 'already_in_room');
    if (totalRoomCount() >= MAX_ROOMS) return socket.emit('errorMsg', 'server_full');
    name = validateName(name);
    clientId = validateClientId(clientId);
    if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
    dequeue(cardQueue, socket.id); // no duplicate entries for this socket
    releaseClientMemberships(clientId);

    let opp = null;
    while (cardQueue.length) {
      const cand = cardQueue.shift();
      const s = socketOf(cand.socketId);
      const boundId = s && Object.hasOwn(s.data, 'clientId') ? s.data.clientId : undefined;
      if (s && !rm.findRoomBySocket(cand.socketId) && !urFindRoomBySocket(cand.socketId) &&
          cand.socketId !== socket.id && cand.clientId !== clientId &&
          boundId === (cand.clientId || null)) { opp = cand; break; }
    }

    if (!opp) {
      enqueueMatch(cardQueue, { socketId: socket.id, clientId: clientId || null, name, lang, botDelayMs });
      return socket.emit('matchSearching');
    }

    const room = rm.createRoom(opp.socketId, opp.clientId, opp.name, opp.lang || 'hu');
    room.botDelay = clampBotDelay(opp.botDelayMs, DEFAULT_BOT_DELAY);
    const res = rm.joinRoom(room.code, socket.id, clientId, name);
    if (res.error) {
      enqueueMatch(cardQueue, { socketId: socket.id, clientId: clientId || null, name, lang, botDelayMs });
      return socket.emit('matchSearching');
    }
    emitMatchCount(cardQueue);
    rm.startGame(room);
    gamelog.logStart(room);
    const hostSeat = room.seats.find((s) => s.socketId === opp.socketId);
    const joinSeat = room.seats.find((s) => s.socketId === socket.id);
    socketOf(opp.socketId)?.emit('matched', {
      code: room.code,
      resumeToken: hostSeat ? issueSeatToken(hostSeat) : undefined,
    });
    socket.emit('matched', {
      code: room.code,
      resumeToken: joinSeat ? issueSeatToken(joinSeat) : undefined,
    });
    emitGame(room);
    driveBots(room.code);
  });

  socket.on('cancelMatch', () => {
    dequeue(cardQueue, socket.id);
    socket.emit('matchCancelled');
  });

  socket.on('addBot', () => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    const res = rm.addBot(room);
    if (res.error) return socket.emit('errorMsg', res.error);
    emitLobby(room);
  });

  onObjectEvent(socket, 'removeSeat', ({ seatId }) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room || socket.id !== room.hostId) return;
    const res = rm.removeSeat(room, seatId);
    if (res.error) return socket.emit('errorMsg', res.error);
    emitLobby(room);
  });

  onObjectEvent(socket, 'setLang', ({ lang }) => {
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

  onObjectEvent(socket, 'move', ({ move }) => {
    if (!gameActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
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
    if (!gameActionLimiter(socket.id, clientIp(socket.handshake))) return;
    const room = rm.findRoomBySocket(socket.id);
    if (!room || !room.game) return;
    const seatIdx = seatIndexOf(room, socket.id);
    if (seatIdx === -1) return;
    const g = room.game;
    const type = payload && payload.type;
    if (type === 'attack') {
      if (g.phase !== 'attack' || g.attacker !== seatIdx) return;
      const cards = Array.isArray(payload.cards)
        ? payload.cards
          .filter(isCardId)
          .slice(0, 5)
        : [];
      emitPreview(room, seatIdx, { type: 'attack', cards });
    } else if (type === 'defense') {
      if (g.phase !== 'defense' || g.defender !== seatIdx) return;
      const slots = Array.isArray(payload.slots)
        ? payload.slots
          .filter((s) => s && Number.isInteger(s.slot) && isCardId(s.card))
          .slice(0, 5)
          .map((s) => ({ slot: s.slot, card: s.card })) // rebuild exactly — never forward unknown extra properties
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
    leaveCardSocket(socket.id);
    socket.emit('leftRoom');
  });

  socket.on('disconnect', () => {
    dequeue(cardQueue, socket.id);
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
  onObjectEvent(socket, 'abandon', ({ clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) {
      return socket.emit('errorMsg', 'rate_limited');
    }
    const current = socketMemberships(socket.id);
    if (current.length > 1) return socket.emit('errorMsg', 'session_auth_failed');
    const requestedId = validateClientId(clientId);
    const effectiveId = current.length === 1 ? current[0].clientId : requestedId;
    if (!authorizeMembershipChange(socket, effectiveId, resumeToken)) return;
    dequeue(cardQueue, socket.id);
    leaveCardSocket(socket.id);
    releaseClientMemberships(effectiveId);
  });

  // A returning browser: reattach it to whatever seat its clientId holds —
  // singleplayer, waiting lobby or a live game — or point it at the other
  // game if that's where its room lives.
  onObjectEvent(socket, 'resume', ({ clientId, resumeToken }) => {
    clientId = validateClientId(clientId);
    if (!clientId) return;
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) {
      return socket.emit('errorMsg', 'rate_limited');
    }
    // The clientId only says WHO is asking; the resume token is the proof.
    // Verify against the claimed seat BEFORE touching any state, and stay
    // quiet on failure — same outward behavior as an unknown clientId, so a
    // probe learns nothing about which part was wrong.
    const claimRoom = rm.findRoomByClient(clientId);
    if (!claimRoom) {
      const urClaim = urFindSeatByClient(clientId);
      if (urClaim && verifySeatToken(urClaim.seat, resumeToken)) {
        socket.emit('resumeElsewhere', { game: 'ur' });
      }
      return; // nothing to resume — stay quiet
    }
    const claimSeat = claimRoom.seats.find((s) => s.clientId === clientId);
    if (!verifySeatToken(claimSeat, resumeToken)) return;
    if (!bindResumeSocket(socket, clientId, claimSeat)) return;
    resumeCardClaim(socket, clientId, claimRoom, claimSeat);
  });
});

// ── Royal Game of Ur namespace ──────────────────────────────────────────

const urEngine = require('./game/ur/engine');
const urBot = require('./game/ur/bot');

const urIo = io.of('/ur');
urIo.use(connectionGuard);

function emitMatchCount(queue) {
  const namespace = queue === cardQueue ? io : urIo;
  namespace.emit('matchCount', { count: queue.length });
}

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

  urBotScheduler.schedule(room, room.botDelay || 1100, () => {
    const r = urRooms.get(code);
    if (r !== room || !r.game || r.game.phase === 'over') return;
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
  });
}

// Seats held by a returning client, including a socket that has not timed out
// yet after the PWA was closed.
function urFindSeatByClient(clientId) {
  if (!clientId) return null;
  for (const [code, room] of urRooms) {
    const seat = room.seats.find((s) => s.clientId === clientId);
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
      clearSeatToken(seat);
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
    clearSeatToken(seat); // explicit leave — the resume claim dies with it
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

function removeClientFromQueue(queue, clientId, keepSocketId, socketsToClose) {
  let changed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    const entry = queue[i];
    if (entry.clientId !== clientId) continue;
    queue.splice(i, 1);
    changed = true;
    if (entry.socketId && entry.socketId !== keepSocketId) socketsToClose.add(entry.socketId);
  }
  if (changed) emitMatchCount(queue);
}

function disconnectCardSession(socketId) {
  const oldSocket = socketOf(socketId);
  if (!oldSocket) return;
  oldSocket.emit('sessionReplaced');
  oldSocket.disconnect(true);
}

function disconnectUrSession(socketId) {
  const oldSocket = urIo.sockets.get(socketId);
  if (!oldSocket) return;
  oldSocket.emit('sessionReplaced');
  oldSocket.disconnect(true);
}

function clientClaims(clientId) {
  const seats = [];
  for (const room of [...rm.rooms.values(), ...urRooms.values()]) {
    for (const seat of room.seats) {
      if (seat.clientId === clientId) seats.push({ room, seat });
    }
  }
  const queues = [];
  for (const entry of cardQueue) if (entry.clientId === clientId) queues.push({ game: 'cards', entry });
  for (const entry of urQueue) if (entry.clientId === clientId) queues.push({ game: 'ur', entry });
  return { seats, queues };
}

function socketMemberships(socketId) {
  const claims = [];
  for (const room of [...rm.rooms.values(), ...urRooms.values()]) {
    for (const seat of room.seats) {
      if (seat.socketId === socketId) claims.push({ clientId: seat.clientId || null, seat, queue: null });
    }
  }
  for (const entry of cardQueue) {
    if (entry.socketId === socketId) claims.push({ clientId: entry.clientId || null, seat: null, queue: entry });
  }
  for (const entry of urQueue) {
    if (entry.socketId === socketId) claims.push({ clientId: entry.clientId || null, seat: null, queue: entry });
  }
  return claims;
}

function socketClientCompatible(socket, clientId) {
  if (Object.hasOwn(socket.data, 'clientId') && socket.data.clientId !== clientId) return false;
  const current = socketMemberships(socket.id);
  return current.length <= 1 && current.every((claim) => claim.clientId === clientId);
}

function authorizeMembershipChange(socket, clientId, resumeToken) {
  if (!socketClientCompatible(socket, clientId)) {
    socket.emit('errorMsg', 'session_auth_failed');
    return false;
  }
  if (!clientId) {
    socket.data.clientId = null;
    return true;
  }
  const { seats, queues } = clientClaims(clientId);
  const total = seats.length + queues.length;
  let allowed = total === 0;
  if (total === 1 && seats.length === 1) {
    const seat = seats[0].seat;
    allowed = seat.socketId === socket.id || verifySeatToken(seat, resumeToken);
  } else if (total === 1 && queues.length === 1) {
    allowed = queues[0].entry.socketId === socket.id;
  }
  if (!allowed) {
    socket.emit('errorMsg', 'session_auth_failed');
    return false;
  }
  socket.data.clientId = clientId;
  return true;
}

function bindResumeSocket(socket, clientId, targetSeat) {
  if (!socketClientCompatible(socket, clientId)) {
    socket.emit('errorMsg', 'already_in_room');
    return false;
  }
  const { seats, queues } = clientClaims(clientId);
  if (seats.length !== 1 || seats[0].seat !== targetSeat ||
      queues.some(({ entry }) => entry.socketId !== socket.id)) {
    socket.emit('errorMsg', 'already_in_room');
    return false;
  }
  const current = socketMemberships(socket.id);
  if (current.some((claim) => claim.seat && claim.seat !== targetSeat)) {
    socket.emit('errorMsg', 'already_in_room');
    return false;
  }
  socket.data.clientId = clientId;
  return true;
}

/**
 * Enforce one live membership per browser client id across both games.
 * `keepSocketId` is the seat just resumed by this request; every other room,
 * game, or matchmaking claim is released before the caller continues.
 */
function releaseClientMemberships(clientId, keepSocketId = null) {
  if (!clientId) return;

  const cardSockets = new Set();
  const urSockets = new Set();

  for (const room of [...rm.rooms.values()]) {
    for (const seat of room.seats) {
      if (seat.clientId === clientId && seat.socketId && seat.socketId !== keepSocketId) {
        cardSockets.add(seat.socketId);
      }
    }
  }
  for (const room of [...urRooms.values()]) {
    for (const seat of room.seats) {
      if (seat.clientId === clientId && seat.socketId && seat.socketId !== keepSocketId) {
        urSockets.add(seat.socketId);
      }
    }
  }

  removeClientFromQueue(cardQueue, clientId, keepSocketId, cardSockets);
  removeClientFromQueue(urQueue, clientId, keepSocketId, urSockets);

  for (const socketId of cardSockets) {
    dequeue(cardQueue, socketId);
    leaveCardSocket(socketId);
  }
  for (const socketId of urSockets) {
    dequeue(urQueue, socketId);
    urLeave(socketId);
  }

  // Clean up disconnected legacy duplicates while preserving the one active
  // seat identified by keepSocketId, if this is a resume rather than a switch.
  rm.forgetClient(clientId);
  urForgetClient(clientId);

  for (const socketId of cardSockets) disconnectCardSession(socketId);
  for (const socketId of urSockets) disconnectUrSession(socketId);
}

function resumeCardClaim(socket, clientId, room, seat) {
  const res = rm.resumeSeat(room, seat, socket.id);
  if (!res) return false;
  if (res.previousSocketId === socket.id) return true;
  if (res.previousSocketId) {
    dequeue(cardQueue, res.previousSocketId);
    disconnectCardSession(res.previousSocketId);
  }
  releaseClientMemberships(clientId, socket.id);
  socket.emit('resumed', { code: room.code, resumeToken: rotateSeatToken(seat) });
  if (room.started) {
    emitGame(room);
    driveBots(room.code);
  } else {
    emitLobby(room);
  }
  return true;
}

function resumeUrClaim(socket, clientId, found) {
  const { code, room, seat } = found;
  const previousSocketId = seat.socketId;
  if (previousSocketId === socket.id) return true;
  seat.socketId = socket.id;
  if (previousSocketId) {
    dequeue(urQueue, previousSocketId);
    disconnectUrSession(previousSocketId);
  }
  releaseClientMemberships(clientId, socket.id);
  if (seat.isBot) {
    seat.isBot = false;
    if (room.game && room.game.players[seat.playerIdx]) room.game.players[seat.playerIdx].isBot = false;
  }
  if (room.hostClientId === clientId || !room.seats.some((s) => s.socketId === room.hostId)) {
    room.hostId = socket.id;
    if (!room.hostClientId) room.hostClientId = clientId;
  }
  room.emptySince = null;
  socket.emit('resumed', { code, resumeToken: rotateSeatToken(seat) });
  if (room.game) {
    urEmitGame(room);
    urDriveBots(code);
  } else {
    urEmitLobby(room);
  }
  return true;
}

urIo.on('connection', (socket) => {
  socket.emit('matchCount', { count: urQueue.length });

  function urSeatIdx(room) {
    return room.seats.findIndex((s) => s.socketId === socket.id);
  }

  function urCleanMode(mode) {
    return Object.hasOwn(urEngine.MODES, mode) ? mode : 'finkel';
  }

  onObjectEvent(socket, 'createRoom', ({ name, botDelayMs, mode, clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    if (urFindRoomBySocket(socket.id)) return socket.emit('errorMsg', 'already_in_room');
    if (totalRoomCount() >= MAX_ROOMS) return socket.emit('errorMsg', 'server_full');
    name = validateName(name);
    clientId = validateClientId(clientId);
    if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
    dequeue(urQueue, socket.id);
    releaseClientMemberships(clientId);
    const code = urMakeCode();
    const room = {
      code,
      hostId: socket.id,
      hostClientId: clientId || null,
      mode: urCleanMode(mode),
      botDelay: clampBotDelay(botDelayMs, 1100),
      seats: [{ name: name || 'Player', isBot: false, socketId: socket.id, clientId: clientId || null, playerIdx: 0 }],
      game: null,
      emptySince: null,
    };
    urRooms.set(code, room);
    socket.emit('joined', { code, resumeToken: issueSeatToken(room.seats[0]) });
    urEmitLobby(room);
  });

  onObjectEvent(socket, 'joinRoom', ({ code, name, clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    if (urFindRoomBySocket(socket.id)) return socket.emit('errorMsg', 'already_in_room');
    name = validateName(name);
    clientId = validateClientId(clientId);
    const clean = String(code || '').trim().toUpperCase().slice(0, 8);
    const room = urRooms.get(clean);
    if (!room) {
      const cardRoom = rm.getRoom(clean);
      if (cardRoom && !cardRoom.single) {
        return socket.emit('wrongGame', { game: 'cards', code: clean });
      }
      return socket.emit('errorMsg', 'Room not found');
    }
    const targetSeat = clientId ? room.seats.find((seat) => seat.clientId === clientId) : null;
    if (targetSeat) {
      if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
      return resumeUrClaim(socket, clientId, { code: clean, room, seat: targetSeat });
    }
    if (room.seats.length >= 2) return socket.emit('errorMsg', 'Room full');
    if (room.game) return socket.emit('errorMsg', 'Game in progress');
    if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
    dequeue(urQueue, socket.id);
    releaseClientMemberships(clientId);
    const seat = { name: name || 'Player', isBot: false, socketId: socket.id, clientId: clientId || null, playerIdx: 1 };
    room.seats.push(seat);
    room.emptySince = null;
    socket.emit('joined', { code: clean, resumeToken: issueSeatToken(seat) });
    urEmitLobby(room);
  });

  onObjectEvent(socket, 'singleplayer', ({ name, botDelayMs, mode, clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    if (urFindRoomBySocket(socket.id)) return socket.emit('errorMsg', 'already_in_room');
    if (totalRoomCount() >= MAX_ROOMS) return socket.emit('errorMsg', 'server_full');
    name = validateName(name);
    clientId = validateClientId(clientId);
    if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
    dequeue(urQueue, socket.id);
    releaseClientMemberships(clientId);
    const code = urMakeCode();
    const cleanMode = urCleanMode(mode);
    const room = {
      code,
      hostId: socket.id,
      hostClientId: clientId || null,
      mode: cleanMode,
      botDelay: clampBotDelay(botDelayMs, 1100),
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
    socket.emit('joined', { code, resumeToken: issueSeatToken(room.seats[0]) });
    urEmitGame(room);
    urDriveBots(code);
  });

  // Matchmaking: pair with another searching player into a fresh 2-player
  // game (using the waiting player's chosen mode), or wait in the queue.
  onObjectEvent(socket, 'findMatch', ({ name, botDelayMs, mode, clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    if (urFindRoomBySocket(socket.id)) return socket.emit('errorMsg', 'already_in_room');
    if (totalRoomCount() >= MAX_ROOMS) return socket.emit('errorMsg', 'server_full');
    name = validateName(name);
    clientId = validateClientId(clientId);
    if (!authorizeMembershipChange(socket, clientId, resumeToken)) return;
    dequeue(urQueue, socket.id);
    releaseClientMemberships(clientId);

    let opp = null;
    while (urQueue.length) {
      const cand = urQueue.shift();
      const s = urIo.sockets.get(cand.socketId);
      const boundId = s && Object.hasOwn(s.data, 'clientId') ? s.data.clientId : undefined;
      if (s && !urFindRoomBySocket(cand.socketId) && !rm.findRoomBySocket(cand.socketId) &&
          cand.socketId !== socket.id && cand.clientId !== clientId &&
          boundId === (cand.clientId || null)) { opp = cand; break; }
    }

    if (!opp) {
      enqueueMatch(urQueue, {
        socketId: socket.id,
        clientId: clientId || null,
        name,
        botDelayMs,
        mode: urCleanMode(mode),
      });
      return socket.emit('matchSearching');
    }

    const code = urMakeCode();
    const cleanMode = opp.mode || 'finkel';
    const room = {
      code,
      hostId: opp.socketId,
      hostClientId: opp.clientId || null,
      mode: cleanMode,
      botDelay: clampBotDelay(opp.botDelayMs, 1100),
      seats: [
        { name: opp.name || 'Player', isBot: false, socketId: opp.socketId, clientId: opp.clientId || null, playerIdx: 0 },
        { name: name || 'Player', isBot: false, socketId: socket.id, clientId: clientId || null, playerIdx: 1 },
      ],
      game: null,
      emptySince: null,
    };
    room.game = urEngine.createGame(
      room.seats.map((s, i) => ({ id: 'p' + i, name: s.name, isBot: s.isBot })),
      undefined,
      cleanMode
    );
    urRooms.set(code, room);
    emitMatchCount(urQueue);
    urIo.sockets.get(opp.socketId)?.emit('matched', {
      code,
      resumeToken: issueSeatToken(room.seats[0]),
    });
    socket.emit('matched', { code, resumeToken: issueSeatToken(room.seats[1]) });
    urEmitGame(room);
    urDriveBots(code);
  });

  socket.on('cancelMatch', () => {
    dequeue(urQueue, socket.id);
    socket.emit('matchCancelled');
  });

  socket.on('startGame', () => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) {
      return socket.emit('errorMsg', 'rate_limited');
    }
    const room = urRooms.get([...urRooms.entries()].find(([, r]) => r.hostId === socket.id)?.[0]);
    if (!room || room.hostId !== socket.id) return;
    if (room.game) return socket.emit('errorMsg', 'Game already started');
    if (room.seats.length < 2) return socket.emit('errorMsg', 'Need 2 players');
    room.game = urEngine.createGame(room.seats.map((s, i) => ({
      id: 'p' + i, name: s.name, isBot: s.isBot,
    })), undefined, room.mode);
    urEmitGame(room);
    urDriveBots(room.code);
  });

  socket.on('roll', () => {
    if (!gameActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.seats.some((s) => s.socketId === socket.id));
    if (!entry) return;
    const room = entry[1];
    if (!room.game) return;
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

  onObjectEvent(socket, 'move', ({ piece, destPos }) => {
    if (!gameActionLimiter(socket.id, clientIp(socket.handshake))) return socket.emit('errorMsg', 'rate_limited');
    const entry = [...urRooms.entries()].find(([, r]) =>
      r.seats.some((s) => s.socketId === socket.id));
    if (!entry) return;
    const room = entry[1];
    if (!room.game) return;
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
  onObjectEvent(socket, 'abandon', ({ clientId, resumeToken }) => {
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) {
      return socket.emit('errorMsg', 'rate_limited');
    }
    const current = socketMemberships(socket.id);
    if (current.length > 1) return socket.emit('errorMsg', 'session_auth_failed');
    const requestedId = validateClientId(clientId);
    const effectiveId = current.length === 1 ? current[0].clientId : requestedId;
    if (!authorizeMembershipChange(socket, effectiveId, resumeToken)) return;
    dequeue(urQueue, socket.id);
    urLeave(socket.id);
    releaseClientMemberships(effectiveId);
  });

  onObjectEvent(socket, 'resume', ({ clientId, resumeToken }) => {
    clientId = validateClientId(clientId);
    if (!clientId) return;
    if (!roomActionLimiter(socket.id, clientIp(socket.handshake))) {
      return socket.emit('errorMsg', 'rate_limited');
    }
    const found = urFindSeatByClient(clientId);
    if (!found) {
      const cardRoom = rm.findRoomByClient(clientId);
      const cardSeat = cardRoom && cardRoom.seats.find((s) => s.clientId === clientId);
      if (cardSeat && verifySeatToken(cardSeat, resumeToken)) {
        socket.emit('resumeElsewhere', { game: 'cards' });
      }
      return;
    }
    // clientId identifies, the token proves — verify before touching state,
    // and fail silently so probes look identical to unknown clientIds.
    if (!verifySeatToken(found.seat, resumeToken)) return;
    if (!bindResumeSocket(socket, clientId, found.seat)) return;
    resumeUrClaim(socket, clientId, found);
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
    dequeue(urQueue, socket.id);
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
