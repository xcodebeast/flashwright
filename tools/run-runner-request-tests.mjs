import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHttpFixture } from './http-fixture.mjs';
import { runtimeArtifactLabel, runtimeMetadata } from './javascript-runtime.mjs';

const retryPairsOnly = process.argv.includes('--retry-pairs-only');
const driver = process.env.FLASHWRIGHT_DRIVER_PATH;
assert.ok(driver, 'Select a verified native driver with FLASHWRIGHT_DRIVER_PATH');
const destination = resolve(`compatibility/evidence/runner-request-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = [
  'packages/flashwright-core/src/index.ts', 'packages/flashwright-core/src/api-request.ts',
  'packages/flashwright-core/src/runner-context-defaults.ts', 'packages/flashwright-core/src/runner-request-lifecycle.ts',
  'packages/flashwright-runner/src/index.ts', 'packages/flashwright-runner/src/upstream-runtime.ts',
  'packages/flashwright-runner/src/runner-artifact-coordinator.ts',
  'packages/flashwright-runner/src/request-fixture-owner.ts', 'packages/flashwright-core/src/tracing.ts',
  'compatibility/m2/runner-request/request.spec.ts', 'compatibility/m2/runner-request/playwright.config.ts',
  'compatibility/m2/runner-request/lifecycle.spec.ts', 'compatibility/m2/runner-request/public-types.ts',
  'compatibility/m2/runner-request/late-creation.spec.ts',
  'tools/run-runner-request-tests.mjs', 'tools/test-public-request-ownership.mjs', 'tools/http-fixture.mjs', 'tools/watchdog.py',
];
async function sourceIdentity() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(path))])));
}
const report = {
  status: 'running', selection: retryPairsOnly ? 'retry-pairs-only' : 'full-matrix', referenceVersion: '1.60.0', ...runtimeMetadata,
  driverSha256: hash(await readFile(driver)), sources: await sourceIdentity(), outcomes: {},
  scope: 'Public standalone request fixture/defaults, hooks, failure/timeout disposal, late native publication and successor ownership, fresh retry jars, real native HTTP, request-only browser guards. Scoped source identity; no application admission, packed-platform, transport-fault, complete artifact, or performance claim.',
};
const ledger = [];
const pendingTimers = new Set();
let currentEngine;
const fixture = createHttpFixture((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  const details = {
    engine: currentEngine,
    method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
    userAgent: request.headers['user-agent'] ?? '', cookie: request.headers.cookie ?? '',
  };
  ledger.push(details);
  if (url.pathname === '/never') return;
  if (url.pathname === '/delay') {
    const timer = setTimeout(() => { pendingTimers.delete(timer); response.end('delayed'); }, 240);
    pendingTimers.add(timer);
    response.once('close', () => { clearTimeout(timer); pendingTimers.delete(timer); });
  } else if (url.pathname === '/html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<p>Mail: blåbær ✓</p>');
  } else if (url.pathname === '/missing') {
    response.statusCode = 404;
    response.end('No email');
  } else if (url.pathname === '/inspect' || url.pathname === '/set-cookie') {
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/set-cookie') response.setHeader('set-cookie', 'changed=fixture; Path=/');
    response.end(JSON.stringify(details));
  } else {
    response.statusCode = 500;
    response.end('Unexpected request fixture endpoint');
  }
});

async function artifactIdentity(directory) {
  const files = {};
  async function visit(currentDirectory) {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files[relative(directory, path)] = { bytes: bytes.length, sha256: hash(bytes) };
      }
    }
  }
  await visit(directory);
  return files;
}

async function run(engine, directory, origin, storagePath, mode) {
  const resourcePath = join(directory, 'resources.json');
  const resultPath = join(directory, 'results.json');
  const executable = engine === 'playwright' ? 'node_modules/playwright/cli.js' : 'packages/flashwright-test/cli.cjs';
  const child = spawn('python3', [
    'tools/watchdog.py', '--timeout', '180', '--report', resourcePath, '--',
    process.execPath, executable, 'test', '--config', join(directory, 'playwright.config.ts'),
    '--output', join(directory, 'test-results'),
  ], {
    stdio: 'inherit',
    env: { ...process.env, FLASHWRIGHT_DRIVER_PATH: driver, FLASHWRIGHT_REQUEST_ENGINE: engine,
      FLASHWRIGHT_REQUEST_ORIGIN: origin, FLASHWRIGHT_REQUEST_STORAGE: storagePath,
      FLASHWRIGHT_REQUEST_RESULTS: resultPath, FLASHWRIGHT_REQUEST_LIFECYCLE_MODE: mode,
      FLASHWRIGHT_REQUEST_LIFECYCLE_LOG: join(directory, 'lifecycle.jsonl') },
  });
  const [code, signal] = await once(child, 'close');
  const results = JSON.parse(await readFile(resultPath, 'utf8'));
  const resources = JSON.parse(await readFile(resourcePath, 'utf8'));
  const artifactDirectory = join(directory, 'test-results');
  const artifacts = await artifactIdentity(artifactDirectory);
  return { code, signal, results, resources, artifactDirectory, artifacts };
}

function assertCleanResources(outcome) {
  assert.equal(outcome.signal, null);
  assert.equal(outcome.resources.timedOut, false);
  assert.equal(outcome.resources.interrupted, false);
  assert.deepEqual(outcome.resources.cleanupSignals, []);
  assert.deepEqual(outcome.resources.remainingObservedProcesses, []);
}

async function copyFixtureSources(engine, directory) {
  for (const filename of ['playwright.config.ts', 'request.spec.ts', 'lifecycle.spec.ts', 'late-creation.spec.ts']) {
    const source = await readFile(`compatibility/m2/runner-request/${filename}`, 'utf8');
    await writeFile(join(directory, filename), engine === 'playwright'
      ? source.replaceAll("from '@flashwright/test'", "from '@playwright/test'").replaceAll("from 'flashwright'", "from 'playwright'")
      : source);
  }
}

function testResults(suites) {
  return suites.flatMap(suite => [
    ...(suite.specs ?? []).flatMap(spec => spec.tests.flatMap(test => test.results)),
    ...testResults(suite.suites ?? []),
  ]);
}

try {
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  const origin = `http://127.0.0.1:${fixture.server.address().port}`;
  const storagePath = join(destination, 'storage-state.json');
  await writeFile(storagePath, JSON.stringify({ cookies: [{ name: 'seed', value: 'original', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }) + '\n');
  for (const engine of ['playwright', 'flashwright']) {
    const directory = join(destination, engine);
    await mkdir(directory);
    await copyFixtureSources(engine, directory);
    currentEngine = engine;
    if (!retryPairsOnly) {
      const ledgerStart = ledger.length;
      const outcome = await run(engine, directory, origin, storagePath);
      report.outcomes[engine] = { ...outcome, ledger: ledger.slice(ledgerStart) };
      assert.equal(outcome.code, 0, `${engine} public request fixture must pass`);
      assertCleanResources(outcome);
      assert.equal(outcome.results.stats.expected, 14);
      for (const count of ['unexpected', 'flaky', 'skipped']) assert.equal(outcome.results.stats[count], 0);
      assert.ok(report.outcomes[engine].ledger.some(entry => entry.query.query === 'to:user+mail@example.test' && entry.query.limit === '1'));
    }
    for (const mode of retryPairsOnly ? ['retry'] : ['throw', 'timeout', 'retry']) {
      const modeDirectory = join(directory, mode);
      await mkdir(modeDirectory);
      await copyFixtureSources(engine, modeDirectory);
      const lifecycle = await run(engine, modeDirectory, origin, storagePath, mode);
      report.outcomes[`${engine}-${mode}`] = lifecycle;
      assertCleanResources(lifecycle);
      const results = testResults(lifecycle.results.suites);
      const events = (await readFile(join(modeDirectory, 'lifecycle.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      report.outcomes[`${engine}-${mode}`].events = events;
      const retired = events.filter(event => event.phase === 'fixture-retired');
      assert.equal(retired.length, mode === 'retry' ? 2 : 1);
      assert.ok(retired.every(event => event.contextCount === 1));
      assert.equal(lifecycle.results.stats.skipped, 0);
      if (mode === 'retry') {
        assert.equal(lifecycle.code, 0);
        assert.equal(lifecycle.results.stats.unexpected, 0);
        assert.equal(lifecycle.results.stats.flaky, 1);
        assert.deepEqual(results.map(result => result.status), ['failed', 'passed']);
        assert.deepEqual(events.filter(event => event.phase === 'retry-start').map(event => ({ retry: event.retry, cookie: event.cookie })), [{ retry: 0, cookie: 'seed=original' }, { retry: 1, cookie: 'seed=original' }]);
        assert.equal(results[0].attachments.filter(attachment => attachment.name === 'trace').length, 0);
        const traces = results[1].attachments.filter(attachment => attachment.name === 'trace');
        assert.equal(traces.length, 1);
        report.outcomes[`${engine}-${mode}`].traceSha256 = hash(await readFile(traces[0].path));
      } else {
        assert.equal(lifecycle.code, 1);
        assert.equal(lifecycle.results.stats.unexpected, 1);
        assert.equal(lifecycle.results.stats.flaky, 0);
        assert.equal(results.length, 1);
        assert.equal(results[0].status, mode === 'timeout' ? 'timedOut' : 'failed');
        if (mode === 'throw') assert.ok(results[0].errors.some(error => error.message?.includes('original-request-body-failure')));
        else assert.ok(events.some(event => event.phase === 'body-pending'));
      }
    }
    if (engine === 'flashwright' && !retryPairsOnly) {
      const lateDirectory = join(directory, 'factory-timeout');
      await mkdir(lateDirectory);
      await copyFixtureSources(engine, lateDirectory);
      const lateCreation = await run(engine, lateDirectory, origin, storagePath, 'factory-timeout');
      report.outcomes['flashwright-factory-timeout'] = lateCreation;
      assertCleanResources(lateCreation);
      assert.equal(lateCreation.code, 1);
      assert.equal(lateCreation.results.stats.unexpected, 1);
      assert.equal(lateCreation.results.stats.expected, 1);
      assert.equal(lateCreation.results.stats.skipped, 0);
      assert.equal(lateCreation.results.stats.flaky, 0);
      const results = testResults(lateCreation.results.suites);
      assert.deepEqual(results.map(result => result.status), ['timedOut', 'passed']);
      const events = (await readFile(join(lateDirectory, 'lifecycle.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      lateCreation.events = events;
      assert.ok(!events.some(event => event.phase === 'unexpected-body'));
      const originalOwner = 'native request creation cannot escape its setup timeout';
      assert.ok(events.some(event => event.phase === 'late-creation-retired' && event.owner === originalOwner));
      const allocations = events.filter(event => event.phase === 'native-allocation-paused');
      assert.equal(allocations.length, 1);
      assert.equal(events.filter(event => event.phase === 'native-publication-released').length, 1);
      const originalDisposals = events.filter(event => event.phase === 'native-disposal-complete' && event.owner === originalOwner);
      const identity = event => ({ context: event.context, owner: event.owner, workerProcess: event.workerProcess });
      assert.deepEqual(originalDisposals.map(identity), allocations.map(identity));
      const disposalPosition = events.findIndex(event => event === originalDisposals[0]);
      const successorPosition = events.findIndex(event => event.phase === 'successor-operation');
      assert.ok(disposalPosition >= 0 && successorPosition > disposalPosition);
      assert.equal(events.filter(event => event.phase === 'successor-complete').length, 1);
    }
  }
  for (const outcome of Object.values(report.outcomes)) {
    assert.deepEqual(await artifactIdentity(outcome.artifactDirectory), outcome.artifacts, 'Earlier trace/error bytes must survive the full selected job sequence');
  }
  assert.deepEqual(await sourceIdentity(), report.sources);
  assert.equal(hash(await readFile(driver)), report.driverSha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  for (const timer of pendingTimers) clearTimeout(timer);
  try { await fixture.close(); }
  catch (error) {
    report.status = 'failed';
    report.cleanupError = { message: error.message, stack: error.stack };
    process.exitCode = 1;
  }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Public request fixture evidence: ${destination}/report.json`);
}
