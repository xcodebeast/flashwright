import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createFinalGoalClock } from './final-goal-clock.mjs';

const projectDirectory = resolve(import.meta.dirname, '..');
const python = process.env.FLASHWRIGHT_PYTHON_PATH ?? 'python3';
const pythonClock = JSON.parse(spawnSync(python, ['-c', `
import json,time
print(json.dumps({'schemaVersion':1,'type':'monotonic','implementation':time.get_clock_info('monotonic').implementation,
 'identity':'0123456789abcdef0123456789abcdef','originNanoseconds':str(time.monotonic_ns()),
 'resolutionSeconds':time.get_clock_info('monotonic').resolution}))
`], { encoding: 'utf8' }).stdout);

test('native Bun readings bracket independent Python OS-clock observations without fitted offsets', async () => {
  const clock = await createFinalGoalClock(pythonClock);
  const child = spawn(python, ['-u', '-c', `
import json,sys,time
for line in sys.stdin:
    print(json.dumps({'nanoseconds':str(time.monotonic_ns()),'implementation':time.get_clock_info('monotonic').implementation}),flush=True)
`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const terminal = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    for (let index = 0; index < 12; index++) {
      const before = clock.nowNanoseconds();
      child.stdin.write('sample\n');
      const line = await iterator.next();
      assert.equal(line.done, false);
      const observation = JSON.parse(line.value);
      const after = clock.nowNanoseconds();
      assert.equal(observation.implementation, clock.metadata.implementation);
      const timestamp = BigInt(observation.nanoseconds);
      assert.ok(before <= timestamp && timestamp <= after,
        `OS clock observation ${timestamp} escaped native bracket [${before}, ${after}]`);
    }
    child.stdin.end();
    assert.deepEqual(await terminal, [0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    lines.close();
    clock.close();
  }
});

test('closed and incompatible capture records fail before emitting a timestamp', async () => {
  for (const changed of [
    { implementation: pythonClock.implementation === 'mach_absolute_time()' ? 'clock_gettime(CLOCK_MONOTONIC)' : 'mach_absolute_time()' },
    { implementation: 'clock_gettime(CLOCK_MONOTONIC_RAW)' },
    { originNanoseconds: '-1' },
    { originNanoseconds: '18446744073709551615' },
    { identity: 'missing' },
    { schemaVersion: 2 },
    { resolutionSeconds: pythonClock.resolutionSeconds * 2 },
  ]) await assert.rejects(createFinalGoalClock({ ...pythonClock, ...changed }));
  const clock = await createFinalGoalClock(pythonClock);
  assert.equal(typeof clock.nowNanoseconds(), 'bigint');
  clock.close();
  clock.close();
  assert.throws(() => clock.nowNanoseconds(), /closed/);
});

test('caller mutation during native module loading cannot relabel the original capture', async () => {
  const input = { ...pythonClock };
  const pending = createFinalGoalClock(input);
  input.identity = 'relabelled';
  input.originNanoseconds = '18446744073709551615';
  input.resolutionSeconds *= 2;
  const clock = await pending;
  try {
    assert.equal(clock.metadata.captureIdentity, pythonClock.identity);
    assert.equal(clock.metadata.originNanoseconds, pythonClock.originNanoseconds);
    assert.ok(clock.nowNanoseconds() >= BigInt(pythonClock.originNanoseconds));
  } finally { clock.close(); }
});

test('separate Bun processes retain the actual watchdog origin and a common OS time domain', async () => {
  await mkdir(join(projectDirectory, 'workbench'), { recursive: true });
  const directory = await mkdtemp(join(projectDirectory, 'workbench', 'flashwright-final-clock-test-'));
  const clockModule = new URL('./final-goal-clock.mjs', import.meta.url).href;
  const watchdog = join(projectDirectory, 'tools/watchdog.py');
  const worker = join(directory, 'worker.mjs');
  const controller = join(directory, 'controller.py');
  const resources = join(directory, 'resources.json');
  const output = join(directory, 'observations.json');
  try {
    await writeFile(worker, `
      import { createFinalGoalClock } from ${JSON.stringify(clockModule)};
      const original = JSON.parse(process.env.FLASHWRIGHT_WATCHDOG_CLOCK);
      const clock = await createFinalGoalClock(original);
      console.log(JSON.stringify({ original, metadata: clock.metadata,
        nanoseconds: clock.nowNanoseconds().toString(), process: process.pid }));
      clock.close();
    `);
    await writeFile(controller, `
import json,os,pathlib,subprocess,sys,time
before=time.monotonic_ns()
children=[subprocess.Popen([sys.argv[1],sys.argv[2]],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(4)]
observations=[]
for child in children:
    output,diagnostics=child.communicate(timeout=10)
    assert child.returncode==0,diagnostics
    observations.append(json.loads(output))
after=time.monotonic_ns()
pathlib.Path(sys.argv[3]).write_text(json.dumps({'beforeNanoseconds':str(before),'afterNanoseconds':str(after),'observations':observations}))
    `);
    const result = spawnSync(python, [watchdog, '--timeout', '15', '--report', resources, '--', python,
      controller, process.execPath, worker, output], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(await readFile(resources, 'utf8'));
    const observations = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(new Set(observations.observations.map(entry => entry.process)).size, 4);
    const before = BigInt(observations.beforeNanoseconds);
    const after = BigInt(observations.afterNanoseconds);
    assert.ok(BigInt(report.clock.originNanoseconds) <= before && before < after);
    for (const observation of observations.observations) {
      assert.deepEqual(observation.original, report.clock);
      assert.equal(observation.metadata.captureIdentity, report.clock.identity);
      const timestamp = BigInt(observation.nanoseconds);
      assert.ok(before <= timestamp && timestamp <= after);
    }
    assert.equal(report.exitCode, 0);
    assert.equal(report.timedOut, false);
    assert.equal(report.interrupted, false);
    assert.deepEqual(report.cleanupSignals, []);
    assert.deepEqual(report.remainingObservedProcesses, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
