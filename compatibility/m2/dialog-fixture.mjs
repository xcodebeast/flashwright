import assert from 'node:assert/strict';

export const dialogHTML = `<!doctype html><meta charset="utf-8"><title>Dialog contracts</title>
<button id="confirm" onclick="globalThis.confirmResult = confirm('clicked'); globalThis.clickFinished = true">Confirm</button>
<iframe name="child" src="/child"></iframe>`;
export const dialogChildHTML = '<!doctype html><meta charset="utf-8"><title>Same-origin dialog frame</title>';

/** Observe rejection immediately so a close or a failed assertion cannot create a stray rejection. */
function observe(promise) {
  const observation = { settled: false, outcome: undefined };
  observation.outcome = promise.then(
    value => { observation.settled = true; return { status: 'fulfilled', value }; },
    error => { observation.settled = true; return { status: 'rejected', error }; },
  );
  return observation;
}

async function fulfilled(observation) {
  const outcome = await observation.outcome;
  if (outcome.status === 'rejected') throw outcome.error;
  return outcome.value;
}

function initiateDialog(frame, type, message = 'message', defaultValue = 'default') {
  return observe(frame.evaluate(({ type, message, defaultValue }) => {
    if (type === 'alert') return alert(message);
    if (type === 'confirm') return confirm(message);
    return prompt(message, defaultValue);
  }, { type, message, defaultValue }));
}

async function captureDialog(page, type, message, defaultValue, emitter = page) {
  const opened = emitter.waitForEvent('dialog');
  const operation = initiateDialog(page, type, message, defaultValue);
  return { dialog: await opened, operation };
}

