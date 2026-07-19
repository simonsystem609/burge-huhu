'use strict';

/**
 * Seat-resume authentication. The browser-visible clientId only *identifies*
 * a returning player; it travels with every join/create payload and could be
 * observed or guessed given enough exposure. Holding a seat must therefore be
 * proven by a separate secret: a server-issued random resume token, handed to
 * exactly one browser at seat claim, required alongside the clientId to
 * resume, rotated on every successful recovery, and dropped the moment the
 * seat is abandoned or reassigned.
 *
 * Tokens are 256-bit random values stored on the seat itself (seats are pure
 * in-memory state, so there is no cross-restart persistence to sign for —
 * unguessable-and-stored gives the same guarantee a signature would with less
 * machinery). Rotation keeps a one-token grace window so a second connection
 * drop mid-handoff can never lock the real owner out: the previous token
 * stays valid for ROTATION_GRACE_MS after each rotation.
 */

const crypto = require('crypto');

const ROTATION_GRACE_MS = 60 * 1000;
// base64url of 32 random bytes is 43 chars; accept a sane band around that
// so the format check itself can't become a compatibility trap.
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Compare via fixed-length digests: timingSafeEqual demands equal lengths,
// and hashing first makes the comparison length-independent of the input.
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

/** Mint the seat's resume secret (fresh claim — no grace carry-over). Returns the token to send to the owner. */
function issueSeatToken(seat) {
  const token = newToken();
  seat.resumeToken = token;
  seat.resumeTokenPrev = null;
  seat.resumeTokenPrevExpiry = 0;
  return token;
}

/** True only if `token` proves ownership of `seat`: the current secret, or the pre-rotation one still inside its grace window. */
function verifySeatToken(seat, token, now = Date.now()) {
  if (!seat || typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  if (seat.resumeToken && tokensEqual(token, seat.resumeToken)) return true;
  return !!(
    seat.resumeTokenPrev &&
    now < (seat.resumeTokenPrevExpiry || 0) &&
    tokensEqual(token, seat.resumeTokenPrev)
  );
}

/** Rotate after a successful resume; the outgoing token stays valid for `graceMs`. Returns the fresh token. */
function rotateSeatToken(seat, now = Date.now(), graceMs = ROTATION_GRACE_MS) {
  const fresh = newToken();
  if (seat.resumeToken) {
    seat.resumeTokenPrev = seat.resumeToken;
    seat.resumeTokenPrevExpiry = now + graceMs;
  }
  seat.resumeToken = fresh;
  return fresh;
}

/** Drop every resume credential from a seat (abandon, botify-for-good, removal). */
function clearSeatToken(seat) {
  if (!seat) return;
  seat.resumeToken = null;
  seat.resumeTokenPrev = null;
  seat.resumeTokenPrevExpiry = 0;
}

module.exports = {
  issueSeatToken,
  verifySeatToken,
  rotateSeatToken,
  clearSeatToken,
  ROTATION_GRACE_MS,
};
