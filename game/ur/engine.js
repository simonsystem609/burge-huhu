'use strict';

/**
 * Royal Game of Ur — pure engine, no networking.
 *
 * Board has 20 positions in the distinctive pinched shape (vertical layout):
 *
 *   Top block (3×2):        Bridge:       Bottom block (3×4):
 *   [15][16][19]            [13]          [ 0][ 4][ 8]
 *   [14][17][18]            [12]          [ 1][ 5][ 9]
 *                                         [ 2][ 6][10]
 *                                         [ 3][ 7][11]
 *
 * Each player has a PATH array: step index → board position.
 * Pieces start at step -1 ("home"), enter the board at step 0,
 * and are borne off after completing all PATH steps (exact roll).
 *
 * Player 0 uses the right column (8-11 / 18-19), player 1 the left
 * (0-3 / 14-15); the middle column (4-7, 12-13, 16-17) is shared.
 *
 * Rosettes (matching the British Museum board / Finkel's reading) fall on
 * path steps 4, 8 and 14: positions 3 & 11 (4th square of each start lane),
 * 4 (centre of the shared lane) and 14 & 18 (last square before the exit).
 *
 * Three rulesets are supported (following royalur.net):
 *  • finkel  — 7 pieces, 4 binary dice (0-4), 14-square path,
 *              rosettes: extra roll + safe from capture.
 *  • masters — 7 pieces, 3 binary dice with 0 counting as 4 (1-4),
 *              16-square path looping through the far block,
 *              rosettes: extra roll but NOT safe.
 *  • blitz   — 5 pieces, 4 binary dice (0-4), Masters path,
 *              rosettes: extra roll, not safe; captures grant an extra roll.
 */

// ── Paths ───────────────────────────────────────────────────────────────────

// Finkel / Bell path (14 steps): own lane down, shared lane up, own exit pair.
const FINKEL_PATH_0 = [8, 9, 10, 11, 7, 6, 5, 4, 12, 13, 17, 16, 19, 18];
const FINKEL_PATH_1 = [0, 1, 2, 3, 7, 6, 5, 4, 12, 13, 17, 16, 15, 14];

// Masters path (16 steps): as Finkel through the shared lane, then across the
// far block through the OPPONENT's corner before coming home — a rosette
// falls on every 4th step.
const MASTERS_PATH_0 = [8, 9, 10, 11, 7, 6, 5, 4, 12, 13, 17, 14, 15, 16, 19, 18];
const MASTERS_PATH_1 = [0, 1, 2, 3, 7, 6, 5, 4, 12, 13, 17, 18, 19, 16, 15, 14];

// Shared (combat) squares — the middle column, where captures are possible.
const SHARED = new Set([4, 5, 6, 7, 12, 13, 16, 17]);

// Rosette squares — extra roll (all modes); safe from capture in Finkel only.
const ROSETTES = new Set([3, 4, 11, 14, 18]);

const MODES = {
  finkel: {
    name: 'finkel',
    pieceCount: 7,
    paths: [FINKEL_PATH_0, FINKEL_PATH_1],
    rosettesSafe: true,
    captureExtraRoll: false,
    diceCount: 4,
    zeroAs4: false,
  },
  masters: {
    name: 'masters',
    pieceCount: 7,
    paths: [MASTERS_PATH_0, MASTERS_PATH_1],
    rosettesSafe: false,
    captureExtraRoll: false,
    diceCount: 3,
    zeroAs4: true,
  },
  blitz: {
    name: 'blitz',
    pieceCount: 5,
    paths: [MASTERS_PATH_0, MASTERS_PATH_1],
    rosettesSafe: false,
    captureExtraRoll: true,
    diceCount: 4,
    zeroAs4: false,
  },
};

// Back-compat exports (Finkel defaults).
const PIECE_COUNT = 7;
const PATH_0 = FINKEL_PATH_0;
const PATH_1 = FINKEL_PATH_1;
const PATHS = [PATH_0, PATH_1];

// ── Dice ────────────────────────────────────────────────────────────────────

function rollDice(rng, cfg) {
  rng = rng || Math.random;
  cfg = cfg || MODES.finkel;
  let total = 0;
  for (let i = 0; i < cfg.diceCount; i++) {
    if (rng() >= 0.5) total++;
  }
  if (total === 0 && cfg.zeroAs4) total = 4;
  return total;
}

