import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runProcessSuite } from '../packages/flashwright-runner/dist/commonjs/independent/process-runner.js';
const root = resolve(import.meta.dirname, '..');
const destination = await mkdtemp(join(root, 'workbench/independent-process-tests-'));
const modulePath = join(root, 'compatibility/runner-process/fixture.cjs');
const title = result => JSON.parse(result.id).at(-1);
async function run(kind, options = {}) {
  const eventPath = join(destination, kind + '.jsonl');
  const result = await runProcessSuite({ modulePath, workers: 1, startupTimeoutMs: 5000, shutdownTimeoutMs: 2000, testWatchdogMs: 2000, killGraceMs: 100, ...options, env: { FW_PROCESS_CASE: kind, FW_PROCESS_EVENTS: eventPath } });
  await writeFile(join(destination, kind + '-result.json'), JSON.stringify(result, null, 2));
  const events = (await readFile(eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const worker of result.workers) {
    assert.notEqual(worker.exitCode === null && worker.signal === null, true, 'original child exit observed');
    assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
  }
  return { result, events };
}

test('parallel groups execute in separate processes and reuse successful worker fixtures', async () => {
  const { result, events } = await run('parallel', { workers: 4 });
  assert.equal(result.status, 'passed'); assert.equal(result.results.length, 8); assert.deepEqual(result.workerErrors, []);
  assert.equal(result.workers.length, 4); assert.equal(new Set(result.results.map(r => r.workerIndex)).size, 4);
  assert.equal(new Set(result.results.map(r => r.parallelIndex)).size, 4);
  assert.equal(events.filter(e => e.event === 'worker-setup').length, 4); assert.equal(events.filter(e => e.event === 'worker-teardown').length, 4);
  let active = 0, peak = 0;
  for (const event of events) { if (event.event === 'begin') peak = Math.max(peak, ++active); if (event.event === 'end') active--; }
  assert.equal(peak, 4); assert.equal(active, 0);
});

test('one worker serves multiple independent successful groups', async () => {
  const { result, events } = await run('reuse');
  assert.equal(result.status, 'passed'); assert.equal(result.workers.length, 1);
  assert.equal(events.filter(e => e.event === 'worker-setup').length, 1); assert.equal(events.filter(e => e.event === 'worker-teardown').length, 1);
});

test('failure retries in a fresh process before pending tests, preserving the slot', async () => {
  const { result } = await run('retry', { retries: 1 });
  assert.equal(result.status, 'passed'); assert.deepEqual(result.workerErrors, []);
  assert.deepEqual(result.results.map(r => [title(r), r.retry, r.status, r.workerIndex, r.parallelIndex]), [['A',0,'passed',0,0],['B',0,'failed',0,0],['B',1,'passed',1,0],['C',0,'passed',1,0]]);
  assert.equal(result.workers.length, 2); assert.ok(result.workers.every(w => !w.forcedTermination));
});

test('beforeAll failure skips its descendants and retries them at their next attempt', async () => {
  const { result } = await run('setup', { retries: 1 });
  assert.equal(result.status, 'passed'); assert.deepEqual(result.workerErrors, []);
  assert.deepEqual(result.results.map(r => [title(r),r.retry,r.status]), [['A',0,'failed'],['B',0,'skipped'],['A',1,'passed'],['B',1,'passed'],['C',0,'passed']]);
});

test('unexpected process exit preserves prior results and replaces the process', async () => {
  const { result } = await run('crash', { retries: 1 });
  assert.equal(result.status, 'passed'); assert.deepEqual(result.workerErrors, []);
  assert.deepEqual(result.results.map(r => [title(r),r.retry,r.status]), [['A',0,'passed'],['B',0,'crashed'],['B',1,'passed'],['C',0,'passed']]);
  assert.equal(result.workers[0].exitCode, 19);
});

test('watchdog terminates a blocked callback before a replacement process runs', async () => {
  const { result } = await run('hang', { retries: 1, testWatchdogMs: 200 });
  assert.equal(result.status, 'passed'); assert.deepEqual(result.workerErrors, []);
  assert.deepEqual(result.results.map(r => [title(r),r.retry,r.status]), [['A',0,'passed'],['B',0,'timedOut'],['B',1,'passed'],['C',0,'passed']]);
  assert.equal(result.workers[0].forcedTermination, true); assert.ok(result.workers[0].signal);
  assert.equal(result.results[1].errors[0].phase, 'watchdog');
});

test('normal worker teardown errors fail the run without rewriting successful test results', async () => {
  const { result } = await run('teardown');
  assert.equal(result.status, 'failed'); assert.ok(result.results.every(r => r.status === 'passed'));
  assert.deepEqual(result.workerErrors.map(e => [e.phase,e.message]), [['workerTeardown','worker cleanup sentinel']]);
});

test('a worker failure after its final done cannot turn into a passed suite', async () => {
  const { result } = await run('fatal-after-done');
  assert.equal(result.status, 'failed'); assert.ok(result.results.every(r => r.status === 'passed'));
  assert.ok(result.workerErrors.some(e => e.message.includes('failure after final result sentinel')));
});

test('watchdog escalation survives leader exit and kills a TERM-resistant descendant', { skip: process.platform !== 'linux' }, async () => {
  const { result, events } = await run('descendant', { testWatchdogMs: 300 });
  assert.equal(result.status, 'failed');
  const pid = events.find(e => e.event === 'descendant').childPid;
  // A reparented zombie has exited but is awaiting the host init's reap. Never
  // count a sleeping/runnable descendant as cleaned up merely because its leader exited.
  let state;
  for (let i = 0; i < 100; i++) {
    try { state = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1][0]; }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = undefined; }
    if (state === undefined || state === 'Z') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(state === undefined || state === 'Z', `descendant ${pid} still running (${state})`);
  assert.equal(result.results.find(r => title(r) === 'B').status, 'timedOut');
});

test('invalid process configuration rejects before launch', async () => {
  for (const options of [{ workers: 0 }, { workers: 1, retries: -1 }, { workers: 1, testWatchdogMs: NaN }]) await assert.rejects(runProcessSuite({ modulePath, ...options }), /Invalid/);
});
