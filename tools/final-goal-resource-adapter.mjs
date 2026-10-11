import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finalGoalClockProjection } from './final-goal-clock-projection.mjs';

function requireText(value, description) {
  assert.ok(typeof value === 'string' && value.trim(), description);
  return value;
}

function requireHash(value, description) {
  assert.ok(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), description);
}

function requireNonnegative(value, description) {
  assert.ok(Number.isFinite(value) && value >= 0, description);
}

/** Preserve the watchdog's opaque start token, normalizing only ps whitespace. */
export function watchdogProcessIdentity(namespace, processId, startIdentity) {
  requireText(namespace, 'Missing original process namespace');
  assert.ok(namespace === namespace.trim() && !namespace.includes('/'), 'Process namespace must be an exact non-path identity');
  assert.ok(Number.isSafeInteger(processId) && processId > 0, 'Invalid original process ID');
  const normalizedStart = requireText(startIdentity, 'Missing original process start identity').trim().replace(/\s+/g, ' ');
  assert.ok(!normalizedStart.includes('/'), 'Process start identity cannot contain a path separator');
  return { identity: `${namespace}/${processId}/${normalizedStart}`, namespace, processId, startIdentity: normalizedStart };
}

function lifecycleProcess(namespace, event) {
  assert.ok(event.process && typeof event.process === 'object', 'Missing lifecycle process provenance');
  return watchdogProcessIdentity(namespace, event.process.processId, event.process.startIdentity);
}

function watchdogProcess(namespace, process) {
  const original = watchdogProcessIdentity(namespace, process.process, process.started);
  assert.ok(Number.isSafeInteger(process.rssBytes) && process.rssBytes >= 0, 'Invalid original sampled RSS');
  requireNonnegative(process.cpuSeconds, 'Invalid original sampled CPU');
  return original;
}

function requireInterval(interval, description) {
  assert.ok(interval && Number.isFinite(interval.startMilliseconds) && Number.isFinite(interval.endMilliseconds)
    && interval.endMilliseconds > interval.startMilliseconds, description);
}

