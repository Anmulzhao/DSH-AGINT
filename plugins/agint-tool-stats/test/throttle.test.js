/**
 * agint-tool-stats throttle.test.js — throttle logic unit test.
 * Simulates checkThrottle behavior in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const THROTTLE_PER_HOUR = 5;
function makeThrottle() {
  let windowStart = Date.now();
  let count = 0;
  return {
    check() {
      const now = Date.now();
      if (now - windowStart > 3600_000) {
        windowStart = now;
        count = 0;
      }
      if (count >= THROTTLE_PER_HOUR) {
        const waitMin = Math.ceil((3600_000 - (now - windowStart)) / 60_000);
        throw new Error(`throttled (${THROTTLE_PER_HOUR}/hour reached). Wait ~${waitMin} min`);
      }
      count++;
    },
    get count() { return count; },
  };
}

test('throttle: allows up to limit then blocks', () => {
  const t = makeThrottle();
  for (let i = 0; i < 5; i++) t.check();
  assert.equal(t.count, 5);
  assert.throws(() => t.check(), /throttled/);
});

test('throttle: resets after window', () => {
  let fakeNow = Date.now();
  const origNow = Date.now;
  Date.now = () => fakeNow;
  try {
    const t = makeThrottle();
    for (let i = 0; i < 5; i++) t.check();
    assert.throws(() => t.check(), /throttled/);
    fakeNow += 3600_001; // jump 1 hour
    t.check(); // should succeed after window reset
    assert.equal(t.count, 1);
  } finally {
    Date.now = origNow;
  }
});