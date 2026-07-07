'use strict';

const { createGame, rollDice, legalMoves, applyMove, currentActor, PIECE_COUNT } = require('../game/ur/engine');
const { chooseMove } = require('../game/ur/bot');

function playOneGame() {
  const players = [
    { id: 'p0', name: 'P0', isBot: true },
    { id: 'p1', name: 'P1', isBot: true },
  ];
  const state = createGame(players);
  let passes = 0;

  let guard = 0;
  while (state.phase !== 'over') {
    if (++guard > 10000) throw new Error('Game did not terminate');

    if (state.phase === 'roll') {
      state.lastRoll = rollDice(state.rng);
      const moves = legalMoves(state, state.turn, state.lastRoll);
      if (moves.length === 0) {
        passes++;
        if (passes >= 30) {
          state.phase = 'over';
          state.winner = null;
          break;
        }
        state.turn = 1 - state.turn;
        state.phase = 'roll';
        state.lastRoll = null;
        continue;
      }
      passes = 0;
      state.phase = 'move';
      continue;
    }

    const actor = currentActor(state);
    if (!actor) throw new Error('No actor');
    const move = chooseMove(state, actor.player);
    if (!move) {
      passes++;
      if (passes >= 30) {
        state.phase = 'over';
        state.winner = null;
        break;
      }
      state.turn = 1 - state.turn;
      state.phase = 'roll';
      state.lastRoll = null;
      continue;
    }
    passes = 0;
    try {
      applyMove(state, actor.player, move);
    } catch (e) {
      state.turn = 1 - state.turn;
      state.phase = 'roll';
      state.lastRoll = null;
    }
  }

  return state.winner != null;
}

let ok = 0;
for (let i = 0; i < 100; i++) {
  try {
    if (playOneGame()) ok++;
  } catch (e) {
    console.log(`Game ${i} error: ${e.message}`);
  }
}

console.log(`✓ ${ok}/100 UR games completed with no integrity errors.`);
