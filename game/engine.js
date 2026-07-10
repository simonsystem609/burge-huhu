'use strict';

/**
 * Bürge / Hühü game engine — pure logic, no networking.
 *
 * Family: Hungarian trump "beating" game (rokon a durák/orosz családdal).
 * 2–4 players. See RULES below and README.md for the exact interpretation used.
 *
 * ── RULES IMPLEMENTED (v2) ────────────────────────────────────────────────
 *  • 32-card Hungarian deck. Deal 5 cards each.
 *  • Flip the next card: its SUIT is trump (adu). That card is placed at the
 *    BOTTOM of the talon (draw pile), so it is the very last card drawn.
 *  • Turn = one attacker vs one defender (the next active player clockwise).
 *  • Attacker plays a SET of cards: a single card, a pair (same rank, any
 *    suits) + one follower card, or two pairs + one follower card (3 or 5
 *    cards total) — capped at the defender's current hand size.
 *  • Defender may BEAT any card in the set (higher card of the same suit, or
 *    any trump; a higher trump beats a lower trump) with one hand card per
 *    attack card. Beating is never mandatory, even if a full defense is
 *    possible — the defender can stop at any point and TAKE.
 *  • On take: slots already beaten this exchange are discarded as normal
 *    (attack + defense card both); only the still-undefended attack cards
 *    go into the defender's hand. A full beat and a full take are just the
 *    two ends of this same spectrum — partial defense is a real, rewarded
 *    choice, not an all-or-nothing gamble.
 *      – Fully beaten (defender chose to cover every slot): all cards go to
 *        discard. Refill hands to 5 (attacker first, clockwise). The
 *        DEFENDER becomes the next attacker.
 *      – Any cards taken: refill, then the attack passes to the player
 *        AFTER the defender (defender is skipped).
 *  • The trump VII may be swapped, on your attack turn, for the face-up trump
 *    card at the bottom of the talon — except when that trump card is the
 *    very last card left in the talon.
 *  • Once the talon is empty there is no more drawing. A player who empties
 *    their hand is OUT (finished) and is ranked by finishing order.
 *  • The LAST player still holding cards is the "bürge" (loser).
 * ──────────────────────────────────────────────────────────────────────────
 */

const {
  fullDeck,
  shuffle,
  cardSuit,
  cardRank,
  strength,
  beats,
} = require('./deck');

const HAND_SIZE = 5;

/**
 * Create a fresh game.
 * @param {Array<{id:string,name:string,isBot:boolean}>} players 2..4 seats
 * @param {function} [rng] optional deterministic RNG for tests
 */
function createGame(players, rng = Math.random) {
  if (players.length < 2 || players.length > 4) {
    throw new Error('Bürge requires 2–4 players.');
  }

  const talon = shuffle(fullDeck(), rng);

  const gamePlayers = players.map((p) => ({
    id: p.id,
    name: p.name,
    isBot: !!p.isBot,
    hand: [],
    finished: false,
    finishRank: null,
  }));

  // Deal 5 each.
  for (let n = 0; n < HAND_SIZE; n++) {
    for (const p of gamePlayers) {
      p.hand.push(talon.pop());
    }
  }

  // Flip trump, park it at the bottom of the talon (drawn last).
  const trumpCard = talon.shift(); // take from the "far" end
  const trumpSuit = cardSuit(trumpCard);
  talon.unshift(trumpCard); // bottom of pile => last to be drawn

  const state = {
    players: gamePlayers,
    talon, // talon[0] is the bottom card (the trump card) once it's the last one
    trumpCard,
    trumpSuit,
    trumpPicked: false, // true once the trump card has actually been drawn out
    // Public memory: cards each player is KNOWN to hold, maintained from
    // public events only (visible pickups, the face-up trump being drawn,
    // the swap7 exchange). Any player watching the table could keep this
    // list themselves — it reveals nothing hidden.
    knownHolds: gamePlayers.map(() => []),
    discard: [],
    attacker: 0,
    defender: 1,
    table: { slots: [] }, // [{ attack: cardId, defense: cardId|null }, ...]
    phase: 'attack', // 'attack' | 'defense' | 'over'
    finishedOrder: [],
    loser: null,
    turnCount: 0,
    sinceDiscard: 0, // exchanges with no discard while talon is empty (stall guard)
    log: [],
  };

  state.defender = nextActive(state, 0);
  pushLog(state, 'game_start', { trump: trumpSuit });
  return state;
}

