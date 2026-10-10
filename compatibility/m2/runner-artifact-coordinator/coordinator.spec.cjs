const assert = require('node:assert/strict');
const { test: artifactTest, chromium, runnerIntegration } = require('./coordinator-fixtures.cjs');
let originalRecording;
let originalChunk;
const test = artifactTest.extend({
  shared: [async ({}, use) => {
    const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.evaluate(() => { document.title = 'shared original context'; });
      await use({ browser, context, page });
    } finally { await browser.close(); }
  }, { scope: 'worker' }],
});

test.beforeAll(async ({ shared }) => { assert.equal(await shared.page.title(), 'shared original context'); });
test.afterAll(async ({ shared }) => { assert.equal(await shared.page.title(), 'shared original context'); });

test('first attempt captures shared context and user steps', async ({ shared }) => {
  originalRecording = runnerIntegration.currentTraceRecording(7, shared.context.tracing);
  originalChunk = runnerIntegration.currentTraceChunk(3, shared.context.tracing);
  assert(originalRecording); assert(originalChunk);
  await test.step('original user parent', async () => { assert.equal(await shared.page.title(), 'shared original context'); });
});

test('successor reuses recording with its own chunk', async ({ shared }) => {
  assert.equal(runnerIntegration.currentTraceRecording(7, shared.context.tracing), originalRecording);
  assert.notEqual(runnerIntegration.currentTraceChunk(3, shared.context.tracing), originalChunk);
  assert.equal(await shared.page.title(), 'shared original context');
});

test('manual contexts and separate launches join their original attempt', async ({ shared }) => {
  const separate = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  try {
    for (const browser of [shared.browser, separate]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.evaluate(() => { document.title = 'separate original context'; });
        assert.equal(await page.title(), 'separate original context');
      } finally { await context.close(); }
    }
    assert.equal(await shared.page.title(), 'shared original context');
  } finally { await separate.close(); }
});
