'use strict';

/**
 * Evaluation-based AI for Bürge with trained weights.
 *
 * The game has two very different phases and the bot plays them differently:
 *
 *  • FILL phase (talon still has cards): hands refill to 5 anyway, so playing
 *    cards is really *churning* — improve hand quality. Dump weak singles,
 *    hold trumps, and collect pairs (pairs enable 3- and 5-card dumps later).
 *    Picking up an attack card on purpose can be right: a trump, a high card,
 *    or a pair-completer is worth more than the tempo it costs.
 *
 *  • RACE phase (talon empty): pure race to an empty hand. Shedding is
 *    everything — attacking sheds, beating sheds, taking bloats. Emptying the
 *    whole hand in one attack is an instant finish and always taken.
 *
 * Every decision scores the legal moves with a weight vector. The default
 * weights were tuned by self-play hill-climbing over tens of thousands of
 * games against the previous heuristic bot (see scripts/train-bot.js).
 */

const { legalMoves, findFullDefense } = require('./engine');
const { cardSuit, cardRank, strength, beats } = require('./deck');

// Weights tuned by scripts/train-bot.js self-play runs (hill-climbing on
// thousands of seeded games vs the previous bot; validated on fresh seeds).
const DEFAULT_WEIGHTS = {
  trumpPremium: 8.4, // how precious a trump is compared to its plain strength
  fillShed: 1.47, // per card shed in an attack while the talon lasts
  raceShed: 14, // per card shed in an attack once the talon is empty
  giveQuality: 1.0, // penalty per point of quality given away in an attack
  breakPair: 2.8, // penalty for splitting up a pair
  usePair: 10, // bonus for playing a full pair inside an attack set
  finishBonus: 1000, // emptying the hand in the race phase = finishing
  deny: 8.4, // beating sends the attacker's card to discard — deny value
  spend: 1.0, // multiplier on the quality of the card burned to beat
  raceBeat: 4, // in the race, beating sheds one of our own cards too
  pickTrump: 3, // taking a trump on purpose
  pickPair: 2.5, // taking a card that completes a pair in hand
  pickHigh: 2.8, // taking a strong card (Felső or better)
  pickJunk: 4.2, // penalty for hoovering up weak off-suit singles
  fillBloat: 1, // per card picked up while the talon lasts
  raceBloat: 10, // per card picked up once the talon is empty
  skipTurn: 3.92, // taking skips our next attack turn
  raceGiveQuality: 0.4, // race-phase giveaway penalty — send aggressively
  forceTake: 16, // 2p race: attack the defender provably cannot fully beat
};

function quality(card, trumpSuit, W) {
  return strength(card) + (cardSuit(card) === trumpSuit ? W.trumpPremium : 0);
}

function rankCounts(hand) {
  const counts = {};
  for (const c of hand) {
    const r = cardRank(c);
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

/** Pair bookkeeping for an attack set: full pairs used vs pairs broken. */
function pairUsage(hand, set) {
  const handCounts = rankCounts(hand);
  const setCounts = rankCounts(set);
  let used = 0;
  let broken = 0;
  for (const r in setCounts) {
    const inSet = setCounts[r];
    const inHand = handCounts[r];
    used += Math.floor(inSet / 2);
    // Taking exactly one card out of an existing pair splits it.
    if (inSet % 2 === 1 && inHand >= inSet + 1) broken++;
  }
  return { used, broken };
}

function scoreAttack(set, hand, trumpSuit, race, W, state) {
  const shed = set.length;
  let score = race ? W.raceShed * shed : W.fillShed * shed;
  const giveW = race ? W.raceGiveQuality : W.giveQuality;
  for (const c of set) score -= giveW * quality(c, trumpSuit, W);
  const { used, broken } = pairUsage(hand, set);
  score += W.usePair * used - W.breakPair * broken;
  if (race && shed === hand.length) score += W.finishBonus;

  // Heads-up endgame is perfect information: with the talon empty, every
  // hidden card is in the defender's hand — count them. An attack the
  // defender provably cannot fully beat forces a pickup and bloats them.
  if (race && state && state.players.length === 2) {
    const defHand = state.players[state.defender].hand;
    if (!findFullDefense(set, defHand, trumpSuit)) {
      score += W.forceTake * shed;
    }
  }
  return score;
}

/** Value of deliberately picking up an attack card. */
function pickupGain(card, hand, trumpSuit, race, W) {
  let gain = 0;
  if (cardSuit(card) === trumpSuit) gain += W.pickTrump;
  const r = cardRank(card);
  if (hand.some((c) => cardRank(c) === r)) gain += W.pickPair;
  if (strength(card) >= 5) gain += W.pickHigh;
  if (gain === 0) gain -= W.pickJunk; // weak off-suit single: dead weight
  gain -= race ? W.raceBloat : W.fillBloat;
  return gain;
}

/** Cheapest hand card that beats `attack` (prefers not breaking pairs). */
function bestBeater(attack, hand, trumpSuit, W) {
  const counts = rankCounts(hand);
  let best = null;
  let bestCost = Infinity;
  for (const c of hand) {
    if (!beats(attack, c, trumpSuit)) continue;
    let cost = quality(c, trumpSuit, W) * W.spend;
    if (counts[cardRank(c)] >= 2) cost += W.breakPair;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best ? { card: best, cost: bestCost } : null;
}

function chooseMove(state, playerIndex, weights) {
  const W = weights || DEFAULT_WEIGHTS;
  const moves = legalMoves(state, playerIndex);
  if (moves.length === 0) return null;

  const trumpSuit = state.trumpSuit;
  const hand = state.players[playerIndex].hand;
  const race = state.talon.length === 0;

  // Swapping the VII for a stronger face-up trump is a pure gain.
  const swapMove = moves.find((m) => m.type === 'swap7');
  if (swapMove) return swapMove;

  const attackMoves = moves.filter((m) => m.type === 'attack');
  if (attackMoves.length > 0) {
    let best = attackMoves[0];
    let bestScore = -Infinity;
    for (const m of attackMoves) {
      const s = scoreAttack(m.cards, hand, trumpSuit, race, W, state);
      if (s > bestScore) {
        bestScore = s;
        best = m;
      }
    }
    return best;
  }

  // ── Defense ──────────────────────────────────────────────────────
  // Greedy per-slot choice: beat the slot where beating clearly pays off
  // more than picking that card up would; once no slot passes the bar,
  // take whatever is left (beaten slots stay discarded either way).
  const undefended = [];
  state.table.slots.forEach((slot, i) => {
    if (slot.defense == null) undefended.push({ attack: slot.attack, i });
  });
  if (undefended.length === 0) return { type: 'take' };

  let bestSlot = null;
  let bestMargin = 0;
  for (const u of undefended) {
    const beater = bestBeater(u.attack, hand, trumpSuit, W);
    if (!beater) continue;
    let beatNet = -beater.cost + W.deny;
    if (race) beatNet += W.raceBeat; // beating sheds one of our cards too
    const takeNet = pickupGain(u.attack, hand, trumpSuit, race, W) - W.skipTurn;
    const margin = beatNet - takeNet;
    if (margin > bestMargin) {
      bestMargin = margin;
      bestSlot = { slot: u.i, card: beater.card };
    }
  }
  if (bestSlot) return { type: 'defend', slot: bestSlot.slot, card: bestSlot.card };
  return { type: 'take' };
}

module.exports = { chooseMove, DEFAULT_WEIGHTS };
