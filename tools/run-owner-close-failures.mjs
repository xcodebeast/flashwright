import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
const { chromium } = await import(process.env.FLASHWRIGHT_TEST_LIBRARY ?? 'flashwright');

const checks = [];

/** Observe intentional listener exceptions while retaining their original values. */
async function browserWithThrowingListeners() {
  const browser = await chromium.launch();
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = [];
  for (const context of contexts) pages.push([await context.newPage(), await context.newPage()]);
  const failures = [new Error('original page listener'), new Error('original context listener'), new Error('original browser listener')];
  const observed = [];
  const listenerCalls = [];
  function observe(error) {
    if (!failures.includes(error)) throw error;
    observed.push(error);
  }
  process.on('uncaughtException', observe);
  try {
    pages[0][0].once('close', () => { listenerCalls.push('page'); throw failures[0]; });
    contexts[0].once('close', () => { listenerCalls.push('context'); throw failures[1]; });
    browser.once('disconnected', () => { listenerCalls.push('browser'); throw failures[2]; });
    try { await browser.close(); } catch (error) { observe(error); }
    await setImmediate();
    assert.deepEqual(listenerCalls, ['page', 'context', 'browser']);
    assert.ok(observed.length > 0);
    assert.ok(observed.every(error => failures.includes(error)));
    assert.equal(browser.isConnected(), false);
    assert.deepEqual(browser.contexts(), []);
    assert.ok(pages.flat().every(page => page.isClosed()));
    assert.ok(contexts.every(context => context.pages().length === 0));
    checks.push({ name: 'original listener failures preserve sibling retirement and driver shutdown',
      observedOriginalErrors: observed.map(error => failures.indexOf(error)) });
  } finally {
    try { await browser.close(); } catch (error) { observe(error); }
    await setImmediate();
    process.off('uncaughtException', observe);
  }
}

/** Ownership cleanup cannot depend on listeners that users may remove or prepend. */
async function removedAndPrependedListeners() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const removed = await context.newPage();
  const prepended = await context.newPage();
  const originalFailure = new Error('original prepended page listener');
  const observed = [];
  function observe(error) {
    if (error !== originalFailure) throw error;
    observed.push(error);
  }
  process.on('uncaughtException', observe);
  try {
    removed.removeAllListeners('close');
    await removed.close();
    assert.deepEqual(context.pages(), [prepended]);
    prepended.prependOnceListener('close', () => { throw originalFailure; });
    try { await prepended.close(); } catch (error) { observe(error); }
    await setImmediate();
    assert.equal(observed.length, 1);
    assert.equal(prepended.isClosed(), true);
    assert.deepEqual(context.pages(), []);
    context.removeAllListeners('close');
    await context.close();
    assert.deepEqual(browser.contexts(), []);
    await browser.close();
    checks.push({ name: 'removed and prepended listeners cannot retain closed owners', observedOriginalErrors: 1 });
  } finally {
    await browser.close();
    process.off('uncaughtException', observe);
  }
}

let report;
try {
  await browserWithThrowingListeners();
  await removedAndPrependedListeners();
  report = { status: 'passed', checks, scope: 'Real Chromium public owner closure and original listener failures. Process cleanup must also pass the external watchdog.' };
} catch (error) {
  report = { status: 'failed', checks, error: { name: error?.name, message: String(error?.message ?? error), stack: error?.stack } };
  process.exitCode = 1;
}
if (process.env.FLASHWRIGHT_REPORT_PATH) await writeFile(process.env.FLASHWRIGHT_REPORT_PATH, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
