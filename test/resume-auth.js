'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const {
  issueSeatToken,
  verifySeatToken,
  rotateSeatToken,
  clearSeatToken,
  ROTATION_GRACE_MS,
} = require('../game/resume-auth');
const { RoomManager } = require('../game/rooms');

// ── Unit: token lifecycle ──────────────────────────────────────────────────

function unitTests() {
  const seat = {};
  const t1 = issueSeatToken(seat);
  assert(typeof t1 === 'string' && t1.length >= 20, 'issued token looks wrong');
  assert(verifySeatToken(seat, t1), 'freshly issued token must verify');
  assert(!verifySeatToken(seat, t1 + 'x'), 'tampered token must fail');
  assert(!verifySeatToken(seat, ''), 'empty token must fail');
  assert(!verifySeatToken(seat, null), 'null token must fail');
  assert(!verifySeatToken(seat, { token: t1 }), 'non-string token must fail');
  assert(!verifySeatToken(null, t1), 'missing seat must fail');
  assert(!verifySeatToken({}, t1), 'seat without a token must fail');

  const now = Date.now();
  const t2 = rotateSeatToken(seat, now);
  assert(t2 !== t1, 'rotation must mint a new token');
  assert(verifySeatToken(seat, t2, now), 'fresh token must verify after rotation');
  assert(verifySeatToken(seat, t1, now + ROTATION_GRACE_MS - 1000), 'old token must stay valid within grace');
  assert(!verifySeatToken(seat, t1, now + ROTATION_GRACE_MS + 1000), 'old token must expire after grace');

  const t3 = rotateSeatToken(seat, now);
  assert(verifySeatToken(seat, t2, now), 'previous token valid right after second rotation');
  assert(!verifySeatToken(seat, t1, now), 'grandparent token must be dead after two rotations');

  clearSeatToken(seat);
  assert(!verifySeatToken(seat, t3, now), 'cleared seat must reject its own last token');

  // Issuing resets any grace carry-over from a prior claim.
  const s2 = {};
  const a = issueSeatToken(s2);
  rotateSeatToken(s2, now);
  const c = issueSeatToken(s2);
  assert(!verifySeatToken(s2, a, now), 're-issue must wipe the grace window');
  assert(verifySeatToken(s2, c, now), 're-issued token must verify');

  // Room integration: leaveRoom mid-game and forgetClient wipe the claim.
  const rmgr = new RoomManager();
  const room = rmgr.createRoom('sock1', 'client1', 'P1');
  const seatTok = issueSeatToken(room.seats[0]);
  rmgr.addBot(room);
  rmgr.startGame(room);
  rmgr.leaveRoom('sock1');
  assert(!verifySeatToken(room.seats[0], seatTok), 'explicit leave must clear the resume token');

  const rmgr2 = new RoomManager();
  const room2 = rmgr2.createRoom('sock2', 'client2', 'P2');
  const seatTok2 = issueSeatToken(room2.seats[0]);
  rmgr2.addBot(room2);
  rmgr2.startGame(room2);
  rmgr2.handleDisconnect('sock2');
  assert(verifySeatToken(room2.seats[0], seatTok2), 'disconnect must keep the claim (resume expected)');
  rmgr2.forgetClient('client2');
  assert(!verifySeatToken(room2.seats[0], seatTok2), 'forgetClient must clear the resume token');

  console.log('PASS: resume-auth unit tests');
}

// ── End-to-end: the running server enforces tokens on resume ───────────────

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

async function e2eTests() {
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

  // Card game: singleplayer join hands out a resume token.
  const player = await connect(base);
  const joined = waitEvent(player, 'joined');
  player.emit('singleplayer', { name: 'P', lang: 'en', bots: 1, clientId: 'resume-e2e-card' });
  const { code, resumeToken } = await joined;
  assert(code, 'joined must carry the room code');
  assert(typeof resumeToken === 'string' && resumeToken.length >= 20, 'joined must carry a resume token');

  // Drop the connection (seat held), then try to resume with a WRONG token.
  player.disconnect();
  await delay(200);

  const thief = await connect(base);
  let thiefResumed = 0;
  thief.on('resumed', () => { thiefResumed++; });
  thief.emit('resume', { clientId: 'resume-e2e-card', resumeToken: 'A'.repeat(43) });
  thief.emit('resume', { clientId: 'resume-e2e-card' }); // and with none at all
  await delay(400);
  assert.strictEqual(thiefResumed, 0, 'a wrong/missing token must not resume the seat');

  // The rightful owner resumes with the real token and gets a rotated one.
  const owner = await connect(base);
  const resumed = waitEvent(owner, 'resumed');
  owner.emit('resume', { clientId: 'resume-e2e-card', resumeToken });
  const resumedPayload = await resumed;
  assert.strictEqual(resumedPayload.code, code, 'resume must land in the original room');
  assert(typeof resumedPayload.resumeToken === 'string', 'resume must rotate and return a fresh token');
  assert(resumedPayload.resumeToken !== resumeToken, 'rotated token must differ');

  // Grace: the pre-rotation token still works right after rotation (second
  // drop mid-handoff), and the freshly rotated token works too.
  owner.disconnect();
  await delay(200);
  const owner2 = await connect(base);
  const resumed2 = waitEvent(owner2, 'resumed');
  owner2.emit('resume', { clientId: 'resume-e2e-card', resumeToken }); // OLD token, within grace
  const resumedPayload2 = await resumed2;
  assert.strictEqual(resumedPayload2.code, code, 'grace-window resume with the old token must work');

  // Ur: create a lobby, verify the token gates Ur resume as well.
  const urHost = await connect(`${base}/ur`);
  const urJoined = waitEvent(urHost, 'joined');
  urHost.emit('createRoom', { name: 'U', mode: 'finkel', clientId: 'resume-e2e-ur' });
  const urPayload = await urJoined;
  assert(typeof urPayload.resumeToken === 'string', 'Ur joined must carry a resume token');
  urHost.disconnect();
  await delay(200);

  const urThief = await connect(`${base}/ur`);
  let urThiefResumed = 0;
  urThief.on('resumed', () => { urThiefResumed++; });
  urThief.emit('resume', { clientId: 'resume-e2e-ur', resumeToken: 'B'.repeat(43) });
  await delay(400);
  assert.strictEqual(urThiefResumed, 0, 'Ur seat must reject a wrong token');

  const urOwner = await connect(`${base}/ur`);
  const urResumed = waitEvent(urOwner, 'resumed');
  urOwner.emit('resume', { clientId: 'resume-e2e-ur', resumeToken: urPayload.resumeToken });
  const urResumedPayload = await urResumed;
  assert.strictEqual(urResumedPayload.code, urPayload.code, 'Ur resume with the right token must work');
  assert(typeof urResumedPayload.resumeToken === 'string', 'Ur resume must rotate the token');

  assert(!stderr.includes('Uncaught exception:'), `Server logged an uncaught exception: ${stderr}`);
  console.log('PASS: resume-auth end-to-end tests');
}

(async () => {
  unitTests();
  await e2eTests();
})()
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
