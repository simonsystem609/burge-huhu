'use strict';

/**
 * Evaluation AI for the Royal Game of Ur (all rulesets).
 *
 * For every legal move the bot simulates the resulting position and scores
 * it: piece progress, borne-off pieces, extra rolls earned (rosette, or
 * capture in Blitz), and — the important part — capture *risk*: for each of
 * our pieces sitting in the shared lane it computes the exact probability
 * that the opponent's next roll can take it, using the dice distribution of
 * the active mode. Rosette safety is honoured only in modes where rosettes
 * are safe.
 */

const {
  legalMoves,
  pathFor,
  SHARED,
  ROSETTES,
  rollDistribution,
} = require('./engine');

const W = {
  onBoard: 2.0, // being in play at all
  progress: 1.0, // per step advanced
  borneOff: 22, // a finished piece
  extraRoll: 5.5, // expected value of rolling again
  threat: 0.85, // fraction of a piece's value lost per unit capture risk
  rosetteHold: 1.5, // sitting on a safe rosette (Finkel)
  capture: 3.0, // bonus on top of the opponent's lost progress
};

/** Cheap structural clone — only what evaluation needs. */
function cloneSim(state) {
  return {
    players: state.players.map((p) => ({
      pieces: p.pieces.slice(),
      borneOff: p.borneOff || 0,
    })),
    cfg: state.cfg,
    turn: state.turn,
    phase: state.phase,
  };
}

function occupantSim(sim, pos) {
  for (let p = 0; p < sim.players.length; p++) {
    const path = pathFor(sim, p);
    const pieces = sim.players[p].pieces;
    for (let i = 0; i < pieces.length; i++) {
      const s = pieces[i];
      if (s >= 0 && s < path.length && path[s] === pos) return { player: p, piece: i };
    }
  }
  return null;
}

/** Apply a move to a sim state. Returns true if it earned an extra roll. */
function applySim(sim, player, move) {
  const cfg = sim.cfg;
  const pl = sim.players[player];
  const path = pathFor(sim, player);
  let extra = false;

  if (move.action === 'bearOff') {
    pl.pieces[move.piece] = path.length;
    pl.borneOff += 1;
    return false;
  }
  const destPos = path[move.dest];
  const occ = occupantSim(sim, destPos);
  if (occ && occ.player !== player) {
    sim.players[occ.player].pieces[occ.piece] = -1;
    if (cfg.captureExtraRoll) extra = true;
  }
  pl.pieces[move.piece] = move.dest;
  if (ROSETTES.has(destPos)) extra = true;
  return extra;
}

/**
 * Probability that `player`'s piece at `step` gets captured by the opponent
 * on their next roll. Exact over the mode's dice distribution; considers
 * opponent pieces on the board and entries from home.
 */
function captureRisk(sim, player, step) {
  const cfg = sim.cfg;
  const myPath = pathFor(sim, player);
  const pos = myPath[step];
  if (!SHARED.has(pos)) return 0;
  if (cfg.rosettesSafe && ROSETTES.has(pos)) return 0;

  const opp = 1 - player;
  const oppPath = pathFor(sim, opp);
  const target = oppPath.indexOf(pos);
  if (target === -1) return 0;

  const dist = rollDistribution(cfg);
  const oppPieces = sim.players[opp].pieces;
  let risk = 0;
  for (let r = 1; r <= 4; r++) {
    if (!dist[r]) continue;
    let canHit = false;
    for (let i = 0; i < oppPieces.length; i++) {
      const s = oppPieces[i];
      if (s === -1) {
        if (r - 1 === target) { canHit = true; break; } // entering lands on step r-1
      } else if (s >= 0 && s < oppPath.length && s + r === target) {
        canHit = true;
        break;
      }
    }
    if (canHit) risk += dist[r];
  }
  return risk;
}

function pieceValue(step, pathLen) {
  return W.onBoard + step * W.progress * (14 / pathLen);
}

function evalSide(sim, player) {
  const path = pathFor(sim, player);
  const pl = sim.players[player];
  let score = pl.borneOff * W.borneOff;
  for (let i = 0; i < pl.pieces.length; i++) {
    const s = pl.pieces[i];
    if (s < 0 || s >= path.length) continue;
    const v = pieceValue(s, path.length);
    score += v;
    const pos = path[s];
    if (sim.cfg.rosettesSafe && ROSETTES.has(pos) && SHARED.has(pos)) score += W.rosetteHold;
    score -= captureRisk(sim, player, s) * v * W.threat;
  }
  return score;
}

function chooseMove(state, player) {
  const roll = state.lastRoll;
  if (roll == null || roll === 0) return null;
  const moves = legalMoves(state, player, roll);
  if (moves.length === 0) return null;

  const opp = 1 - player;
  let best = moves[0];
  let bestScore = -Infinity;

  for (const m of moves) {
    const sim = cloneSim(state);
    const before = sim.players[opp].pieces.filter((s) => s >= 0).length;
    const extra = applySim(sim, player, m);
    const after = sim.players[opp].pieces.filter((s) => s >= 0).length;

    let score = evalSide(sim, player) - evalSide(sim, opp);
    if (extra) score += W.extraRoll;
    if (after < before) score += W.capture;

    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

module.exports = { chooseMove };
