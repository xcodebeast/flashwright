import assert from 'node:assert/strict';

/** Validate actual launch logs; only the independently owned temporary profile path may differ. */
export function launchArguments(diagnostics, engine, executablePath) {
  const marker = engine === 'flashwright' ? 'flashwright:browser <launching> ' : 'pw:browser <launching> ';
  const lines = diagnostics.split('\n').filter(line => line.includes(marker));
  assert.equal(lines.length, 1, `Expected exactly one ${engine} browser launch`);
  const launch = lines[0].slice(lines[0].indexOf(marker) + marker.length);
  let arguments_;
  if (engine === 'flashwright') {
    const record = JSON.parse(launch);
    assert.equal(record.executable, executablePath);
    arguments_ = record.arguments;
  } else {
    assert.ok(launch.startsWith(executablePath + ' '), 'Reference browser path differs');
    arguments_ = launch.slice(executablePath.length + 1).split(' ');
  }
  assert.equal(arguments_.filter(argument => argument.startsWith('--user-data-dir=')).length, 1);
  return arguments_.map(argument => argument.startsWith('--user-data-dir=') ? '--user-data-dir=__FLASHWRIGHT_PROFILE__' : argument);
}

export function verifyLaunch(result, configuration, policy, executablePath) {
  assert.equal(result.processExit.code, 0);
  assert.equal(result.browserVersion, configuration.browserVersion);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(launchArguments(result.diagnostics, result.engine, executablePath), configuration.headless ? policy.headless : policy.headed);
  assert.equal(result.workloads.length, configuration.workloads.length);
  assert.deepEqual([...result.workloads.map(workload => workload.name)].sort(), [...configuration.workloads].sort());
  const iterations = configuration.warmupIterations + configuration.measuredIterations;
  for (const workload of result.workloads) {
    assert.deepEqual(workload.failures, []);
    assert.equal(workload.samples.length, configuration.measuredIterations);
    assert.equal(workload.warmupSamples.length, configuration.warmupIterations);
    assert.ok([...workload.samples, ...workload.warmupSamples].every(sample => Number.isFinite(sample.milliseconds) && sample.milliseconds > 0));
    assert.ok(workload.completeMilliseconds >= workload.preparationMilliseconds + workload.samples.reduce((sum, sample) => sum + sample.milliseconds, 0));
    if (workload.name === 'setup') {
      assert.equal(workload.observations.freshContexts, iterations);
    } else {
      assert.equal(workload.observations.untrustedClicks, 0);
      assert.equal(workload.observations.untrustedChanges, 0);
      assert.equal(workload.observations.trustedClicks, ['interaction', 'backend'].includes(workload.name) ? iterations : 0);
      assert.equal(workload.observations.trustedChanges, workload.name === 'backend' ? iterations : 0);
      assert.equal(workload.observations.applicationCount, workload.name === 'interaction' ? iterations : 0);
    }
  }
  assert.equal(result.backend.backendRequests, iterations);
  assert.equal(result.backend.documents, iterations * 2 + configuration.workloads.length - 1);
  assert.equal(result.resources.exitCode, 0);
  assert.equal(result.resources.timedOut, false);
  assert.equal(result.resources.interrupted, false);
  assert.deepEqual(result.resources.remainingObservedProcesses, []);
  assert.deepEqual(result.resources.cleanupSignals, [], 'A successful engine must clean up without watchdog signals');
}
