'use strict';

/**
 * Room / lobby management. Pure state — no sockets, no timers.
 * Seat order maps 1:1 to engine player index.
 */

const { createGame } = require('./engine');

const MAX_SEATS = 4;
const MIN_SEATS = 2;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars

let botCounter = 0;

function makeCode(rooms) {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> room
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  createRoom(hostSocketId, name, lang = 'hu', { single = false } = {}) {
    const code = makeCode(this.rooms);
    const room = {
      code,
      hostId: hostSocketId,
      lang,
      single, // singleplayer rooms are not joinable
      started: false,
      game: null,
      seats: [
        {
          id: `p_${hostSocketId}`,
          name: name || 'Játékos',
          isBot: false,
          socketId: hostSocketId,
          connected: true,
        },
      ],
    };
    this.rooms.set(code, room);
    return room;
  }

  findRoomBySocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.seats.some((s) => s.socketId === socketId)) return room;
    }
    return null;
  }

  joinRoom(code, socketId, name) {
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
      connected: true,
    };
    room.seats.push(seat);
    return { room };
  }

  addBot(room) {
    if (room.started) return { error: 'in_progress' };
    if (room.seats.length >= MAX_SEATS) return { error: 'full' };
    botCounter += 1;
    room.seats.push({
      id: `bot_${botCounter}`,
      name: `Bot ${room.seats.filter((s) => s.isBot).length + 1}`,
      isBot: true,
      socketId: null,
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

  /**
   * Handle a socket disconnecting. Returns { room, removed, ended } or null.
   * - In lobby: the seat is removed.
   * - In game: the seat is turned into a bot so play can continue.
   */
  handleDisconnect(socketId) {
    const room = this.findRoomBySocket(socketId);
    if (!room) return null;
    const seat = room.seats.find((s) => s.socketId === socketId);
    if (!seat) return null;

    if (!room.started) {
      const wasHost = seat.socketId === room.hostId;
      room.seats = room.seats.filter((s) => s.socketId !== socketId);
      // If the room is now empty of humans, drop it.
      if (!room.seats.some((s) => s.socketId)) {
        this.rooms.delete(room.code);
        return { room, ended: true };
      }
      if (wasHost) {
        const nextHuman = room.seats.find((s) => s.socketId);
        if (nextHuman) room.hostId = nextHuman.socketId;
      }
      return { room, removed: seat.id };
    }

    // Mid-game: convert to a bot.
    seat.isBot = true;
    seat.connected = false;
    seat.socketId = null;
    seat.name = `${seat.name} (bot)`;
    // If no humans remain connected, close the room.
    if (!room.seats.some((s) => s.socketId)) {
      this.rooms.delete(room.code);
      return { room, ended: true };
    }
    return { room, botified: seat.id };
  }
}

module.exports = { RoomManager, MAX_SEATS, MIN_SEATS };
