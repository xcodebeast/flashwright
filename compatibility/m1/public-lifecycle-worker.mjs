import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { chromium } from 'flashwright';
import { expect } from '@flashwright/test';

const browser = await chromium.launch();
browser.client.process.stderr.pipe(process.stderr);
const context = await browser.newContext();
const page = await context.newPage();
const heartbeat = setInterval(() => {}, 1000);
browser.on('disconnected', () => {
  assert.equal(browser.isConnected(), false);
  assert.equal(page.isClosed(), true);
  assert.equal(context.pages().length, 0);
  assert.equal(browser.contexts().length, 0);
  console.log(JSON.stringify({ disconnected: true }));
});
// This test-only private access locates the owned process tree for fault injection.
console.log(JSON.stringify({ ready: true, driver: browser.client.process.pid }));
const commands = createInterface({ input: process.stdin });
for await (const command of commands) {
  if (command === 'drain-browser-close' || command === 'drain-browser-loss') {
    const pending = page.evaluate(() => {
      globalThis.shutdownEvaluationStarted = true;
      return new Promise(() => {});
    }).catch(error => error);
    const started = await page.waitForFunction(() => globalThis.shutdownEvaluationStarted, undefined, { timeout: 2000 });
    await started.dispose();
    console.log(JSON.stringify({ shutdownPending: true }));
    if (command === 'drain-browser-close') await browser.close();
    const error = await pending;
    assert.ok(['TargetClosedError', 'BrowserDisconnectedError'].includes(error.name));
    assert.doesNotMatch(error.message, /driver exited/);
    await browser.close();
    console.log(JSON.stringify({ shutdownDrained: true, errorName: error.name, message: error.message }));
    break;
  } else if (command === 'crash') {
    const crash = page.waitForEvent('crash');
    const navigation = page.goto('chrome://crash', { timeout: 2000 }).then(() => null, error => error);
    await crash;
    assert.match((await navigation).message, /crash|closed/i);
    assert.equal(page.isClosed(), false);
    await assert.rejects(page.evaluate(() => 1), error => error.name === 'PageCrashedError');
    assert.equal(browser.isConnected(), true);
    const replacement = await context.newPage();
    assert.equal(await replacement.evaluate(() => 42), 42);
    await replacement.close();
    await page.close();
    console.log(JSON.stringify({ crashRecovered: true }));
  } else if (command === 'blocked-locator') {
    await page.evaluate(() => { document.body.innerHTML = '<input type="date" value="2026-01-01">'; });
    assert.equal(await page.locator('input').count(), 1);
    const source = 'while (true) {}';
    const blocked = browser.client.request('page.evaluate', {
      page: page.identifier, source: Array.from(source, character => character.charCodeAt(0)), isFunction: false, argument: { kind: 'undefined' },
    }, 600).then(() => null, error => error);
    await new Promise(resolve => setTimeout(resolve, 30));
    const started = performance.now();
    await assert.rejects(page.locator('input').fill('2026-10-07', { timeout: 80 }), error => error.name === 'TimeoutError');
    assert.ok(performance.now() - started < 500);
    assert.equal((await blocked).name, 'TimeoutError');
    assert.equal(await page.locator('input').inputValue(), '2026-01-01');
    await page.locator('input').fill('2026-10-07');
    assert.equal(await page.locator('input').inputValue(), '2026-10-07');
    console.log(JSON.stringify({ locatorRecovered: true }));
  } else if (command === 'blocked-assertion') {
    await page.evaluate(() => { document.body.innerHTML = '<p>Available</p>'; });
    await expect(page.locator('p')).toHaveText('Available');
    const source = 'while (true) {}';
    const blocked = browser.client.request('page.evaluate', {
      page: page.identifier, source: Array.from(source, character => character.charCodeAt(0)), isFunction: false, argument: { kind: 'undefined' },
    }, 600).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 30));
    const started = performance.now();
    await assert.rejects(expect(page.locator('p')).toHaveText('Available', { timeout: 80 }), error => {
      assert.match(error.message, /Timed out after 80ms/);
      assert.match(error.message, /no observation before the deadline/);
      return true;
    });
    assert.ok(performance.now() - started < 500);
    assert.equal((await blocked).name, 'TimeoutError');
    await expect(page.locator('p')).toHaveText('Available');
    console.log(JSON.stringify({ assertionRecovered: true }));
  } else if (command === 'close-assertion') {
    const pending = expect(page.locator('p')).toHaveText('never appears', { timeout: 0 }).catch(error => error);
    await page.evaluate(() => 1);
    await context.close();
    assert.equal((await pending).name, 'TargetClosedError');
    assert.equal(page.isClosed(), true);
    assert.equal(browser.contexts().length, 0);
    const replacement = await browser.newPage();
    await expect(replacement.locator('body')).toBeVisible();
    await replacement.close();
    console.log(JSON.stringify({ assertionDisposed: true }));
  } else if (command === 'cancel-pointer') {
    await page.evaluate(() => {
      document.body.innerHTML = '<button>Target</button>';
      globalThis.inputEvents = [];
      for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'mousemove', 'click']) {
        document.addEventListener(type, event => globalThis.inputEvents.push({ type, key: event.key, buttons: event.buttons, shift: event.shiftKey, alt: event.altKey }));
      }
    });
    const target = page.getByRole('button');
    await target.hover();
    await page.evaluate(() => { globalThis.inputEvents = []; });
    const started = performance.now();
    await assert.rejects(target.click({ modifiers: ['Alt', 'Shift'], delay: 5000, timeout: 500 }), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.details.inputDelivery, 'acknowledged');
      assert.equal(error.details.cleanup, 'residentReleased');
      return true;
    });
    assert.ok(performance.now() - started < 1800);
    const interruptedEvents = await page.evaluate(() => globalThis.inputEvents);
    assert.equal(interruptedEvents.filter(event => event.type === 'mousedown').length, 1);
    assert.equal(interruptedEvents.filter(event => event.type === 'mouseup').length, 1);
    for (const key of ['Alt', 'Shift']) {
      assert.equal(interruptedEvents.filter(event => event.type === 'keydown' && event.key === key).length, 1);
      assert.equal(interruptedEvents.filter(event => event.type === 'keyup' && event.key === key).length, 1);
    }
    await page.evaluate(() => { globalThis.inputEvents = []; });
    await target.click();
    const recoveredEvents = await page.evaluate(() => globalThis.inputEvents);
    assert.equal(recoveredEvents.filter(event => event.type === 'click').length, 1);
    assert.ok(recoveredEvents.every(event => !event.shift && !event.alt));
    assert.equal(recoveredEvents.find(event => event.type === 'mousemove').buttons, 0);
    console.log(JSON.stringify({ pointerRecovered: true }));
  } else if (command === 'blocked-pointer') {
    const survivor = await context.newPage();
    for (const eventType of ['mousemove', 'mousedown', 'mouseup', 'click']) {
      const targetPage = eventType === 'mousemove' ? page : await context.newPage();
      await targetPage.evaluate(() => { document.body.innerHTML = '<button>Target</button>'; });
      await targetPage.getByRole('button').hover({ timeout: 1500 });
      await targetPage.evaluate(eventType => {
        document.querySelector('button').addEventListener(eventType, () => { while (true) {} });
      }, eventType);
      const closed = targetPage.waitForEvent('close');
      const started = performance.now();
      await assert.rejects(targetPage.getByRole('button').click({ modifiers: ['Shift'], clickCount: 3, timeout: 500 }), error => {
        assert.equal(error.name, 'TimeoutError');
        assert.equal(error.details.inputDelivery, 'uncertain');
        assert.ok(['resourceDisposed', 'resourceAlreadyDisposed'].includes(error.details.cleanup));
        return true;
      });
      assert.ok(performance.now() - started < 2000);
      await closed;
      assert.equal(targetPage.isClosed(), true);
      assert.equal(browser.isConnected(), true);
      assert.equal(await survivor.evaluate(() => 42), 42);
    }
    await survivor.close();
    console.log(JSON.stringify({ blockedPointerRecovered: true }));
  } else if (command === 'cancel-keyboard') {
    await page.evaluate(() => {
      document.body.innerHTML = '<input><button>Target</button>';
      globalThis.inputEvents = [];
      for (const type of ['keydown', 'keyup', 'click']) document.addEventListener(type, event => inputEvents.push({ type, key: event.key, shift: event.shiftKey }));
    });
    await page.locator('input').focus();
    await assert.rejects(page.locator('input').press('Shift+KeyX', { delay: 5000, timeout: 500 }), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.details.inputDelivery, 'acknowledged');
      assert.equal(error.details.cleanup, 'keyboardReleased');
      return true;
    });
    assert.deepEqual(await page.evaluate(() => inputEvents.map(event => [event.type, event.key])), [['keydown', 'Shift'], ['keydown', 'X'], ['keyup', 'X'], ['keyup', 'Shift']]);
    await page.locator('input').press('a'); assert.equal(await page.locator('input').inputValue(), 'Xa');
    await page.evaluate(() => {
      inputEvents = [];
      globalThis.keyStarted = new Promise(resolve => document.addEventListener('keydown', event => { if (event.key === 'Shift') resolve(); }, { once: true }));
    });
    const held = page.locator('input').press('Shift+KeyB', { delay: 200 });
    await page.evaluate(() => keyStarted);
    await Promise.all([held, page.getByRole('button').click()]);
    assert.equal((await page.evaluate(() => inputEvents.find(event => event.type === 'click'))).shift, false);
    await page.evaluate(() => { inputEvents = []; });
    await assert.rejects(page.locator('input').press('Shift+NotAKey'), /Unknown key/);
    assert.deepEqual(await page.evaluate(() => inputEvents), []);
    console.log(JSON.stringify({ keyboardRecovered: true }));
  } else if (command === 'blocked-keyboard') {
    await page.evaluate(() => {
      document.body.innerHTML = '<input>';
      document.querySelector('input').addEventListener('keydown', () => { while (true) {} });
    });
    await page.locator('input').focus();
    const started = performance.now();
    await assert.rejects(page.locator('input').press('a', { timeout: 500 }), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.details.inputDelivery, 'uncertain');
      assert.ok(['resourceDisposed', 'resourceAlreadyDisposed'].includes(error.details.cleanup));
      return true;
    });
    assert.ok(performance.now() - started < 2000);
    assert.equal(browser.isConnected(), true);
    const replacement = await context.newPage();
    assert.equal(await replacement.evaluate(() => 42), 42); await replacement.close();
    console.log(JSON.stringify({ blockedKeyboardRecovered: true }));
  } else if (command === 'close-page-keyboard') {
    await page.evaluate(() => {
      document.body.innerHTML = '<input>';
      globalThis.keyStarted = new Promise(resolve => document.addEventListener('keydown', resolve, { once: true }));
    });
    await page.locator('input').focus();
    const pending = page.keyboard.press('Shift+KeyA', { delay: 5000 }).catch(error => error);
    await page.evaluate(() => keyStarted.then(() => true));
    const started = performance.now();
    await context.close();
    assert.equal((await pending).name, 'TargetClosedError');
    assert.ok(performance.now() - started < 2000);
    assert.equal(page.isClosed(), true);
    assert.equal(browser.isConnected(), true);
    assert.equal(browser.contexts().length, 0);
    const replacement = await browser.newPage();
    await replacement.evaluate(() => { document.body.innerHTML = '<input>'; });
    await replacement.locator('input').focus();
    await replacement.keyboard.press('a');
    assert.equal(await replacement.locator('input').inputValue(), 'a');
    await replacement.close();
    console.log(JSON.stringify({ pageKeyboardDisposed: true }));
  } else if (command === 'close') {
    await browser.close();
    break;
  }
}
clearInterval(heartbeat);
commands.close();
process.stdin.destroy();
