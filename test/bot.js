'use strict';

const assert = require('assert');
const {
  chooseMove,
  chooseClaudeMove,
  choosePreviousMove,
} = require('../game/bot');
const { createGame, currentActor, applyMove } = require('../game/engine');
const { cardSuit, strength } = require('../game/deck');

function defenseState() {
  return {
    players: [
      { hand: [], finished: false },
      { hand: ['piros-Asz', 'zold-Asz', 'makk-VIII'], finished: false },
    ],
    talon: [],
    discard: [],
    table: {
      slots: [
        { attack: 'piros-X', defense: null },
        { attack: 'makk-VII', defense: null },
      ],
    },
    attacker: 0,
    defender: 1,
    phase: 'defense',
    trumpSuit: 'makk',
    trumpCard: 'makk-Asz',
    turnCount: 10,
    knownHolds: [[], []],
  };
}

// The frozen Claude policy spends its only trump on the first card, leaving
// the second trump impossible to cover. The planner sees the whole exchange
// and preserves that trump for the slot only it can beat.
const planned = chooseMove(defenseState(), 1);
const claude = chooseClaudeMove(defenseState(), 1);
assert.deepStrictEqual(planned, { type: 'defend', slot: 0, card: 'piros-Asz' });
assert.deepStrictEqual(claude, { type: 'defend', slot: 0, card: 'makk-VIII' });

function attackState(hiddenHand, hiddenTalon) {
  return {
    players: [
      {
        hand: ['piros-VII', 'zold-VII', 'tok-X', 'piros-Felso', 'makk-IX'],
        finished: false,
      },
      { hand: hiddenHand, finished: false },
    ],
    talon: ['makk-Asz', ...hiddenTalon],
    discard: ['tok-VII', 'tok-VIII'],
    table: { slots: [] },
    attacker: 0,
    defender: 1,
    phase: 'attack',
    trumpSuit: 'makk',
    trumpCard: 'makk-Asz',
    turnCount: 4,
    knownHolds: [[], ['zold-Asz']],
  };
}

// Hidden-information firewall: changing only the opponent's unrevealed cards
// and the face-down talon must not influence the bot's choice. It may use hand
// sizes and knownHolds, because those are public.
const hiddenA = attackState(
  ['zold-Asz', 'piros-Asz', 'makk-Kiraly', 'tok-Felso', 'zold-IX'],
  ['piros-IX', 'tok-Kiraly', 'makk-VII']
);
const hiddenB = attackState(
  ['zold-Asz', 'tok-IX', 'piros-Kiraly', 'zold-X', 'makk-Felso'],
  ['makk-VII', 'piros-IX', 'tok-Kiraly']
);
assert.deepStrictEqual(chooseMove(hiddenA, 0), chooseMove(hiddenB, 0));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function previousState(seed, predicate) {
  const state = createGame(
    [
      { id: 'p0', name: 'P0', isBot: true },
      { id: 'p1', name: 'P1', isBot: true },
    ],
    mulberry32(seed)
  );
  let guard = 0;
  while (!predicate(state)) {
    assert(++guard <= 8000, `seed ${seed} did not reach the regression state`);
    const actor = currentActor(state);
    applyMove(state, actor.player, choosePreviousMove(state, actor.player));
  }
  return state;
}

// Regression from a real seeded game: the old pair bonus put a strong trump
// Alsó into a five-card early attack even though a trump-free lead existed.
const earlyAttack = previousState(
  8,
  (state) => state.phase === 'attack' && state.turnCount === 3
);
const oldAttack = choosePreviousMove(earlyAttack, earlyAttack.attacker);
const reservedAttack = chooseMove(earlyAttack, earlyAttack.attacker);
assert(
  oldAttack.cards.some(
    (card) => cardSuit(card) === earlyAttack.trumpSuit && strength(card) >= 3
  )
);
assert(
  reservedAttack.cards.every((card) => cardSuit(card) !== earlyAttack.trumpSuit)
);

// Another reproduced game: the previous planner spent trump Alsó even though
// a same-suit Felső could continue the defense. The guarded policy preserves
// the strong trump and chooses the ordinary beater.
const earlyDefense = previousState(
  6,
  (state) => state.phase === 'defense' && state.turnCount === 4
);
const oldDefense = choosePreviousMove(earlyDefense, earlyDefense.defender);
const reservedDefense = chooseMove(earlyDefense, earlyDefense.defender);
assert.deepStrictEqual(oldDefense, { type: 'defend', slot: 1, card: 'piros-Also' });
assert.deepStrictEqual(reservedDefense, { type: 'defend', slot: 2, card: 'makk-Felso' });

console.log(
  '✓ card bot plans defenses, ignores hidden cards, and preserves early trumps.'
);