/** Read prospective ownership events without deriving lifecycle from reporter indexes or samples. */
function readLifecycle(lifecycle, captureInterval) {
  const owned = new Map();
  const activeProcesses = new Map();
  const latestProcesses = new Map();
  const workers = new Map();
  const missing = new Map();
  const remaining = new Set();
  const namespace = lifecycle.host.namespace;
  let previousTimestamp = -Infinity;
  assert.ok(Array.isArray(lifecycle.events), 'Missing prospective lifecycle events');
  for (const event of lifecycle.events) {
    const timestamp = event.timestampMilliseconds;
    assert.ok(Number.isFinite(timestamp) && timestamp >= previousTimestamp
      && timestamp >= captureInterval.startMilliseconds && timestamp <= captureInterval.endMilliseconds,
    'Lifecycle event is unordered or outside the original capture interval');
    previousTimestamp = timestamp;
    const process = lifecycleProcess(namespace, event);
    const registered = owned.get(process.identity);
    switch (event.type) {
      case 'process-owned': {
        assert.ok(!registered, 'Original process identity was registered more than once');
        assert.ok(!activeProcesses.has(process.processId), 'Reused PID still has an active original identity');
        const previousIdentity = latestProcesses.get(process.processId);
        if (previousIdentity) owned.get(previousIdentity).replacedMilliseconds = timestamp;
        assert.ok(Array.isArray(event.components) && event.components.length
          && new Set(event.components).size === event.components.length, 'Missing or duplicate process components');
        for (const component of event.components) requireText(component, 'Invalid process component');
        owned.set(process.identity, { ...process, components: [...event.components], registeredMilliseconds: timestamp });
        activeProcesses.set(process.processId, process.identity);
        latestProcesses.set(process.processId, process.identity);
        break;
      }
      case 'process-ended': {
        assert.ok(registered && registered.endedMilliseconds === undefined
          && activeProcesses.get(process.processId) === process.identity, 'Unknown or repeated original process ending');
        assert.ok(timestamp >= registered.registeredMilliseconds, 'Process ending precedes original registration');
        assert.ok(!remaining.has(process.identity), 'Terminal remaining process identity later ended');
        for (const worker of workers.values()) if (worker.hostProcessIdentity === process.identity)
          assert.ok(worker.endMilliseconds !== undefined && worker.endMilliseconds <= timestamp, 'Process ended with an unsettled logical worker');
        registered.endedMilliseconds = timestamp;
        activeProcesses.delete(process.processId);
        break;
      }
      case 'process-missing': {
        assert.ok(registered, 'Missing process has no original ownership provenance');
        requireText(event.reason, 'Missing process needs its original coverage reason');
        const reasons = missing.get(process.identity) ?? [];
        reasons.push({ timestampMilliseconds: timestamp, reason: event.reason });
        missing.set(process.identity, reasons);
        break;
      }
      case 'process-remaining': {
        assert.ok(registered && activeProcesses.get(process.processId) === process.identity
          && !remaining.has(process.identity), 'Remaining process identity is unknown, ended or repeated');
        remaining.add(process.identity);
        break;
      }
      case 'worker-started': {
        requireText(event.workerIdentity, 'Missing original logical worker identity');
        assert.ok(registered && activeProcesses.get(process.processId) === process.identity
          && registered.components.includes('workers'), 'Logical worker lacks its original active worker host');
        assert.ok(!workers.has(event.workerIdentity), 'Logical worker identity was reused');
        workers.set(event.workerIdentity, { identity: event.workerIdentity, hostProcessIdentity: process.identity,
          startMilliseconds: timestamp });
        break;
      }
      case 'worker-ended': {
        const worker = workers.get(event.workerIdentity);
        assert.ok(worker && worker.hostProcessIdentity === process.identity && worker.endMilliseconds === undefined
          && timestamp > worker.startMilliseconds, 'Conflicting, repeated or invalid logical worker ending');
        worker.endMilliseconds = timestamp;
        break;
      }
      default: assert.fail(`Unknown lifecycle event type: ${event.type}`);
    }
  }
  assert.ok(owned.size, 'Missing original process ownership');
  for (const worker of workers.values()) {
    requireInterval(worker, 'Logical worker has no complete original lifetime');
    assert.ok(worker.startMilliseconds >= lifecycle.clock.ownerInterval.startMilliseconds
      && worker.endMilliseconds <= lifecycle.clock.ownerInterval.endMilliseconds, 'Logical worker escapes complete owner interval');
  }
  return { owned, workers, missing, remaining };
}

function approximatelyEqual(left, right, count) {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, left, right) * Math.max(1, count) * 4;
}

