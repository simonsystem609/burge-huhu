'use strict';

/**
 * Small, dependency-free guards shared by both games' socket handlers:
 * input sanitizing (name / clientId) and a per-key sliding-window rate
 * limiter for spam-prone socket events (room creation, matchmaking).
 */

const NAME_MAX = 40;
const CLIENT_ID_MAX = 100;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Trims and caps a display name; returns '' if empty/invalid so callers can fall back to their own default. */
function validateName(name) {
  const trimmed = String(name || '').trim().slice(0, NAME_MAX);
  return trimmed;
}

/** A client-generated id must be a short, plain alphanumeric/hyphen token — otherwise treat as absent. */
function validateClientId(clientId) {
  if (typeof clientId !== 'string') return null;
  if (clientId.length === 0 || clientId.length > CLIENT_ID_MAX) return null;
  if (!CLIENT_ID_RE.test(clientId)) return null;
  return clientId;
}

/**
 * Returns a `check(key)` function: true if this call is within the limit
 * (and counts against it), false if the key has exceeded `max` calls within
 * `windowMs`. Old entries are pruned lazily on access, so this never grows
 * unbounded even without an explicit cleanup timer.
 */
function socketRateLimiter(max, windowMs) {
  const hits = new Map(); // key -> timestamps[]

  return function check(key) {
    const now = Date.now();
    let arr = hits.get(key);
    if (!arr) {
      arr = [];
      hits.set(key, arr);
    }
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  };
}

module.exports = { validateName, validateClientId, socketRateLimiter };
