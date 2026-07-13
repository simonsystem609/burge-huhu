'use strict';

const { createGame, rollDice, legalMoves, applyMove, currentActor } = require('../game/ur/engine');
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
    // Let engine errors propagate: a thrown applyMove is a real bug, not a
    // recoverable game state, so it must surface as a failed game below —
    // not get silently absorbed into a turn pass.
    applyMove(state, actor.player, move);
  }

  if (state.winner == null) throw new Error('game ended without a winner (stalemate/pass-limit)');
  return true;
}

let ok = 0;
for (let i = 0; i < 100; i++) {
  try {
    if (playOneGame()) ok++;
  } catch (e) {
    console.log(`Game ${i} error: ${e.message}`);
  }
}

console.log(`${ok}/100 UR games completed with no integrity errors.`);
if (ok < 100) {
  console.error(`FAIL: only ${ok}/100 UR games completed cleanly.`);
  process.exit(1);
}
console.log('PASS');