function pushLog(state, key, params = {}) {
  state.log.push({ key, params, t: state.turnCount });
  if (state.log.length > 60) state.log.shift();
}

function activeCount(state) {
  return state.players.filter((p) => !p.finished).length;
}

/** Next active (not finished) player index after `from`, clockwise. */
function nextActive(state, from) {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    if (!state.players[idx].finished) return idx;
  }
  return from;
}

/** A card publicly entered this player's hand (pickup, trump draw, swap). */
function knowHold(state, playerIndex, card) {
  const list = state.knownHolds && state.knownHolds[playerIndex];
  if (list && !list.includes(card)) list.push(card);
}

/** A card publicly left this player's hand (played onto the table, swapped away). */
function forgetHold(state, playerIndex, card) {
  const list = state.knownHolds && state.knownHolds[playerIndex];
  if (!list) return;
  const i = list.indexOf(card);
  if (i !== -1) list.splice(i, 1);
}

/** Draw one card from the top of the talon (talon end). */
function drawOne(state, player) {
  if (state.talon.length === 0) return false;
  const card = state.talon.pop();
  if (card === state.trumpCard) {
    state.trumpPicked = true;
    // The face-up trump is public — everyone sees who draws it.
    knowHold(state, state.players.indexOf(player), card);
  }
  player.hand.push(card);
  return true;
}

/** Refill hands to HAND_SIZE, attacker first, clockwise, while talon lasts. */
function refill(state) {
  const n = state.players.length;
  state.drewLast = new Array(n).fill(0);
  const order = [];
  for (let step = 0; step < n; step++) {
    order.push((state.attacker + step) % n);
  }
  for (const idx of order) {
    const p = state.players[idx];
    while (!p.finished && p.hand.length < HAND_SIZE && state.talon.length > 0) {
      drawOne(state, p);
      state.drewLast[idx]++;
    }
  }
}

/** Mark players who are out (empty hand + empty talon), assign finishing ranks. */
function updateFinished(state) {
  if (state.talon.length > 0) return; // can't finish while cards remain to draw
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i];
      if (!p.finished && p.hand.length === 0) {
        p.finished = true;
        p.finishRank = state.finishedOrder.length + 1;
        state.finishedOrder.push(i);
        pushLog(state, 'player_out', { player: i, rank: p.finishRank });
        changed = true;
      }
    }
  }
  // One (or zero) player left holding cards => game over.
  const remaining = state.players.filter((p) => !p.finished);
  if (remaining.length <= 1) {
    if (remaining.length === 1) {
      const loserIdx = state.players.indexOf(remaining[0]);
      state.loser = loserIdx;
      pushLog(state, 'loser', { player: loserIdx });
    } else {
      state.loser = null; // everyone emptied simultaneously — a draw
    }
    state.phase = 'over';
  }
}

/** Safety net: end a stalled game, ranking active players by fewest cards. */
function forceEndByHandSize(state) {
  const active = state.players
    .map((p, i) => ({ p, i }))
    .filter((x) => !x.p.finished)
    .sort((a, b) => a.p.hand.length - b.p.hand.length);
  const maxLen = Math.max(...active.map((x) => x.p.hand.length));
  const topTied = active.filter((x) => x.p.hand.length === maxLen);
  for (const x of active) {
    if (topTied.length === 1 && x === topTied[0]) continue;
    x.p.finished = true;
    x.p.finishRank = state.finishedOrder.length + 1;
    state.finishedOrder.push(x.i);
  }
  state.loser = topTied.length === 1 ? topTied[0].i : null;
  state.phase = 'over';
  pushLog(state, 'stalled', { player: state.loser == null ? -1 : state.loser });
}

/**
 * The player whose turn it is to act right now.
 * Returns { player, role } where role is 'attack'|'defense', or null if over.
 */
function currentActor(state) {
  if (state.phase === 'over') return null;
  if (state.phase === 'attack') return { player: state.attacker, role: 'attack' };
  return { player: state.defender, role: 'defense' };
}

// ── Attack-set combinatorics ────────────────────────────────────────────

