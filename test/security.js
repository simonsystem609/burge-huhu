'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  isPlainObject,
  onObjectEvent,
  socketAndIpRateLimiter,
} = require('../game/security');
const urEngine = require('../game/ur/engine');
const { fullDeck, isCardId } = require('../game/deck');
const { createKeyedScheduler } = require('../game/keyed-scheduler');

class FakeSocket {
  constructor() {
    this.handlers = new Map();
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  trigger(event, payload) {
    const handler = this.handlers.get(event);
    assert(handler, `No handler registered for ${event}`);
    handler(payload);
  }
}

const namespaceEvents = {
  cards: [
    'createRoom', 'joinRoom', 'singleplayer', 'findMatch', 'removeSeat',
    'setLang', 'move', 'abandon', 'resume',
  ],
  ur: [
    'createRoom', 'joinRoom', 'singleplayer', 'findMatch', 'move',
    'abandon', 'resume',
  ],
};

const invalidPayloads = [
  null,
  undefined,
  [],
  ['array'],
  'string',
  42,
  true,
  new Date(),
];

for (const [namespace, events] of Object.entries(namespaceEvents)) {
  const socket = new FakeSocket();
  for (const event of events) {
    let calls = 0;
    let received;
    onObjectEvent(socket, event, (payload) => {
      calls++;
      received = payload;
    });

    for (const payload of invalidPayloads) socket.trigger(event, payload);
    assert.strictEqual(calls, 0, `${namespace}:${event} accepted a malformed payload`);

    const valid = { namespace, event };
    socket.trigger(event, valid);
    assert.strictEqual(calls, 1, `${namespace}:${event} rejected a valid object`);
    assert.strictEqual(received, valid);

    const nullPrototype = Object.assign(Object.create(null), { event });
    socket.trigger(event, nullPrototype);
    assert.strictEqual(calls, 2, `${namespace}:${event} rejected a null-prototype object`);
    assert.strictEqual(received, nullPrototype);
  }
}

assert.strictEqual(isPlainObject({}), true);
assert.strictEqual(isPlainObject(Object.create(null)), true);
for (const payload of invalidPayloads) assert.strictEqual(isPlainObject(payload), false);

// Guard the registration invariant as handlers are added later: no Socket.IO
// callback may destructure an unvalidated parameter directly.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.strictEqual(/socket\.on\('[^']+',\s*\(\{/.test(serverSource), false);
assert.strictEqual((serverSource.match(/onObjectEvent\(socket,/g) || []).length, 16);

// Separate sockets on one IP get independent bursts, while the aggregate IP
// ceiling still stops quota resets via reconnects/new socket ids.
const allowAction = socketAndIpRateLimiter(2, 5, 60 * 1000);
assert.strictEqual(allowAction('socket-1', '203.0.113.10'), true);
assert.strictEqual(allowAction('socket-1', '203.0.113.10'), true);
assert.strictEqual(allowAction('socket-1', '203.0.113.10'), false);
assert.strictEqual(allowAction('socket-2', '203.0.113.10'), true);
assert.strictEqual(allowAction('socket-2', '203.0.113.10'), true);
assert.strictEqual(allowAction('socket-3', '203.0.113.10'), true);
assert.strictEqual(allowAction('socket-4', '203.0.113.10'), false);
assert.strictEqual(allowAction('socket-4', '198.51.100.20'), true);

const players = [
  { id: 'p0', name: 'P0', isBot: false },
  { id: 'p1', name: 'P1', isBot: false },
];
for (const mode of ['__proto__', 'constructor', 'toString']) {
  assert.strictEqual(Object.hasOwn(urEngine.MODES, mode), false);
  const game = urEngine.createGame(players, () => 0.5, mode);
  assert.strictEqual(game.mode, 'finkel', `Inherited mode ${mode} was accepted`);
  assert.strictEqual(game.cfg, urEngine.MODES.finkel);
}
for (const mode of Object.keys(urEngine.MODES)) {
  assert.strictEqual(urEngine.createGame(players, () => 0.5, mode).mode, mode);
}

// Preview payloads may only relay canonical card ids; HTML fragments and
// lookalikes must never reach the client's cardHTML/innerHTML path.
for (const card of fullDeck()) assert.strictEqual(isCardId(card), true);
for (const card of [
  '<img src=x>',
  'piros-Asz"><img',
  'constructor',
  'tok-VI',
  '',
  null,
]) {
  assert.strictEqual(isCardId(card), false, `Accepted non-canonical card id: ${card}`);
}
assert.strictEqual((serverSource.match(/\.filter\(isCardId\)/g) || []).length, 1);
assert.strictEqual((serverSource.match(/isCardId\(s\.card\)/g) || []).length, 1);

// Only one bot callback may be pending for a room. Once it starts, the next
// turn can schedule normally; cancellation also releases the key.
const timers = [];
const cleared = [];
const scheduler = createKeyedScheduler(
  (callback) => {
    const handle = { callback };
    timers.push(handle);
    return handle;
  },
  (handle) => { cleared.push(handle); }
);
let botRuns = 0;
assert.strictEqual(scheduler.schedule('ROOM', 10, () => { botRuns++; }), true);
assert.strictEqual(scheduler.schedule('ROOM', 10, () => { botRuns++; }), false);
assert.strictEqual(timers.length, 1);
assert.strictEqual(scheduler.hasPending('ROOM'), true);
timers.shift().callback();
assert.strictEqual(botRuns, 1);
assert.strictEqual(scheduler.hasPending('ROOM'), false);
assert.strictEqual(scheduler.schedule('ROOM', 10, () => { botRuns++; }), true);
assert.strictEqual(scheduler.cancel('ROOM'), true);
assert.strictEqual(scheduler.hasPending('ROOM'), false);
assert.strictEqual(cleared.length, 1);

console.log('PASS: socket payload, dual-quota, and Ur mode security checks');
