'use strict';

/**
 * Card-bot arena + trainer.
 *
 *   node scripts/train-bot.js                 evaluate current weights vs the
 *                                             old heuristic bot
 *   node scripts/train-bot.js train [iters]   hill-climb the weight vector by
 *                                             self-play (common random seeds),
 *                                             printing accepted improvements
 *
 * Fitness: 2-player win rate vs the old bot (loser = bürge), plus bürge
 * avoidance in 4-player games (1 new bot + 3 old bots; random chance 25%).
 */

const { createGame, currentActor, applyMove } = require('../game/engine');
const { legalMoves, findFullDefense } = require('../game/engine');
const { cardSuit, strength } = require('../game/deck');
const newBot = require('../game/bot');

// ── Frozen copy of the previous heuristic bot ──────────────────────────────
function oldCardScore(card, trumpSuit) {
  return strength(card) + (cardSuit(card) === trumpSuit ? 100 : 0);
}
function oldSetScore(cards, trumpSuit) {
  const total = cards.reduce((sum, c) => sum + oldCardScore(c, trumpSuit), 0);
  return total - cards.length * 8;
}
function oldChooseMove(state, playerIndex) {
  const moves = legalMoves(state, playerIndex);
  if (moves.length === 0) return null;
  const trumpSuit = state.trumpSuit;
  const swapMove = moves.find((m) => m.type === 'swap7');
  if (swapMove) return swapMove;

  const attackMoves = moves.filter((m) => m.type === 'attack');
  if (attackMoves.length > 0) {
    const nonTrumpSets = attackMoves.filter((m) => m.cards.every((c) => cardSuit(c) !== trumpSuit));
    const pool = nonTrumpSets.length > 0 ? nonTrumpSets : attackMoves;
    pool.sort((a, b) => oldSetScore(a.cards, trumpSuit) - oldSetScore(b.cards, trumpSuit));
    return pool[0];
  }

  const canTake = moves.some((m) => m.type === 'take');
  const undefendedSlots = state.table.slots
    .map((s, i) => ({ attack: s.attack, i }))
    .filter((_, idx) => state.table.slots[idx].defense == null);
  const hand = state.players[playerIndex].hand;
  const fullDefense = findFullDefense(
    undefendedSlots.map((s) => s.attack),
    hand,
    trumpSuit
  );
  if (!fullDefense) {
    if (canTake) return { type: 'take' };
    const defendMoves = moves.filter((m) => m.type === 'defend');
    return defendMoves[0] || { type: 'take' };
  }
  const slot0 = undefendedSlots[0];
  const card0 = fullDefense[0];
  const beatingWithTrump = cardSuit(card0) === trumpSuit;
  const trumpCostHigh = beatingWithTrump && strength(card0) >= 4;
  const attackIsCheapNonTrump = cardSuit(slot0.attack) !== trumpSuit && strength(slot0.attack) <= 2;
  if (canTake && trumpCostHigh && attackIsCheapNonTrump && undefendedSlots.length === 1 && hand.length <= 5) {
    return { type: 'take' };
  }
  return { type: 'defend', slot: slot0.i, card: card0 };
}

// ── Seeded RNG ─────────────────────────────────────────────────────────────
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

/** Play one game; choosers[seat] picks that seat's moves. Returns loser. */
function playGame(choosers, rng) {
  const players = choosers.map((_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: true }));
  const state = createGame(players, rng);
  let guard = 0;
  while (state.phase !== 'over') {
    if (++guard > 8000) throw new Error('non-terminating game');
    const actor = currentActor(state);
    const move = choosers[actor.player](state, actor.player);
    applyMove(state, actor.player, move);
  }
  return state.loser; // seat index or null (draw)
}

function evaluate(weights, games2p, games4p, seedBase) {
  const mine = (s, i) => newBot.chooseMove(s, i, weights);

  let wins = 0;
  let n2 = 0;
  for (let g = 0; g < games2p; g++) {
    const rng = mulberry32(seedBase + g);
    const mySeat = g % 2;
    const choosers = mySeat === 0 ? [mine, oldChooseMove] : [oldChooseMove, mine];
    const loser = playGame(choosers, rng);
    n2++;
    if (loser == null) wins += 0.5;
    else if (loser !== mySeat) wins++;
  }
  const winRate2p = wins / n2;

  let burge = 0;
  let n4 = 0;
  for (let g = 0; g < games4p; g++) {
    const rng = mulberry32(seedBase + 100000 + g);
    const mySeat = g % 4;
    const choosers = [oldChooseMove, oldChooseMove, oldChooseMove, oldChooseMove];
    choosers[mySeat] = mine;
    const loser = playGame(choosers, rng);
    n4++;
    if (loser === mySeat) burge++;
  }
  const burgeRate4p = n4 ? burge / n4 : 0.25;

  // Higher is better: 2p win rate plus 4p bürge avoidance vs the 25% baseline.
  const fitness = winRate2p + 2 * (0.25 - burgeRate4p);
  return { winRate2p, burgeRate4p, fitness };
}

const KEYS = Object.keys(newBot.DEFAULT_WEIGHTS);

function trainLoop(iters) {
  let best = { ...newBot.DEFAULT_WEIGHTS };
  let bestFit = evaluate(best, 1200, 400, 42);
  console.log(
    `start    fitness=${bestFit.fitness.toFixed(4)} ` +
      `2p=${(bestFit.winRate2p * 100).toFixed(1)}% burge4p=${(bestFit.burgeRate4p * 100).toFixed(1)}%`
  );
  const rand = mulberry32(1234567);
  const factors = [0.5, 0.7, 1.4, 2.0];
  for (let it = 0; it < iters; it++) {
    const key = KEYS[Math.floor(rand() * KEYS.length)];
    const factor = factors[Math.floor(rand() * factors.length)];
    const cand = { ...best, [key]: best[key] * factor };
    const fit = evaluate(cand, 1200, 400, 42);
    const accept = fit.fitness > bestFit.fitness + 0.002;
    if (accept) {
      best = cand;
      bestFit = fit;
      console.log(
        `it ${String(it).padStart(3)} ACCEPT ${key} ×${factor} → ${best[key].toFixed(2)} ` +
          `fitness=${fit.fitness.toFixed(4)} 2p=${(fit.winRate2p * 100).toFixed(1)}% ` +
          `burge4p=${(fit.burgeRate4p * 100).toFixed(1)}%`
      );
    }
  }
  // Fresh-seed validation so the result isn't overfit to the training seeds.
  const val = evaluate(best, 3000, 1000, 987654);
  console.log(
    `\nvalidation (fresh seeds): 2p=${(val.winRate2p * 100).toFixed(1)}% ` +
      `burge4p=${(val.burgeRate4p * 100).toFixed(1)}%`
  );
  console.log('\nbest weights:\n' + JSON.stringify(best, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'train') {
  trainLoop(Number(process.argv[3]) || 60);
} else {
  const r = evaluate(newBot.DEFAULT_WEIGHTS, 3000, 1000, 987654);
  console.log(
    `current weights vs old bot: 2p win rate=${(r.winRate2p * 100).toFixed(1)}% ` +
      `(baseline 50%), 4p bürge rate=${(r.burgeRate4p * 100).toFixed(1)}% (baseline 25%)`
  );
}
