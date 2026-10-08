import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';

const variants = { previous: '.cache/frame-pacing-001/condition-registry-before.js', current: 'packages/resident-runtime/condition-registry.js' };
const results = [];
for (const [variant, path] of Object.entries(variants)) {
  const source = await readFile(path, 'utf8');
  for (const conditionCount of [1, 32, 128]) {
    for (const checkCostMilliseconds of [0, 0.05]) {
      const clock = { now: 0, nextToken: 0, callbacks: new Map() };
      const create = new Function('clock', `
        const performance = {now:() => clock.now};
        const globalThis = {addEventListener(){},removeEventListener(){}};
        const document = {};
        const schedule = (callback, deadline, kind) => {
          const token = ++clock.nextToken;
          clock.callbacks.set(token, {callback,deadline,kind});
          return token;
        };
        const requestAnimationFrame = callback => schedule(callback, Math.ceil((clock.now + 0.0001) / 16) * 16, 'frame');
        const cancelAnimationFrame = token => clock.callbacks.delete(token);
        const setTimeout = (callback, delay) => schedule(callback, clock.now + Math.max(1, delay), 'timer');
        const clearTimeout = token => clock.callbacks.delete(token);
        ${source}
        return createConditionRegistry({instrumentation:true,observeMutations:false});
      `);
      const registry = create(clock);
      const waits = Array.from({ length: conditionCount }, (_, index) => registry.wait({ token: 'condition-' + index, check: () => {
        clock.now += checkCostMilliseconds;
        return { status: 'observation', matches: false };
      } }));
      const drain = async () => {
        for (let attempts = 0; attempts < 1000; attempts++) {
          await setImmediate();
          const state = registry.inspect();
          if (!state.queuedConditions && !state.flushMicrotaskScheduled && !state.flushTaskScheduled && !state.fallbackSchedulingQueued) return;
        }
        throw new Error('Controlled registry work did not drain');
      };
      await drain();
      let dispatched = 0;
      while (true) {
        const next = [...clock.callbacks.entries()].sort((left, right) => left[1].deadline - right[1].deadline)[0];
        if (!next || next[1].deadline >= 1000) break;
        assert.ok(++dispatched < 10000);
        clock.callbacks.delete(next[0]);
        clock.now = Math.max(clock.now, next[1].deadline);
        next[1].callback();
        await drain();
      }
      const counters = registry.inspect();
      registry.dispose();
      assert.ok((await Promise.all(waits)).every(result => result.status === 'cancelled'));
      await drain();
      assert.equal(clock.callbacks.size, 0);
      results.push({ variant, sourceSha256: createHash('sha256').update(source).digest('hex'), conditionCount, checkCostMilliseconds, simulatedMilliseconds: clock.now, dispatched, counters });
    }
  }
}
const report = { scope: 'Controlled Node registry clock, synthetic predicate cost, fixed 16 ms frame grid and 1 ms minimum timer delay. Scheduling diagnostic only; no real-browser latency, CPU, semantics or speed claim.', results };
await writeFile('compatibility/evidence/resident-frame-pacing-exploration-2026-10-08/timer-probe.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
for (const result of results) console.log(JSON.stringify({ variant: result.variant, conditions: result.conditionCount, checkCost: result.checkCostMilliseconds, frames: result.counters.animationFrameChecks, timers: result.counters.timerFallbackChecks, predicates: result.counters.predicateEvaluations, deferred: result.counters.fallbackConditionsDeferred }));
