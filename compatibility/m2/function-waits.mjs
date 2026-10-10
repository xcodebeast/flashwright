import assert from 'node:assert/strict';

/** Execute the same predicate, ownership and lifecycle cases through each public implementation. */
export async function functionWaitCases(browser, baseURL, outcomes) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const retainValue = async (predicate, argument, options) => {
    const handle = await page.waitForFunction(predicate, argument, options);
    try { return await handle.jsonValue(); }
    finally { await handle.dispose(); }
  };
  try {
    await page.goto(baseURL);
    assert.equal(await retainValue(() => 42), 42);
    assert.equal(await retainValue('"é😃\\ud800\\0"'), 'é😃\ud800\0');
    const expressionHandle = await page.waitForFunction('(() => 42)');
    assert.equal(await expressionHandle.evaluate(value => [typeof value, value()]).then(value => value.join('/')), 'function/42');
    await expressionHandle.dispose();
    const method = { predicate(value) { return value.answer; } };
    assert.equal(await retainValue(method.predicate, { answer: 42 }), 42);
    outcomes.push('immediate-functions-expression-values-and-method-syntax');

    for (const polling of ['raf', 5]) {
      const handle = await page.waitForFunction(() => {
        globalThis.predicateVisits = (globalThis.predicateVisits ?? 0) + 1;
        return predicateVisits % 3 === 0 && { answer: 42, visits: predicateVisits };
      }, undefined, { polling });
      const value = await handle.jsonValue();
      assert.equal(value.answer, 42); assert.equal(value.visits % 3, 0);
      await handle.dispose();
    }
    outcomes.push('real-raf-and-numeric-polling');

    const borrowed = await page.evaluateHandle(() => ({ answer: 42 }));
    const argument = { first: borrowed, second: borrowed, text: 'é😃\ud800\0' }; argument.self = argument;
    assert.deepEqual(await retainValue(value => value.first.answer && [value.first === value.second, value.self === value, value.text], argument), [true, true, argument.text]);
    await borrowed.dispose();
    const element = await page.waitForFunction(() => document.querySelector('button'));
    assert.equal(element.asElement(), element);
    assert.equal(await element.evaluate(node => [node.textContent, node.ownerDocument === document]).then(value => value.join('/')), 'original/true');
    await element.dispose();
    outcomes.push('nested-handle-arguments-graph-values-and-element-results');

    await page.evaluate(() => { globalThis.asyncVisits = 0; });
    assert.equal(await retainValue(async () => { asyncVisits++; return false; }), false);
    assert.equal(await page.evaluate(() => asyncVisits), 1);
    assert.equal(await retainValue(() => ({ then(resolve) { resolve(false); } })), false);
    for (const predicate of [() => { throw new Error('Execution context was destroyed'); }, async () => { throw new Error('predicate rejection'); }]) {
      await assert.rejects(page.waitForFunction(predicate), /Execution context was destroyed|predicate rejection/);
    }
    await assert.rejects(page.waitForFunction('!@#$'), /token|syntax|invalid/i);
    outcomes.push('one-shot-async-and-thenable-assimilation-and-terminal-user-errors');

    await page.evaluate(() => { globalThis.timeoutVisits = 0; });
    await assert.rejects(page.waitForFunction(() => { timeoutVisits++; return false; }, undefined, { polling: 10, timeout: 80 }), error => error.name === 'TimeoutError');
    const visits = await page.evaluate(() => timeoutVisits);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    assert.equal(await page.evaluate(() => timeoutVisits), visits);
    await assert.rejects(page.waitForFunction(() => new Promise(() => {}), undefined, { timeout: 80 }), error => error.name === 'TimeoutError');
    await assert.rejects(page.waitForFunction(() => new Promise(resolve => { globalThis.latePredicateResult = resolve; }), undefined, { timeout: 80 }), error => error.name === 'TimeoutError');
    await page.evaluate(() => latePredicateResult({ answer: 42 }));
    assert.equal(await retainValue(() => 42), 42);
    outcomes.push('finite-timeout-stops-polling-never-settling-and-late-async-results');

    page.setDefaultTimeout(30);
    await assert.rejects(page.waitForFunction(() => false), error => error.name === 'TimeoutError');
    const noTimeout = page.waitForFunction(() => globalThis.unboundedReady, undefined, { timeout: 0 });
    await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 60)); globalThis.unboundedReady = { answer: 42 }; });
    const noTimeoutHandle = await noTimeout;
    assert.deepEqual(await noTimeoutHandle.jsonValue(), { answer: 42 }); await noTimeoutHandle.dispose();
    page.setDefaultTimeout(3000);
    outcomes.push('inherited-default-and-explicit-zero-timeouts');

    const acrossNavigation = page.waitForFunction(() => { globalThis.predicateStarted = true; return globalThis.successorReady; }, undefined, { polling: 5 });
    await page.evaluate(async () => {
      while (!globalThis.predicateStarted) await new Promise(resolve => setTimeout(resolve, 0));
    });
    await page.goto(`${baseURL}/successor`);
    const successor = await acrossNavigation;
    assert.deepEqual(await successor.jsonValue(), { document: 'successor' }); await successor.dispose();
    outcomes.push('logical-frame-document-navigation-retry');

    await page.goto(`${baseURL}/frames`);
    const child = page.frames().find(frame => frame.name() === 'child');
    assert(child, 'Expected a published child frame');
    const childValue = await child.waitForFunction(() => ({ marker: globalThis.realmMarker }));
    assert.deepEqual(await childValue.jsonValue(), { marker: 'child-main' });
    await childValue.dispose();
    const retainedChild = await child.waitForFunction(() => document.querySelector('button'));
    assert.equal(await retainedChild.evaluate(element => element.ownerDocument === document), true);
    const detached = child.waitForFunction(() => false, undefined, { timeout: 0 });
    const detachedFailure = assert.rejects(detached, /detach|closed|frame/i);
    await page.evaluate(() => document.querySelector('iframe').remove());
    await detachedFailure;
    await assert.rejects(retainedChild.evaluate(() => 42), /destroy|closed|context|object|detach/i);
    await retainedChild.dispose();
    outcomes.push('child-main-world-results-original-handles-and-frame-detachment');

    await page.goto(`${baseURL}/frames`);
    const shortDeadlineChild = page.frames().find(frame => frame.name() === 'child');
    assert(shortDeadlineChild, 'Expected a fresh child frame');
    const warmedChild = await shortDeadlineChild.waitForFunction(() => true);
    await warmedChild.dispose();
    await assert.rejects(shortDeadlineChild.waitForFunction(() => {
      frameElement.remove();
      return false;
    }, undefined, { timeout: 100 }), error => error.name !== 'TimeoutError' && /detach|closed|frame/i.test(error.message));
    outcomes.push('known-frame-detachment-precedes-navigation-backoff-deadline');

    const closed = page.waitForFunction(() => false, undefined, { timeout: 0 });
    const closedFailure = assert.rejects(closed, /closed|context|target/i);
    await context.close(); await closedFailure;
    outcomes.push('parent-context-closure');
  } finally { await context.close(); }

  // Capture timing is a public compatibility boundary; each case owns a fresh document.
  const schedulingContext = await browser.newContext();
  try {
    for (const polling of ['raf', 5]) {
      const schedulingPage = await schedulingContext.newPage();
      await schedulingPage.goto(baseURL);
      const first = await schedulingPage.waitForFunction(() => true, undefined, { polling });
      await first.dispose();
      await schedulingPage.evaluate(() => {
        globalThis.schedulerCalls = 0;
        globalThis.requestAnimationFrame = () => { schedulerCalls++; throw new Error('patched animation frames'); };
        globalThis.setTimeout = () => { schedulerCalls++; throw new Error('patched timers'); };
        Object.defineProperty(globalThis.performance, 'now', { configurable: true, get() { throw new Error('patched performance clock must not be read'); } });
      });
      const cached = await schedulingPage.waitForFunction(() => {
        globalThis.cachedVisits = (globalThis.cachedVisits ?? 0) + 1;
        return cachedVisits === 2 && 42;
      }, undefined, { polling, timeout: 1000 });
      assert.equal(await cached.jsonValue(), 42); await cached.dispose();
      assert.equal(await schedulingPage.evaluate(() => schedulerCalls), 0);
      await schedulingPage.close();
    }
    outcomes.push('document-cached-schedulers-and-performance-clock-getter-non-use');

    for (const polling of ['raf', 5]) {
      const schedulingPage = await schedulingContext.newPage();
      await schedulingPage.goto(baseURL);
      await schedulingPage.evaluate(() => {
        globalThis.requestAnimationFrame = () => { throw new Error('initial animation frame patch'); };
        globalThis.setTimeout = () => { throw new Error('initial timer patch'); };
      });
      await assert.rejects(schedulingPage.waitForFunction(() => false, undefined, { polling, timeout: 1000 }), /initial animation frame patch|initial timer patch/);
      await schedulingPage.close();
    }
    outcomes.push('first-wait-observes-existing-scheduler-patches');
  } finally { await schedulingContext.close(); }
}

/** Retain real successful and timed-out predicate calls with original source and DOM snapshots. */
export async function functionWaitTraceCase(browser, baseURL, path) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(baseURL);
    await context.tracing.start({ snapshots: true, screenshots: false, sources: true });
    const selected = await page.waitForFunction(() => document.querySelector('button'), undefined, { timeout: 1000 });
    assert.equal(await selected.evaluate(element => element.textContent), 'original');
    await selected.dispose();
    const frameValue = await page.mainFrame().waitForFunction(() => ({ answer: 42 }), undefined, { polling: 5, timeout: 1000 });
    assert.deepEqual(await frameValue.jsonValue(), { answer: 42 }); await frameValue.dispose();
    await assert.rejects(page.waitForFunction(() => false, undefined, { polling: 10, timeout: 100 }), error => error.name === 'TimeoutError');
    await context.tracing.stop({ path });
    return { successfulWaits: 2, timedOutWaits: 1 };
  } finally { await context.close(); }
}
