import assert from 'node:assert/strict';

/** Advance frame and deadline sources independently; events cannot stand in for frames. */
export async function verifyFrameHints({ reset, evaluate, cases, registrySource }) {
  await reset('<div id="target"></div>');
  const result = await evaluate(`(async () => {
    let now = 0, nextToken = 0;
    const frames = new Map(), timers = new Map();
    const performance = { now: () => now };
    const requestAnimationFrame = callback => { const token = ++nextToken; frames.set(token, callback); return token; };
    const cancelAnimationFrame = token => frames.delete(token);
    const setTimeout = (callback, delay) => { const token = ++nextToken; timers.set(token, {callback, deadline:now + delay}); return token; };
    const clearTimeout = token => timers.delete(token);
    ${registrySource}
    const registry = createConditionRegistry({instrumentation:true});
    const drain = async () => {
      for (let attempts = 0; attempts < 100; attempts++) {
        await new Promise(resolve => globalThis.setTimeout(resolve, 0));
        const s = registry.inspect();
        if (!s.queuedConditions && !s.flushMicrotaskScheduled && !s.flushTaskScheduled && !s.fallbackSchedulingQueued) return;
      }
      throw new Error('Frame-hint scheduling did not drain');
    };
    const frame = async time => {
      now = time;
      const batch = [...frames.values()]; frames.clear();
      if (batch.length !== 1) throw new Error('Expected one shared frame callback');
      batch[0](time); await drain();
    };
    const dueTimers = async time => {
      now = time;
      for (const [token, timer] of [...timers]) {
        if (timer.deadline <= now) { timers.delete(token); timer.callback(); }
      }
      await drain();
    };
    let checks = 0, ordinaryChecks = 0, ordinaryReady = false, rectangle = 0, previous;
    const observations = [];
    const sample = () => {
      checks++; observations.push({now, rectangle});
      const matches = previous === rectangle; previous = rectangle;
      return {status:'observation', matches};
    };
    const hint = registry.wait({token:'hint', animationFramesOnly:true, timeoutMilliseconds:500, check:sample});
    const ordinary = registry.wait({token:'ordinary', timeoutMilliseconds:600, check:() => {
      ordinaryChecks++; return {status:'observation', matches:ordinaryReady};
    }});
    try {
      await drain(); const initial = {checks, ordinaryChecks, frames:frames.size};
      document.querySelector('#target').setAttribute('data-before-frame', 'yes');
      globalThis.dispatchEvent(new Event('input'));
      await drain(); const beforeFrame = {checks, ordinaryChecks};
      await frame(16);
      document.querySelector('#target').setAttribute('data-same-frame', 'yes');
      globalThis.dispatchEvent(new Event('scroll'));
      await drain(); const sameFrame = {checks, ordinaryChecks};
      rectangle = 1; await frame(32);
      rectangle = 2; await frame(96);
      // Drain due discovery work without manufacturing a frame.
      const beforeTimer = checks; await dueTimers(100); const afterTimer = checks;
      rectangle = 3; await frame(116);
      rectangle = 4; await frame(132);
      const pastFastWindow = {checks, frames:frames.size};
      const timerIsolation = {hintBefore:checks, ordinaryBefore:ordinaryChecks, timerBefore:registry.inspect().timerFallbackChecks};
      const fallbackDeadline = Math.min(...[...timers.values()].map(timer => timer.deadline).filter(deadline => deadline > now));
      await dueTimers(fallbackDeadline);
      Object.assign(timerIsolation, {deadline:fallbackDeadline, hintAfter:checks, ordinaryAfter:ordinaryChecks, timerAfter:registry.inspect().timerFallbackChecks});
      // Replacing the document's registry listeners does not manufacture a frame.
      registry.documentReplaced(); await drain(); const afterReplacement = checks;
      await frame(184);
      const hintResult = await hint;
      ordinaryReady = true;
      globalThis.dispatchEvent(new Event('change')); await drain();
      const ordinaryResult = await ordinary;
      const clean = {state:registry.inspect(), frames:frames.size, timers:timers.size};

      let replacementChecks = 0;
      const replacement = registry.wait({token:'replacement', animationFramesOnly:true, timeoutMilliseconds:500,
        check:() => { replacementChecks++; return {status:'observation', matches:false}; }});
      await drain();
      now = 200;
      const queuedFrame = [...frames.values()][0]; frames.clear(); queuedFrame(200);
      // Replace before the queued predicate microtask runs. Its old queue entry
      // is retired, but its registration must resume on the next fresh frame.
      registry.documentReplaced(); await drain();
      const queuedReplacement = {checks:replacementChecks, frames:frames.size};
      await frame(216);
      const resumedReplacement = replacementChecks;
      registry.cancel('replacement'); await replacement;

      let cancelledChecks = 0;
      const cancelled = registry.wait({token:'cancelled', animationFramesOnly:true, timeoutMilliseconds:500,
        check:() => { cancelledChecks++; return {status:'observation', matches:false}; }});
      await drain(); const staleFrame = [...frames.values()][0];
      registry.cancel('cancelled'); const cancelledResult = await cancelled;
      const afterCancel = {state:registry.inspect(), frames:frames.size, timers:timers.size};
      let successorChecks = 0;
      const successor = registry.wait({token:'successor', animationFramesOnly:true, timeoutMilliseconds:500,
        check:() => { successorChecks++; return {status:'observation', matches:false}; }});
      await drain(); staleFrame(217); await drain();
      const afterStale = {cancelledChecks, successorChecks, frames:frames.size};
      // Withhold every live frame. The independent deadline must still release it.
      await dueTimers(716); const expiredResult = await successor;
      const afterExpiry = {state:registry.inspect(), frames:frames.size, timers:timers.size, successorChecks};
      let unboundedRejected = false;
      try { registry.wait({token:'unbounded', animationFramesOnly:true, check:sample}); }
      catch { unboundedRejected = true; }
      return {initial,beforeFrame,sameFrame,beforeTimer,afterTimer,pastFastWindow,afterReplacement,observations,
        hintResult,ordinaryResult,clean,timerIsolation,queuedReplacement,resumedReplacement,cancelledResult,afterCancel,afterStale,expiredResult,afterExpiry,unboundedRejected};
    } finally { registry.dispose(); }
  })()`);
  assert.deepEqual(result.initial, { checks: 0, ordinaryChecks: 1, frames: 1 });
  assert.equal(result.beforeFrame.checks, 0);
  assert.ok(result.beforeFrame.ordinaryChecks > 1);
  assert.equal(result.sameFrame.checks, 1);
  assert.ok(result.sameFrame.ordinaryChecks > result.beforeFrame.ordinaryChecks);
  assert.equal(result.beforeTimer, result.afterTimer);
  assert.equal(result.pastFastWindow.frames, 1);
  assert.equal(result.afterReplacement, result.pastFastWindow.checks);
  assert.deepEqual(result.observations, [
    { now: 16, rectangle: 0 }, { now: 32, rectangle: 1 }, { now: 96, rectangle: 2 },
    { now: 116, rectangle: 3 }, { now: 132, rectangle: 4 }, { now: 184, rectangle: 4 },
  ]);
  assert.equal(result.timerIsolation.deadline, 168);
  assert.equal(result.timerIsolation.hintBefore, result.timerIsolation.hintAfter);
  assert.ok(result.timerIsolation.timerAfter > result.timerIsolation.timerBefore);
  assert.ok(result.timerIsolation.ordinaryAfter > result.timerIsolation.ordinaryBefore);
  assert.equal(result.hintResult.status, 'matched');
  assert.equal(result.ordinaryResult.status, 'matched');
  assert.deepEqual(result.queuedReplacement, { checks: 0, frames: 1 });
  assert.equal(result.resumedReplacement, 1);
  assert.equal(result.cancelledResult.status, 'cancelled');
  assert.deepEqual(result.afterStale, { cancelledChecks: 0, successorChecks: 0, frames: 1 });
  assert.equal(result.expiredResult.status, 'expired');
  assert.equal(result.afterExpiry.successorChecks, 0);
  assert.equal(result.unboundedRejected, true);
  for (const snapshot of [result.clean, result.afterCancel, result.afterExpiry]) {
    assert.equal(snapshot.frames, 0);
    assert.equal(snapshot.timers, 0);
    for (const key of ['activeConditions', 'observedRoots', 'queuedDiscovery', 'queuedConditions']) assert.equal(snapshot.state[key], 0, key);
    for (const key of ['fallbackSchedulingQueued', 'animationFrameScheduled', 'fallbackTimerScheduled', 'deadlineTimerScheduled', 'discoveryTimerScheduled', 'flushMicrotaskScheduled', 'flushTaskScheduled', 'flushChannelOpen']) assert.equal(snapshot.state[key], false, key);
  }
  cases.push({ name: 'bounded frame hints ignore event and timer duplicates, preserve ordinary wakeups and retire stale callbacks', result,
    scope: 'Controlled registry scheduler inside the real browser; no performance or native-input claim.' });
  console.log(`Resident registry: ${cases.at(-1).name}`);
}
