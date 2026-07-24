'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const clients = [];
let child;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function connect(url) {
  const socket = io(url, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });
  clients.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out connecting to ${url}`)), 3000);
    function finish(error) {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      if (error) reject(error);
      else resolve();
    }
    function onConnect() { finish(); }
    function onError(error) { finish(error); }
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
  });
  return socket;
}

async function expectError(socket, event, payload, expected = 'session_auth_failed', successEvents = []) {
  const successes = [];
  const listeners = successEvents.map((name) => {
    const listener = () => successes.push(name);
    socket.on(name, listener);
    return [name, listener];
  });
  try {
    const error = waitEvent(socket, 'errorMsg');
    socket.emit(event, payload);
    assert.strictEqual(await error, expected, `${event} returned the wrong rejection`);
    await delay(75);
    assert.deepStrictEqual(successes, [], `${event} emitted success after rejection`);
  } finally {
    for (const [name, listener] of listeners) socket.off(name, listener);
  }
}

async function createCardLobby(socket, clientId) {
  const joined = waitEvent(socket, 'joined');
  socket.emit('createRoom', { name: clientId, lang: 'en', clientId });
  return joined;
}

async function createUrLobby(socket, clientId) {
  const joined = waitEvent(socket, 'joined');
  socket.emit('createRoom', { name: clientId, mode: 'finkel', clientId });
  return joined;
}

async function run() {
  const port = await freePort();
  let stdout = '';
  let stderr = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitUntil(
    () => stdout.includes('server running'),
    `Server did not start (exit ${child.exitCode}). stdout: ${stdout} stderr: ${stderr}`,
    10000
  );
  const base = `http://127.0.0.1:${port}`;
  const wrongToken = 'X'.repeat(43);

  const cardVictim = await connect(base);
  let cardVictimReplaced = 0;
  cardVictim.on('sessionReplaced', () => { cardVictimReplaced++; });
  const cardClaim = await createCardLobby(cardVictim, 'guard-card');
  const cardTarget = await connect(base);
  const cardTargetClaim = await createCardLobby(cardTarget, 'target-card');
  const cardAttacker = await connect(base);

  const cardAttacks = [
    ['createRoom', { name: 'thief', clientId: 'guard-card', resumeToken: wrongToken }, ['joined']],
    ['joinRoom', { code: cardTargetClaim.code, name: 'thief', clientId: 'guard-card', resumeToken: wrongToken }, ['joined']],
    ['singleplayer', { name: 'thief', bots: 1, clientId: 'guard-card', resumeToken: wrongToken }, ['joined']],
    ['findMatch', { name: 'thief', clientId: 'guard-card', resumeToken: wrongToken }, ['matchSearching', 'matched']],
    ['abandon', { clientId: 'guard-card', resumeToken: wrongToken }, []],
  ];
  for (const [event, payload, successEvents] of cardAttacks) {
    await expectError(cardAttacker, event, payload, 'session_auth_failed', successEvents);
  }
  assert.strictEqual(cardVictim.connected, true, 'card attacks disconnected the owner');
  assert.strictEqual(cardVictimReplaced, 0, 'card attacks replaced the owner');

  await expectError(
    cardAttacker,
    'joinRoom',
    { code: 'NOPE0000', name: 'owner', clientId: 'guard-card', resumeToken: cardClaim.resumeToken },
    'no_room',
    ['joined', 'resumed']
  );
  assert.strictEqual(cardVictim.connected, true, 'invalid target released the valid card claim');

  const cardSelf = await connect(base);
  const cardSelfResume = waitEvent(cardSelf, 'resumed');
  cardSelf.emit('joinRoom', {
    code: cardClaim.code,
    name: 'owner',
    clientId: 'guard-card',
    resumeToken: cardClaim.resumeToken,
  });
  const cardSelfClaim = await cardSelfResume;
  assert.strictEqual(cardSelfClaim.code, cardClaim.code, 'card self-join changed rooms');
  assert.notStrictEqual(cardSelfClaim.resumeToken, cardClaim.resumeToken, 'card self-join did not rotate');
  await waitUntil(() => cardVictimReplaced === 1, 'card live owner was not replaced once');

  let cardTargetResumes = 0;
  cardTarget.on('resumed', () => { cardTargetResumes++; });
  await expectError(
    cardTarget,
    'resume',
    { clientId: 'guard-card', resumeToken: cardSelfClaim.resumeToken },
    'already_in_room'
  );
  assert.strictEqual(cardTargetResumes, 0, 'one card socket resumed a second identity');

  cardSelf.disconnect();
  await delay(150);
  const cardOwner = await connect(base);
  const cardOwnerResume = waitEvent(cardOwner, 'resumed');
  cardOwner.emit('resume', { clientId: 'guard-card', resumeToken: cardSelfClaim.resumeToken });
  const cardOwnerClaim = await cardOwnerResume;
  assert.strictEqual(cardOwnerClaim.code, cardClaim.code, 'card claim changed after rejected double resume');

  const cardQueueOwner = await connect(base);
  const cardSearching = waitEvent(cardQueueOwner, 'matchSearching');
  cardQueueOwner.emit('findMatch', { name: 'queue', clientId: 'queue-card' });
  await cardSearching;
  await expectError(
    cardQueueOwner,
    'createRoom',
    { name: 'changed', clientId: 'queue-card-other' },
    'session_auth_failed',
    ['joined']
  );
  const queueRoomJoined = waitEvent(cardQueueOwner, 'joined');
  cardQueueOwner.emit('createRoom', { name: 'queue', clientId: 'queue-card' });
  await queueRoomJoined;

  const laterMatcher = await connect(base);
  const laterSearching = waitEvent(laterMatcher, 'matchSearching');
  laterMatcher.emit('findMatch', { name: 'later', clientId: 'queue-card-later' });
  await laterSearching;
  await expectError(
    cardAttacker,
    'createRoom',
    { name: 'thief', clientId: 'queue-card-later' },
    'session_auth_failed',
    ['joined']
  );
  const matchCancelled = waitEvent(laterMatcher, 'matchCancelled');
  laterMatcher.emit('cancelMatch');
  await matchCancelled;

  const urVictim = await connect(`${base}/ur`);
  let urVictimReplaced = 0;
  urVictim.on('sessionReplaced', () => { urVictimReplaced++; });
  const urClaim = await createUrLobby(urVictim, 'guard-ur');
  const urTarget = await connect(`${base}/ur`);
  const urTargetClaim = await createUrLobby(urTarget, 'target-ur');
  const urAttacker = await connect(`${base}/ur`);

  const urAttacks = [
    ['createRoom', { name: 'thief', clientId: 'guard-ur', resumeToken: wrongToken }, ['joined']],
    ['joinRoom', { code: urTargetClaim.code, name: 'thief', clientId: 'guard-ur', resumeToken: wrongToken }, ['joined']],
    ['singleplayer', { name: 'thief', clientId: 'guard-ur', resumeToken: wrongToken }, ['joined']],
    ['findMatch', { name: 'thief', clientId: 'guard-ur', resumeToken: wrongToken }, ['matchSearching', 'matched']],
    ['abandon', { clientId: 'guard-ur', resumeToken: wrongToken }, []],
  ];
  for (const [event, payload, successEvents] of urAttacks) {
    await expectError(urAttacker, event, payload, 'session_auth_failed', successEvents);
  }
  assert.strictEqual(urVictim.connected, true, 'Ur attacks disconnected the owner');
  assert.strictEqual(urVictimReplaced, 0, 'Ur attacks replaced the owner');

  const urSelf = await connect(`${base}/ur`);
  const urSelfResume = waitEvent(urSelf, 'resumed');
  urSelf.emit('joinRoom', {
    code: urClaim.code,
    name: 'owner',
    clientId: 'guard-ur',
    resumeToken: urClaim.resumeToken,
  });
  const urSelfClaim = await urSelfResume;
  assert.strictEqual(urSelfClaim.code, urClaim.code, 'Ur self-join changed rooms');
  assert.notStrictEqual(urSelfClaim.resumeToken, urClaim.resumeToken, 'Ur self-join did not rotate');
  await waitUntil(() => urVictimReplaced === 1, 'Ur live owner was not replaced once');

  let urTargetResumes = 0;
  urTarget.on('resumed', () => { urTargetResumes++; });
  await expectError(
    urTarget,
    'resume',
    { clientId: 'guard-ur', resumeToken: urSelfClaim.resumeToken },
    'already_in_room'
  );
  assert.strictEqual(urTargetResumes, 0, 'one Ur socket resumed a second identity');

  urSelf.disconnect();
  await delay(150);
  const urOwner = await connect(`${base}/ur`);
  const urOwnerResume = waitEvent(urOwner, 'resumed');
  urOwner.emit('resume', { clientId: 'guard-ur', resumeToken: urSelfClaim.resumeToken });
  const urOwnerClaim = await urOwnerResume;
  assert.strictEqual(urOwnerClaim.code, urClaim.code, 'Ur claim changed after rejected double resume');

  let cardOwnerReplaced = 0;
  cardOwner.on('sessionReplaced', () => { cardOwnerReplaced++; });
  const urSwitch = await connect(`${base}/ur`);
  const switched = waitEvent(urSwitch, 'joined');
  urSwitch.emit('createRoom', {
    name: 'switch',
    clientId: 'guard-card',
    resumeToken: cardOwnerClaim.resumeToken,
  });
  const switchedClaim = await switched;
  assert(switchedClaim.code, 'cross-game switch did not create an Ur room');
  assert.notStrictEqual(switchedClaim.resumeToken, cardOwnerClaim.resumeToken, 'cross-game switch did not rotate');
  await waitUntil(() => cardOwnerReplaced === 1, 'authenticated cross-game switch did not replace old card socket');

  assert(!stderr.includes('Uncaught exception:'), `Server logged an uncaught exception: ${stderr}`);
  console.log('PASS: authenticated membership changes, self-resume, queues, and cross-game switching');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const socket of clients) socket.disconnect();
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        delay(1000),
      ]);
    }
  });
