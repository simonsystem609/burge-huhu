'use strict';

/**
 * Room / lobby management. Pure state — no sockets, no timers.
 * Seat order maps 1:1 to engine player index.
 *
 * Every human seat remembers a persistent `clientId` (a browser-scoped id),
 * so a player who closes the tab can RESUME later: on disconnect the seat is
 * kept — botified if other humans are still playing, or the whole room just
 * pauses when nobody is left — and `resumeClient` reattaches a new socket.
 * Rooms with no connected humans are swept after a grace period.
 */

const { createGame } = require('./engine');
const { clearSeatToken } = require('./resume-auth');

const MAX_SEATS = 4;
const MIN_SEATS = 2;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars
const GRACE_MS = 15 * 60 * 1000; // empty rooms survive this long

let botCounter = 0;

function makeCode(rooms, isTaken) {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code) || (isTaken && isTaken(code)));
  return code;
}

class RoomManager {
  constructor({ isCodeTaken } = {}) {
    this.rooms = new Map(); // code -> room
    // Optional extra check so codes stay unique across other games' rooms too.
    this.isCodeTaken = isCodeTaken || null;
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  createRoom(hostSocketId, clientId, name, lang = 'hu', { single = false } = {}) {
    const code = makeCode(this.rooms, this.isCodeTaken);
    const room = {
      code,
      hostId: hostSocketId,
      hostClientId: clientId || null,
      lang,
      single, // singleplayer rooms are not joinable
      started: false,
      game: null,
      emptySince: null,
      seats: [
        {
          id: `p_${hostSocketId}`,
          name: name || 'Játékos',
          isBot: false,
          socketId: hostSocketId,
          clientId: clientId || null,
          connected: true,
        },
      ],
    };
    this.rooms.set(code, room);
    return room;
  }

  findRoomBySocket(socketId) {
    if (!socketId) return null;
    for (const room of this.rooms.values()) {
      if (room.seats.some((s) => s.socketId === socketId)) return room;
    }
    return null;
  }

  /** The room holding a (possibly disconnected) seat for this client. */
  findRoomByClient(clientId) {
    if (!clientId) return null;
    for (const room of this.rooms.values()) {
      if (room.seats.some((s) => s.clientId === clientId)) return room;
    }
    return null;
  }

  joinRoom(code, socketId, clientId, name) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'no_room' };
    if (room.single) return { error: 'no_room' };
    if (room.started) return { error: 'in_progress' };
    if (room.seats.filter((s) => s.socketId || s.isBot).length >= MAX_SEATS) {
      return { error: 'full' };
    }
    const seat = {
      id: `p_${socketId}`,
      name: name || 'Játékos',
      isBot: false,
      socketId,
      clientId: clientId || null,
      connected: true,
    };
    room.seats.push(seat);
    room.emptySince = null;
    return { room };
  }

  addBot(room) {
    if (room.started) return { error: 'in_progress' };
    if (room.seats.length >= MAX_SEATS) return { error: 'full' };
    botCounter += 1;
    const styles = ['balanced', 'aggressive', 'gatherer', 'cautious'];
    room.seats.push({
      id: `bot_${botCounter}`,
      name: `Bot ${room.seats.filter((s) => s.isBot).length + 1}`,
      isBot: true,
      // Each bot gets a temperament for the whole room's lifetime.
      style: styles[Math.floor(Math.random() * styles.length)],
      socketId: null,
      clientId: null,
      connected: true,
    });
    return { room };
  }

  removeSeat(room, seatId) {
    if (room.started) return { error: 'in_progress' };
    const idx = room.seats.findIndex((s) => s.id === seatId);
    if (idx === -1) return { error: 'no_seat' };
    if (room.seats[idx].socketId === room.hostId) return { error: 'host' };
    room.seats.splice(idx, 1);
    return { room };
  }

  startGame(room) {
    if (room.started || room.game) return { error: 'in_progress' };
    const seatCount = room.seats.length;
    if (seatCount < MIN_SEATS) return { error: 'need_players' };
    if (seatCount > MAX_SEATS) return { error: 'full' };
    room.game = createGame(
      room.seats.map((s) => ({ id: s.id, name: s.name, isBot: s.isBot }))
    );
    room.started = true;
    return { room };
  }

  /** Reset a finished game back to the lobby for a rematch (same seats). */
  resetGame(room) {
    room.started = false;
    room.game = null;
    return room;
  }

  hasConnectedHuman(room) {
    return room.seats.some((s) => s.socketId);
  }

  transferHost(room, exceptSocketId) {
    const next = room.seats.find((s) => s.socketId && s.socketId !== exceptSocketId);
    if (next) {
      room.hostId = next.socketId;
      room.hostClientId = next.clientId || null;
    }
  }

  /**
   * Explicit leave — the player chose to go. Their seat is removed (lobby)
   * or permanently botified (mid-game); the room dies once no connected
   * human remains. Returns { room, ended } or null.
   */
  leaveRoom(socketId) {
    const room = this.findRoomBySocket(socketId);
    if (!room) return null;
    const seat = room.seats.find((s) => s.socketId === socketId);
    if (!seat) return null;

    if (!room.started) {
      const wasHost = seat.socketId === room.hostId;
      room.seats = room.seats.filter((s) => s !== seat);
      if (!this.hasConnectedHuman(room)) {
        this.rooms.delete(room.code);
        return { room, ended: true };
      }
      if (wasHost) this.transferHost(room, socketId);
      return { room };
    }

    // Mid-game: a bot takes the seat for good (no resume claim).
    seat.isBot = true;
    seat.connected = false;
    seat.socketId = null;
    seat.clientId = null;
    clearSeatToken(seat);
    seat.name = `${seat.name} (bot)`;
    if (!this.hasConnectedHuman(room)) {
      this.rooms.delete(room.code);
      return { room, ended: true };
    }
    if (room.hostId === socketId) this.transferHost(room, socketId);
    return { room };
  }

  /**
   * A socket dropped without leaving — keep the player's place so they can
   * resume. Returns { room, paused } or null.
   * - Others still connected + game running: bot takes over (temporarily).
   * - Others still connected + lobby: the seat is removed (they can rejoin).
   * - Nobody left: the room pauses and waits out the grace period.
   */
  handleDisconnect(socketId) {
    const room = this.findRoomBySocket(socketId);
    if (!room) return null;
    const seat = room.seats.find((s) => s.socketId === socketId);
    if (!seat) return null;

    seat.socketId = null;
    seat.connected = false;

    const othersConnected = this.hasConnectedHuman(room);

    if (!room.started) {
      if (othersConnected) {
        room.seats = room.seats.filter((s) => s !== seat);
        if (room.hostId === socketId) this.transferHost(room, socketId);
        return { room };
      }
      room.emptySince = Date.now();
      return { room, paused: true };
    }

    if (othersConnected) {
      // Bot plays the seat until (if ever) the human comes back.
      seat._humanName = seat.name;
      seat.isBot = true;
      if (room.game && room.game.players[room.seats.indexOf(seat)]) {
        room.game.players[room.seats.indexOf(seat)].isBot = true;
      }
      if (room.hostId === socketId) this.transferHost(room, socketId);
      return { room };
    }

    // Nobody is watching: pause — bots stop, the game waits.
    room.emptySince = Date.now();
    return { room, paused: true };
  }

  /**
   * Reattach a returning client to their seat. The previous socket may still
   * look connected when a PWA is closed and reopened before Engine.IO's ping
   * timeout; callers can disconnect `previousSocketId` after the seat has
   * moved so that stale socket cannot keep acting. Returns
   * { room, seatIdx, previousSocketId } or null if no seat exists.
   */
  resumeClient(clientId, newSocketId) {
    if (!clientId) return null;
    for (const room of this.rooms.values()) {
      const seat = room.seats.find((s) => s.clientId === clientId);
      if (!seat) continue;
      const previousSocketId = seat.socketId;
      seat.socketId = newSocketId;
      seat.connected = true;
      if (seat._humanName) {
        seat.name = seat._humanName;
        seat._humanName = null;
      }
      if (seat.isBot) {
        seat.isBot = false;
        const idx = room.seats.indexOf(seat);
        if (room.game && room.game.players[idx]) room.game.players[idx].isBot = false;
      }
      if (room.hostClientId === clientId || !room.seats.some((s) => s.socketId === room.hostId)) {
        room.hostId = newSocketId;
        if (!room.hostClientId) room.hostClientId = clientId;
      }
      room.emptySince = null;
      return { room, seatIdx: room.seats.indexOf(seat), previousSocketId };
    }
    return null;
  }

  /** Drop stale (disconnected) seats this client holds — before a fresh join. */
  forgetClient(clientId) {
    if (!clientId) return;
    for (const room of this.rooms.values()) {
      const seat = room.seats.find((s) => s.clientId === clientId && !s.socketId);
      if (!seat) continue;
      if (!room.started) {
        room.seats = room.seats.filter((s) => s !== seat);
        if (room.seats.length === 0 || !room.seats.some((s) => s.socketId || s.isBot)) {
          this.rooms.delete(room.code);
        }
      } else {
        seat.clientId = null; // seat stays botified; no resume claim
        clearSeatToken(seat);
        seat.isBot = true;
        const idx = room.seats.indexOf(seat);
        if (room.game && room.game.players[idx]) room.game.players[idx].isBot = true;
      }
      if (!this.hasConnectedHuman(room) && this.rooms.has(room.code)) {
        if (!room.emptySince) room.emptySince = Date.now();
      }
    }
  }

  /** Delete rooms that have been empty of humans past the grace period. */
  sweep(graceMs = GRACE_MS) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (!this.hasConnectedHuman(room)) {
        if (!room.emptySince) room.emptySince = now;
        if (now - room.emptySince > graceMs) this.rooms.delete(code);
      }
    }
  }
}

module.exports = { RoomManager, MAX_SEATS, MIN_SEATS, GRACE_MS };
