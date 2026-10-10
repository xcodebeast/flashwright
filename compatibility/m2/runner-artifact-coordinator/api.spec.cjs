const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { dirname, join } = require('node:path');
const { createRequire } = require('node:module');
const { test: artifactTest, chromium, runnerIntegration } = require('./coordinator-fixtures.cjs');
const requireLibrary = createRequire(join(process.env.FLASHWRIGHT_COORDINATOR_MODULES, 'index.js'));
const { request } = require(join(dirname(requireLibrary.resolve('@flashwright/core')), 'api-request.js'));
let originalRecording;
let originalChunk;
const test = artifactTest.extend({
  shared: [async ({}, use) => {
    const server = createServer(async (incoming, outgoing) => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      outgoing.setHeader('content-type', 'text/plain');
      outgoing.end(`api:${incoming.url}:${Buffer.concat(chunks).length}`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await request.newContext({ baseURL: origin });
    try { await use({ context, origin }); }
    finally { await context.dispose(); await new Promise(resolve => server.close(resolve)); }
  }, { scope: 'worker' }],
});

test.beforeAll(async ({ shared }) => { assert.equal(await (await shared.context.get('/before')).text(), 'api:/before:0'); });
test.afterAll(async ({ shared }) => { assert.equal(await (await shared.context.get('/after')).text(), 'api:/after:0'); });

test('API first attempt owns beforeAll and user steps', async ({ shared }) => {
  const tracing = runnerIntegration.requestTraceOwner(12, shared.context);
  originalRecording = runnerIntegration.currentTraceRecording(7, tracing);
  originalChunk = runnerIntegration.currentTraceChunk(3, tracing);
  assert(originalRecording); assert(originalChunk);
  await test.step('API original parent', async () => {
    const response = await shared.context.get('/first');
    assert.equal(await response.text(), 'api:/first:0');
    await response.dispose();
  });
});

test('API successor reuses recording with its own empty POST resource', async ({ shared }) => {
  const tracing = runnerIntegration.requestTraceOwner(12, shared.context);
  assert.equal(runnerIntegration.currentTraceRecording(7, tracing), originalRecording);
  assert.notEqual(runnerIntegration.currentTraceChunk(3, tracing), originalChunk);
  assert.equal(await (await shared.context.post('/second', { data: '' })).text(), 'api:/second:0');
});

test('API mixed manual owners seal before disposal and include afterAll', async ({ shared }) => {
  const manual = await request.newContext({ baseURL: shared.origin });
  try { assert.equal(await (await manual.get('/manual')).text(), 'api:/manual:0'); }
  finally { await manual.dispose(); }
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.evaluate(() => { document.title = 'mixed API owner'; });
    assert.equal(await page.title(), 'mixed API owner');
    await context.close();
  } finally { await browser.close(); }
});