function combinations(arr, k) {
  const results = [];
  const combo = [];
  (function helper(start) {
    if (combo.length === k) {
      results.push(combo.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1);
      combo.pop();
    }
  })(0);
  return results;
}

/**
 * A legal attack set is: one card; OR one pair (two cards of the same rank,
 * any suits) plus one follower card (3 total); OR two pairs plus one
 * follower card (5 total). Extra cards sharing a pair's rank are fine (e.g.
 * a follower that happens to match — that's just a bigger pair, still legal).
 */
function isValidAttackSet(cards) {
  if (cards.length === 1) return true;
  if (cards.length !== 3 && cards.length !== 5) return false;
  const counts = {};
  for (const c of cards) {
    const r = cardRank(c);
    counts[r] = (counts[r] || 0) + 1;
  }
  const pairsNeeded = cards.length === 3 ? 1 : 2;
  let pairs = 0;
  for (const r in counts) pairs += Math.floor(counts[r] / 2);
  return pairs >= pairsNeeded;
}

/** All legal attack sets from `hand`, capped at `maxSize` cards. */
function enumerateAttackSets(hand, maxSize) {
  const sets = [];
  for (const n of [1, 3, 5]) {
    if (n > hand.length || n > maxSize) continue;
    for (const combo of combinations(hand, n)) {
      if (isValidAttackSet(combo)) sets.push(combo);
    }
  }
  return sets;
}

/**
 * Can every card in `attackCards` be beaten by a distinct card from `hand`?
 * Bipartite matching (Kuhn's algorithm) — small inputs, always exact.
 * Returns an assignment array (attackCards[i] -> hand card that beats it) or
 * null if no full defense exists.
 */
function findFullDefense(attackCards, hand, trumpSuit) {
  const n = attackCards.length;
  if (n === 0) return [];
  const adj = attackCards.map((atk) =>
    hand.map((c, hi) => (beats(atk, c, trumpSuit) ? hi : -1)).filter((hi) => hi !== -1)
  );
  const matchToAttack = new Array(hand.length).fill(-1);

  function tryKuhn(attackIdx, visited) {
    for (const hi of adj[attackIdx]) {
      if (visited[hi]) continue;
      visited[hi] = true;
      if (matchToAttack[hi] === -1 || tryKuhn(matchToAttack[hi], visited)) {
        matchToAttack[hi] = attackIdx;
        return true;
      }
    }
    return false;
  }

  let matched = 0;
  for (let i = 0; i < n; i++) {
    const visited = new Array(hand.length).fill(false);
    if (tryKuhn(i, visited)) matched++;
  }
  if (matched < n) return null;

  const assignment = new Array(n).fill(null);
  for (let hi = 0; hi < hand.length; hi++) {
    if (matchToAttack[hi] !== -1) assignment[matchToAttack[hi]] = hand[hi];
  }
  return assignment;
}

/** Legal moves for a given player index (empty array if not their turn). */
function legalMoves(state, playerIndex) {
  const actor = currentActor(state);
  if (!actor || actor.player !== playerIndex) return [];
  const p = state.players[playerIndex];
  const moves = [];

  if (actor.role === 'attack') {
    // Optional: swap trump VII with the face-up trump card at bottom of talon
    // (not allowed once the trump card is the very last card left in the talon).
    const trumpSeven = `${state.trumpSuit}-VII`;
    if (
      state.talon.length > 1 &&
      state.talon[0] === state.trumpCard &&
      state.trumpCard !== trumpSeven &&
      p.hand.includes(trumpSeven)
    ) {
      moves.push({ type: 'swap7' });
    }
    const defenderHandSize = state.players[state.defender].hand.length;
    for (const cards of enumerateAttackSets(p.hand, defenderHandSize)) {
      moves.push({ type: 'attack', cards });
    }
  } else {
    const undefended = [];
    state.table.slots.forEach((slot, i) => {
      if (slot.defense == null) undefended.push(i);
    });
    for (const i of undefended) {
      const atk = state.table.slots[i].attack;
      for (const card of p.hand) {
        if (beats(atk, card, state.trumpSuit)) {
          moves.push({ type: 'defend', slot: i, card });
        }
      }
    }
    // Beating is never mandatory — the defender can always stop and pick up
    // whatever they haven't (or don't want to) beat, even if a full defense
    // of every remaining slot was still possible.
    moves.push({ type: 'take' });
  }
  return moves;
}

