import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { startConsumerRegistry } from './consumer-registry.mjs';
import { requireBun } from './bun-toolchain.mjs';

const require = createRequire(import.meta.url);
const { utils } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const packed = process.argv.includes('--packed');
const destination = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? `compatibility/evidence/runner-finalizer${packed ? '-packed' : ''}-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const sources = ['packages/flashwright-runner/src/runner-trace-finalizer.ts', 'packages/flashwright-runner/src/artifact-errors.ts', 'packages/flashwright-runner/src/screenshot-recorder.ts', 'packages/flashwright-runner/src/runner-trace-journal.ts', 'packages/flashwright-core/src/runner-trace-journal.ts', 'packages/flashwright-core/src/runner-trace-record.ts', 'packages/flashwright-core/src/trace-archive.ts', 'compatibility/m2/runner-trace-finalizer/finalizer.spec.cjs', 'compatibility/m2/runner-trace-finalizer/playwright.config.cjs', 'tools/run-runner-trace-finalizer-tests.mjs', 'node_modules/playwright/lib/worker/workerProcessEntry.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(path))])));
const report = { status: 'running', ...runtimeMetadata, inputs: await inputs(), scope: 'Private journal final-stop owner in the actual pinned runner: artifact failures preserve original test outcomes, successful ZIPs and final timeout metadata. No public automatic tracing, library/API capture, aggregate admission or performance claim.' };
let consumer;
let registry;
try {
  if (packed) {
    const { archives } = await packConsumerPackages(destination, { runner: true });
    report.artifacts = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, { path, sha256: hash(await readFile(path)) }])));
    consumer = await mkdtemp(join(tmpdir(), 'flashwright-finalizer-packed-'));
    registry = await startConsumerRegistry(Object.values(archives));
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'finalizer-packed-consumer', private: true, dependencies: { '@flashwright/runner': '0.0.0', 'flashwright-upstream-runner': 'npm:playwright@1.60.0' } }));
    const installing = spawn(requireBun(), ['install', '--ignore-scripts', '--omit=optional', '--omit=peer', '--registry', registry.url], { cwd: consumer, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(consumer, 'cache') } });
    let output = '';
    for (const stream of [installing.stdout, installing.stderr]) stream.on('data', bytes => { output += bytes; });
    const exitCode = await new Promise((complete, reject) => { installing.on('error', reject); installing.on('close', complete); });
    await writeFile(join(destination, 'install.log'), output); assert.equal(exitCode, 0, output);
  }
  const workingDirectory = consumer ?? process.cwd();
  const fixtureDirectory = consumer ? join(consumer, 'tests') : destination;
  await mkdir(fixtureDirectory, { recursive: true });
  for (const name of ['finalizer.spec.cjs', 'playwright.config.cjs']) await writeFile(join(fixtureDirectory, name), await readFile(`compatibility/m2/runner-trace-finalizer/${name}`));
  const consumerRequire = createRequire(join(workingDirectory, 'package.json'));
  const modules = consumer ? join(dirname(consumerRequire.resolve('@flashwright/runner/package.json')), 'dist/commonjs') : resolve('packages/flashwright-runner/dist/commonjs');
  const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '60', '--report-directory', join(destination, 'watchdog'), '--', process.execPath, join(modules, '../upstream/cli.js'), 'test', '--config', join(fixtureDirectory, 'playwright.config.cjs')], {
    cwd: workingDirectory, stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_FINALIZER_MODULES: modules, FLASHWRIGHT_FINALIZER_OUTPUT: join(destination, 'output'), FLASHWRIGHT_FINALIZER_RESULTS: join(destination, 'results.json'), FLASHWRIGHT_FINALIZER_EVENTS: join(destination, 'events.jsonl') },
  });
  report.exitCode = await new Promise((complete, reject) => { child.on('error', reject); child.on('close', complete); });
  assert.equal(report.exitCode, 0);
  const results = JSON.parse(await readFile(join(destination, 'results.json'), 'utf8'));
  assert.equal(results.stats.expected, 6); assert.equal(results.stats.unexpected, 0); assert.equal(results.stats.flaky, 0); assert.equal(results.stats.skipped, 0);
  const attempts = [];
  function visit(suites) { for (const suite of suites) { for (const spec of suite.specs ?? []) for (const test of spec.tests) for (const result of test.results) attempts.push({ title: spec.title, expectedStatus: test.expectedStatus, ...result }); visit(suite.suites ?? []); } }
  visit(results.suites); assert.equal(attempts.length, 6);
  const expectedTimeouts = [4567, 5678, 6001, 6789, 7890, 8001]; const archivePaths = []; report.attempts = [];
  for (const [index, attempt] of attempts.entries()) {
    assert.equal(attempt.status, index === 1 ? 'failed' : 'passed'); assert.equal(attempt.expectedStatus, attempt.status);
    if (index === 1) { assert.equal(attempt.errors.length, 1); assert.match(attempt.errors[0].message, /original expected test failure/); }
    else assert.deepEqual(attempt.errors, []);
    const traces = attempt.attachments.filter(attachment => attachment.name === 'trace');
    const errors = attempt.attachments.filter(attachment => attachment.name === 'trace-error');
    assert.equal(traces.length, index < 2 ? 0 : 1); assert.equal(errors.length, index < 2 || index === 3 ? 1 : 0);
    const diagnostic = errors[0] && Buffer.from(errors[0].body, 'base64').toString();
    if (index < 2) assert.match(diagnostic, /record exceeds 256 KiB/);
    if (index === 3) assert.match(diagnostic, /cleanup failed after original journal settlement/);
    const retained = { title: attempt.title, status: attempt.status, errors: attempt.errors, diagnostic, expectedTimeout: expectedTimeouts[index] };
    if (index === 5) {
      const screenshotErrors = attempt.attachments.filter(attachment => attachment.name === 'screenshot-error');
      assert.equal(screenshotErrors.length, 1);
      retained.screenshotDiagnostic = Buffer.from(screenshotErrors[0].body, 'base64').toString();
      assert.match(retained.screenshotDiagnostic, /original screenshot failure 1/);
      assert.match(retained.screenshotDiagnostic, /original screenshot failure 2/);
      assert.match(retained.screenshotDiagnostic, /original screenshot failure 3/);
    }
    if (traces.length) {
      const archive = new utils.ZipFile(traces[0].path);
      try {
        const records = (await archive.read('test.trace')).toString().trimEnd().split('\n').map(JSON.parse);
        assert.equal(records[0].testTimeout, expectedTimeouts[index]);
        retained.trace = { path: traces[0].path, sha256: hash(await readFile(traces[0].path)), records: records.length };
      } finally { archive.close(); }
      archivePaths.push(traces[0].path);
    }
    report.attempts.push(retained);
  }
  const events = (await readFile(join(destination, 'events.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.equal(events.length, 1); assert.ok(events[0].elapsed >= 2500); assert.equal(events[0].status, 'passed'); assert.equal(events[0].timeout, 7890);
  execFileSync('python3', ['-c', 'import sys,zipfile\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive: assert archive.testzip() is None', ...archivePaths]);
  assert.deepEqual(await inputs(), report.inputs);
  report.status = 'passed'; report.stats = results.stats; report.finalPreparation = events[0]; report.zipCrcChecks = archivePaths.length;
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  await registry?.close();
  if (consumer) await rm(consumer, { recursive: true, force: true });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Runner finalizer evidence: ${destination}/report.json`);
}
