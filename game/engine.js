'use strict';

/**
 * Bürge / Hühü game engine — pure logic, no networking.
 *
 * Family: Hungarian trump "beating" game (rokon a durák/orosz családdal).
 * 2–4 players. See RULES below and README.md for the exact interpretation used.
 *
 * ── RULES IMPLEMENTED (v1) ────────────────────────────────────────────────
 *  • 32-card Hungarian deck. Deal 5 cards each.
 *  • Flip the next card: its SUIT is trump (adu). That card is placed at the
 *    BOTTOM of the talon (draw pile), so it is the very last card drawn.
 *  • Turn = one attacker vs one defender (the next active player clockwise).
 *  • Attacker plays ONE card. Defender must BEAT it (higher card of the same
 *    suit, or any trump; a higher trump beats a lower trump) or PICK IT UP.
 *      – Beaten: both cards go to the discard pile. Refill hands to 5 (attacker
 *        first, clockwise). The DEFENDER becomes the next attacker.
 *      – Taken: the attack card goes into the defender's hand. Refill. The
 *        attack passes to the player AFTER the defender (defender is skipped).
 *  • The trump VII may be swapped, on your attack turn, for the face-up trump
 *    card at the bottom of the talon.
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
    discard: [],
    attacker: 0,
    defender: 1,
    table: { attack: null, defense: null },
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

/** Draw one card from the top of the talon (talon end). */
function drawOne(state, player) {
  if (state.talon.length === 0) return false;
  player.hand.push(state.talon.pop());
  return true;
}

/** Refill hands to HAND_SIZE, attacker first, clockwise, while talon lasts. */
function refill(state) {
  const n = state.players.length;
  const order = [];
  for (let step = 0; step < n; step++) {
    order.push((state.attacker + step) % n);
  }
  for (const idx of order) {
    const p = state.players[idx];
    while (!p.finished && p.hand.length < HAND_SIZE && state.talon.length > 0) {
      drawOne(state, p);
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

/** Legal moves for a given player index (empty array if not their turn). */
function legalMoves(state, playerIndex) {
  const actor = currentActor(state);
  if (!actor || actor.player !== playerIndex) return [];
  const p = state.players[playerIndex];
  const moves = [];

  if (actor.role === 'attack') {
    // Optional: swap trump VII with the face-up trump card at bottom of talon.
    const trumpSeven = `${state.trumpSuit}-VII`;
    if (
      state.talon.length > 0 &&
      state.talon[0] === state.trumpCard &&
      state.trumpCard !== trumpSeven &&
      p.hand.includes(trumpSeven)
    ) {
      moves.push({ type: 'swap7' });
    }
    for (const card of p.hand) {
      moves.push({ type: 'attack', card });
    }
  } else {
    let canBeat = false;
    for (const card of p.hand) {
      if (beats(state.table.attack, card, state.trumpSuit)) {
        moves.push({ type: 'defend', card });
        canBeat = true;
      }
    }
    // Endgame rule: once the talon is empty you MUST beat if you can — no
    // voluntary pickups — otherwise cheap cards can circulate forever.
    if (!(state.talon.length === 0 && canBeat)) {
      moves.push({ type: 'take' });
    }
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
      state.talon.length === 0 ||
      state.talon[0] !== state.trumpCard ||
      state.trumpCard === trumpSeven ||
      !handHas(p, trumpSeven)
    ) {
      throw new Error('illegal:swap');
    }
    // Swap: take the face-up trump into hand, put our VII at the bottom.
    removeCard(p, trumpSeven);
    p.hand.push(state.trumpCard);
    state.talon[0] = trumpSeven;
    state.trumpCard = trumpSeven;
    pushLog(state, 'swap7', { player: playerIndex });
    return state; // still attacker's turn to actually attack
  }

  if (actor.role === 'attack') {
    if (move.type !== 'attack') throw new Error('illegal:expected_attack');
    const p = state.players[playerIndex];
    if (!handHas(p, move.card)) throw new Error('illegal:not_in_hand');
    removeCard(p, move.card);
    state.table.attack = move.card;
    state.table.defense = null;
    state.phase = 'defense';
    pushLog(state, 'attack', { player: playerIndex, card: move.card });
    return state;
  }

  // Defense phase.
  const defender = state.players[playerIndex];
  if (move.type === 'take') {
    // Enforce the "must beat if able" endgame rule.
    if (
      state.talon.length === 0 &&
      defender.hand.some((c) => beats(state.table.attack, c, state.trumpSuit))
    ) {
      throw new Error('illegal:must_beat');
    }
    defender.hand.push(state.table.attack);
    pushLog(state, 'take', { player: playerIndex, card: state.table.attack });
    const skipDefender = state.defender;
    resolveEndOfExchange(state, /*defenderBeat=*/ false, skipDefender);
    return state;
  }

  if (move.type === 'defend') {
    if (!handHas(defender, move.card)) throw new Error('illegal:not_in_hand');
    if (!beats(state.table.attack, move.card, state.trumpSuit)) {
      throw new Error('illegal:does_not_beat');
    }
    removeCard(defender, move.card);
    state.table.defense = move.card;
    pushLog(state, 'defend', {
      player: playerIndex,
      card: move.card,
      over: state.table.attack,
    });
    resolveEndOfExchange(state, /*defenderBeat=*/ true, state.defender);
    return state;
  }

  throw new Error('illegal:unknown_move');
}

/**
 * Clean up the table, refill, decide who attacks next, and check finishes.
 * @param defenderBeat  true if the defender beat the card, false if they took it
 * @param defenderIdx   the defender's seat index for this exchange
 */
function resolveEndOfExchange(state, defenderBeat, defenderIdx) {
  // Cards leave the table.
  if (defenderBeat) {
    if (state.table.attack) state.discard.push(state.table.attack);
    if (state.table.defense) state.discard.push(state.table.defense);
  }
  // (If taken, the attack card already went into the defender's hand.)
  state.table.attack = null;
  state.table.defense = null;
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
    // Defender took the card and is skipped -> next player after them leads.
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
    talonCount: state.talon.length,
    discardCount: state.discard.length,
    table: { attack: state.table.attack, defense: state.table.defense },
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
  // exported for tests
  beats,
  strength,
  cardSuit,
  cardRank,
};
