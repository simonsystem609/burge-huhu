'use strict';

/**
 * Local training-data logger for card games with at least one human seat.
 *
 * Every game is written as JSONL to logs/cardgames-YYYY-MM-DD.jsonl:
 *   {t:'start', id, seats, state}   full initial state — hands + talon order
 *   {t:'move',  id, seat, human, move}   every applied move, in order
 *   {t:'end',   id, loser, finishedOrder, turns}
 * Initial state + the move list make the whole game exactly replayable, so
 * human decisions can be studied / trained against later.
 *
 * Enabled on localhost by default; DISABLED on Render (which sets RENDER=1)
 * so the deployed server never writes logs. Override with GAME_LOG=1 / 0.
 */

const fs = require('fs');
const path = require('path');

const ENABLED =
  process.env.GAME_LOG === '1' ||
  (!process.env.RENDER && process.env.GAME_LOG !== '0');

const DIR = path.join(__dirname, '..', 'logs');

let counter = 0;

function logFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(DIR, `cardgames-${day}.jsonl`);
}

function write(rec) {
  if (!ENABLED) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(rec) + '\n');
  } catch (_) {
    /* logging must never break the game */
  }
}

function hasHuman(room) {
  return room.seats.some((s) => !s.isBot);
}

function logStart(room) {
  if (!ENABLED || !room.game || !hasHuman(room)) return;
  counter += 1;
  room._logId = Date.now().toString(36) + '-' + counter;
  write({
    t: 'start',
    id: room._logId,
    ts: new Date().toISOString(),
    code: room.code,
    seats: room.seats.map((s) => ({ name: s.name, isBot: s.isBot, style: s.style || null })),
    state: {
      hands: room.game.players.map((p) => [...p.hand]),
      talon: [...room.game.talon],
      trumpCard: room.game.trumpCard,
      trumpSuit: room.game.trumpSuit,
      attacker: room.game.attacker,
      defender: room.game.defender,
    },
  });
}

function logMove(room, seatIdx, move) {
  if (!ENABLED || !room._logId || !room.game) return;
  const seat = room.seats[seatIdx];
  write({
    t: 'move',
    id: room._logId,
    seat: seatIdx,
    human: seat ? !seat.isBot : false,
    move,
  });
  if (room.game.phase === 'over') {
    write({
      t: 'end',
      id: room._logId,
      loser: room.game.loser,
      finishedOrder: [...room.game.finishedOrder],
      turns: room.game.turnCount,
    });
    room._logId = null;
  }
}

module.exports = { logStart, logMove, ENABLED };
