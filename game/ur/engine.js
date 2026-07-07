'use strict';

/**
 * Royal Game of Ur — pure engine, no networking.
 *
 * Board has 20 positions in a distinctive shape.
 * Each player has a PATH array: step index → board position.
 * Pieces start at step -1 ("home"), enter the board at step 0,
 * and are borne off after completing all PATH steps.
 *
 * Board layout (for CSS/rendering reference):
 *   row 0: .  .  .  .  12 13 14 15  .  .
 *   row 1: .  .  .  .  04 05 06 07 16 18
 *   row 2: .  .  .  .  00 01 02 03 17 19
 *   row 3: .  .  .  .  08 09 10 11  .  .
 *
 * Dice: 4 tetrahedral (binary) dice → sum 0-4.
 */

const PATH_0 = [4, 0, 1, 2, 3, 7, 16, 18, 19, 17, 6, 5, 12, 13, 14, 15, 11, 10, 9, 8];
const PATH_1 = [8, 9, 10, 11, 15, 14, 13, 12, 5, 6, 17, 19, 18, 16, 7, 3, 2, 1, 0, 4];

const PATHS = [PATH_0, PATH_1];

// Shared (combat) squares end up being positions that appear in both paths.
// These 8 positions are where capture is possible:
const SHARED = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

// Rosette squares: landing here gives an extra roll AND is safe from capture.
// Approximated from surviving boards: the middle rosette in the big block,
// the two rosettes on the small block side, etc.
const ROSETTES = new Set([4, 8, 12, 14, 17]);

const PIECE_COUNT = 7;

function rollDice(rng) {
  rng = rng || Math.random;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    if (rng() >= 0.5) total++;
  }
  return total;
}

function createGame(players, rng) {
  rng = rng || Math.random;
  return {
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      pieces: new Array(PIECE_COUNT).fill(-1),
      borneOff: 0,
    })),
    turn: 0,
    phase: 'roll',
    lastRoll: null,
    extraRoll: false,
    winner: null,
    log: [],
    rng,
  };
}

function currentActor(state) {
  if (state.phase === 'over') return null;
  return { player: state.turn, phase: state.phase };
}

function pathFor(player) {
  return PATHS[player % 2];
}

function positionOf(player, step) {
  return pathFor(player)[step];
}

// Which step index (if any) on this player's path corresponds to pos?
function stepAt(player, pos) {
  return pathFor(player).indexOf(pos);
}

// What is currently on board position `pos`?
function occupant(state, pos) {
  for (let p = 0; p < state.players.length; p++) {
    const pl = state.players[p];
    for (let i = 0; i < PIECE_COUNT; i++) {
      const step = pl.pieces[i];
      if (step >= 0 && step < PATH_0.length && positionOf(p, step) === pos) {
        return { player: p, piece: i };
      }
    }
  }
  return null;
}

// After applying a roll, what are the legal moves for the current player?
function legalMoves(state, player, roll) {
  if (state.turn !== player || roll === 0) return [];
  const pl = state.players[player];
  const path = pathFor(player);
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
      if (occ && occ.player !== player && !SHARED.has(destPos)) return; // can't capture on protected square
    }
    moves.push(m);
  }

  for (let i = 0; i < PIECE_COUNT; i++) {
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

  // Enter new pieces: step 0 = first position on path
  // Only if the entry square is not occupied by own piece.
  const entryPos = path[0];
  const entryOcc = occupant(state, entryPos);
  if (!entryOcc || entryOcc.player !== player) {
    for (let i = 0; i < PIECE_COUNT; i++) {
      if (pl.pieces[i] === -1) {
        addMove({ piece: i, action: 'move', dest: 0 });
      }
    }
  }

  return moves;
}

function applyMove(state, player, move) {
  if (state.turn !== player) {
    throw new Error('illegal:not_your_turn');
  }
  const pl = state.players[player];
  const piece = move.piece;
  const curStep = pl.pieces[piece];
  const path = pathFor(player);

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
      if (SHARED.has(destPos)) {
        const opp = state.players[occ.player];
        opp.pieces[occ.piece] = -1;
        pushLog(state, 'capture', { player, piece, opponent: occ.player, oppPiece: occ.piece });
      } else {
        throw new Error('illegal:cant_capture_protected');
      }
    }

    pl.pieces[piece] = destStep;
    pushLog(state, 'move', { player, piece, dest: destStep, pos: destPos });
  }

  // Rosette → extra roll
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
  for (let p = 0; p < state.players.length; p++) {
    if (state.players[p].borneOff >= PIECE_COUNT) {
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

function viewFor(state, playerIndex) {
  if (!state || !state.players) return null; // safety
  const you = state.players[playerIndex];
  const actor = currentActor(state);

  // Build board occupancy map: pos → [{ player, piece, step }]
  const boardMap = {};
  for (let p = 0; p < state.players.length; p++) {
    const pl = state.players[p];
    for (let i = 0; i < PIECE_COUNT; i++) {
      const step = pl.pieces[i];
      if (step >= 0 && step < PATH_0.length) {
        const pos = positionOf(p, step);
        if (!boardMap[pos]) boardMap[pos] = [];
        boardMap[pos].push({ player: p, piece: i, step });
      }
    }
  }

  return {
    you: playerIndex,
    phase: state.phase,
    turn: state.turn,
    lastRoll: state.lastRoll,
    extraRoll: state.extraRoll,
    actor: actor,

    // Your pieces: array of { step, active } where step is -1 (home) or
    // PATH.length (off) or the current step index.
    pieces: you ? you.pieces.map((s) => ({ step: s })) : [],

    // Opponent: just counts, not positions
    opponent: state.players[1 - playerIndex]
      ? {
        name: state.players[1 - playerIndex].name,
        isBot: state.players[1 - playerIndex].isBot,
        homeCount: state.players[1 - playerIndex].pieces.filter((s) => s === -1).length,
        boardCount: state.players[1 - playerIndex].pieces.filter((s) => s >= 0 && s < PATH_0.length).length,
        offCount: state.players[1 - playerIndex].borneOff || 0,
      }
      : null,

    // Board occupancy (which player's pieces are on each position)
    board: boardMap,

    piecesRemaining: you ? PIECE_COUNT - (you.borneOff || 0) : 0,
    winner: state.winner,
    log: state.log.slice(-8),

    // Constants for the client
    path: pathFor(playerIndex),
    isShared: (pos) => SHARED.has(pos),
    isRosette: (pos) => ROSETTES.has(pos),
  };
}

module.exports = {
  PIECE_COUNT,
  PATHS,
  PATH_0,
  PATH_1,
  SHARED,
  ROSETTES,
  createGame,
  rollDice,
  legalMoves,
  applyMove,
  currentActor,
  viewFor,
  positionOf,
  stepAt,
  occupant,
};
