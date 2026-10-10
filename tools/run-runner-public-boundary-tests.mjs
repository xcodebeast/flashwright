import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), checks: [] };
const cases = [
  ['slow-disposal', { trace: 'on' }, 'original boundary failure'],
  ['slow-readiness', { trace: 'on' }, undefined],
  ['live', { trace: { mode: 'on', live: true } }, 'UnsupportedFeatureError: test.use.trace.live'],
  ['unknown-option', { trace: { mode: 'on', unknown: true } }, 'UnsupportedFeatureError: test.use.trace.unknown'],
  ['invalid-mode', { trace: 'invalid' }, 'InvalidArgumentError: test.use.trace.mode'],
  ['invalid-boolean', { trace: { mode: 'on', snapshots: 'yes' } }, 'InvalidArgumentError: test.use.trace.snapshots'],
  ['video', { trace: 'off', video: 'on' }, 'UnsupportedFeatureError: test.use.video'],
];
try {
  for (const [name, use, expectedError] of cases) {
    const directory = join(destination, name);
    await mkdir(directory);
    await writeFile(join(directory, 'boundaries.spec.cjs'), await readFile('compatibility/m2/runner-public-boundaries/boundaries.spec.cjs'));
    await writeFile(join(directory, 'playwright.config.cjs'), `module.exports = ${JSON.stringify({ testDir: directory, testMatch: 'boundaries.spec.cjs', timeout: 300, workers: 1, retries: 0, use, outputDir: join(directory, 'output'), reporter: [['json', { outputFile: join(directory, 'results.json') }]] })};`);
    const child = spawn('python3', ['tools/watchdog.py', '--timeout', '45', '--report-directory', join(directory, 'watchdog'), '--', process.execPath, 'packages/flashwright-test/cli.cjs', 'test', '--config', join(directory, 'playwright.config.cjs')], {
      env: { ...process.env, FLASHWRIGHT_PUBLIC_BOUNDARY_CASE: name, FLASHWRIGHT_PUBLIC_BOUNDARY_MODULES: resolve('packages/flashwright-runner/dist/commonjs') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
    const exitCode = await new Promise((complete, reject) => { child.on('error', reject); child.on('close', complete); });
    await writeFile(join(directory, 'runner.log'), log);
    assert.equal(exitCode, expectedError ? 1 : 0, log);
    const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
    assert.equal(results.errors.length, 0);
    assert.equal(results.stats.unexpected, expectedError ? 1 : 0);
    assert.equal(results.stats.expected, expectedError ? 0 : 1);
    const attempt = results.suites[0].specs[0].tests[0].results[0];
    assert.equal(attempt.status, expectedError ? 'failed' : 'passed');
    assert.equal(attempt.errors.length, expectedError ? 1 : 0, JSON.stringify(attempt.errors));
    if (expectedError) assert(attempt.errors[0].message.includes(expectedError), attempt.errors[0].message);
    const standardOutput = attempt.stdout.map(item => item.text ?? Buffer.from(item.buffer, 'base64').toString()).join('');
    assert(!standardOutput.includes('UNEXPECTED_PUBLIC_TEST_BODY'));
    assert(!standardOutput.includes('UNEXPECTED_PUBLIC_HOOK'));
    assert(!standardOutput.includes('UNEXPECTED_PUBLIC_FIXTURE'));
    if (name === 'slow-readiness') assert(standardOutput.includes('ORIGINAL_TEST_BODY_REACHED'));
    if (name === 'slow-disposal') {
      assert(standardOutput.includes('ORIGINAL_ARTIFACT_DISPOSAL_SETTLED'));
      assert.equal(attempt.attachments.filter(attachment => attachment.name === 'trace').length, 1);
      assert.equal(attempt.attachments.filter(attachment => attachment.name === 'trace-error').length, 0);
    }
    report.checks.push({ name, status: attempt.status, errors: attempt.errors.map(error => error.message), attachments: attempt.attachments.map(attachment => attachment.name) });
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error }));
}
