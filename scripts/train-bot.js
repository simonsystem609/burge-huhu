'use strict';

/**
 * Card-bot arena + trainer.
 *
 *   node scripts/train-bot.js                 evaluate current weights vs the
 *                                             frozen Claude bot and old bot
 *   node scripts/train-bot.js train [iters] [deals]
 *                                             evolve the weight vector through
 *                                             exploratory self-play, then
 *                                             validate on unseen seeded deals
 *
 * A "deal" is always raced twice with the policies swapping seats. Candidate
 * discovery uses seeded personality/temperature exploration; acceptance and
 * the final Claude race are deterministic and use disjoint seeds.
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

const STYLES = Object.keys(newBot.PERSONALITIES);

function weightedChooser(weights, seed, style, temp) {
  const policyRng = mulberry32(seed);
  return (state, player) =>
    newBot.chooseMove(state, player, weights, {
      style,
      temp,
      rng: policyRng,
    });
}

function claudeChooser(seed, style, temp) {
  const policyRng = mulberry32(seed);
  return (state, player) =>
    newBot.chooseClaudeMove(state, player, undefined, {
      style,
      temp,
      rng: policyRng,
    });
}

function resultRecord() {
  return { games: 0, wins: 0, losses: 0, draws: 0, points: 0 };
}

function recordResult(result, loser, candidateSeat) {
  result.games++;
  if (loser == null) {
    result.draws++;
    result.points += 0.35; // draws beat losing, but training should seek wins
  } else if (loser === candidateSeat) {
    result.losses++;
  } else {
    result.wins++;
    result.points += 1;
  }
}

function finishResult(result) {
  result.pointRate = result.points / result.games;
  const decisive = result.wins + result.losses;
  result.decisiveWinRate = decisive ? result.wins / decisive : 0;
  return result;
}

/**
 * Paired 2-player race. Each deck seed is played twice with policies swapping
 * seats. In exploration mode both policies receive the same rotating style
 * schedule and independent seeded temperature randomness.
 */
function head2head(wA, wB, deals, seedBase, explore = false) {
  const result = resultRecord();
  for (let deal = 0; deal < deals; deal++) {
    for (let aSeat = 0; aSeat < 2; aSeat++) {
      const style = explore ? STYLES[(seedBase + deal) % STYLES.length] : undefined;
      const temp = explore ? 0.35 : 0;
      const choosers = [];
      for (let seat = 0; seat < 2; seat++) {
        const weights = seat === aSeat ? wA : wB;
        choosers.push(
          weightedChooser(weights, seedBase * 17 + deal * 31 + seat, style, temp)
        );
      }
      const loser = playGame(choosers, mulberry32(seedBase + deal));
      recordResult(result, loser, aSeat);
    }
  }
  return finishResult(result);
}

/** Current policy against the exact pre-improvement Claude policy. */
function raceClaude(weights, deals, seedBase, explore = false, temperature) {
  const result = resultRecord();
  for (let deal = 0; deal < deals; deal++) {
    for (let candidateSeat = 0; candidateSeat < 2; candidateSeat++) {
      const style = explore ? STYLES[(seedBase + deal) % STYLES.length] : undefined;
      const temp = explore ? temperature ?? 0.35 : 0;
      const choosers = [];
      for (let seat = 0; seat < 2; seat++) {
        const seed = seedBase * 19 + deal * 37 + seat;
        choosers.push(
          seat === candidateSeat
            ? weightedChooser(weights, seed, style, temp)
            : claudeChooser(seed, style, temp)
        );
      }
      const loser = playGame(choosers, mulberry32(seedBase + deal));
      recordResult(result, loser, candidateSeat);
    }
  }
  return finishResult(result);
}

