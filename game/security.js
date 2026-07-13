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

  function check(key) {
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
  }

  // Pruning inside check() only shrinks an entry's own array; a key that's
  // never looked up again (a one-off visitor's socket id or IP) would
  // otherwise sit in `hits` forever. Sweep out fully-expired keys so a
  // long-running server's memory use stays bounded by active traffic, not
  // by every distinct key it has ever seen.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, arr] of hits) {
      if (!arr.length || now - arr[arr.length - 1] > windowMs) hits.delete(key);
    }
  }, Math.max(windowMs, 60 * 1000));
  sweep.unref();

  check._hits = hits; // exposed for tests only
  return check;
}

module.exports = { validateName, validateClientId, socketRateLimiter };
