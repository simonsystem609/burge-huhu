'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
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

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function main() {
  const port = await freePort();
  let stdout = '';
  let stderr = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
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
  const urHost = await connect(`${base}/ur`);
  const urJoined = waitEvent(urHost, 'joined');
  const urLobby = waitEvent(urHost, 'lobby');
  urHost.emit('createRoom', {
    name: 'Ur Host',
    mode: 'finkel',
    clientId: 'abuse-ur-host',
  });
  const { code: urCode } = await urJoined;
  await urLobby;

  // These events used to dereference room.game while it was still null and
  // reach the process-wide exception logger.
  const stderrBeforeLobbyEvents = stderr;
  urHost.emit('roll');
  urHost.emit('move', { piece: 0, destPos: 0 });
  await delay(150);
  assert.strictEqual(stderr, stderrBeforeLobbyEvents, 'Ur lobby events reached an exception');

  const urGuest = await connect(`${base}/ur`);
  const guestJoined = waitEvent(urGuest, 'joined');
  const guestLobby = waitEvent(urGuest, 'lobby');
  urGuest.emit('joinRoom', {
    code: urCode,
    name: 'Ur Guest',
    clientId: 'abuse-ur-guest',
  });
  await guestJoined;
  await guestLobby;

  let urGameEvents = 0;
  let urResumedEvents = 0;
  const urErrors = [];
  urHost.on('game', () => { urGameEvents++; });
  urHost.on('resumed', () => { urResumedEvents++; });
  urHost.on('errorMsg', (error) => { urErrors.push(error); });
  const firstUrGame = waitEvent(urHost, 'game');
  urHost.emit('startGame');
  await firstUrGame;
  await delay(100);
  const gameEventsAfterStart = urGameEvents;

  urHost.emit('startGame');
  await waitUntil(
    () => urErrors.includes('Game already started'),
    'Repeated Ur startGame was not refused'
  );
  await delay(100);
  assert.strictEqual(urGameEvents, gameEventsAfterStart, 'Repeated startGame reset the active Ur game');

  for (let i = 0; i < 14; i++) {
    urHost.emit('resume', { clientId: 'abuse-ur-host' });
  }
  await waitUntil(
    () => urErrors.includes('rate_limited'),
    'Ur resume flood did not hit the room-action limiter'
  );
  await delay(100);
  assert.strictEqual(urResumedEvents, 0, 'Same-socket Ur resume was not idempotent');
  assert.strictEqual(urGameEvents, gameEventsAfterStart, 'Ur resume flood rebroadcast game state');

  const cardHost = await connect(base);
  const cardJoined = waitEvent(cardHost, 'joined');
  const firstCardLobby = waitEvent(cardHost, 'lobby');
  cardHost.emit('createRoom', {
    name: 'Card Host',
    lang: 'en',
    clientId: 'abuse-card-host',
  });
  await cardJoined;
  await firstCardLobby;

  let cardLobbyEvents = 0;
  let cardResumedEvents = 0;
  const cardErrors = [];
  cardHost.on('lobby', () => { cardLobbyEvents++; });
  cardHost.on('resumed', () => { cardResumedEvents++; });
  cardHost.on('errorMsg', (error) => { cardErrors.push(error); });
  for (let i = 0; i < 14; i++) {
    cardHost.emit('resume', { clientId: 'abuse-card-host' });
  }
  await waitUntil(
    () => cardErrors.includes('rate_limited'),
    'Card resume flood did not hit the room-action limiter'
  );
  await delay(100);
  assert.strictEqual(cardResumedEvents, 0, 'Same-socket card resume was not idempotent');
  assert.strictEqual(cardLobbyEvents, 0, 'Card resume flood rebroadcast lobby state');
  assert(!stderr.includes('Uncaught exception:'), `Server logged an uncaught exception: ${stderr}`);

  console.log('PASS: Ur lobby guards, start guard, and resume abuse controls');
}

main()
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
