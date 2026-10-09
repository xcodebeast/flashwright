import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { utils } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const destination = resolve(process.argv[2] ?? `compatibility/evidence/runner-adoption-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
for (const name of ['adoption.spec.cjs', 'fixtures.cjs', 'early-failure.spec.cjs', 'playwright.config.cjs']) await writeFile(join(destination, name), await readFile(`compatibility/m2/runner-trace-adoption/${name}`));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['packages/flashwright-runner/src/runner-trace-journal.ts', 'packages/flashwright-runner/src/runner-trace-finalizer.ts', 'packages/flashwright-runner/src/artifact-errors.ts', 'packages/flashwright-runner/src/runner-trace-off.ts', 'packages/flashwright-core/src/runner-trace-journal.ts', 'packages/flashwright-core/src/runner-trace-record.ts', 'packages/flashwright-core/src/runner-integration.ts', 'packages/flashwright-core/src/trace-resources.ts', 'packages/flashwright-core/src/trace-archive.ts', 'compatibility/m2/runner-trace-adoption/adoption.spec.cjs', 'compatibility/m2/runner-trace-adoption/fixtures.cjs', 'compatibility/m2/runner-trace-adoption/early-failure.spec.cjs', 'compatibility/m2/runner-trace-adoption/playwright.config.cjs', 'tools/run-runner-trace-adoption-tests.mjs', 'node_modules/playwright/lib/worker/workerProcessEntry.js'];
const inputs = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(path))])));
const report = { status: 'running', ...runtimeMetadata, inputs: await inputs(), outcomes: {}, comparisons: [], scope: 'Actual pinned runner with private candidate earliest instance adapter and production final-stop journal owner. No browser/native capture, public automatic policy or aggregate capture-budget claim.' };
const collected = {};
const zipPaths = [];
function attempts(suites, result = []) {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) for (const attempt of test.results) result.push({ project: test.projectName, title: spec.title, retry: attempt.retry, status: attempt.status, expectedStatus: test.expectedStatus, attachments: attempt.attachments });
    attempts(suite.suites ?? [], result);
  }
  return result;
}
async function readZip(path) {
  const zip = new utils.ZipFile(path);
  try { return Object.fromEntries(await Promise.all((await zip.entries()).map(async name => [name, await zip.read(name)]))); }
  finally { zip.close(); }
}
function withoutClocks(records) {
  return records.map(record => Object.fromEntries(Object.entries(record).filter(([name]) => !['startTime', 'endTime', 'timestamp', 'wallTime', 'monotonicTime'].includes(name))));
}
function validateClocks(records) {
  const origin = records[0].monotonicTime;
  assert.ok(Number.isFinite(origin));
  const starts = new Map();
  for (const record of records) {
    const time = record.startTime ?? record.endTime ?? record.timestamp;
    if (time !== undefined) assert.ok(Number.isFinite(time) && time >= origin, 'events retain the original monotonic clock domain');
    if (record.type === 'before') starts.set(record.callId, record.startTime);
    if (record.type === 'after') assert.ok(record.endTime >= starts.get(record.callId), 'completion follows its original start');
  }
}
try {
  for (const engine of ['playwright', 'flashwright']) {
    const folder = join(destination, engine); await mkdir(folder);
    const child = spawn('python3', ['tools/watchdog.py', '--timeout', '90', '--report-directory', join(folder, 'watchdog'), '--', process.execPath, 'node_modules/playwright/cli.js', 'test', '--config', join(destination, 'playwright.config.cjs')], {
      stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_ADOPTION_ENGINE: engine, FLASHWRIGHT_ADOPTION_OUTPUT: join(folder, 'output'), FLASHWRIGHT_ADOPTION_RESULTS: join(folder, 'results.json'), FLASHWRIGHT_ADOPTION_EVENTS: join(folder, 'events.jsonl'), FLASHWRIGHT_ADOPTION_MODULE: resolve('packages/flashwright-runner/dist/commonjs/runner-trace-journal.js') },
    });
    const exitCode = await new Promise((complete, reject) => { child.on('error', reject); child.on('close', complete); });
    assert.equal(exitCode, 0, `${engine} original expected outcomes`);
    const results = JSON.parse(await readFile(join(folder, 'results.json'), 'utf8'));
    assert.equal(results.stats.expected, 32); assert.equal(results.stats.flaky, 8); assert.equal(results.stats.unexpected, 0); assert.equal(results.stats.skipped, 8);
    const records = attempts(results.suites); assert.equal(records.length, 56);
    const phases = (await readFile(join(folder, 'events.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    report.outcomes[engine] = { stats: results.stats, attempts: records.map(({ attachments, ...attempt }) => ({ ...attempt, traces: attachments.filter(item => item.name === 'trace').length })), phases: phases.map(({ records, ...phase }) => phase), maximumOriginalRecords: Math.max(...phases.map(phase => phase.records ?? 0)), archives: [] };
    if (engine === 'flashwright') assert.equal(report.outcomes[engine].maximumOriginalRecords, 0);
    collected[engine] = new Map();
    for (const attempt of records) {
      const trace = attempt.attachments.find(item => item.name === 'trace');
      if (!trace) continue;
      const key = `${attempt.project}:${attempt.title}:${attempt.retry}`;
      const contents = await readZip(trace.path); collected[engine].set(key, contents); zipPaths.push(trace.path);
      report.outcomes[engine].archives.push({ key, path: trace.path, sha256: hash(await readFile(trace.path)) });
    }
    assert.equal(collected[engine].size, 14);
  }
  assert.deepEqual(report.outcomes.flashwright.attempts, report.outcomes.playwright.attempts);
  assert.deepEqual(report.outcomes.flashwright.phases, report.outcomes.playwright.phases);
  assert.deepEqual([...collected.flashwright.keys()], [...collected.playwright.keys()]);
  for (const [key, reference] of collected.playwright) {
    const candidate = collected.flashwright.get(key);
    assert.deepEqual(Object.keys(candidate).sort(), Object.keys(reference).sort(), `${key}: entry names`);
    for (const name of Object.keys(reference)) if (name !== 'test.trace') assert.deepEqual(candidate[name], reference[name], `${key}: original resource bytes`);
    const parse = bytes => bytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
    const referenceRecords = parse(reference['test.trace']); const candidateRecords = parse(candidate['test.trace']);
    validateClocks(referenceRecords); validateClocks(candidateRecords);
    assert.deepEqual(withoutClocks(candidateRecords), withoutClocks(referenceRecords), `${key}: every non-clock record field`);
    report.comparisons.push({ key, records: candidateRecords.length, resources: Object.keys(candidate).length - 1 });
  }
  execFileSync('python3', ['-c', 'import sys,zipfile\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive: assert archive.testzip() is None, path', ...zipPaths]);
  assert.deepEqual(await inputs(), report.inputs);
  report.status = 'passed'; report.zipCrcChecks = zipPaths.length;
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Runner trace adoption evidence: ${destination}/report.json`); }