function handHas(player, card) {
  return player.hand.includes(card);
}

function removeCard(player, card) {
  const i = player.hand.indexOf(card);
  if (i === -1) return false;
  player.hand.splice(i, 1);
  return true;
}

/**
 * Apply a move for playerIndex. Mutates and returns state.
 * Throws Error('illegal:<reason>') on invalid input.
 */
function applyMove(state, playerIndex, move) {
  const actor = currentActor(state);
  if (!actor) throw new Error('illegal:game_over');
  if (actor.player !== playerIndex) throw new Error('illegal:not_your_turn');

  if (move.type === 'swap7') {
    if (actor.role !== 'attack') throw new Error('illegal:swap_phase');
    const trumpSeven = `${state.trumpSuit}-VII`;
    const p = state.players[playerIndex];
    if (
      state.talon.length <= 1 ||
      state.talon[0] !== state.trumpCard ||
      state.trumpCard === trumpSeven ||
      !handHas(p, trumpSeven)
    ) {
      throw new Error('illegal:swap');
    }
    // Swap: take the face-up trump into hand, put our VII at the bottom.
    removeCard(p, trumpSeven);
    p.hand.push(state.trumpCard);
    knowHold(state, playerIndex, state.trumpCard); // taken in full view
    forgetHold(state, playerIndex, trumpSeven);
    state.talon[0] = trumpSeven;
    state.trumpCard = trumpSeven;
    pushLog(state, 'swap7', { player: playerIndex });
    return state; // still attacker's turn to actually attack
  }

  if (actor.role === 'attack') {
    if (move.type !== 'attack') throw new Error('illegal:expected_attack');
    const p = state.players[playerIndex];
    const cards = move.cards;
    if (!Array.isArray(cards) || cards.length === 0) throw new Error('illegal:empty_attack');
    if (new Set(cards).size !== cards.length) throw new Error('illegal:duplicate_cards');
    for (const c of cards) {
      if (!handHas(p, c)) throw new Error('illegal:not_in_hand');
    }
    if (!isValidAttackSet(cards)) throw new Error('illegal:bad_set_shape');
    if (cards.length > state.players[state.defender].hand.length) {
      throw new Error('illegal:too_many_cards');
    }
    for (const c of cards) {
      removeCard(p, c);
      forgetHold(state, playerIndex, c);
    }
    state.table.slots = cards.map((c) => ({ attack: c, defense: null }));
    state.phase = 'defense';
    pushLog(state, 'attack', { player: playerIndex, cards });
    return state;
  }

  // Defense phase. Beating is never mandatory: whatever the defender hasn't
  // beaten by the time they submit `take`, they pick up — but slots they
  // already beat are still discarded, not returned. Partial defense is a
  // real, rewarded choice, not an all-or-nothing gamble.
  const defender = state.players[playerIndex];
  if (move.type === 'take') {
    const beaten = state.table.slots.filter((s) => s.defense != null);
    const undefended = state.table.slots.filter((s) => s.defense == null);
    for (const s of beaten) {
      state.discard.push(s.attack);
      state.discard.push(s.defense);
    }
    const pickedUp = undefended.map((s) => s.attack);
    defender.hand.push(...pickedUp);
    for (const c of pickedUp) knowHold(state, playerIndex, c); // taken in full view
    if (pickedUp.length > 0) {
      pushLog(state, 'take', { player: playerIndex, cards: pickedUp });
    }
    state.table.slots = [];
    const fullyBeaten = pickedUp.length === 0;
    const leadIdx = state.defender;
    resolveEndOfExchange(state, /*defenderBeat=*/ fullyBeaten, leadIdx);
    return state;
  }

  if (move.type === 'defend') {
    const slot = state.table.slots[move.slot];
    if (!slot) throw new Error('illegal:no_such_slot');
    if (slot.defense != null) throw new Error('illegal:slot_already_defended');
    if (!handHas(defender, move.card)) throw new Error('illegal:not_in_hand');
    if (!beats(slot.attack, move.card, state.trumpSuit)) {
      throw new Error('illegal:does_not_beat');
    }
    removeCard(defender, move.card);
    forgetHold(state, playerIndex, move.card);
    slot.defense = move.card;
    pushLog(state, 'defend', {
      player: playerIndex,
      card: move.card,
      over: slot.attack,
    });
    const allDefended = state.table.slots.every((s) => s.defense != null);
    if (allDefended) {
      resolveEndOfExchange(state, /*defenderBeat=*/ true, state.defender);
    }
    return state;
  }

  throw new Error('illegal:unknown_move');
}

