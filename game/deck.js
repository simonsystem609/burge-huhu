'use strict';

/**
 * Hungarian card deck (magyar kártya) — 32 cards.
 *
 * Suits (színek):  tok (Tök), makk (Makk), zold (Zöld), piros (Piros)
 * Ranks (értékek), weakest -> strongest:
 *   VII, VIII, IX, X, Also (Alsó), Felso (Felső), Kiraly (Király), Asz (Ász)
 *
 * A card is stored as a compact id string "suit-rank", e.g. "tok-VII", "piros-Asz".
 */

const SUITS = ['tok', 'makk', 'zold', 'piros'];

// Ordered from weakest to strongest. Index = strength.
const RANKS = ['VII', 'VIII', 'IX', 'X', 'Also', 'Felso', 'Kiraly', 'Asz'];

const RANK_STRENGTH = RANKS.reduce((acc, r, i) => {
  acc[r] = i;
  return acc;
}, {});

function makeCard(suit, rank) {
  return `${suit}-${rank}`;
}

function parseCard(card) {
  const idx = card.indexOf('-');
  return { suit: card.slice(0, idx), rank: card.slice(idx + 1) };
}

function cardSuit(card) {
  return card.slice(0, card.indexOf('-'));
}

function cardRank(card) {
  return card.slice(card.indexOf('-') + 1);
}

function strength(card) {
  return RANK_STRENGTH[cardRank(card)];
}

/** Build the full 32-card deck. */
function fullDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push(makeCard(s, r));
    }
  }
  return deck;
}

/** Fisher–Yates shuffle (in place), returns the same array. */
function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Does `defense` beat `attack`, given the trump suit?
 *  - same suit: higher rank wins
 *  - trump beats any non-trump
 *  - higher trump beats lower trump
 */
function beats(attack, defense, trumpSuit) {
  const aSuit = cardSuit(attack);
  const dSuit = cardSuit(defense);
  if (dSuit === aSuit) {
    return strength(defense) > strength(attack);
  }
  if (dSuit === trumpSuit && aSuit !== trumpSuit) {
    return true;
  }
  return false;
}

module.exports = {
  SUITS,
  RANKS,
  RANK_STRENGTH,
  makeCard,
  parseCard,
  cardSuit,
  cardRank,
  strength,
  fullDeck,
  shuffle,
  beats,
};
