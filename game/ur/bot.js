'use strict';

/**
 * Simple heuristic AI for the Royal Game of Ur.
 *
 * Priorities (in order):
 *   1. Bear off if possible
 *   2. Capture opponent if safe (shared zone, won't get captured next)
 *   3. Land on rosette
 *   4. Enter new piece if hand has pieces and entry is safe
 *   5. Move furthest-behind piece forward
 */

const { legalMoves, positionOf, SHARED, ROSETTES, PIECE_COUNT, PATHS } = require('./engine');

function isSafeForPlayer(state, pos, player) {
  if (!SHARED.has(pos)) return true; // own lane, always safe
  // In shared zone, check if opponent could capture on their next turn.
  // Simple heuristic: if opponent has pieces nearby, it might be dangerous.
  const opp = state.players[1 - player];
  const oppPath = PATHS[1 - player];
  for (let i = 0; i < PIECE_COUNT; i++) {
    const s = opp.pieces[i];
    if (s < 0 || s >= oppPath.length) continue;
    const oppPos = oppPath[s];
    if (oppPos === pos) continue;
    // Could the opponent reach this position with a single roll?
    // This is approximate — we don't know the roll, just check proximity.
    const oppIdx = oppPath.indexOf(pos);
    if (oppIdx >= 0 && oppIdx > s && oppIdx - s <= 4) return false;
  }
  return true;
}

function chooseMove(state, player) {
  const roll = state.lastRoll;
  if (roll == null || roll === 0) return null;
  const moves = legalMoves(state, player, roll);
  if (moves.length === 0) return null;

  // 1. Bear off
  const bearOff = moves.find((m) => m.action === 'bearOff');
  if (bearOff) return bearOff;

  const path = PATHS[player % 2];

  // 2. Capture
  const captures = moves.filter((m) => {
    if (m.action !== 'move') return false;
    const pos = path[m.dest];
    return SHARED.has(pos) && isSafeForPlayer(state, pos, player);
  });
  // Prefer captures that also land on rosettes
  const captureRosette = captures.filter((m) => ROSETTES.has(path[m.dest]));
  if (captureRosette.length > 0) return captureRosette[0];
  if (captures.length > 0) return captures[0];

  // 3. Land on rosette
  const rosette = moves.filter(
    (m) => m.action === 'move' && ROSETTES.has(path[m.dest])
  );
  if (rosette.length > 0) return rosette[0];

  // 4. Enter new piece (entry always lands on step roll-1)
  const enter = moves.find((m) => m.action === 'move' && m.dest === roll - 1);
  if (enter) return enter;

  // 5. Move furthest-behind piece forward
  const normal = moves.filter((m) => m.action === 'move');
  normal.sort((a, b) => a.dest - b.dest); // move the piece that's furthest back
  return normal[0] || moves[0];
}

module.exports = { chooseMove };
