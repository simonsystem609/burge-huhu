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
const { cardSuit, cardRank, strength, beats, fullDeck } = require('./deck');

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
  pickTrump: 3, // taking a trump on purpose in the race
  pickTrumpFill: 6, // gathering trumps is THE early/mid-game plan
  pickPair: 2.5, // taking a card that completes a pair in hand
  pickHigh: 2.8, // taking a strong card (Felső or better)
  pickJunk: 4.2, // penalty for hoovering up weak off-suit singles
  fillBloat: 1, // per card picked up while the talon lasts
  raceBloat: 10, // per card picked up once the talon is empty
  skipTurn: 3.92, // taking skips our next attack turn
  raceGiveQuality: 0.4, // race-phase giveaway penalty — send aggressively
  forceTake: 16, // attack no combination of unseen cards can fully beat
  unbeatable: 3, // per attack card that no unseen card can beat
  fish: 1.2, // trump fishing: dump big while trumpless to draw fresh cards
  probExp: 6, // convexity of the forced-pickup bet: only near-certainty pays
};

// Bot personalities: weight multipliers giving each bot a temperament.
// 'balanced' plays the trained optimum; the others trade a little strength
// for character. Server bots get a random style per seat.
const PERSONALITIES = {
  balanced: {},
  aggressive: {
    fillShed: 1.3, raceShed: 1.3, forceTake: 1.3, deny: 1.25,
    giveQuality: 0.7, raceGiveQuality: 0.7,
  },
  gatherer: {
    pickTrump: 2.2, pickTrumpFill: 1.8, pickPair: 2.0, pickHigh: 1.6,
    pickJunk: 0.6, skipTurn: 0.6, fish: 1.5,
  },
  cautious: {
    giveQuality: 1.35, breakPair: 1.4, spend: 1.2, trumpPremium: 1.25,
    fillShed: 0.75,
  },
};

function applyStyle(base, style) {
  const mult = PERSONALITIES[style];
  if (!mult) return base;
  const w = { ...base };
  for (const k in mult) w[k] = w[k] * mult[k];
  return w;
}

/**
 * Honest card counting: everything a player at this seat could know from
 * watching the game — the full deck minus their own hand, the discard pile
 * (every discarded card crossed the table face-up), the table, and the
 * face-up trump card while it still sits under the talon. Whatever remains
 * is "unseen": the union of the other hands and the face-down talon.
 * (Heads-up with the talon empty this IS the opponent's exact hand.)
 */
function unseenCards(state, playerIndex) {
  const seen = new Set(state.players[playerIndex].hand);
  for (const c of state.discard) seen.add(c);
  for (const slot of state.table.slots) {
    seen.add(slot.attack);
    if (slot.defense != null) seen.add(slot.defense);
  }
  if (state.talon.length > 0 && state.talon[0] === state.trumpCard) seen.add(state.trumpCard);
  return fullDeck().filter((c) => !seen.has(c));
}

/**
 * Per-player memory, applied: the cards the DEFENDER could possibly hold.
 * Cards publicly known to sit in some OTHER player's hand (engine-tracked
 * knownHolds — visible pickups, the trump draw, swap7) cannot be the
 * defender's, so they leave the pool. Still a superset of their real hand,
 * so "no full defense exists" stays provable — just provable more often.
 * The defender's own known cards are returned too: they are certainly held.
 */
function defenderPool(state, playerIndex, unseen) {
  if (!state.knownHolds) return { pool: unseen, certain: [] };
  const othersKnown = new Set();
  state.players.forEach((p, i) => {
    if (i === state.defender || i === playerIndex) return;
    for (const c of state.knownHolds[i] || []) othersKnown.add(c);
  });
  const pool = othersKnown.size === 0 ? unseen : unseen.filter((c) => !othersKnown.has(c));
  return { pool, certain: state.knownHolds[state.defender] || [] };
}

