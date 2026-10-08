import assert from 'node:assert/strict';

/** Exercise the scheduling clock separately from real-browser detection and cleanup. */
export async function verifyConditionFallbackCadence({ reset, evaluate, page, start, finish, clean, cases, registrySource }) {
  await reset('<p>unchanged</p>');
  const clocked = await evaluate(`(async () => {
    let now = 0;
    let frame;
    let nextTimer = 0;
    const timers = new Map();
    const performance = {now:() => now};
    const requestAnimationFrame = callback => { frame = callback; return 1; };
    const cancelAnimationFrame = () => { frame = undefined; };
    const setTimeout = (callback, delay) => {
      const token = ++nextTimer; timers.set(token, {callback,deadline:now + delay}); return token;
    };
    const clearTimeout = token => timers.delete(token);
    ${registrySource}
    const registry = createConditionRegistry({instrumentation:true,observeMutations:false});
    const checks = {long:0,short:0};
    const drain = async () => {
      const deadline = globalThis.performance.now() + 2000;
      do {
        await new Promise(resolve => globalThis.setTimeout(resolve, 0));
        const state = registry.inspect();
        if (!state.queuedConditions && !state.flushMicrotaskScheduled && !state.flushTaskScheduled) return;
      } while (globalThis.performance.now() < deadline);
      throw new Error('Registry queue did not drain before advancing the controlled clock');
    };
    const advanceFrame = async time => {
      now = time;
      const callback = frame;
      frame = undefined;
      callback();
      await drain();
      return {...checks};
    };
    const long = registry.wait({token:'long',check:() => {
      checks.long++; return {status:'observation',matches:false};
    }});
    try {
      await drain();
      const frames = [];
      for (const time of [16,32,96,100,120,128]) frames.push(await advanceFrame(time));
      now = 129;
      globalThis.dispatchEvent(new Event('input'));
      await drain();
      const afterEvent = {...checks};
      const afterRecentEvent = await advanceFrame(145);
      const short = registry.wait({token:'short',timeoutMilliseconds:25,check:() => {
        checks.short++; return {status:'observation',matches:false};
      }});
      await drain();
      const afterNewCondition = await advanceFrame(146);
      const afterInterval = await advanceFrame(161);
      now = 170;
      // Dispatch the independent deadline timer, without advancing the fallback frame.
      const deadline = [...timers.entries()].find(([,timer]) => timer.deadline === 170);
      if (!deadline) throw new Error('Short condition omitted its deadline timer');
      timers.delete(deadline[0]);
      deadline[1].callback();
      const shortResult = await short;
      registry.cancel('long');
      const longResult = await long;
      return {frames,afterEvent,afterRecentEvent,afterNewCondition,afterInterval,shortResult,longResult,
        state:registry.inspect(),timers:timers.size,framePending:frame !== undefined};
    } finally { registry.dispose(); }
  })()`);
  assert.deepEqual(clocked.frames.map(check => check.long), [2, 3, 4, 4, 4, 5]);
  assert.deepEqual(clocked.afterEvent, { long: 6, short: 0 });
  assert.deepEqual(clocked.afterRecentEvent, { long: 6, short: 0 });
  assert.deepEqual(clocked.afterNewCondition, { long: 6, short: 2 });
  assert.deepEqual(clocked.afterInterval, { long: 7, short: 3 });
  assert.equal(clocked.shortResult.status, 'expired');
  assert.equal(clocked.shortResult.observation.matches, false);
  assert.equal(clocked.longResult.status, 'cancelled');
  assert.ok(clocked.state.fallbackConditionsDeferred > 0);
  assert.equal(clocked.state.activeConditions, 0);
  assert.equal(clocked.state.flushChannelOpen, false);
  assert.equal(clocked.timers, 0);
  assert.equal(clocked.framePending, false);
  cases.push({ name: 'paced fallback preserves fresh-condition frames, immediate events and independent deadlines', clocked,
    scope: 'Controlled registry clock and fallback callbacks; no browser latency or performance claim.' });
  console.log(`Resident registry: ${cases.at(-1).name}`);

  await reset('<style>p { visibility:hidden }</style><p>target</p><input value="before"><div id="host"></div>');
  const tokens = [
    await start({ selector: 'css=input', expression: 'to.have.value', request: { expectedText: [{ string: 'after' }] } }),
    await start({ selector: 'css=p', expression: 'to.be.visible' }),
    await start({ selector: 'css=#host i', expression: 'to.have.text', request: { expectedText: [{ string: 'after' }] } }),
  ];
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    document.querySelector('input').value = 'after';
    document.styleSheets[0].cssRules[0].style.visibility = 'visible';
    document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<i>after</i>';
  });
  for (const token of tokens) await finish(token);
  const late = await clean('long-pending property, CSSOM and new-shadow conditions still detect fresh state');
  assert.equal(late.mutationBatches, 0);
  assert.ok(late.fallbackConditionsDeferred > 0);

  await reset('<p>before</p>', true, false, true, true);
  const mutation = await start({ selector: 'css=p', expression: 'to.have.text', request: { expectedText: [{ string: 'after' }] } });
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.querySelector('p').textContent = 'after'; });
  await finish(mutation);
  const awakened = await clean('long-pending mutation still wakes with both fallback callbacks withheld');
  assert.ok(awakened.mutationBatches > 0);
  assert.equal(awakened.fallbackChecks, 0);
}