/** Convert actual watchdog samples, preserving CPU maxima when zombie accounting resets. */
function readSamples(watchdog, lifecycle, owned) {
  assert.ok(Array.isArray(watchdog.samples) && watchdog.samples.length, 'Missing original watchdog samples');
  const cumulativeCpu = new Map();
  const cpuResets = [];
  let previousElapsed = -Infinity;
  let sampledConcurrentBytes = 0;
  const samples = watchdog.samples.map(sample => {
    requireNonnegative(sample.elapsedSeconds, 'Invalid watchdog sample timestamp');
    assert.ok(sample.elapsedSeconds >= previousElapsed && sample.elapsedSeconds <= watchdog.elapsedSeconds,
      'Watchdog sample is unordered or outside capture bounds');
    previousElapsed = sample.elapsedSeconds;
    const timestampMilliseconds = lifecycle.clock.watchdogOriginMilliseconds + sample.elapsedSeconds * 1000;
    assert.ok(Array.isArray(sample.processes), 'Missing original sampled processes');
    const seen = new Set();
    const seenProcessIds = new Set();
    let concurrentBytes = 0;
    const processes = sample.processes.map(rawProcess => {
      const process = watchdogProcess(lifecycle.host.namespace, rawProcess);
      const registered = owned.get(process.identity);
      assert.ok(registered, 'Observed process has no explicit ownership/component provenance');
      assert.ok(!seen.has(process.identity) && !seenProcessIds.has(process.processId), 'Duplicate or conflicting PID in one watchdog snapshot');
      seen.add(process.identity); seenProcessIds.add(process.processId);
      assert.ok(timestampMilliseconds >= registered.registeredMilliseconds, 'Process sample precedes prospective ownership registration');
      assert.ok(registered.replacedMilliseconds === undefined || timestampMilliseconds < registered.replacedMilliseconds,
        'Process sample conflicts with a later original PID generation');
      if (registered.endedMilliseconds !== undefined && timestampMilliseconds > registered.endedMilliseconds)
        assert.ok(typeof rawProcess.state === 'string' && /^[ZX]/.test(rawProcess.state), 'Live process observed after original ending');
      const previousCpu = cumulativeCpu.get(process.identity) ?? 0;
      if (rawProcess.cpuSeconds < previousCpu) cpuResets.push({ identity: process.identity, timestampMilliseconds,
        previousCpuSeconds: previousCpu, observedCpuSeconds: rawProcess.cpuSeconds, observedState: rawProcess.state ?? null });
      const cpuSeconds = Math.max(previousCpu, rawProcess.cpuSeconds);
      cumulativeCpu.set(process.identity, cpuSeconds);
      concurrentBytes += rawProcess.rssBytes;
      assert.ok(Number.isSafeInteger(concurrentBytes), 'Concurrent sampled RSS overflows');
      return { identity: process.identity, residentBytes: rawProcess.rssBytes, cpuSeconds };
    });
    assert.equal(sample.liveOwnedProcesses, processes.length, 'Watchdog sample process count differs from original snapshot');
    assert.equal(sample.concurrentRssBytes, concurrentBytes, 'Watchdog RSS summary differs from original snapshot');
    sampledConcurrentBytes = Math.max(sampledConcurrentBytes, concurrentBytes);
    return { timestampMilliseconds, processes };
  });
  return { samples, cumulativeCpu, cpuResets, sampledConcurrentBytes };
}

/**
 * Produce final-contract resource fields from retained watchdog bytes and prospective events.
 * Lifecycle input schema 1 contains provenance {sourceSha256, watchdogSha256}, host
 * {namespace, identitySha256}, clock {type:'monotonic', identity, watchdogOriginMilliseconds,
 * ownerInterval}, and ordered events. Every event has type, timestampMilliseconds and process
 * {processId, startIdentity}. process-owned adds components; worker-started/ended add
 * workerIdentity; process-missing adds reason. Optional process-ended/remaining retain custody.
 * The clock origin must be recorded prospectively by the controller, not reconstructed from
 * wall time. Hashes bind supplied evidence; independent source/clock/collector admission remains
 * external. This adapter neither records test/context identities nor grants acceptance.
 */
