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

/**
 * Head-to-head score of weight set A vs weight set B over 2-player games
 * with alternating seats. Draws are bad for BOTH sides (0.25 credit) — a
 * bürge player should fight to win, not to stall.
 */
function head2head(wA, wB, games, seedBase) {
  const botA = (s, i) => newBot.chooseMove(s, i, wA);
  const botB = (s, i) => newBot.chooseMove(s, i, wB);
  let score = 0;
  for (let g = 0; g < games; g++) {
    const rng = mulberry32(seedBase + g);
    const aSeat = g % 2;
    const choosers = aSeat === 0 ? [botA, botB] : [botB, botA];
    const loser = playGame(choosers, rng);
    if (loser == null) score += 0.25;
    else if (loser !== aSeat) score += 1;
  }
  return score / games;
}

/** Report card vs the frozen old heuristic (2p + 4p). */
function vsOldBot(weights, games2p, games4p, seedBase) {
  const mine = (s, i) => newBot.chooseMove(s, i, weights);
  let wins = 0;
  let draws = 0;
  for (let g = 0; g < games2p; g++) {
    const rng = mulberry32(seedBase + g);
    const mySeat = g % 2;
    const choosers = mySeat === 0 ? [mine, oldChooseMove] : [oldChooseMove, mine];
    const loser = playGame(choosers, rng);
    if (loser == null) draws++;
    else if (loser !== mySeat) wins++;
  }
  let burge = 0;
  for (let g = 0; g < games4p; g++) {
    const rng = mulberry32(seedBase + 100000 + g);
    const mySeat = g % 4;
    const choosers = [oldChooseMove, oldChooseMove, oldChooseMove, oldChooseMove];
    choosers[mySeat] = mine;
    if (playGame(choosers, rng) === mySeat) burge++;
  }
  return {
    winRate2p: wins / games2p,
    drawRate2p: draws / games2p,
    burgeRate4p: games4p ? burge / games4p : null,
  };
}

const KEYS = Object.keys(newBot.DEFAULT_WEIGHTS);

/**
 * Self-play hill climb: two bots fight head-to-head — a candidate replaces
 * the champion only by beating it directly. This selects for aggression:
 * draws are punished and there is no committee of weaker bots to farm.
 */
function trainLoop(iters) {
  let best = { ...newBot.DEFAULT_WEIGHTS };
  const rand = mulberry32(7654321);
  const factors = [0.5, 0.7, 1.4, 2.0];
  for (let it = 0; it < iters; it++) {
    const key = KEYS[Math.floor(rand() * KEYS.length)];
    const factor = factors[Math.floor(rand() * factors.length)];
    const cand = { ...best, [key]: best[key] * factor };
    const score = head2head(cand, best, 1600, 42 + it); // fresh seeds per duel
    if (score > 0.53) {
      best = cand;
      const check = vsOldBot(best, 800, 0, 555000 + it);
      console.log(
        `it ${String(it).padStart(3)} ACCEPT ${key} ×${factor} → ${best[key].toFixed(2)} ` +
          `(beat champion ${(score * 100).toFixed(1)}%; vs old bot ${(check.winRate2p * 100).toFixed(1)}%)`
      );
    }
  }
  const val = vsOldBot(best, 3000, 1000, 987654);
  console.log(
    `\nvalidation vs old bot (fresh seeds): 2p=${(val.winRate2p * 100).toFixed(1)}% ` +
      `draws=${(val.drawRate2p * 100).toFixed(1)}% burge4p=${(val.burgeRate4p * 100).toFixed(1)}%`
  );
  console.log('\nbest weights:\n' + JSON.stringify(best, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'train') {
  trainLoop(Number(process.argv[3]) || 60);
} else {
  const r = vsOldBot(newBot.DEFAULT_WEIGHTS, 3000, 1000, 987654);
  console.log(
    `current weights vs old bot: 2p win rate=${(r.winRate2p * 100).toFixed(1)}% ` +
      `(draws ${(r.drawRate2p * 100).toFixed(1)}%), ` +
      `4p bürge rate=${(r.burgeRate4p * 100).toFixed(1)}% (baseline 25%)`
  );
}
