'use strict';

/**
 * Simple heuristic AI for Bürge.
 *
 * Strategy:
 *   • Attack: swap the trump VII if offered (gain a stronger trump), then lead
 *     the weakest card, preferring non-trumps so trumps are kept for defence.
 *   • Defend: beat with the cheapest card that works, preferring non-trumps.
 *     If the only way to beat a weak attack is to burn a strong trump, and our
 *     hand is comfortable, just take the card instead.
 */

const { legalMoves } = require('./engine');
const { cardSuit, strength } = require('./deck');

function cardScore(card, trumpSuit) {
  // Lower = cheaper to give up. Trumps get a big premium so they're kept.
  return strength(card) + (cardSuit(card) === trumpSuit ? 100 : 0);
}

function chooseMove(state, playerIndex) {
  const moves = legalMoves(state, playerIndex);
  if (moves.length === 0) return null;

  const trumpSuit = state.trumpSuit;
  const attackMoves = moves.filter((m) => m.type === 'attack');
  const defendMoves = moves.filter((m) => m.type === 'defend');
  const canTake = moves.some((m) => m.type === 'take');
  const canSwap = moves.some((m) => m.type === 'swap7');

  // Attacking.
  if (attackMoves.length > 0 || canSwap) {
    if (canSwap) return { type: 'swap7' };
    attackMoves.sort(
      (a, b) => cardScore(a.card, trumpSuit) - cardScore(b.card, trumpSuit)
    );
    return attackMoves[0];
  }

  // Defending.
  if (defendMoves.length > 0) {
    defendMoves.sort(
      (a, b) => cardScore(a.card, trumpSuit) - cardScore(b.card, trumpSuit)
    );
    const cheapest = defendMoves[0];
    const attackCard = state.table.attack;

    // Spend low trumps freely; only hoard EXPENSIVE trumps (Alsó and up) against
    // a cheap non-trump attack — and even then only with a comfortable hand.
    // (Hoarding every trump lets cheap cards circulate forever, so we don't.)
    const cheapestIsTrump = cardSuit(cheapest.card) === trumpSuit;
    const trumpCostHigh = cheapestIsTrump && strength(cheapest.card) >= 4; // >= Alsó
    const attackIsCheapNonTrump =
      cardSuit(attackCard) !== trumpSuit && strength(attackCard) <= 2; // <= IX
    const hand = state.players[playerIndex].hand;
    if (canTake && trumpCostHigh && attackIsCheapNonTrump && hand.length <= 5) {
      return { type: 'take' };
    }
    return cheapest;
  }

  // No way to beat — take it.
  return { type: 'take' };
}

module.exports = { chooseMove };
