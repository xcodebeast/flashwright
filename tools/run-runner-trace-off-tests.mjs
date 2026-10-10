import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';

const destination = resolve(process.argv[2] ?? `compatibility/evidence/runner-trace-off-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const readEvents = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), outcomes: {}, scope: 'Disabled trace journals, earliest user-fixture admission, retries/skips/early failures and preserved public reporter data. The reference uses artifact-free upstream _baseTest; candidate default failure documents are separately asserted. No automatic enabled trace or performance claim.' };
try {
  for (const engine of ['playwright', 'flashwright']) {
    const directory = join(destination, engine);
    await mkdir(directory);
    for (const filename of ['playwright.config.cjs', 'trace-off.spec.cjs', 'reporter.cjs']) {
      await writeFile(join(directory, filename), await readFile(`compatibility/m2/runner-trace-off/${filename}`));
    }
    const executable = engine === 'playwright' ? 'node_modules/playwright/cli.js' : 'packages/flashwright-test/cli.cjs';
    const child = spawn('python3', ['tools/watchdog.py', '--timeout', '90', '--report-directory', join(directory, 'resources'), '--', process.execPath, executable, 'test', '--config', join(directory, 'playwright.config.cjs')], {
      stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_TRACE_OFF_ENGINE: engine, FLASHWRIGHT_TRACE_OFF_EVENTS: join(directory, 'events.jsonl'), FLASHWRIGHT_TRACE_OFF_REPORTER: join(directory, 'reporter.jsonl'), FLASHWRIGHT_TRACE_OFF_RESULTS: join(directory, 'results.json'), FLASHWRIGHT_TRACE_OFF_OUTPUT: join(directory, 'output') },
    });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const outcome = report.outcomes[engine] = { code };
    assert.equal(code, 0, `${engine} disabled-trace runner must pass`);
    const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
    outcome.stats = results.stats;
    assert.equal(results.stats.expected, 3);
    assert.equal(results.stats.flaky, 1);
    assert.equal(results.stats.skipped, 2);
    assert.equal(results.stats.unexpected, 0);
    const events = await readEvents(join(directory, 'events.jsonl'));
    outcome.phases = events.map(({ phase, title, retry, outsideTest }) => ({ phase, title, retry, outsideTest }));
    outcome.maximumTraceEvents = Math.max(...events.map(event => event.traceEvents ?? 0));
    if (engine === 'flashwright') assert.equal(outcome.maximumTraceEvents, 0);
    else assert(outcome.maximumTraceEvents > 200, 'reference must exercise retained trace records while disabled');
    const reporter = await readEvents(join(directory, 'reporter.jsonl'));
    outcome.publicSteps = reporter.filter(event => event.type === 'step' && event.step.startsWith('reporter step '));
    assert.equal(outcome.publicSteps.length, 100);
    assert(outcome.publicSteps.every(event => !event.error));
    outcome.publicResults = reporter.filter(event => event.type === 'result');
    // This control intentionally uses upstream _baseTest without its automatic artifact fixtures.
    outcome.defaultFailureDocuments = outcome.publicResults.flatMap(result => result.attachments.filter(attachment => attachment.name === 'error-context').map(attachment => ({ title: result.title, retry: result.retry, ...attachment })));
    assert.equal(outcome.defaultFailureDocuments.length, engine === 'flashwright' ? 2 : 0);
    for (const document of outcome.defaultFailureDocuments) {
      assert.equal(document.contentType, 'text/markdown');
      assert.match(await readFile(document.path, 'utf8'), /intentional (first-attempt|early fixture) failure/);
    }
    const successor = outcome.publicResults.find(event => event.title === 'ordinary successor');
    assert.deepEqual(successor.attachments, [{ name: 'retained attachment', contentType: 'text/plain', body: Buffer.from('reporter attachment').toString('base64') }]);
    outcome.stdio = ['stdout', 'stderr'].flatMap(type => reporter.filter(event => event.type === type));
    assert.deepEqual(outcome.stdio, [{ type: 'stdout', text: 'trace-off stdout marker\n' }, { type: 'stderr', text: 'trace-off stderr marker\n' }]);
    assert(!(await readdir(join(directory, 'output'), { recursive: true })).some(path => path.endsWith('.zip')), 'disabled tracing must not create archives');
    outcome.inputs = Object.fromEntries(await Promise.all(['results.json', 'events.jsonl', 'reporter.jsonl'].map(async path => [path, hash(await readFile(join(directory, path)))])));
  }
  for (const field of ['phases', 'publicSteps', 'stdio']) assert.deepEqual(report.outcomes.flashwright[field], report.outcomes.playwright[field], `public ${field} must match`);
  const comparableResults = outcome => outcome.publicResults.map(result => ({ ...result, attachments: result.attachments.filter(attachment => attachment.name !== 'error-context') }));
  assert.deepEqual(comparableResults(report.outcomes.flashwright), comparableResults(report.outcomes.playwright), 'explicit public reporter results must match; default failure documents are separately asserted against the artifact-free control');
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Runner disabled-trace evidence: ${destination}/report.json`);
}
