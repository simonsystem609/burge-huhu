'use strict';

/**
 * Royal Game of Ur — pure engine, no networking.
 *
 * Board has 20 positions in a distinctive pinched shape:
 *
 *   Left block (3×4):       Bridge:       Right block (3×2):
 *   [ 0][ 1][ 2][ 3]         .  .         [14][15]
 *   [ 4][ 5][ 6][ 7]       [12][13]       [16][17]
 *   [ 8][ 9][10][11]         .  .         [18][19]
 *
 * Each player has a PATH array: step index → board position.
 * Pieces start at step -1 ("home"), enter the board at step 0,
 * and are borne off after completing all PATH steps.
 *
 * Player 0 enters from bottom-left, exits via bottom-right.
 * Player 1 enters from top-left, exits via top-right.
 *
 * Shared (combat) zone: positions 4-7, 12-13, 16-17 (8 squares).
 * Rosettes: positions 0, 4, 8, 14, 18 — extra roll + safe from capture.
 *
 * Dice: 4 tetrahedral (binary) dice → sum 0-4.
 */

// ── Paths (Finkel interpretation) ───────────────────────────────────────────

// Player 0: enter bottom-left → right along bottom → up to middle →
//           left along middle → through bridge → right block → bear off
const PATH_0 = [8, 9, 10, 11, 7, 6, 5, 4, 12, 13, 17, 16, 19, 18];

// Player 1: enter top-left → right along top → down to middle →
//           left along middle → through bridge → right block → bear off
const PATH_1 = [0, 1, 2, 3, 7, 6, 5, 4, 12, 13, 17, 16, 15, 14];

const PATHS = [PATH_0, PATH_1];

// Shared (combat) squares — 8 squares where captures are possible:
// middle row of left block (4) + bridge (2) + middle row of right block (2)
const SHARED = new Set([4, 5, 6, 7, 12, 13, 16, 17]);

// Rosette squares — landing here gives an extra roll AND is safe from capture.
// Two on left block edges (entry squares), one in middle-left, two on right side.
const ROSETTES = new Set([0, 8, 15, 19]);

const PIECE_COUNT = 7;

// ── Dice ────────────────────────────────────────────────────────────────────

function rollDice(rng) {
  rng = rng || Math.random;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    if (rng() >= 0.5) total++;
  }
  return total;
}

// ── Game state ──────────────────────────────────────────────────────────────

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

function stepAt(player, pos) {
  return pathFor(player).indexOf(pos);
}

function occupant(state, pos) {
  for (let p = 0; p < state.players.length; p++) {
    const pl = state.players[p];
    for (let i = 0; i < PIECE_COUNT; i++) {
      const step = pl.pieces[i];
      if (step >= 0 && step < pathFor(p).length && positionOf(p, step) === pos) {
        return { player: p, piece: i };
      }
    }
  }
  return null;
}

// ── Legal moves ─────────────────────────────────────────────────────────────

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
      if (occ && occ.player !== player && (!SHARED.has(destPos) || ROSETTES.has(destPos))) return; // can't capture on safe or rosette square
    }
    moves.push(m);
  }

  // Move existing pieces
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

  // Enter new pieces from home — a roll of N lands on step N-1
  const entryStep = roll - 1;
  const entryPos = path[entryStep];
  const entryOcc = occupant(state, entryPos);
  if (!entryOcc || entryOcc.player !== player) {
    for (let i = 0; i < PIECE_COUNT; i++) {
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
  const pl = state.players[player];
  const piece = move.piece;
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

// ── View for client ─────────────────────────────────────────────────────────

function viewFor(state, playerIndex) {
  if (!state || !state.players) return null;
  const you = state.players[playerIndex];
  const actor = currentActor(state);

  // Build board occupancy map: pos → [{ player, piece, step }]
  const boardMap = {};
  for (let p = 0; p < state.players.length; p++) {
    const pl = state.players[p];
    const path = pathFor(p);
    for (let i = 0; i < PIECE_COUNT; i++) {
      const step = pl.pieces[i];
      if (step >= 0 && step < path.length) {
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

    pieces: you ? you.pieces.map((s) => ({ step: s })) : [],

    opponent: state.players[1 - playerIndex]
      ? {
        name: state.players[1 - playerIndex].name,
        isBot: state.players[1 - playerIndex].isBot,
        homeCount: state.players[1 - playerIndex].pieces.filter((s) => s === -1).length,
        boardCount: state.players[1 - playerIndex].pieces.filter((s) => s >= 0 && s < pathFor(1 - playerIndex).length).length,
        offCount: state.players[1 - playerIndex].borneOff || 0,
      }
      : null,

    board: boardMap,
    piecesRemaining: you ? PIECE_COUNT - (you.borneOff || 0) : 0,
    winner: state.winner,
    log: state.log.slice(-8),
    path: pathFor(playerIndex),
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
