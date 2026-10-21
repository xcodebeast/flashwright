import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { FixturePool } from '../packages/flashwright-runner/dist/commonjs/independent/fixture-pool.js';
import { FixtureWorker } from '../packages/flashwright-runner/dist/commonjs/independent/fixture-runtime.js';
import { fixtureScenarios } from '../compatibility/runner-fixture-core/scenarios.mjs';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(process.argv[2] ?? join(root, 'workbench', `independent-fixture-differential-${Date.now()}`));
assert.ok(destination.startsWith(join(root, 'workbench') + '/'), 'Raw fixture runs belong in workbench');
await mkdir(destination, { recursive: false });
const project = join(destination, 'reference'); await mkdir(project);
const referenceEvents = join(destination, 'reference-events.jsonl');
const scenarioSource = resolve(root, 'compatibility/runner-fixture-core/scenarios.mjs');
const sources = ['packages/flashwright-runner/src/independent/fixture-pool.ts', 'packages/flashwright-runner/src/independent/fixture-runtime.ts', 'compatibility/runner-fixture-core/scenarios.mjs', 'tools/run-independent-fixture-differential.mjs', 'packages/flashwright-runner/dist/commonjs/independent/fixture-pool.js', 'packages/flashwright-runner/dist/commonjs/independent/fixture-runtime.js'];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async p => [p, createHash('sha256').update(await readFile(join(root, p))).digest('hex')])));
const definitions = fixtureScenarios(() => {});
for (const scenario of definitions) {
  const source = `import { test as base } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { fixtureScenarios } from ${JSON.stringify(pathToFileURL(scenarioSource).href)};
const scenario = fixtureScenarios((name, event) => appendFileSync(${JSON.stringify(referenceEvents)}, JSON.stringify({ name, event })+'\\n')).find(s => s.name === ${JSON.stringify(scenario.name)});
let test = base;
for (const layer of scenario.layers) test = test.extend(layer);
test.describe(scenario.name, () => {
  if (scenario.use) test.use(scenario.use);
  for (const hook of scenario.beforeAll ?? []) test.beforeAll(hook);
  for (const hook of scenario.beforeEach ?? []) test.beforeEach(hook);
  for (let i = 0; i < scenario.tests.length; i++) test('attempt-'+i, scenario.tests[i]);
  for (const hook of scenario.afterEach ?? []) test.afterEach(hook);
  for (const hook of scenario.afterAll ?? []) test.afterAll(hook);
});
`;
  await writeFile(join(project, scenario.name + '.spec.mjs'), source);
}
const config = { testDir: project, workers: 1, retries: 0, timeout: 5000, fullyParallel: false, use: { choice: 'configured' }, reporter: [['json', { outputFile: join(destination, 'reference-report.json') }]], outputDir: join(destination, 'reference-output') };
await writeFile(join(project, 'playwright.config.mjs'), 'export default ' + JSON.stringify(config) + ';\n');
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
const args = ['tools/watchdog.py', '--timeout', '90', '--report', join(destination, 'resources.json'), '--', process.execPath, cli, 'test', '--config', join(project, 'playwright.config.mjs')];
await writeFile(join(destination, 'command.json'), JSON.stringify({ executable: 'python3', args }, null, 2));
const child = spawn('python3', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
await writeFile(join(destination, 'reference-stdout.txt'), stdout); await writeFile(join(destination, 'reference-stderr.txt'), stderr);
assert.equal(code, 1, 'Only the four intentional fixture failures should fail');
const resource = JSON.parse(await readFile(join(destination, 'resources.json')));
assert.equal(resource.exitCode, 1); assert.equal(resource.timedOut, false); assert.equal(resource.interrupted, false);
assert.deepEqual(resource.cleanupSignals, []); assert.deepEqual(resource.remainingObservedProcesses, []);
const reference = JSON.parse(await readFile(join(destination, 'reference-report.json')));
assert.deepEqual(reference.errors, []);
const specs = [];
function collect(suites) { for (const suite of suites) { specs.push(...suite.specs ?? []); collect(suite.suites ?? []); } }
collect(reference.suites);
assert.equal(specs.length, definitions.reduce((sum, s) => sum + s.tests.length, 0)); assert.equal(reference.stats.expected, specs.length - 4); assert.equal(reference.stats.unexpected, 4); assert.equal(reference.stats.skipped, 0); assert.equal(reference.stats.flaky, 0);
const recorded = (await readFile(referenceEvents, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const candidate = [], candidateEvents = [];
const scenarios = fixtureScenarios((name, event) => candidateEvents.push({ name, event }));
const failures = error => error instanceof AggregateError ? error.errors.flatMap(failures) : [String(error?.message ?? error)];
for (const scenario of scenarios) {
  let pool = new FixturePool({}, { configurationUse: scenario.configurationUse });
  for (const layer of scenario.layers) pool = pool.extend(layer);
  if (scenario.use) pool = pool.withUse(scenario.use, { inDescribe: true });
  const worker = new FixtureWorker(pool, { config: {}, project: {}, workerIndex: 0, parallelIndex: 0 });
  const info = { retry: 0, workerIndex: 0, parallelIndex: 0, config: {}, project: {} };
  for (const hook of scenario.beforeAll ?? []) {
    const scope = worker.beginAttempt(info);
    try { assert.equal((await scope.run(hook, 'all-hooks-only')).ran, true); } finally { await scope.close(); }
  }
  for (let i = 0; i < scenario.tests.length; i++) {
    const scope = worker.beginAttempt(info), bodyErrors = [], cleanupErrors = [];
    try {
      for (const hook of scenario.beforeEach ?? []) assert.equal((await scope.run(hook)).ran, true);
      assert.equal((await scope.run(scenario.tests[i])).ran, true);
    } catch (error) { bodyErrors.push(...failures(error)); }
    finally {
      for (const hook of scenario.afterEach ?? []) { try { await scope.run(hook); } catch (error) { cleanupErrors.push(...failures(error)); } }
      try { await scope.close(); } catch (error) { cleanupErrors.push(...failures(error)); }
    }
    const actual = { name: scenario.name, attempt: i, status: bodyErrors.length || cleanupErrors.length ? 'failed' : 'passed', bodyErrors, cleanupErrors };
    candidate.push(actual);
    const pinned = specs.find(s => s.file === scenario.name + '.spec.mjs' && s.title === 'attempt-' + i);
    assert.ok(pinned); assert.equal(pinned.tests.length, 1); assert.equal(pinned.tests[0].results.length, 1);
    assert.equal(actual.status, pinned.tests[0].results[0].status, scenario.name);
    if (scenario.expectedFailure) assert.ok(pinned.tests[0].results[0].errors.some(e => e.message?.includes(scenario.expectedFailure)), scenario.name);
    if (scenario.expectedFailure && !scenario.candidateCleanupErrors) assert.ok([...bodyErrors, ...cleanupErrors].some(e => e.includes(scenario.expectedFailure)), scenario.name + ' candidate failure');
    if (scenario.name === 'body-and-cleanup-errors') assert.deepEqual(bodyErrors, ['body sentinel']);
    for (const expected of scenario.candidateCleanupErrors ?? []) assert.ok(cleanupErrors.some(e => e.includes(expected)), expected);
  }
  for (const hook of scenario.afterAll ?? []) {
    const scope = worker.beginAttempt(info);
    try { assert.equal((await scope.run(hook, 'all-hooks-only')).ran, true); } finally { await scope.close(); }
  }
  await worker.close();
  assert.deepEqual(candidateEvents.filter(e => e.name === scenario.name), recorded.filter(e => e.name === scenario.name), scenario.name + ' exact event sequence');
}
await writeFile(join(destination, 'candidate-events.json'), JSON.stringify(candidateEvents, null, 2));
await writeFile(join(destination, 'candidate-results.json'), JSON.stringify(candidate, null, 2));
for (const [p, digest] of Object.entries(sourceHashes)) assert.equal(createHash('sha256').update(await readFile(join(root, p))).digest('hex'), digest, p);
const report = { status: 'passed', scenarios: scenarios.length, attemptsPerImplementation: specs.length, expectedFailuresPerImplementation: 4, exactLifecycleEventSequences: true, candidatePreservesAllTeardownErrors: true, sourceHashes, limitations: ['Internal fixture core only; no independent scheduler, deadline/cancellation, general hook collector, worker restart, retries, reporting or artifact admission.', 'Reference teardown exposes its first cleanup error; candidate retains every cleanup error separately from body errors.', 'No browser work or performance measurement in this fixture differential.'] };
await writeFile(join(destination, 'verified.json'), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify({ destination, ...report }));
