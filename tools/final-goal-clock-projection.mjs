import assert from 'node:assert/strict';

/** Preserve the supervisor's original clock identity without reconstructing its origin. */
export function finalGoalClockProjection(clock) {
  assert.equal(clock?.schemaVersion, 1, 'Missing original watchdog clock');
  assert.equal(clock.type, 'monotonic', 'Watchdog must use an original monotonic clock');
  assert.ok(typeof clock.implementation === 'string' && clock.implementation.trim(), 'Missing watchdog clock implementation');
  assert.match(clock.identity ?? '', /^[a-f0-9]{32}$/, 'Invalid watchdog capture identity');
  assert.match(clock.originNanoseconds ?? '', /^(0|[1-9][0-9]{0,19})$/, 'Invalid original watchdog clock origin');
  assert.ok(Number.isFinite(clock.resolutionSeconds) && clock.resolutionSeconds > 0, 'Missing original watchdog clock resolution');
  return { schemaVersion: clock.schemaVersion, type: clock.type, implementation: clock.implementation,
    identity: clock.identity, originNanoseconds: clock.originNanoseconds, resolutionSeconds: clock.resolutionSeconds };
}
