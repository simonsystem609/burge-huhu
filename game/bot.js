'use strict';

/**
 * Simple heuristic AI for Bürge.
 *
 * Strategy:
 *   • Attack: swap the trump VII if offered, then lead the cheapest legal
 *     attack set, preferring sets that shed more cards and avoid trumps.
 *   • Defend: check whether every currently-undefended slot can be beaten at
 *     once (bipartite matching via engine.findFullDefense). If so, play the
 *     next assigned defend card — unless it means burning an expensive trump
 *     on a cheap single attack while the hand is already comfortable, in
 *     which case just take. If no full defense exists, take.
 */

const { legalMoves, findFullDefense } = require('./engine');
const { cardSuit, strength } = require('./deck');

function cardScore(card, trumpSuit) {
  // Lower = cheaper to give up. Trumps get a big premium so they're kept.
  return strength(card) + (cardSuit(card) === trumpSuit ? 100 : 0);
}

function setScore(cards, trumpSuit) {
  const total = cards.reduce((sum, c) => sum + cardScore(c, trumpSuit), 0);
  return total - cards.length * 8; // reward shedding more cards per move
}

function chooseMove(state, playerIndex) {
  const moves = legalMoves(state, playerIndex);
  if (moves.length === 0) return null;

  const trumpSuit = state.trumpSuit;
  const swapMove = moves.find((m) => m.type === 'swap7');
  if (swapMove) return swapMove;

  const attackMoves = moves.filter((m) => m.type === 'attack');
  if (attackMoves.length > 0) {
    const nonTrumpSets = attackMoves.filter((m) => m.cards.every((c) => cardSuit(c) !== trumpSuit));
    const pool = nonTrumpSets.length > 0 ? nonTrumpSets : attackMoves;
    pool.sort((a, b) => setScore(a.cards, trumpSuit) - setScore(b.cards, trumpSuit));
    return pool[0];
  }

  // Defending.
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
  const trumpCostHigh = beatingWithTrump && strength(card0) >= 4; // >= Alsó
  const attackIsCheapNonTrump = cardSuit(slot0.attack) !== trumpSuit && strength(slot0.attack) <= 2; // <= IX
  if (
    canTake &&
    trumpCostHigh &&
    attackIsCheapNonTrump &&
    undefendedSlots.length === 1 &&
    hand.length <= 5
  ) {
    return { type: 'take' };
  }
  return { type: 'defend', slot: slot0.i, card: card0 };
}

module.exports = { chooseMove };