/**
 * Clean up the table, refill, decide who attacks next, and check finishes.
 * @param defenderBeat  true if the defender beat every card, false if taken
 * @param defenderIdx   the defender's seat index for this exchange
 */
function resolveEndOfExchange(state, defenderBeat, defenderIdx) {
  // Cards leave the table.
  if (defenderBeat) {
    for (const slot of state.table.slots) {
      state.discard.push(slot.attack);
      if (slot.defense != null) state.discard.push(slot.defense);
    }
  }
  // (If taken, the cards already went into the defender's hand.)
  state.table.slots = [];
  state.turnCount += 1;

  const talonBefore = state.talon.length;
  refill(state);
  const drewACard = state.talon.length < talonBefore;

  // Stall guard: an exchange makes "progress" if a card leaves play (a beat →
  // discard) or a card is drawn. Both are strictly bounded, so once neither can
  // happen the counter climbs until we force an end. This also catches the case
  // where every hand is >= 5 and the talon can never be drawn down ("frozen").
  if (defenderBeat || drewACard) {
    state.sinceDiscard = 0;
  } else {
    state.sinceDiscard += 1;
  }

  updateFinished(state);
  if (state.phase === 'over') return;

  // Extremely rare pathological loop (no card can ever be beaten): resolve by
  // hand size so the game always terminates.
  if (state.sinceDiscard > 4 * activeCount(state)) {
    forceEndByHandSize(state);
    return;
  }

  // Decide the next attacker.
  let nextAttacker;
  if (defenderBeat) {
    // Defender successfully beat -> they lead next (if still active).
    nextAttacker = state.players[defenderIdx].finished
      ? nextActive(state, defenderIdx)
      : defenderIdx;
  } else {
    // Defender took the cards and is skipped -> next player after them leads.
    nextAttacker = nextActive(state, defenderIdx);
  }

  state.attacker = nextAttacker;
  state.defender = nextActive(state, nextAttacker);
  state.phase = 'attack';
}

/**
 * Build a player-specific view of the game (hides other hands).
 */
function viewFor(state, playerIndex) {
  const you = state.players[playerIndex];
  return {
    you: playerIndex,
    phase: state.phase,
    trumpSuit: state.trumpSuit,
    trumpCard: state.trumpCard,
    trumpInTalon: state.talon.length > 0 && state.talon[0] === state.trumpCard,
    trumpPicked: state.trumpPicked,
    talonCount: state.talon.length,
    discardCount: state.discard.length,
    table: { slots: state.table.slots.map((s) => ({ attack: s.attack, defense: s.defense })) },
    attacker: state.attacker,
    defender: state.defender,
    hand: you ? [...you.hand] : [],
    yourTurn: (() => {
      const a = currentActor(state);
      return !!a && a.player === playerIndex;
    })(),
    legal: legalMoves(state, playerIndex),
    players: state.players.map((p, i) => ({
      seat: i,
      name: p.name,
      isBot: p.isBot,
      count: p.hand.length,
      finished: p.finished,
      finishRank: p.finishRank,
      isAttacker: i === state.attacker && state.phase !== 'over',
      isDefender: i === state.defender && state.phase === 'defense',
      isYou: i === playerIndex,
    })),
    loser: state.loser,
    finishedOrder: [...state.finishedOrder],
    log: state.log.slice(-8),
    drewLast: state.drewLast || [],
    // Public memory (see createGame): what each player is known to hold.
    knownHolds: (state.knownHolds || []).map((a) => [...a]),
  };
}

module.exports = {
  HAND_SIZE,
  createGame,
  legalMoves,
  applyMove,
  currentActor,
  nextActive,
  viewFor,
  isValidAttackSet,
  enumerateAttackSets,
  findFullDefense,
  // exported for tests
  beats,
  strength,
  cardSuit,
  cardRank,
};
