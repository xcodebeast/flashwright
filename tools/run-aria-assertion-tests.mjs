import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHttpFixture } from './http-fixture.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { identifyBrowser } from './browser-identity.mjs';

assert.ok(process.argv[2], 'Usage: run-aria-assertion-tests.mjs OUTPUT_DIRECTORY');
const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
const html = '<!doctype html><h1>Snapshot fixture</h1><main><button>Save</button><label><input type="checkbox" checked>Choice</label><label>Name<input value="Ada"></label><output role="status">Ready</output></main><ul><li>First</li><li>Second</li></ul><iframe src="/frame"></iframe>';
const { server, close } = createHttpFixture((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(request.url === '/frame' ? '<!doctype html><button>Inside</button>' : html);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const sources = await sourceManifest();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources, browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), cases: [], scope: 'Real runner ARIA predicate and baseline policy differential; no performance or public ariaSnapshot method claim.' };
const specs = suites => suites.flatMap(suite => [...suite.specs, ...specs(suite.suites ?? [])]);
const optionalText = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function run(engine, name, settings = {}) {
  const directory = join(destination, `${engine}-${name}`);
  await mkdir(directory);
  const baselines = join(directory, 'baselines');
  await mkdir(baselines);
  const baselinePath = join(baselines, 'status.aria.yml');
  if (settings.baseline !== undefined) await writeFile(baselinePath, settings.baseline);
  const args = ['tools/watchdog.py', '--timeout', '120', '--report', join(directory, 'resources.json'), '--', process.execPath,
    engine === 'playwright' ? 'node_modules/playwright/cli.js' : 'packages/flashwright-test/cli.cjs', 'test', '--config', 'compatibility/m2/aria-assertions/playwright.config.cjs'];
  const environment = { ...process.env, FLASHWRIGHT_ARIA_ENGINE: engine, FLASHWRIGHT_ARIA_URL: `http://127.0.0.1:${server.address().port}`,
    FLASHWRIGHT_ARIA_TEST: 'assertions.spec.cjs', FLASHWRIGHT_ARIA_TIMEOUT: '1000', FLASHWRIGHT_ARIA_UPDATE: 'none',
    FLASHWRIGHT_ARIA_CHILDREN: '', FLASHWRIGHT_ARIA_TEXT_LENGTH: '', FLASHWRIGHT_ARIA_MISSING_TARGET: '0', FLASHWRIGHT_ARIA_RETRIES: '0', FLASHWRIGHT_ARIA_IGNORE: '0', FLASHWRIGHT_ARIA_INLINE: '0', FLASHWRIGHT_ARIA_NEGATED: '0',
    FLASHWRIGHT_ARIA_OUTPUT: join(directory, 'artifacts'), FLASHWRIGHT_ARIA_REPORT: join(directory, 'runner.json'), FLASHWRIGHT_ARIA_BASELINES: baselines,
    ...(name === 'predicates' ? {} : { FLASHWRIGHT_ARIA_TEST: 'baseline.spec.cjs', FLASHWRIGHT_ARIA_TIMEOUT: '100' }), ...settings.environment };
  const child = spawn('python3', args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [], errors = [];
  child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
  const [code, signal] = await once(child, 'close');
  await writeFile(join(directory, 'stdout.txt'), Buffer.concat(output));
  await writeFile(join(directory, 'stderr.txt'), Buffer.concat(errors));
  const resources = JSON.parse(await readFile(join(directory, 'resources.json'), 'utf8'));
  const runner = JSON.parse(await readFile(join(directory, 'runner.json'), 'utf8'));
  const expectedFailures = settings.failure ? 1 : 0;
  assert.equal(signal, null); assert.equal(code, expectedFailures ? 1 : 0, `${engine}/${name}`);
  assert.equal(resources.timedOut, false); assert.deepEqual(resources.cleanupSignals, []); assert.deepEqual(resources.remainingObservedProcesses, []);
  assert.equal(runner.stats.unexpected, expectedFailures, `${engine}/${name}`);
  assert.equal(runner.stats.skipped, 0); assert.equal(runner.stats.flaky, 0);
  const tests = specs(runner.suites);
  assert.equal(tests.length, name === 'predicates' ? 11 : 1);
  for (const spec of tests) assert.equal(spec.tests[0].results.length, 1, `${engine}/${name}/${spec.title} must not retry`);
  if (settings.resourceFailure) assert.match(JSON.stringify(tests[0].tests[0].results[0].errors), /ResourceLimitError/);
  if (settings.unsupportedFailure) assert.match(JSON.stringify(tests[0].tests[0].results[0].errors), /UnsupportedFeatureError/);
  const baseline = await optionalText(baselinePath);
  if (settings.expectedBaseline !== undefined) assert.equal(baseline, settings.expectedBaseline, `${engine}/${name} baseline`);
  const patch = await optionalText(join(directory, 'artifacts/rebaselines.patch'));
  if (settings.emptyReferencePatch) { assert.ok(patch); assert.doesNotMatch(patch, /status: Ready/); assert.doesNotMatch(patch, /^@@/m); }
  else if (settings.patch) { assert.ok(patch); assert.match(patch, /status: Ready/); }
  else assert.equal(patch, null);
  report.cases.push({ engine, name, passed: true, outcomeClass: settings.emptyReferencePatch ? 'pinned-bun-empty-patch' : settings.unsupportedFailure ? 'explicit-bun-inline-update-rejection' : 'shared', unexpected: runner.stats.unexpected, tests: tests.map(spec => ({ title: spec.title, expectedStatus: spec.tests[0].expectedStatus, results: spec.tests[0].results.map(result => result.status) })), baseline, patchGenerated: patch !== null });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

try {
  for (const engine of ['playwright', 'flashwright']) {
    await run(engine, 'predicates');
    await run(engine, 'configured-children', { environment: { FLASHWRIGHT_ARIA_TEST: 'children.spec.cjs', FLASHWRIGHT_ARIA_CHILDREN: 'deep-equal' } });
    await run(engine, 'existing', { baseline: '- status: Ready', expectedBaseline: '- status: Ready' });
    await run(engine, 'missing-none', { failure: true, expectedBaseline: null });
    await run(engine, 'missing-create', { failure: true, expectedBaseline: '- status: Ready', environment: { FLASHWRIGHT_ARIA_UPDATE: 'missing', FLASHWRIGHT_ARIA_RETRIES: '1' } });
    await run(engine, 'changed', { baseline: '- status: Wrong', expectedBaseline: '- status: Ready', environment: { FLASHWRIGHT_ARIA_UPDATE: 'changed' } });
    await run(engine, 'changed-long', { baseline: '- status: Wrong', expectedBaseline: '- status: ' + 'a'.repeat(12000), environment: { FLASHWRIGHT_ARIA_UPDATE: 'changed', FLASHWRIGHT_ARIA_TEXT_LENGTH: '12000' } });
    await run(engine, 'missing-target-update', { failure: true, baseline: '- status: Before', expectedBaseline: '- status: Before', environment: { FLASHWRIGHT_ARIA_UPDATE: 'all', FLASHWRIGHT_ARIA_MISSING_TARGET: '1' } });
    await run(engine, 'all', { baseline: '- status: Ready', expectedBaseline: '- status: Ready', environment: { FLASHWRIGHT_ARIA_UPDATE: 'all' } });
    await run(engine, 'negated-missing', { failure: true, expectedBaseline: null, environment: { FLASHWRIGHT_ARIA_UPDATE: 'missing', FLASHWRIGHT_ARIA_NEGATED: '1' } });
    await run(engine, 'ignored', { baseline: '- status: Wrong', expectedBaseline: '- status: Wrong', environment: { FLASHWRIGHT_ARIA_IGNORE: '1' } });
    const bun = Boolean(process.versions.bun);
    await run(engine, 'inline-missing', { failure: true, expectedBaseline: null, ...(bun ? engine === 'playwright' ? { emptyReferencePatch: true } : { unsupportedFailure: true } : { patch: true }), environment: { FLASHWRIGHT_ARIA_UPDATE: 'missing', FLASHWRIGHT_ARIA_INLINE: '1', FLASHWRIGHT_ARIA_RETRIES: bun && engine === 'flashwright' ? '0' : '1' } });
  }
  assert.deepEqual(report.cases.filter(row => row.engine === 'flashwright' && row.outcomeClass === 'shared').map(({ engine, ...row }) => row), report.cases.filter(row => row.engine === 'playwright' && row.outcomeClass === 'shared').map(({ engine, ...row }) => row));
  await run('flashwright', 'oversized-capture', { failure: true, resourceFailure: true, baseline: '- status: Before', expectedBaseline: '- status: Before', environment: { FLASHWRIGHT_ARIA_UPDATE: 'all', FLASHWRIGHT_ARIA_TEXT_LENGTH: '100001' } });
  assert.deepEqual(await sourceManifest(), sources);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); throw error; }
finally { await close(); await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, destination }));
