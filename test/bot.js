'use strict';

const assert = require('assert');
const { chooseMove, chooseClaudeMove } = require('../game/bot');

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

console.log('✓ card bot plans full defenses and ignores hidden card identities.');
