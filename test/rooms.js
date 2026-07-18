'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RoomManager } = require('../game/rooms');

const rooms = new RoomManager();
const room = rooms.createRoom('socket-old', 'client-a', 'Alice');

// A reopened PWA must be able to reclaim its seat even before the old
// Engine.IO socket reaches its ping timeout.
const liveTakeover = rooms.resumeClient('client-a', 'socket-new');
assert(liveTakeover);
assert.strictEqual(liveTakeover.room, room);
assert.strictEqual(liveTakeover.previousSocketId, 'socket-old');
assert.strictEqual(room.seats[0].socketId, 'socket-new');
assert.strictEqual(room.seats[0].connected, true);
assert.strictEqual(room.hostId, 'socket-new');
assert.strictEqual(rooms.findRoomBySocket('socket-old'), null);
assert.strictEqual(rooms.findRoomBySocket('socket-new'), room);

// The normal post-disconnect path still resumes and reports no live socket to
// evict, preserving the existing grace-period behavior.
const disconnected = rooms.handleDisconnect('socket-new');
assert(disconnected && disconnected.paused);
const afterDisconnect = rooms.resumeClient('client-a', 'socket-third');
assert(afterDisconnect);
assert.strictEqual(afterDisconnect.previousSocketId, null);
assert.strictEqual(room.seats[0].socketId, 'socket-third');

assert.strictEqual(rooms.resumeClient('missing-client', 'socket-x'), null);

// Starting an already-active room must not replace its game object or create
// a second bot-driving chain.
const secondRoom = rooms.createRoom('socket-b', 'client-b', 'Bob');
rooms.addBot(secondRoom);
assert.strictEqual(rooms.startGame(secondRoom).error, undefined);
const activeGame = secondRoom.game;
assert.strictEqual(rooms.startGame(secondRoom).error, 'in_progress');
assert.strictEqual(secondRoom.game, activeGame);

// Keep the server wiring exhaustive: four membership entry points per game,
// plus the now-prevalidated resume in both namespaces, pass the clean id
// directly. Abandon still validates inline in both namespaces.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.strictEqual(
  (serverSource.match(/releaseClientMemberships\(clientId, socket\.id\)/g) || []).length,
  10
);
assert.strictEqual(
  (serverSource.match(/releaseClientMemberships\(validateClientId\(clientId\), socket\.id\)/g) || []).length,
  2
);

console.log('PASS: lobby takeover, resume, and single-membership wiring checks');
