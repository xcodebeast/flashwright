import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcessSuite } from '../../packages/flashwright-runner/dist/commonjs/independent/process-runner.js';
const root = resolve(import.meta.dirname, '../..');
const [destination, engine] = process.argv.slice(2);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><link rel="icon" href="data:,"><button onclick="window.trusted=event.isTrusted;this.textContent=\'clicked\'">ready</button>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, FW_TIMEOUT_URL: `http://127.0.0.1:${server.address().port}/`, FW_TIMEOUT_EVENTS: join(destination, 'events.jsonl') };
try {
  if (engine === 'candidate') {
    const result = await runProcessSuite({ modulePath: join(import.meta.dirname, 'browser-worker.cjs'), workers: 1, retries: 1, timeoutMs: 10000, startupTimeoutMs: 10000, shutdownTimeoutMs: 10000, env });
    await writeFile(join(destination, 'result.json'), JSON.stringify(result, null, 2));
    assert.equal(result.status, 'passed'); assert.deepEqual(result.workerErrors, []);
    assert.deepEqual(result.results.map(r => [r.retry, r.status]), [[0, 'timedOut'], [1, 'passed']]);
    assert.equal(result.workers.length, 2);
    for (const worker of result.workers) {
      assert.equal(worker.exitCode, 0); assert.equal(worker.signal, null); assert.equal(worker.forcedTermination, false);
      assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
    }
  } else {
    assert.equal(engine, 'reference');
    const child = spawn(process.execPath, [join(root, 'node_modules/playwright/cli.js'), 'test', '--config', join(destination, 'playwright.config.cjs')], { env, stdio: 'inherit' });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    assert.deepEqual(exit, { code: 0, signal: null });
    const report = JSON.parse(await readFile(join(destination, 'result.json')));
    const outcomes = []; const walk = s => { for (const spec of s.specs ?? []) for (const test of spec.tests) outcomes.push(...test.results.map(r => [r.retry, r.status])); for (const suite of s.suites ?? []) walk(suite); }; walk(report);
    assert.deepEqual(report.errors, []); assert.deepEqual(outcomes, [[0, 'timedOut'], [1, 'passed']]);
  }
  const events = (await readFile(env.FW_TIMEOUT_EVENTS, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.event), ['browser-open','context-open','fresh-state','evaluation-pending','afterEach','evaluation-rejected','context-closed','browser-closed','browser-open','context-open','fresh-state','trusted-click','afterEach','context-closed','browser-closed']);
  const fresh = events.filter(e => e.event === 'fresh-state');
  assert.notEqual(fresh[0].pid, fresh[1].pid); assert.notEqual(fresh[0].workerIndex, fresh[1].workerIndex); assert.equal(fresh[0].parallelIndex, fresh[1].parallelIndex);
  await writeFile(join(destination, 'verified.json'), JSON.stringify({ status: 'passed', engine, events, limitations: ['Selected native timeout/retry control, not complete cancellation or artifact admission. No performance measurement.'] }, null, 2));
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
