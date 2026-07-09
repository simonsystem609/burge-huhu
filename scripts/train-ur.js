'use strict';

/**
 * UR bot arena: pits the current bot (game/ur/bot.js) against the previous
 * simple heuristic bot over many self-play games, per ruleset.
 * Run: node scripts/train-ur.js [gamesPerMode]
 */

const engine = require('../game/ur/engine');
const newBot = require('../game/ur/bot');

const { createGame, rollDice, legalMoves, applyMove, SHARED, ROSETTES, MODES, pathFor } = engine;

// ── Frozen copy of the previous bot (priority list heuristic) ──────────────
function isSafeForPlayerOld(state, pos, player) {
  if (!SHARED.has(pos)) return true;
  const opp = state.players[1 - player];
  const oppPath = pathFor(state, 1 - player);
  for (let i = 0; i < opp.pieces.length; i++) {
    const s = opp.pieces[i];
    if (s < 0 || s >= oppPath.length) continue;
    const oppIdx = oppPath.indexOf(pos);
    if (oppIdx >= 0 && oppIdx > s && oppIdx - s <= 4) return false;
  }
  return true;
}

function oldChooseMove(state, player) {
  const roll = state.lastRoll;
  if (roll == null || roll === 0) return null;
  const moves = legalMoves(state, player, roll);
  if (moves.length === 0) return null;

  const bearOff = moves.find((m) => m.action === 'bearOff');
  if (bearOff) return bearOff;

  const path = pathFor(state, player);
  const captures = moves.filter((m) => {
    if (m.action !== 'move') return false;
    const pos = path[m.dest];
    return SHARED.has(pos) && isSafeForPlayerOld(state, pos, player);
  });
  const captureRosette = captures.filter((m) => ROSETTES.has(path[m.dest]));
  if (captureRosette.length > 0) return captureRosette[0];
  if (captures.length > 0) return captures[0];

  const rosette = moves.filter((m) => m.action === 'move' && ROSETTES.has(path[m.dest]));
  if (rosette.length > 0) return rosette[0];

  const enter = moves.find((m) => m.action === 'move' && m.dest === roll - 1);
  if (enter) return enter;

  const normal = moves.filter((m) => m.action === 'move');
  normal.sort((a, b) => a.dest - b.dest);
  return normal[0] || moves[0];
}

// ── Seeded RNG so runs are reproducible ────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Play one game; bots[0] plays seat 0. Returns winner seat (or null). */
function playGame(bots, mode, rng) {
  const state = createGame(
    [
      { id: 'p0', name: 'A', isBot: true },
      { id: 'p1', name: 'B', isBot: true },
    ],
    rng,
    mode
  );
  let guard = 0;
  while (state.phase !== 'over') {
    if (++guard > 20000) return null;
    if (state.phase === 'roll') {
      state.lastRoll = rollDice(rng, state.cfg);
      const moves = legalMoves(state, state.turn, state.lastRoll);
      if (moves.length === 0) {
        state.turn = 1 - state.turn;
        state.lastRoll = null;
        continue;
      }
      state.phase = 'move';
      continue;
    }
    const mover = state.turn;
    const move = bots[mover](state, mover);
    if (!move) {
      state.turn = 1 - state.turn;
      state.phase = 'roll';
      state.lastRoll = null;
      continue;
    }
    applyMove(state, mover, move);
  }
  return state.winner;
}

const gamesPerMode = Number(process.argv[2]) || 2000;

for (const mode of Object.keys(MODES)) {
  let newWins = 0;
  let played = 0;
  for (let g = 0; g < gamesPerMode; g++) {
    const rng = mulberry32(1000 + g);
    // Alternate seats so first-mover advantage cancels out.
    const newSeat = g % 2;
    const bots = newSeat === 0 ? [newBot.chooseMove, oldChooseMove] : [oldChooseMove, newBot.chooseMove];
    const winner = playGame(bots, mode, rng);
    if (winner == null) continue;
    played++;
    if (winner === newSeat) newWins++;
  }
  const pct = ((newWins / played) * 100).toFixed(1);
  console.log(`${mode.padEnd(8)} new bot vs old: ${newWins}/${played} = ${pct}% wins`);
}