/** One current bot against a table of frozen Claude bots, rotating every seat. */
function multiplayerVsClaude(weights, seats, deals, seedBase) {
  let games = 0;
  let burge = 0;
  let draws = 0;
  for (let deal = 0; deal < deals; deal++) {
    for (let candidateSeat = 0; candidateSeat < seats; candidateSeat++) {
      const choosers = [];
      for (let seat = 0; seat < seats; seat++) {
        const seed = seedBase * 23 + deal * 41 + seat;
        choosers.push(
          seat === candidateSeat
            ? weightedChooser(weights, seed, undefined, 0)
            : claudeChooser(seed, undefined, 0)
        );
      }
      const loser = playGame(choosers, mulberry32(seedBase + deal));
      games++;
      if (loser == null) draws++;
      else if (loser === candidateSeat) burge++;
    }
  }
  return { games, burge, draws, burgeRate: burge / games };
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

const MUTABLE_KEYS = Object.keys(newBot.DEFAULT_WEIGHTS).filter(
  (key) => key !== 'finishBonus'
);

function normal(rand) {
  const u = Math.max(rand(), Number.EPSILON);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Mutate several coordinates by small log-normal factors. The old trainer
 * changed one weight by ×0.5/×2, which could only jump across much of the
 * useful search space. These smaller multi-feature mutations let genuinely
 * different strategies emerge without making most candidates nonsense.
 */
function mutate(weights, rand) {
  const candidate = { ...weights };
  const count = 1 + Math.floor(rand() * 3);
  const touched = new Set();
  while (touched.size < count) {
    touched.add(MUTABLE_KEYS[Math.floor(rand() * MUTABLE_KEYS.length)]);
  }
  for (const key of touched) {
    const factor = Math.exp(normal(rand) * 0.22);
    candidate[key] = Math.max(0.05, Math.min(200, candidate[key] * factor));
  }
  return { candidate, touched: [...touched] };
}

function percent(value) {
  return (value * 100).toFixed(1) + '%';
}

function printRace(label, result) {
  console.log(
    `${label}: ${result.wins}W/${result.losses}L/${result.draws}D ` +
      `(decisive ${percent(result.decisiveWinRate)}, points ${percent(result.pointRate)})`
  );
}

/**
 * Evolutionary league training with three gates:
 *  1. improve against frozen Claude under exploratory styles/temperature;
 *  2. confirm that improvement deterministically on disjoint seeds;
 *  3. remain non-inferior in a direct race against the current champion.
 *
 * The Claude gate prevents the cyclic self-play failure where a mutation
 * learns to exploit copies of itself but becomes easier for the old bot.
 */
function trainLoop(iters, deals) {
  const start = { ...newBot.DEFAULT_WEIGHTS };
  let best = { ...start };
  const rand = mulberry32(7654321);

  for (let it = 0; it < iters; it++) {
    const { candidate, touched } = mutate(best, rand);
    const discoverySeed = 100000 + it * 1009;
    const candidateDiscovery = raceClaude(
      candidate,
      deals,
      discoverySeed,
      true
    );
    const championDiscovery = raceClaude(best, deals, discoverySeed, true);
    if (
      candidateDiscovery.pointRate <= 0.5 ||
      candidateDiscovery.pointRate <= championDiscovery.pointRate + 0.015
    ) {
      continue;
    }

    const confirmSeed = 3000000 + it * 2003;
    const candidateConfirm = raceClaude(
      candidate,
      deals * 2,
      confirmSeed,
      false
    );
    const championConfirm = raceClaude(best, deals * 2, confirmSeed, false);
    if (
      candidateConfirm.pointRate <= 0.5 ||
      candidateConfirm.pointRate <= championConfirm.pointRate + 0.005
    ) {
      continue;
    }

    const direct = head2head(
      candidate,
      best,
      deals * 2,
      5000000 + it * 3001,
      false
    );
    if (direct.pointRate < 0.49) continue;

    best = candidate;
    console.log(
      `it ${String(it).padStart(3)} ACCEPT ${touched.join('+')} ` +
        `(Claude explore ${percent(candidateDiscovery.pointRate)}, ` +
        `confirm ${percent(candidateConfirm.pointRate)}, ` +
        `champion ${percent(direct.pointRate)})`
    );
    console.log(JSON.stringify(best));
  }

  console.log('\nUnseen validation');
  printRace('best vs starting policy', head2head(best, start, 1000, 7000000));
  printRace('best vs frozen Claude', raceClaude(best, 1000, 8000000));
  const old = vsOldBot(best, 1500, 500, 9000000);
  console.log(
    `best vs old bot: 2p wins ${percent(old.winRate2p)}, ` +
      `draws ${percent(old.drawRate2p)}, 4p bürge ${percent(old.burgeRate4p)}`
  );
  console.log('\nbest weights:\n' + JSON.stringify(best, null, 2));
}

function benchmark(deals) {
  console.log('Frozen benchmark: Claude policy from master 6d43539');
  printRace(
    'current vs frozen Claude (2p)',
    raceClaude(newBot.DEFAULT_WEIGHTS, deals, 11000000)
  );
  printRace(
    'current vs frozen Claude (2p live styles/temp)',
    raceClaude(newBot.DEFAULT_WEIGHTS, deals, 11500000, true, 0.6)
  );
  const three = multiplayerVsClaude(newBot.DEFAULT_WEIGHTS, 3, Math.ceil(deals / 4), 12000000);
  const four = multiplayerVsClaude(newBot.DEFAULT_WEIGHTS, 4, Math.ceil(deals / 4), 13000000);
  console.log(
    `current among Claude bots (3p): bürge ${percent(three.burgeRate)} ` +
      `(${three.burge}/${three.games}, random baseline 33.3%)`
  );
  console.log(
    `current among Claude bots (4p): bürge ${percent(four.burgeRate)} ` +
      `(${four.burge}/${four.games}, random baseline 25.0%)`
  );
  const old = vsOldBot(newBot.DEFAULT_WEIGHTS, deals * 2, deals, 14000000);
  console.log(
    `current vs old bot: 2p wins ${percent(old.winRate2p)}, ` +
      `draws ${percent(old.drawRate2p)}, 4p bürge ${percent(old.burgeRate4p)}`
  );
}

const cmd = process.argv[2];
if (cmd === 'train') {
  trainLoop(Number(process.argv[3]) || 40, Number(process.argv[4]) || 250);
} else {
  benchmark(Number(process.argv[3]) || 2000);
}