// Deterministic per-state RNG for the Monte-Carlo sampling below — the same
// position always produces the same estimate, so self-play training and the
// smoke tests stay reproducible.
function stateRng(state) {
  let seed =
    state.turnCount * 2654435761 +
    state.talon.length * 40503 +
    state.discard.length * 65599 +
    state.players.reduce((a, p) => a * 31 + p.hand.length, 7);
  seed >>>= 0;
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Probabilistic counting: P(the defender CANNOT fully beat `set`), given
 * that their hand is `handSize` cards drawn from `pool`, of which `certain`
 * are known to be held for sure. Estimated by Monte-Carlo: sample plausible
 * hands, run the exact bipartite matching on each. Heads-up with the talon
 * empty the pool IS the hand, so the estimate collapses to exactly 0 or 1.
 */
function probNoFullBeat(set, pool, certain, handSize, trumpSuit, rng, samples) {
  if (!findFullDefense(set, pool, trumpSuit)) return 1; // provably impossible
  if (pool.length <= handSize) return 0; // their whole hand is known
  const free = pool.filter((c) => !certain.includes(c));
  const need = Math.max(0, handSize - certain.length);
  if (need >= free.length) return findFullDefense(set, pool, trumpSuit) ? 0 : 1;
  let fail = 0;
  const arr = free.slice();
  for (let s = 0; s < samples; s++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (arr.length - i));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    const hand = certain.concat(arr.slice(0, need));
    if (!findFullDefense(set, hand, trumpSuit)) fail++;
  }
  return fail / samples;
}

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

function scoreAttack(set, hand, trumpSuit, race, W, ctx) {
  const shed = set.length;
  let score = race ? W.raceShed * shed : W.fillShed * shed;
  const giveW = race ? W.raceGiveQuality : W.giveQuality;
  for (const c of set) score -= giveW * quality(c, trumpSuit, W);
  const { used, broken } = pairUsage(hand, set);
  score += W.usePair * used - W.breakPair * broken;
  if (race && shed === hand.length) score += W.finishBonus;

  // Trump fishing: holding no worthwhile trump while the talon lasts,
  // dumping BIG means drawing that many fresh cards — a chance at trumps.
  // Only mass churn counts; single-card dribbles don't refresh the hand.
  if (ctx && ctx.fishing && shed >= 3) score += W.fish * shed;

  // Provably unbeatable cards (no card the defender could possibly hold
  // beats them) still score in the base pass; the probabilistic whole-set
  // estimate is added in a second pass over the top candidates only.
  if (ctx && ctx.pool && race) {
    let sure = 0;
    for (const c of set) {
      if (!ctx.pool.some((u) => beats(c, u, trumpSuit))) sure++;
    }
    score += W.unbeatable * sure;
  }
  return score;
}

/** Value of deliberately picking up an attack card. */
function pickupGain(card, hand, trumpSuit, race, W) {
  let gain = 0;
  // Early and mid game the plan is to GATHER trumps (hands refill anyway,
  // so a picked-up trump is nearly free); in the race it's just extra bulk.
  if (cardSuit(card) === trumpSuit) gain += race ? W.pickTrump : W.pickTrumpFill;
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

function chooseMove(state, playerIndex, weights, opts) {
  const o = opts || {};
  let W = weights || DEFAULT_WEIGHTS;
  if (o.style) W = applyStyle(W, o.style);
  const temp = o.temp || 0;
  const rng = o.rng || Math.random;

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
    const unseen = unseenCards(state, playerIndex);
    const { pool, certain } = defenderPool(state, playerIndex, unseen);
    const bestTrump = Math.max(
      -1,
      ...hand.filter((c) => cardSuit(c) === trumpSuit).map((c) => strength(c))
    );
    const ctx = {
      pool,
      fishing: !race && state.talon.length > 1 && bestTrump < 3,
    };
    const scored = attackMoves.map((m) => ({
      m,
      s: scoreAttack(m.cards, hand, trumpSuit, race, W, ctx),
    }));
    scored.sort((a, b) => b.s - a.s);

    // Probabilistic counting, race phase only: for the leading candidates,
    // estimate the chance the defender simply cannot beat the whole set
    // (their hand size is public; possible cards come from the pool) and
    // reward likely forced pickups proportionally.
    if (race) {
      const mcRng = stateRng(state);
      const defHandSize = state.players[state.defender].hand.length;
      const top = scored.slice(0, 24); // race hands are small — cover almost all sets
      for (const x of top) {
        const p = probNoFullBeat(x.m.cards, pool, certain, defHandSize, trumpSuit, mcRng, 32);
        // Convex credit: a coin-flip force is a bad bet with good cards —
        // only near-certain forced pickups earn the full bonus.
        x.s += W.forceTake * x.m.cards.length * Math.pow(p, W.probExp);
      }
      scored.sort((a, b) => b.s - a.s);
    }

    // Temperature: with temp > 0, any move close enough to the best is fair
    // game — bots get occasional bold, off-script sends.
    if (temp > 0 && scored.length > 1) {
      const cutoff = scored[0].s - temp * 6;
      const cand = scored.filter((x) => x.s >= cutoff);
      return cand[Math.floor(rng() * cand.length)].m;
    }
    return scored[0].m;
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

module.exports = { chooseMove, DEFAULT_WEIGHTS, PERSONALITIES };
