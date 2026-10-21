import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { SuiteCollector } from '../packages/flashwright-runner/dist/commonjs/independent/suite-collector.js';
import { SuiteWorker, currentFiniteTestInfo } from '../packages/flashwright-runner/dist/commonjs/independent/suite-runtime.js';
import { groupTests } from '../packages/flashwright-runner/dist/commonjs/independent/suite-groups.js';
import { suiteScenarios } from '../compatibility/runner-suite-core/scenarios.mjs';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(process.argv[2] ?? join(root, 'workbench', `independent-suite-differential-${Date.now()}`));
assert.ok(destination.startsWith(join(root, 'workbench') + '/'), 'Raw suite runs belong in workbench');
await mkdir(destination, { recursive: false });
const project = join(destination, 'reference'); await mkdir(project);
const source = resolve(root, 'compatibility/runner-suite-core/scenarios.mjs');
const eventFile = join(destination, 'reference-events.jsonl');
const paths = [
  ...['fixture-pool', 'fixture-runtime', 'suite-collector', 'suite-runtime', 'suite-groups'].flatMap(name => [`packages/flashwright-runner/src/independent/${name}.ts`, `packages/flashwright-runner/dist/commonjs/independent/${name}.js`]),
  'compatibility/runner-suite-core/scenarios.mjs', 'tools/run-independent-suite-differential.mjs',
];
const digest = async path => createHash('sha256').update(await readFile(join(root, path))).digest('hex');
const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, await digest(path)])));
const definitions = suiteScenarios(() => {});
for (const { name } of definitions) await writeFile(join(project, name + '.spec.mjs'), `import { test } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { suiteScenarios } from ${JSON.stringify(pathToFileURL(source).href)};
suiteScenarios((name, event) => appendFileSync(${JSON.stringify(eventFile)}, JSON.stringify({ name, event })+'\\n')).find(s => s.name === ${JSON.stringify(name)}).declare(test);
`);
const config = { testDir: project, workers: 1, retries: 0, timeout: 5000, fullyParallel: false, reporter: [['json', { outputFile: join(destination, 'reference-report.json') }]], outputDir: join(destination, 'reference-output') };
await writeFile(join(project, 'playwright.config.mjs'), 'export default ' + JSON.stringify(config) + ';\n');
const require = createRequire(import.meta.url), cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
const args = ['tools/watchdog.py', '--timeout', '90', '--report', join(destination, 'resources.json'), '--', process.execPath, cli, 'test', '--config', join(project, 'playwright.config.mjs')];
await writeFile(join(destination, 'command.json'), JSON.stringify({ executable: 'python3', args }, null, 2));
const child = spawn('python3', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
await writeFile(join(destination, 'reference-stdout.txt'), stdout); await writeFile(join(destination, 'reference-stderr.txt'), stderr);
assert.equal(exitCode, 1, 'Five intentional unexpected failures should fail the reference run');
const resource = JSON.parse(await readFile(join(destination, 'resources.json')));
assert.equal(resource.exitCode, 1); assert.equal(resource.timedOut, false); assert.equal(resource.interrupted, false);
assert.deepEqual(resource.cleanupSignals, []); assert.deepEqual(resource.remainingObservedProcesses, []);
const reference = JSON.parse(await readFile(join(destination, 'reference-report.json')));
assert.deepEqual(reference.errors, []);
const specs = [];
function collect(suites, titles = [], file) {
  for (const suite of suites) {
    const nestedTitles = file === undefined ? titles : [...titles, suite.title];
    const testFile = file ?? suite.file;
    for (const spec of suite.specs ?? []) specs.push({ ...spec, testFile, titlePath: [...nestedTitles, spec.title] });
    collect(suite.suites ?? [], nestedTitles, testFile);
  }
}
collect(reference.suites);
const recorded = (await readFile(eventFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const events = [], actual = [];
for (const scenario of suiteScenarios((name, event) => events.push({ name, event }), currentFiniteTestInfo)) {
  const collector = new SuiteCollector(), test = collector.createTest();
  await collector.collect(scenario.name + '.spec.mjs', () => scenario.declare(test));
  const tests = collector.seal(), worker = new SuiteWorker(tests[0].pool);
  const group = { results: [], pending: [] };
  worker.validate(tests);
  try {
    for (const planned of groupTests(tests, 1)) {
      const result = await worker.run(planned.tests);
      group.results.push(...result.results); group.pending.push(...result.pending);
      if (result.workerStopped) break;
    }
  } finally { assert.deepEqual(await worker.close(), []); }
  if (group.pending.length) assert.equal(scenario.name, 'before-all-errors');
  for (const test of tests) {
    const result = group.results.find(r => r.test === test);
    const pinned = specs.find(s => s.testFile === test.file && JSON.stringify(s.titlePath) === JSON.stringify(test.titlePath));
    assert.ok(pinned, JSON.stringify([test.file, test.titlePath]));
    assert.equal(pinned.tests.length, 1); assert.equal(pinned.tests[0].results.length, 1);
    const status = result?.status ?? 'skipped';
    assert.equal(status, pinned.tests[0].results[0].status, test.id);
    assert.equal(test.expectedStatus, pinned.tests[0].expectedStatus, test.id);
    actual.push({ name: scenario.name, titlePath: test.titlePath, status, pending: !result, errors: result?.errors.map(e => ({ phase: e.phase, message: String(e.error?.message ?? e.error) })) ?? [] });
  }
  assert.deepEqual(events.filter(e => e.name === scenario.name), recorded.filter(e => e.name === scenario.name), scenario.name + ' exact event sequence');
}
await writeFile(join(destination, 'candidate-events.json'), JSON.stringify(events, null, 2));
await writeFile(join(destination, 'candidate-results.json'), JSON.stringify(actual, null, 2));
assert.equal(actual.length, specs.length);
assert.equal(reference.stats.unexpected, 5); assert.equal(reference.stats.flaky, 0); assert.equal(reference.stats.skipped, 4);
for (const [path, hash] of Object.entries(sourceHashes)) assert.equal(await digest(path), hash, path);
const report = { status: 'passed', scenarios: definitions.length, outcomesPerImplementation: specs.length, unexpectedFailuresPerImplementation: 5, exactLifecycleEventSequences: true, sourceHashes, limitations: ['Finite internal groups with one worker; no concurrent process scheduler, serial retry policy, deadlines, runtime modifiers, retries, artifacts or public API promotion.', 'Pending tests are returned to the caller; this differential compares the reference beforeAll-blocked test as skipped without simulating a replacement worker.', 'No browser work or performance measurement.'] };
await writeFile(join(destination, 'verified.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ destination, ...report }));
