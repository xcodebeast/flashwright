const { join } = require('node:path');
const modules = process.env.FLASHWRIGHT_COORDINATOR_MODULES;
const requireLibrary = require('node:module').createRequire(join(modules, 'index.js'));
const runtime = join(modules, '../upstream');
const { _baseTest: base } = require(join(runtime, 'test.js'));
const { chromium } = requireLibrary('@flashwright/core');
const { runnerIntegration } = requireLibrary('@flashwright/core/runner-integration');
if (process.env.FLASHWRIGHT_COORDINATOR_PUBLIC === '1') {
  const { test, expect } = requireLibrary('@flashwright/test');
  module.exports = { test, expect, chromium, runnerIntegration };
} else {
  const { RunnerArtifactCoordinator } = require(join(modules, 'runner-artifact-coordinator.js'));
  const coordinator = new RunnerArtifactCoordinator();
  require(join(runtime, 'flashwright-hooks.cjs')).installTraceStart(information => coordinator.start(information));

  const test = base.extend({
    _workerArtifacts: [async ({}, use) => {
      await coordinator.ready();
      try { await use(); } finally { await coordinator.dispose(); }
    }, { scope: 'worker', auto: true }],
    _testArtifacts: [async ({}, use) => { await coordinator.ready(); await use(); }, { auto: 'all-hooks-included' }],
    trace: ['on', { scope: 'worker', option: true }],
    screenshot: ['off', { scope: 'worker', option: true }],
    _screenshots: [async ({ screenshot }, use) => {
      const scopes = coordinator.configureScreenshots({ mode: screenshot, options: {} });
      await coordinator.ready(); await use(scopes);
    }, { scope: 'worker', auto: true }],
    _scopeScreenshots: [async ({ _screenshots }, use, information) => {
      const recording = _screenshots?.start(information);
      try { await use(); } finally { if (recording) await _screenshots.finish(recording); }
    }, { auto: 'all-hooks-included', timeout: 0 }],
  });
  module.exports = { test, coordinator, chromium, runnerIntegration };
}
