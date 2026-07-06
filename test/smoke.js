'use strict';

/**
 * Engine self-test: play many full games with all-bot players and assert the
 * game always terminates in a valid state. No server / sockets involved.
 * Run: node test/smoke.js
 */

const { createGame, currentActor, applyMove, legalMoves } = require('../game/engine');
const { chooseMove } = require('../game/bot');

function cardMultiset(state) {
  const all = [];
  for (const p of state.players) all.push(...p.hand);
  all.push(...state.talon, ...state.discard);
  if (state.table.attack) all.push(state.table.attack);
  if (state.table.defense) all.push(state.table.defense);
  return all;
}

function playOneGame(seatCount) {
  const players = [];
  for (let i = 0; i < seatCount; i++) {
    players.push({ id: `p${i}`, name: `P${i}`, isBot: true });
  }
  const state = createGame(players);

  // Invariant: 32 unique cards always accounted for.
  const start = cardMultiset(state);
  if (start.length !== 32 || new Set(start).size !== 32) {
    throw new Error(`Deck integrity broken at start: ${start.length} cards`);
  }

  let guard = 0;
  while (state.phase !== 'over') {
    if (++guard > 5000) throw new Error('Game did not terminate (possible loop)');
    const actor = currentActor(state);
    if (!actor) throw new Error('No actor but game not over');
    const move = chooseMove(state, actor.player);
    if (!move) throw new Error(`Bot returned no move for seat ${actor.player}`);

    // The chosen move must be in the legal set.
    const legal = legalMoves(state, actor.player);
    const ok = legal.some((m) => m.type === move.type && m.card === move.card);
    if (!ok) throw new Error(`Illegal move chosen: ${JSON.stringify(move)}`);

    applyMove(state, actor.player, move);

    const now = cardMultiset(state);
    if (now.length !== 32 || new Set(now).size !== 32) {
      throw new Error(`Deck integrity broken mid-game: ${now.length} cards`);
    }
  }

  // Exactly one loser (or a draw = null) and all others finished.
  const holding = state.players.filter((p) => !p.finished);
  if (holding.length > 1) throw new Error('Game over but >1 player still holding');
  if (state.loser != null && state.players[state.loser].hand.length === 0) {
    throw new Error('Loser has an empty hand');
  }
  return { turns: state.turnCount, loser: state.loser };
}

let ok = 0;
const results = { 2: 0, 3: 0, 4: 0 };
for (const seats of [2, 3, 4]) {
  for (let i = 0; i < 300; i++) {
    const r = playOneGame(seats);
    results[seats] += r.turns;
    ok++;
  }
}

console.log(`✓ ${ok} games completed with no rule/integrity errors.`);
console.log(
  `  avg turns — 2p: ${(results[2] / 300).toFixed(1)}, ` +
    `3p: ${(results[3] / 300).toFixed(1)}, 4p: ${(results[4] / 300).toFixed(1)}`
);