/** Roll for a game in progress, honouring its mode. */
function rollFor(state, rng) {
  return rollDice(rng || state.rng, state.cfg);
}

/** Probability distribution of rolls for a mode: array indexed by roll. */
function rollDistribution(cfg) {
  cfg = cfg || MODES.finkel;
  const n = cfg.diceCount;
  const dist = new Array(5).fill(0);
  for (let k = 0; k <= n; k++) {
    // C(n,k) / 2^n
    let c = 1;
    for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
    const p = c / Math.pow(2, n);
    if (k === 0 && cfg.zeroAs4) dist[4] += p;
    else dist[k] += p;
  }
  return dist;
}

// ── Game state ──────────────────────────────────────────────────────────────

function createGame(players, rng, mode) {
  rng = rng || Math.random;
  const cfg = MODES[mode] || MODES.finkel;
  return {
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      pieces: new Array(cfg.pieceCount).fill(-1),
      borneOff: 0,
    })),
    mode: cfg.name,
    cfg,
    turn: 0,
    phase: 'roll',
    lastRoll: null,
    extraRoll: false,
    winner: null,
    log: [],
    rng,
  };
}

function cfgOf(state) {
  return state.cfg || MODES.finkel;
}

function currentActor(state) {
  if (state.phase === 'over') return null;
  return { player: state.turn, phase: state.phase };
}

function pathFor(state, player) {
  return cfgOf(state).paths[player % 2];
}

function positionOf(state, player, step) {
  return pathFor(state, player)[step];
}

function stepAt(state, player, pos) {
  return pathFor(state, player).indexOf(pos);
}

function occupant(state, pos) {
  for (let p = 0; p < state.players.length; p++) {
    const pl = state.players[p];
    const path = pathFor(state, p);
    for (let i = 0; i < pl.pieces.length; i++) {
      const step = pl.pieces[i];
      if (step >= 0 && step < path.length && path[step] === pos) {
        return { player: p, piece: i };
      }
    }
  }
  return null;
}

// ── Legal moves ─────────────────────────────────────────────────────────────

function legalMoves(state, player, roll) {
  if (state.turn !== player || roll === 0) return [];
  const cfg = cfgOf(state);
  const pl = state.players[player];
  const path = pathFor(state, player);
  const moves = [];
  const seen = new Set();

  function addMove(m) {
    const key = m.action === 'bearOff' ? 'B' + m.piece : 'M' + m.piece + '_' + m.dest;
    if (seen.has(key)) return;
    seen.add(key);

    if (m.action === 'move') {
      const destPos = path[m.dest];
      const occ = occupant(state, destPos);
      if (occ && occ.player === player) return; // blocked by own piece
      if (occ && occ.player !== player) {
        // Capture is only possible in the shared zone, and (in modes where
        // rosettes are safe) never on a rosette.
        if (!SHARED.has(destPos)) return;
        if (cfg.rosettesSafe && ROSETTES.has(destPos)) return;
      }
    }
    moves.push(m);
  }

  // Move existing pieces
  for (let i = 0; i < pl.pieces.length; i++) {
    const curStep = pl.pieces[i];
    if (curStep === -1) continue; // at home

    const remaining = path.length - curStep;
    if (roll === remaining) {
      addMove({ piece: i, action: 'bearOff' });
    } else if (roll < remaining) {
      addMove({ piece: i, action: 'move', dest: curStep + roll });
    }
    // roll > remaining: cannot move this piece
  }

  // Enter new pieces from home — a roll of N lands on step N-1
  const entryStep = roll - 1;
  const entryPos = path[entryStep];
  const entryOcc = occupant(state, entryPos);
  if (!entryOcc || entryOcc.player !== player) {
    for (let i = 0; i < pl.pieces.length; i++) {
      if (pl.pieces[i] === -1) {
        addMove({ piece: i, action: 'move', dest: entryStep });
      }
    }
  }

  return moves;
}

// ── Apply move ──────────────────────────────────────────────────────────────

