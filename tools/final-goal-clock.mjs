import assert from 'node:assert/strict';

/** Read the watchdog's macOS clock directly, without rebasing a runtime-local timer. */
export async function createFinalGoalClock(watchdogClock) {
  assert.equal(process.platform, 'darwin', 'Final clock capture is admitted only on macOS');
  assert.equal(process.arch, 'arm64', 'Final clock capture is admitted only on arm64');
  assert.equal(process.versions.bun, '1.4.2', 'Final clock capture requires pinned Bun 1.4.2');
  const { schemaVersion, type, implementation, identity,
    originNanoseconds: originText, resolutionSeconds: originalResolutionSeconds } = watchdogClock ?? {};
  assert.equal(schemaVersion, 1, 'Missing original watchdog clock');
  assert.equal(type, 'monotonic');
  assert.equal(implementation, 'mach_absolute_time()', 'Watchdog uses a different OS clock');
  assert.match(identity ?? '', /^[a-f0-9]{32}$/, 'Invalid watchdog capture identity');
  assert.match(originText ?? '', /^(0|[1-9][0-9]{0,19})$/, 'Invalid original clock origin');
  assert.ok(Number.isFinite(originalResolutionSeconds) && originalResolutionSeconds > 0,
    'Missing original clock resolution');
  const originNanoseconds = BigInt(originText);
  const { dlopen, ptr } = await import('bun:ffi');
  const library = dlopen('/usr/lib/libSystem.B.dylib', {
    mach_absolute_time: { args: [], returns: 'u64' },
    mach_timebase_info: { args: ['ptr'], returns: 'i32' },
  });
  try {
    const timebase = new Uint32Array(2);
    assert.equal(library.symbols.mach_timebase_info(ptr(timebase)), 0, 'Mach timebase query failed');
    const [numerator, denominator] = timebase;
    assert.ok(numerator > 0 && denominator > 0, 'Invalid Mach tick conversion');
    const resolutionSeconds = numerator / denominator / 1_000_000_000;
    assert.ok(Math.abs(resolutionSeconds - originalResolutionSeconds)
      <= Number.EPSILON * Math.max(resolutionSeconds, originalResolutionSeconds),
    'Watchdog resolution differs from the native Mach timebase');
    let closed = false;
    let previousNanoseconds = originNanoseconds;
    function nowNanoseconds() {
      assert.ok(!closed, 'Final clock capture is closed');
      const ticks = library.symbols.mach_absolute_time();
      assert.equal(typeof ticks, 'bigint', 'Clock ABI must return exact unsigned ticks');
      const timestamp = ticks * BigInt(numerator) / BigInt(denominator);
      assert.ok(timestamp >= previousNanoseconds, 'Native clock precedes its original origin or regressed');
      previousNanoseconds = timestamp;
      return timestamp;
    }
    nowNanoseconds();
    return Object.freeze({
      metadata: Object.freeze({ schemaVersion: 1, captureIdentity: identity,
        domain: 'darwin-mach-absolute-time', implementation: 'mach_absolute_time()',
        originNanoseconds: originText, numerator, denominator,
        scope: 'Same-host same-boot clock only; host/boot and ownership admission remain external' }),
      nowNanoseconds,
      close() {
        if (closed) return;
        closed = true;
        library.close();
      },
    });
  } catch (error) {
    library.close();
    throw error;
  }
}
