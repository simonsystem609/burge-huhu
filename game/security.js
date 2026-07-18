'use strict';

/**
 * Small, dependency-free guards shared by both games' socket handlers:
 * payload/input validation and sliding-window rate limiters for spam-prone
 * socket events (room creation, matchmaking, and gameplay actions).
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

/** True only for object literals (including objects with a null prototype). */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Register a payload-bearing event without ever passing a non-plain value to
 * a destructuring handler. Malformed payloads are ignored: they cannot mutate
 * state, emit an error flood, or reach application validation/rate limiting.
 */
function onObjectEvent(socket, event, handler) {
  socket.on(event, (payload) => {
    if (!isPlainObject(payload)) return;
    handler(payload);
  });
}

/**
 * Returns a `check(key)` function: true if this call is within the limit
 * (and counts against it), false if the key has exceeded `max` calls within
 * `windowMs`. An entry is pruned lazily when its key is checked, and a periodic
 * unref'd sweep removes inactive keys that are never checked again.
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

/**
 * Combines a per-socket burst limit with a looser per-IP ceiling. Separate
 * sockets behind one NAT retain independent normal-play bursts, while the IP
 * ceiling still prevents reconnecting from resetting the abuse budget.
 */
function socketAndIpRateLimiter(socketMax, ipMax, windowMs) {
  const perSocket = socketRateLimiter(socketMax, windowMs);
  const perIp = socketRateLimiter(ipMax, windowMs);

  function check(socketId, ip) {
    if (!perSocket(socketId)) return false;
    return perIp(ip);
  }

  check._perSocket = perSocket; // exposed for tests only
  check._perIp = perIp; // exposed for tests only
  return check;
}

module.exports = {
  validateName,
  validateClientId,
  isPlainObject,
  onObjectEvent,
  socketRateLimiter,
  socketAndIpRateLimiter,
};