/** This bounds a broken corpus case; context teardown still owns its unfinished browser work. */
async function bounded(callback) {
  let timer;
  try {
    return await Promise.race([
      callback(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Dialog corpus case exceeded 12 seconds')), 12000); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Both implementations run identical cases. Each case owns a fresh context, including on failure. */
export async function ordinaryDialogCases(browser, check, baseURL) {
  const scenario = (name, callback) => check(name, async () => {
    const context = await browser.newContext();
    context.setDefaultTimeout(3000);
    try {
      const page = await context.newPage();
      await page.goto(baseURL);
      await bounded(() => callback({ context, page }));
    } finally { await context.close(); }
  });

  await scenario('ordinary dialogs without listeners dismiss and release repeated evaluations', async ({ page }) => {
    for (let iteration = 0; iteration < 3; iteration++) {
      assert.equal(await fulfilled(initiateDialog(page, 'alert')), undefined);
      assert.equal(await fulfilled(initiateDialog(page, 'confirm')), false);
      assert.equal(await fulfilled(initiateDialog(page, 'prompt')), null);
    }
    assert.equal(await page.evaluate(() => 42), 42);
  });

  await scenario('accept and dismiss preserve ordinary type metadata and browser results', async ({ page }) => {
    for (const type of ['alert', 'confirm', 'prompt']) {
      for (const accepted of [true, false]) {
        const { dialog, operation } = await captureDialog(page, type, `${type} message`, 'initial');
        assert.equal(dialog.page(), page);
        assert.equal(dialog.type(), type);
        assert.equal(dialog.message(), `${type} message`);
        assert.equal(dialog.defaultValue(), type === 'prompt' ? 'initial' : '');
        await (accepted ? dialog.accept() : dialog.dismiss());
        const expected = type === 'alert' ? undefined : type === 'confirm' ? accepted : accepted ? '' : null;
        assert.equal(await fulfilled(operation), expected);
        assert.equal(dialog.message(), `${type} message`);
      }
    }
    for (const replacement of ['', 'replacement']) {
      const { dialog, operation } = await captureDialog(page, 'prompt');
      await dialog.accept(replacement);
      assert.equal(await fulfilled(operation), replacement);
    }
  });

  await scenario('dialog strings match Chromium normalization of lone UTF-16 surrogates', async ({ page }) => {
    const text = '\u0000 high:\ud800 low:\udfff pair:\ud83d\ude80 quote:" slash:\\ newline:\n';
    const normalized = text.toWellFormed();
    for (const type of ['alert', 'confirm', 'prompt']) {
      const { dialog, operation } = await captureDialog(page, type, text, text);
      assert.equal(dialog.message(), normalized);
      assert.equal(dialog.defaultValue(), type === 'prompt' ? normalized : '');
      await dialog.accept(text);
      assert.equal(await fulfilled(operation), type === 'alert' ? undefined : type === 'confirm' ? true : normalized);
    }
    // The closed event also carries prompt userInput, so a subsequent operation checks that path.
    assert.equal(await fulfilled(initiateDialog(page, 'confirm')), false);
  });

  await scenario('context and page listeners receive one object in context-first order', async ({ context, page }) => {
    const received = [];
    context.on('dialog', dialog => received.push(['context', dialog]));
    page.on('dialog', dialog => received.push(['page', dialog]));
    const { dialog, operation } = await captureDialog(page, 'confirm');
    assert.deepEqual(received.map(([owner]) => owner), ['context', 'page']);
    assert.equal(received[0][1], dialog);
    assert.equal(received[1][1], dialog);
    await dialog.accept();
    assert.equal(await fulfilled(operation), true);
  });

  await scenario('context listeners can change page listeners before page dispatch', async ({ context, page }) => {
    const received = [];
    const removed = () => received.push('removed');
    page.on('dialog', removed);
    context.once('dialog', () => {
      received.push('context');
      page.off('dialog', removed);
      page.once('dialog', () => received.push('added'));
    });
    const { dialog, operation } = await captureDialog(page, 'confirm', 'changed', '', context);
    assert.deepEqual(received, ['context', 'added']);
    await dialog.dismiss();
    assert.equal(await fulfilled(operation), false);
  });

  await scenario('an async context handler yields while the page receives the same dialog', async ({ context, page }) => {
    let releasePageBarrier;
    const pageBarrier = new Promise(resolve => { releasePageBarrier = resolve; });
    let contextDialog;
    let handlerCompletion;
    const order = [];
    context.once('dialog', dialog => {
      contextDialog = dialog;
      order.push('context entered');
      const handler = (async () => {
        await pageBarrier;
        order.push('context resumed');
        await dialog.accept();
      })();
      handlerCompletion = observe(handler);
      return handler;
    });
    page.once('dialog', dialog => {
      assert.equal(dialog, contextDialog);
      order.push('page received');
      releasePageBarrier();
    });
    assert.equal(await fulfilled(initiateDialog(page, 'confirm')), true);
    await fulfilled(handlerCompletion);
    assert.deepEqual(order, ['context entered', 'page received', 'context resumed']);
  });

  await scenario('all listener registration forms retain the delivered dialog after removal', async ({ context, page }) => {
    for (const emitter of [page, context]) {
      for (const registration of ['on', 'addListener', 'prependListener', 'once', 'prependOnceListener']) {
        let resolveOpened;
        const opened = new Promise(resolve => { resolveOpened = resolve; });
        const listener = dialog => { emitter.off('dialog', listener); resolveOpened(dialog); };
        emitter[registration]('dialog', listener);
        const operation = initiateDialog(page, 'confirm', registration);
        const dialog = await opened;
        assert.equal(dialog.page(), page);
        assert.equal(emitter.listenerCount('dialog'), 0);
        await Promise.resolve();
        assert.equal(operation.settled, false);
        await dialog.accept();
        assert.equal(await fulfilled(operation), true);
      }
    }
  });

  await scenario('a listener returning false still owns the dialog', async ({ page }) => {
    let resolveOpened;
    const opened = new Promise(resolve => { resolveOpened = resolve; });
    page.once('dialog', dialog => { resolveOpened(dialog); return false; });
    const operation = initiateDialog(page, 'confirm');
    const dialog = await opened;
    await dialog.accept();
    assert.equal(await fulfilled(operation), true);
  });

  await scenario('removing subscriptions restores no-listener handling for new dialogs', async ({ context, page }) => {
    const unexpected = () => assert.fail('removed dialog listener fired');
    page.on('dialog', unexpected);
    page.removeListener('dialog', unexpected);
    context.on('dialog', unexpected);
    context.off('dialog', unexpected);
    assert.equal(await fulfilled(initiateDialog(page, 'confirm')), false);
    page.on('dialog', unexpected);
    context.on('dialog', unexpected);
    page.removeAllListeners('dialog');
    context.removeAllListeners('dialog');
    assert.equal(await fulfilled(initiateDialog(page, 'prompt')), null);
  });

  await scenario('a timed-out dialog wait removes its listener before the next dialog', async ({ context, page }) => {
    for (const emitter of [page, context]) {
      await assert.rejects(emitter.waitForEvent('dialog', { timeout: 30 }), error => error.name === 'TimeoutError');
      assert.equal(emitter.listenerCount('dialog'), 0);
      assert.equal(await fulfilled(initiateDialog(page, 'confirm')), false);
      const { dialog, operation } = await captureDialog(page, 'confirm', 'next', '', emitter);
      await dialog.accept();
      assert.equal(await fulfilled(operation), true);
    }
  });

  await scenario('async dialog predicates filter occurrences through both argument forms', async ({ context, page }) => {
    for (const emitter of [page, context]) {
      for (const argumentForm of ['function', 'options']) {
        const seen = [];
        const predicate = async dialog => {
          seen.push(dialog);
          assert.equal(dialog.page(), page);
          await Promise.resolve();
          if (dialog.message() === 'ignored') { await dialog.dismiss(); return false; }
          return dialog.message() === 'selected';
        };
        const opened = observe(emitter.waitForEvent('dialog', argumentForm === 'function' ? predicate : { predicate, timeout: 3000 }));
        const operation = observe(page.evaluate(() => [confirm('ignored'), confirm('selected')]));
        const dialog = await fulfilled(opened);
        assert.equal(dialog, seen[1]);
        assert.equal(seen.length, 2);
        assert.equal(emitter.listenerCount('dialog'), 0);
        assert.equal(operation.settled, false);
        await dialog.accept();
        assert.deepEqual(await fulfilled(operation), [false, true]);
      }
    }
  });

  await scenario('dialog predicate errors preserve the original error and occurrence', async ({ context, page }) => {
    for (const emitter of [page, context]) {
      for (const failureMode of ['sync', 'async']) {
        const original = new Error(`dialog predicate ${failureMode}`);
        let captured;
        const predicate = dialog => {
          captured = dialog;
          if (failureMode === 'sync') throw original;
          return Promise.reject(original);
        };
        const opened = observe(emitter.waitForEvent('dialog', { predicate, timeout: 3000 }));
        const operation = initiateDialog(page, 'confirm', failureMode);
        const outcome = await opened.outcome;
        assert.equal(outcome.status, 'rejected');
        assert.equal(outcome.error, original);
        assert.equal(captured.page(), page);
        assert.equal(emitter.listenerCount('dialog'), 0);
        assert.equal(operation.settled, false);
        await captured.dismiss();
        assert.equal(await fulfilled(operation), false);
        assert.equal(await fulfilled(initiateDialog(page, 'confirm', 'unobserved successor')), false);
      }
    }
  });

  await scenario('an unmatched dialog remains owned after its predicate wait times out', async ({ context, page }) => {
    for (const emitter of [page, context]) {
      let captured;
      const opened = observe(emitter.waitForEvent('dialog', { predicate: dialog => { captured = dialog; return false; }, timeout: 500 }));
      const operation = initiateDialog(page, 'confirm', 'unmatched');
      const outcome = await opened.outcome;
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.error.name, 'TimeoutError');
      assert.equal(captured.page(), page);
      assert.equal(emitter.listenerCount('dialog'), 0);
      assert.equal(operation.settled, false);
      await captured.dismiss();
      assert.equal(await fulfilled(operation), false);
      assert.equal(await fulfilled(initiateDialog(page, 'confirm', 'unobserved successor')), false);
    }
  });

  await scenario('invalid prompt arguments reject before consuming the dialog', async ({ page }) => {
    const { dialog, operation } = await captureDialog(page, 'prompt');
    for (const invalid of [null, false, 42, {}, ['text']]) {
      await assert.rejects(async () => dialog.accept(invalid), /promptText|string/i);
    }
    assert.equal(operation.settled, false);
    await dialog.accept('valid');
    assert.equal(await fulfilled(operation), 'valid');
  });

  await scenario('handled dialogs reject every repeated handling combination', async ({ page }) => {
    for (const first of ['accept', 'dismiss']) {
      for (const second of ['accept', 'dismiss']) {
        const { dialog, operation } = await captureDialog(page, 'confirm');
        await dialog[first]();
        assert.equal(await fulfilled(operation), first === 'accept');
        await assert.rejects(dialog[second](), /already handled/i);
      }
    }
  });

  await scenario('concurrent handlers consume one occurrence exactly once', async ({ page }) => {
    const { dialog, operation } = await captureDialog(page, 'confirm');
    const results = await Promise.allSettled([dialog.accept(), dialog.dismiss()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.match(rejected.reason.message, /already handled/i);
    assert.equal(await fulfilled(operation), results[0].status === 'fulfilled');
  });

  await scenario('a stale dialog cannot handle a successor dialog from the same evaluation', async ({ page }) => {
    const openedFirst = page.waitForEvent('dialog');
    const operation = observe(page.evaluate(() => [confirm('first'), prompt('second', 'second default')]));
    const first = await openedFirst;
    const openedSecond = page.waitForEvent('dialog');
    await first.accept();
    const second = await openedSecond;
    assert.notEqual(second, first);
    assert.equal(first.message(), 'first');
    assert.equal(second.message(), 'second');
    await assert.rejects(first.dismiss(), /already handled/i);
    await second.accept('successor');
    assert.deepEqual(await fulfilled(operation), [true, 'successor']);
  });

  await scenario('same-origin child-frame dialogs retain the owning page identity', async ({ page }) => {
    const child = page.frames().find(frame => frame.name() === 'child');
    assert(child, 'fixture child frame must be loaded');
    const opened = page.waitForEvent('dialog');
    const operation = initiateDialog(child, 'prompt', 'from child', 'child default');
    const dialog = await opened;
    assert.equal(dialog.page(), page);
    assert.equal(dialog.message(), 'from child');
    await dialog.accept('child result');
    assert.equal(await fulfilled(operation), 'child result');
  });

  await scenario('a modal blocks its click until the handler releases it', async ({ page }) => {
    const opened = page.waitForEvent('dialog');
    const click = observe(page.locator('#confirm').click());
    const dialog = await opened;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(click.settled, false);
    await dialog.accept();
    await fulfilled(click);
    assert.deepEqual(await page.evaluate(() => [globalThis.confirmResult, globalThis.clickFinished]), [true, true]);
  });

  await scenario('page closure preserves metadata and distinguishes accept from dismiss', async ({ context, page }) => {
    const { dialog, operation } = await captureDialog(page, 'confirm', 'closing');
    await page.close();
    assert.equal((await operation.outcome).status, 'rejected');
    assert.equal(dialog.page(), page);
    assert.equal(dialog.message(), 'closing');
    await dialog.dismiss();
    await assert.rejects(dialog.accept(), /closed/i);
    const sibling = await context.newPage();
    assert.equal(await sibling.evaluate(() => 42), 42);
  });

  await scenario('context closure rejects pending page and context dialog waits', async ({ context, page }) => {
    const pageWait = observe(page.waitForEvent('dialog', { timeout: 0 }));
    const contextWait = observe(context.waitForEvent('dialog', { timeout: 0 }));
    await context.close();
    for (const observation of [pageWait, contextWait]) {
      const outcome = await observation.outcome;
      assert.equal(outcome.status, 'rejected');
      assert.match(outcome.error.message, /closed/i);
    }
  });

  await scenario('context closure releases an already delivered ordinary dialog', async ({ context, page }) => {
    const { dialog, operation } = await captureDialog(page, 'prompt', 'context closing', 'original', context);
    await context.close();
    assert.equal((await operation.outcome).status, 'rejected');
    assert.equal(page.isClosed(), true);
    assert.equal(dialog.page(), page);
    assert.equal(dialog.message(), 'context closing');
    assert.equal(dialog.defaultValue(), 'original');
    await dialog.dismiss();
    await assert.rejects(dialog.accept('late'), /closed/i);
  });

  await scenario('context-only handling routes each dialog to its original page', async ({ context, page }) => {
    const sibling = await context.newPage();
    for (const owner of [page, sibling, page]) {
      const { dialog, operation } = await captureDialog(owner, 'confirm', 'owner', '', context);
      assert.equal(dialog.page(), owner);
      await dialog.accept();
      assert.equal(await fulfilled(operation), true);
    }
  });

  await scenario('simultaneous page dialogs retain independent original owners', async ({ context, page }) => {
    const sibling = await context.newPage();
    const dialogs = [];
    let bothOpened;
    const opened = new Promise(resolve => { bothOpened = resolve; });
    context.on('dialog', dialog => { dialogs.push(dialog); if (dialogs.length === 2) bothOpened(); });
    const first = initiateDialog(page, 'confirm', 'first page');
    const second = initiateDialog(sibling, 'confirm', 'second page');
    await opened;
    assert.equal(dialogs.find(dialog => dialog.message() === 'first page').page(), page);
    assert.equal(dialogs.find(dialog => dialog.message() === 'second page').page(), sibling);
    await dialogs.find(dialog => dialog.page() === sibling).dismiss();
    assert.equal(await fulfilled(second), false);
    assert.equal(first.settled, false);
    await dialogs.find(dialog => dialog.page() === page).accept();
    assert.equal(await fulfilled(first), true);
  });

  for (const observed of [false, true]) {
    await scenario(`prepublication dialogs ${observed ? 'retain a null page snapshot while context handling completes' : 'dismiss without a context listener'}`, async ({ context }) => {
      const dialogs = [];
      let handling;
      if (observed) context.once('dialog', dialog => { dialogs.push(dialog); handling = observe(dialog.accept()); });
      await context.addInitScript(() => { globalThis.prepublicationResult = confirm('before-public-page'); });
      const created = await context.newPage();
      if (handling) await fulfilled(handling);
      assert.equal(await created.evaluate(() => globalThis.prepublicationResult), observed);
      assert.equal(dialogs.length, observed ? 1 : 0);
      if (observed) {
        assert.equal(dialogs[0].page(), null);
        assert.equal(dialogs[0].type(), 'confirm');
        assert.equal(dialogs[0].message(), 'before-public-page');
      }
    });
  }

  for (const handlingMode of ['default', 'accept', 'dismiss']) {
    await scenario(`beforeunload navigation uses ${handlingMode} handling without losing its page`, async ({ page }) => {
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.id = 'arm-beforeunload'; button.textContent = 'Arm beforeunload';
        button.addEventListener('click', () => window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = 'armed'; }));
        document.body.append(button);
      });
      await page.locator('#arm-beforeunload').click();
      const originalURL = page.url();
      const dialogs = [];
      let handling;
      if (handlingMode !== 'default') page.once('dialog', dialog => { dialogs.push(dialog); handling = observe(dialog[handlingMode]()); });
      const navigation = observe(page.goto(`${baseURL}/destination`));
      if (handlingMode === 'dismiss') {
        const outcome = await navigation.outcome;
        assert.equal(outcome.status, 'rejected'); assert.match(outcome.error.message, /ERR_ABORTED/);
        assert.equal(page.url(), originalURL);
      } else {
        await fulfilled(navigation);
        assert.equal(page.url(), `${baseURL}/destination`);
      }
      if (handling) await fulfilled(handling);
      assert.equal(dialogs.length, handlingMode === 'default' ? 0 : 1);
      if (dialogs.length) { assert.equal(dialogs[0].page(), page); assert.equal(dialogs[0].type(), 'beforeunload'); }
      assert.equal(page.isClosed(), false);
      assert.equal(await page.evaluate(() => 42), 42);
    });
  }
}
