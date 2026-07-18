'use strict';

/**
 * Create a tiny per-key timer scheduler. Repeated schedule attempts for the
 * same key are ignored until the pending callback starts, while callbacks may
 * safely schedule the next step for that key.
 */
function createKeyedScheduler(setTimer = setTimeout, clearTimer = clearTimeout) {
  const pending = new Map();

  function schedule(key, delay, task) {
    if (pending.has(key)) return false;
    const handle = setTimer(() => {
      pending.delete(key);
      task();
    }, delay);
    pending.set(key, handle);
    return true;
  }

  function cancel(key) {
    const handle = pending.get(key);
    if (handle === undefined) return false;
    pending.delete(key);
    clearTimer(handle);
    return true;
  }

  return {
    schedule,
    cancel,
    hasPending: (key) => pending.has(key),
  };
}

module.exports = { createKeyedScheduler };
