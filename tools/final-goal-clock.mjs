import assert from 'node:assert/strict';

/** Read the watchdog's native OS clock without rebasing a runtime-local timer. */
export async function createFinalGoalClock(watchdogClock) {
  const usesMachClock = process.platform === 'darwin' && process.arch === 'arm64';
  const usesLinuxClock = process.platform === 'linux' && process.arch === 'x64';
  assert.ok(usesMachClock || usesLinuxClock, 'Final clock capture requires macOS arm64 or Linux x64');
  const expectedImplementation = usesMachClock ? 'mach_absolute_time()' : 'clock_gettime(CLOCK_MONOTONIC)';
  assert.equal(process.versions.bun, '1.4.2', 'Final clock capture requires pinned Bun 1.4.2');
  const { schemaVersion, type, implementation, identity,
    originNanoseconds: originText, resolutionSeconds: originalResolutionSeconds } = watchdogClock ?? {};
  assert.equal(schemaVersion, 1, 'Missing original watchdog clock');
  assert.equal(type, 'monotonic');
  assert.equal(implementation, expectedImplementation, 'Watchdog uses a different OS clock');
  assert.match(identity ?? '', /^[a-f0-9]{32}$/, 'Invalid watchdog capture identity');
  assert.match(originText ?? '', /^(0|[1-9][0-9]{0,19})$/, 'Invalid original clock origin');
  assert.ok(Number.isFinite(originalResolutionSeconds) && originalResolutionSeconds > 0,
    'Missing original clock resolution');
  const originNanoseconds = BigInt(originText);
  const { dlopen, ptr } = await import('bun:ffi');
  const library = usesMachClock ? dlopen('/usr/lib/libSystem.B.dylib', {
    mach_absolute_time: { args: [], returns: 'u64' },
    mach_timebase_info: { args: ['ptr'], returns: 'i32' },
  }) : dlopen('libc.so.6', {
    clock_gettime: { args: ['i32', 'ptr'], returns: 'i32' },
    clock_getres: { args: ['i32', 'ptr'], returns: 'i32' },
  });
  try {
    let readNanoseconds;
    let nativeMetadata;
    let resolutionSeconds;
    if (usesMachClock) {
      const timebase = new Uint32Array(2);
      assert.equal(library.symbols.mach_timebase_info(ptr(timebase)), 0, 'Mach timebase query failed');
      const [numerator, denominator] = timebase;
      assert.ok(numerator > 0 && denominator > 0, 'Invalid Mach tick conversion');
      resolutionSeconds = numerator / denominator / 1_000_000_000;
      nativeMetadata = { domain: 'darwin-mach-absolute-time', numerator, denominator };
      readNanoseconds = () => {
        const ticks = library.symbols.mach_absolute_time();
        assert.equal(typeof ticks, 'bigint', 'Clock ABI must return exact unsigned ticks');
        return ticks * BigInt(numerator) / BigInt(denominator);
      };
    } else {
      // The admitted Linux x64 glibc ABI has two signed 64-bit longs in timespec.
      const timespec = new BigInt64Array(2);
      const clockIdentifier = 1; // Linux CLOCK_MONOTONIC, also used by Python's monotonic_ns.
      const decodeTimespec = () => {
        const [seconds, nanoseconds] = timespec;
        assert.ok(seconds >= 0n && nanoseconds >= 0n && nanoseconds < 1_000_000_000n,
          'Native clock returned an invalid timespec');
        return seconds * 1_000_000_000n + nanoseconds;
      };
      assert.equal(library.symbols.clock_getres(clockIdentifier, ptr(timespec)), 0,
        'Linux monotonic clock resolution query failed');
      const resolutionNanoseconds = decodeTimespec();
      assert.ok(resolutionNanoseconds > 0n, 'Invalid Linux monotonic resolution');
      resolutionSeconds = Number(resolutionNanoseconds) / 1_000_000_000;
      nativeMetadata = { domain: 'linux-clock-monotonic', clockIdentifier,
        resolutionNanoseconds: resolutionNanoseconds.toString() };
      readNanoseconds = () => {
        assert.equal(library.symbols.clock_gettime(clockIdentifier, ptr(timespec)), 0,
          'Linux monotonic clock query failed');
        return decodeTimespec();
      };
    }
    assert.ok(Math.abs(resolutionSeconds - originalResolutionSeconds)
      <= Number.EPSILON * Math.max(resolutionSeconds, originalResolutionSeconds),
    'Watchdog resolution differs from the native OS clock');
    let closed = false;
    let previousNanoseconds = originNanoseconds;
    function nowNanoseconds() {
      assert.ok(!closed, 'Final clock capture is closed');
      const timestamp = readNanoseconds();
      assert.ok(timestamp >= previousNanoseconds, 'Native clock precedes its original origin or regressed');
      previousNanoseconds = timestamp;
      return timestamp;
    }
    nowNanoseconds();
    return Object.freeze({
      metadata: Object.freeze({ schemaVersion: 1, captureIdentity: identity,
        ...nativeMetadata, implementation: expectedImplementation,
        originNanoseconds: originText,
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
