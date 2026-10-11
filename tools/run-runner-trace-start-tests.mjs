import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runtimeMetadata } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { utils } = require('playwright-core/lib/coreBundle');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
for (const file of ['start.spec.cjs', 'playwright.config.cjs']) await writeFile(join(output, file), await readFile(`compatibility/m2/runner-trace-start/${file}`));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['tools/build-runner-runtime.mjs', 'compatibility/upstream/runner-runtime-manifest.json', 'packages/flashwright-runner/runner-hooks.cjs', 'packages/flashwright-runner/cli.cjs', 'packages/flashwright-runner/runner-source-transform.cjs', 'packages/flashwright-runner/src/upstream-runtime.ts', 'packages/flashwright-runner/src/runner-trace-journal.ts', 'packages/flashwright-runner/src/runner-trace-finalizer.ts', 'tools/run-runner-trace-start-tests.mjs', 'compatibility/m2/runner-trace-start/start.spec.cjs', 'compatibility/m2/runner-trace-start/playwright.config.cjs'];
const inputs = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(path))])));
const report = { status: 'running', ...runtimeMetadata, inputs: await inputs(), runs: [], scope: 'Owned original-attempt trace startup before fixtures/live writes. Private journal finalizer only; automatic library capture remains gated.' };
const attempts = suites => suites.flatMap(suite => [
  ...(suite.specs ?? []).flatMap(spec => spec.tests.flatMap(test => test.results.map(result => ({ title: spec.title, project: test.projectName, expectedStatus: test.expectedStatus, ...result })))),
  ...attempts(suite.suites ?? []),
]);
const collected = new Map();
try {
  for (const [engine, live] of [['playwright', false], ['flashwright', false], ['flashwright', true]]) {
    const name = `${engine}${live ? '-live' : ''}`;
    const directory = join(output, name); await mkdir(directory);
    const runtime = engine === 'playwright' ? dirname(require.resolve('playwright/package.json')) : resolve('packages/flashwright-runner/dist/upstream');
    const executable = engine === 'playwright' ? join(runtime, 'cli.js') : resolve('packages/flashwright-runner/cli.cjs');
    const child = spawn('python3', ['tools/watchdog.py', '--timeout', '90', '--report-directory', join(directory, 'watchdog'), '--', process.execPath, executable, 'test', '--config', join(output, 'playwright.config.cjs')], {
      env: { ...process.env, FLASHWRIGHT_START_ENGINE: engine, FLASHWRIGHT_START_RUNTIME: runtime, FLASHWRIGHT_START_MODULES: resolve('packages/flashwright-runner/dist/commonjs'), FLASHWRIGHT_START_RESULTS: join(directory, 'results.json'), FLASHWRIGHT_START_EVENTS: join(directory, 'events.jsonl'), FLASHWRIGHT_START_OUTPUT: join(directory, 'output'), FLASHWRIGHT_START_LIVE: live ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
    const exitCode = await new Promise((complete, reject) => { child.on('error', reject); child.on('close', complete); });
    await writeFile(join(directory, 'runner.log'), log); assert.equal(exitCode, 0, log);
    const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
    const records = attempts(results.suites);
    assert.equal(records.length, live ? 6 : 60);
    assert.equal(results.stats.expected, live ? 2 : 20); assert.equal(results.stats.flaky, live ? 1 : 10); assert.equal(results.stats.skipped, live ? 2 : 20); assert.equal(results.stats.unexpected, 0);
    const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const archives = new Map(); const summary = [];
    for (const record of records) {
      const key = `${record.project}:${record.title}:${record.retry}`;
      const trace = record.attachments.filter(attachment => attachment.name === 'trace');
      const diagnostics = record.attachments.filter(attachment => attachment.name === 'trace-error');
      summary.push({ key, status: record.status, expectedStatus: record.expectedStatus, traces: trace.length, diagnostics: diagnostics.length });
      if (live) {
        assert.equal(trace.length, 0); assert.equal(diagnostics.length, 1);
        assert.match(Buffer.from(diagnostics[0].body, 'base64').toString(), /live runner traces are not implemented/);
      } else assert.equal(diagnostics.length, 0);
      if (trace.length) {
        assert.equal(trace.length, 1);
        const zip = new utils.ZipFile(trace[0].path);
        try { archives.set(key, Object.fromEntries(await Promise.all((await zip.entries()).map(async path => [path, await zip.read(path)])))); }
        finally { zip.close(); }
      }
    }
    if (engine === 'flashwright') {
      assert.equal(events.filter(event => event.phase === 'owned start').length, records.length);
      const skipped = events.filter(event => event.title === 'last skipped without fixtures');
      assert.equal(skipped.length, live ? 1 : 10);
      assert.ok(skipped.every(event => event.phase === 'owned start'));
      assert.equal(events.filter(event => event.phase === 'modifier').length, live ? 1 : 10);
    }
    report.runs.push({ name, exitCode, stats: results.stats, attempts: summary, events, archives: records.flatMap(record => record.attachments.filter(attachment => attachment.name === 'trace').map(attachment => attachment.path)) });
    if (!live) collected.set(engine, { summary, archives, events: events.filter(event => event.phase !== 'owned start') });
  }
  const reference = collected.get('playwright'); const candidate = collected.get('flashwright');
  assert.deepEqual(candidate.summary, reference.summary);
  assert.deepEqual(candidate.events, reference.events);
  assert.deepEqual([...candidate.archives.keys()], [...reference.archives.keys()]);
  report.comparisons = [];
  for (const [key, expected] of reference.archives) {
    const actual = candidate.archives.get(key);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), key);
    for (const name of Object.keys(expected)) {
      if (name !== 'test.trace') assert.deepEqual(actual[name], expected[name], `${key}:${name}`);
      else {
        const normalize = bytes => bytes.toString().trim().split('\n').map(line => Object.fromEntries(Object.entries(JSON.parse(line)).filter(([field]) => !['wallTime', 'monotonicTime', 'startTime', 'endTime', 'timestamp'].includes(field))));
        assert.deepEqual(normalize(actual[name]), normalize(expected[name]), key);
      }
    }
    report.comparisons.push({ key, entries: Object.keys(actual).length });
  }
  assert.deepEqual(await inputs(), report.inputs);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, runs: report.runs.map(run => ({ name: run.name, attempts: run.attempts.length })), comparisons: report.comparisons?.length, error: report.error })); }