function applyMove(state, player, move) {
  if (state.turn !== player) {
    throw new Error('illegal:not_your_turn');
  }
  const cfg = cfgOf(state);
  const pl = state.players[player];
  const piece = move.piece;
  const path = pathFor(state, player);

  if (move.action === 'bearOff') {
    pl.pieces[piece] = path.length; // marked as borne off
    pl.borneOff = (pl.borneOff || 0) + 1;
    pushLog(state, 'bearOff', { player, piece });
  } else {
    const destStep = move.dest;
    const destPos = path[destStep];

    const occ = occupant(state, destPos);
    if (occ && occ.player === player) throw new Error('illegal:own_piece');
    if (occ && occ.player !== player) {
      const protectedSquare = !SHARED.has(destPos) || (cfg.rosettesSafe && ROSETTES.has(destPos));
      if (protectedSquare) throw new Error('illegal:cant_capture_protected');
      const opp = state.players[occ.player];
      opp.pieces[occ.piece] = -1;
      pushLog(state, 'capture', { player, piece, opponent: occ.player, oppPiece: occ.piece });
      if (cfg.captureExtraRoll) state.extraRoll = true;
    }

    pl.pieces[piece] = destStep;
    pushLog(state, 'move', { player, piece, dest: destStep, pos: destPos });
  }

  // Rosette → extra roll (all modes)
  const newStep = pl.pieces[piece];
  if (newStep >= 0 && newStep < path.length && ROSETTES.has(path[newStep])) {
    state.extraRoll = true;
  }

  checkWin(state);
  if (state.phase === 'over') return state;

  if (state.extraRoll) {
    state.extraRoll = false;
    state.phase = 'roll';
    state.lastRoll = null;
    state.lastRolled = false;
  } else {
    state.turn = 1 - state.turn;
    state.phase = 'roll';
    state.lastRoll = null;
    state.lastRolled = false;
  }

  return state;
}

function checkWin(state) {
  const cfg = cfgOf(state);
  for (let p = 0; p < state.players.length; p++) {
    if (state.players[p].borneOff >= cfg.pieceCount) {
      state.phase = 'over';
      state.winner = p;
      pushLog(state, 'win', { player: p });
      return;
    }
  }
}

function pushLog(state, key, params) {
  state.log.push({ key, params, t: state.log.length + 1 });
  if (state.log.length > 40) state.log.shift();
}

// ── View for client ─────────────────────────────────────────────────────────

function viewFor(state, playerIndex) {
  if (!state || !state.players) return null;
  const cfg = cfgOf(state);
  const you = state.players[playerIndex];
  const actor = currentActor(state);

  // Build board occupancy map: pos → [{ player, piece, step }]
  const boardMap = {};
  for (let p = 0; p < state.players.length; p++) {
    const pl = state.players[p];
    const path = pathFor(state, p);
    for (let i = 0; i < pl.pieces.length; i++) {
      const step = pl.pieces[i];
      if (step >= 0 && step < path.length) {
        const pos = path[step];
        if (!boardMap[pos]) boardMap[pos] = [];
        boardMap[pos].push({ player: p, piece: i, step });
      }
    }
  }

  return {
    you: playerIndex,
    mode: cfg.name,
    pieceCount: cfg.pieceCount,
    rosettes: [...ROSETTES],
    rosettesSafe: cfg.rosettesSafe,
    diceCount: cfg.diceCount,
    zeroAs4: cfg.zeroAs4,
    phase: state.phase,
    turn: state.turn,
    lastRoll: state.lastRoll,
    extraRoll: state.extraRoll,
    actor: actor,

    pieces: you ? you.pieces.map((s) => ({ step: s })) : [],

    opponent: state.players[1 - playerIndex]
      ? {
        name: state.players[1 - playerIndex].name,
        isBot: state.players[1 - playerIndex].isBot,
        homeCount: state.players[1 - playerIndex].pieces.filter((s) => s === -1).length,
        boardCount: state.players[1 - playerIndex].pieces.filter(
          (s) => s >= 0 && s < pathFor(state, 1 - playerIndex).length
        ).length,
        offCount: state.players[1 - playerIndex].borneOff || 0,
      }
      : null,

    board: boardMap,
    piecesRemaining: you ? cfg.pieceCount - (you.borneOff || 0) : 0,
    winner: state.winner,
    log: state.log.slice(-8),
    path: pathFor(state, playerIndex),
  };
}

module.exports = {
  PIECE_COUNT,
  PATHS,
  PATH_0,
  PATH_1,
  SHARED,
  ROSETTES,
  MODES,
  createGame,
  rollDice,
  rollFor,
  rollDistribution,
  legalMoves,
  applyMove,
  currentActor,
  viewFor,
  pathFor,
  positionOf,
  stepAt,
  occupant,
};