export function adaptFinalGoalResources({ watchdogReportBytes, lifecycle, collectorSha256, requiredResourceComponents }) {
  assert.ok(Buffer.isBuffer(watchdogReportBytes) || typeof watchdogReportBytes === 'string', 'Missing original watchdog report bytes');
  requireHash(collectorSha256, 'Missing collector source provenance');
  assert.equal(lifecycle?.schemaVersion, 1, 'Unknown lifecycle schema');
  requireHash(lifecycle.provenance?.sourceSha256, 'Missing lifecycle source provenance');
  requireHash(lifecycle.provenance?.watchdogSha256, 'Missing retained watchdog provenance');
  assert.equal(createHash('sha256').update(watchdogReportBytes).digest('hex'), lifecycle.provenance.watchdogSha256,
    'Retained watchdog bytes differ from lifecycle provenance');
  requireHash(lifecycle.host?.identitySha256, 'Missing original host identity');
  requireText(lifecycle.host?.namespace, 'Missing original process namespace');
  assert.equal(lifecycle.clock?.type, 'monotonic', 'Lifecycle must use an original monotonic clock');
  requireText(lifecycle.clock.identity, 'Missing original clock identity');
  assert.ok(Number.isFinite(lifecycle.clock.watchdogOriginMilliseconds), 'Missing original watchdog monotonic origin');
  requireInterval(lifecycle.clock.ownerInterval, 'Missing complete original owner interval');
  assert.ok(Array.isArray(requiredResourceComponents) && requiredResourceComponents.length
    && new Set(requiredResourceComponents).size === requiredResourceComponents.length, 'Missing required resource component policy');
  for (const component of requiredResourceComponents) requireText(component, 'Invalid required resource component');
  const watchdog = JSON.parse(watchdogReportBytes.toString());
  assert.equal(watchdog.schemaVersion, 2, 'Unknown watchdog schema');
  const watchdogClock = finalGoalClockProjection(watchdog.clock);
  assert.equal(lifecycle.clock.identity, watchdogClock.identity, 'Lifecycle clock differs from original watchdog capture');
  assert.equal(lifecycle.clock.watchdogOriginNanoseconds, watchdogClock.originNanoseconds, 'Lifecycle origin differs from original watchdog nanoseconds');
  assert.equal(lifecycle.clock.watchdogOriginMilliseconds, Number(BigInt(watchdogClock.originNanoseconds)) / 1e6,
    'Lifecycle millisecond origin differs from original watchdog nanoseconds');
  assert.equal(watchdog.cpuAccounting, 'maximum-per-observed-process-identity', 'Unknown watchdog CPU accounting');
  requireNonnegative(watchdog.elapsedSeconds, 'Invalid watchdog capture duration');
  assert.ok(watchdog.elapsedSeconds > 0 && Number.isSafeInteger(watchdog.exitCode), 'Missing terminal watchdog owner result');
  assert.equal(typeof watchdog.timedOut, 'boolean'); assert.equal(typeof watchdog.interrupted, 'boolean');
  requireText(watchdog.coverage, 'Missing original watchdog coverage limitations');
  const captureInterval = { startMilliseconds: lifecycle.clock.watchdogOriginMilliseconds,
    endMilliseconds: lifecycle.clock.watchdogOriginMilliseconds + watchdog.elapsedSeconds * 1000 };
  requireInterval(captureInterval, 'Invalid original capture interval');
  assert.ok(lifecycle.clock.ownerInterval.startMilliseconds >= captureInterval.startMilliseconds
    && lifecycle.clock.ownerInterval.endMilliseconds <= captureInterval.endMilliseconds, 'Complete owner interval escapes watchdog capture');
  const { owned, workers, missing, remaining } = readLifecycle(lifecycle, captureInterval);
  const observations = readSamples(watchdog, lifecycle, owned);
  assert.ok(observations.samples[0].timestampMilliseconds <= lifecycle.clock.ownerInterval.startMilliseconds
    && observations.samples.at(-1).timestampMilliseconds >= lifecycle.clock.ownerInterval.endMilliseconds,
  'Actual watchdog samples omit complete owner clock boundaries');
  assert.ok(Array.isArray(watchdog.processes), 'Missing original watchdog process aggregate');
  const aggregateIdentities = new Set();
  let originalCpuTotal = 0;
  for (const rawProcess of watchdog.processes) {
    const process = watchdogProcess(lifecycle.host.namespace, rawProcess);
    assert.ok(!aggregateIdentities.has(process.identity), 'Duplicate original process aggregate');
    aggregateIdentities.add(process.identity);
    assert.equal(rawProcess.cpuSeconds, observations.cumulativeCpu.get(process.identity), 'Process aggregate differs from original sampled CPU maxima');
    originalCpuTotal += rawProcess.cpuSeconds;
  }
  assert.equal(aggregateIdentities.size, observations.cumulativeCpu.size, 'Process aggregate omits original sampled identities');
  assert.equal(watchdog.observedProcessCount, aggregateIdentities.size, 'Watchdog aggregate process count differs');
  assert.equal(watchdog.maximumSampledConcurrentRssBytes, observations.sampledConcurrentBytes, 'Watchdog peak RSS differs from original samples');
  assert.equal(watchdog.observedCpuSeconds, originalCpuTotal, 'Watchdog cumulative CPU differs from original aggregate');
  const observedProcessTreeCpuSeconds = [...observations.cumulativeCpu.values()].reduce((total, value) => total + value, 0);
  assert.ok(approximatelyEqual(originalCpuTotal, observedProcessTreeCpuSeconds, aggregateIdentities.size), 'Sampled CPU differs from original aggregate');
  for (const [identity] of owned) if (!observations.cumulativeCpu.has(identity)) {
    const reasons = missing.get(identity) ?? [];
    reasons.push({ reason: 'Original owned process was never observed in a watchdog snapshot' });
    missing.set(identity, reasons);
  }
  for (const reset of observations.cpuResets) if (typeof reset.observedState !== 'string' || !/^[ZX]/.test(reset.observedState)) {
    const reasons = missing.get(reset.identity) ?? [];
    reasons.push({ timestampMilliseconds: reset.timestampMilliseconds, previousCpuSeconds: reset.previousCpuSeconds,
      observedCpuSeconds: reset.observedCpuSeconds, observedState: reset.observedState,
      reason: 'Original cumulative CPU counter regressed in a live or unknown process state; counter is unusable for comparable resource coverage' });
    missing.set(reset.identity, reasons);
  }
  // A later sample for a reused PID cannot supply an old logical worker's resource evidence.
  for (const worker of workers.values()) if (!observations.samples.some(sample => sample.timestampMilliseconds >= worker.startMilliseconds
    && sample.timestampMilliseconds <= worker.endMilliseconds && sample.processes.some(process => process.identity === worker.hostProcessIdentity))) {
    const reasons = missing.get(worker.hostProcessIdentity) ?? [];
    reasons.push({ workerIdentity: worker.identity, reason: 'Logical worker lifetime has no snapshot of its original host process' });
    missing.set(worker.hostProcessIdentity, reasons);
  }
  assert.ok(Array.isArray(watchdog.remainingObservedProcesses) && new Set(watchdog.remainingObservedProcesses).size === watchdog.remainingObservedProcesses.length,
    'Malformed remaining watchdog process IDs');
  assert.deepEqual([...remaining].map(identity => owned.get(identity).processId).sort((left, right) => left - right),
    [...watchdog.remainingObservedProcesses].sort((left, right) => left - right), 'Remaining PID lacks original lifecycle identity');
  assert.ok(Array.isArray(watchdog.cleanupSignals), 'Missing original watchdog cleanup signals');
  const missingRequiredComponents = requiredResourceComponents.filter(component => ![...owned.values()].some(process =>
    process.components.includes(component) && observations.cumulativeCpu.has(process.identity)));
  return {
    collectorSha256, ownerExitCode: watchdog.exitCode, timedOut: watchdog.timedOut, interrupted: watchdog.interrupted,
    watchdogClock, ownerInterval: structuredClone(lifecycle.clock.ownerInterval),
    captureInterval, ownedProcesses: [...owned.values()].map(({ identity, namespace, processId, startIdentity, components }) =>
      ({ identity, namespace, processId, startIdentity, components })),
    workerIntervals: [...workers.values()], samples: observations.samples,
    sampledConcurrentBytes: observations.sampledConcurrentBytes, observedProcessTreeCpuSeconds,
    missingRequiredProcessIdentities: [...missing.keys()], remainingOwnedProcesses: [...remaining],
    cleanupSignals: structuredClone(watchdog.cleanupSignals),
    provenance: { watchdogSha256: lifecycle.provenance.watchdogSha256, lifecycleSourceSha256: lifecycle.provenance.sourceSha256,
      hostIdentitySha256: lifecycle.host.identitySha256, clockIdentity: lifecycle.clock.identity },
    coverage: { originalWatchdogLimitations: watchdog.coverage, missingRequiredComponents,
      missingProcessObservations: [...missing].map(([identity, observations]) => ({ identity, observations })),
      cpuObservationResets: observations.cpuResets,
      limitations: ['Observed watchdog sampling can miss short-lived or reparented processes; absence of known gaps is not proof of complete coverage.',
        'The watchdog ps start token has platform precision limits; PID reuse with an identical start token cannot be distinguished by snapshots.',
        'CPU is maximum observed cumulative process time, not an interval delta or exact kernel tree accounting; owned-process and clock admission remain external.',
        'This conversion does not admit source, clock, instrumentation, test/context ownership or final performance acceptance.'] },
  };
}
