import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHttpFixture } from './http-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';

assert.ok(process.argv[2], 'Usage: run-matcher-context-tests.mjs OUTPUT_DIRECTORY');
const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
const sources = await sourceManifest();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {},
  scope: 'Matcher error snapshots only; default failure artifact and fallback page capture remain unverified.' };
const { server, close } = createHttpFixture((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(request.url === '/child' ? '<!doctype html><button>Child original</button>'
    : '<!doctype html><title>Original title</title><h1>Page body</h1><button id="target">Original</button><button id="hidden" hidden>Hidden</button><iframe src="/child"></iframe>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const specifications = suites => suites.flatMap(suite => [...suite.specs, ...specifications(suite.suites ?? [])]);
try {
  for (const engine of ['playwright', 'flashwright']) {
    const directory = join(destination, engine);
    await mkdir(directory);
    const child = spawn('python3', ['tools/watchdog.py', '--timeout', '180', '--report', join(directory, 'resources.json'), '--', process.execPath,
      engine === 'playwright' ? 'node_modules/playwright/cli.js' : 'packages/flashwright-test/cli.cjs',
      'test', '--config', 'compatibility/m2/matcher-context/playwright.config.cjs'], {
      env: { ...process.env, FLASHWRIGHT_MATCHER_CONTEXT_ENGINE: engine,
        FLASHWRIGHT_MATCHER_CONTEXT_URL: `http://127.0.0.1:${server.address().port}`,
        FLASHWRIGHT_MATCHER_CONTEXT_REPORT: join(directory, 'runner.json'), FLASHWRIGHT_MATCHER_CONTEXT_OUTPUT: join(directory, 'artifacts') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [], errors = [];
    child.stdout.on('data', bytes => output.push(bytes));
    child.stderr.on('data', bytes => errors.push(bytes));
    const [code, signal] = await once(child, 'close');
    await writeFile(join(directory, 'stdout.txt'), Buffer.concat(output));
    await writeFile(join(directory, 'stderr.txt'), Buffer.concat(errors));
    assert.equal(code, 0, engine); assert.equal(signal, null);
    const resources = JSON.parse(await readFile(join(directory, 'resources.json'), 'utf8'));
    assert.equal(resources.timedOut, false); assert.deepEqual(resources.cleanupSignals, []); assert.deepEqual(resources.remainingObservedProcesses, []);
    const runner = JSON.parse(await readFile(join(directory, 'runner.json'), 'utf8'));
    assert.equal(runner.stats.unexpected + runner.stats.flaky + runner.stats.skipped, 0);
    const cases = specifications(runner.suites);
    assert.equal(cases.length, 12);
    report.outcomes[engine] = Object.fromEntries(cases.map(specification => {
      const attempts = specification.tests[0].results;
      assert.equal(attempts.length, 1);
      const passing = specification.title === 'passing matcher produces no error context';
      assert.equal(attempts[0].status, passing ? 'passed' : 'failed');
      assert.equal(attempts[0].errors.length, passing ? 0 : 1);
      // The JSON reporter projects errors onto location/message and omits errorContext.
      const attachment = attempts[0].attachments.find(item => item.name === 'matcher-context-observation');
      assert.ok(attachment);
      const retained = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
      assert.equal(retained.length, passing ? 0 : 1);
      return [specification.title, retained[0] ?? null];
    }));
  }
  for (const [title, reference] of Object.entries(report.outcomes.playwright)) {
    const candidate = report.outcomes.flashwright[title];
    if (title.startsWith('oversized')) {
      assert.ok(reference.length > 16384);
      assert.equal(candidate, reference.slice(0, 16384) + '\n# Diagnostic snapshot truncated at 16384 UTF-16 units');
    } else assert.equal(candidate, reference, title);
    if (title.includes('omits') || title.startsWith('passing')) assert.equal(candidate, null, title);
    else assert.ok(candidate, title);
  }
  assert.match(report.outcomes.flashwright['soft failure keeps original tree after later mutation'], /Original/);
  assert.doesNotMatch(report.outcomes.flashwright['soft failure keeps original tree after later mutation'], /Successor/);
  assert.deepEqual(await sourceManifest(), sources);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); throw error; }
finally { await close(); await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ status: report.status, destination }));
