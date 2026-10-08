import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'flashwright';
import { expect } from '@flashwright/test';
const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
const samples = [];
try {
  const page = await browser.newPage();
  await page.evaluate(() => { document.body.textContent = 'Ready'; });
  await expect(page.locator('body')).toHaveText('Ready');
  const client = page.client;
  assert(client?.process?.stdin);
  let current;
  const originalRequest = client.request;
  client.request = async function (...arguments_) {
    if (arguments_[0] !== 'assertion.run') return originalRequest.apply(this, arguments_);
    current.requestStarted = performance.now();
    try { return await originalRequest.apply(this, arguments_); }
    finally { current.requestSettled = performance.now(); }
  };
  const originalWrite = client.process.stdin.write;
  client.process.stdin.write = function (chunk, ...arguments_) {
    const time = performance.now();
    const bytes = Buffer.from(chunk);
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === bytes.length - 4) {
      const message = JSON.parse(bytes.subarray(4).toString());
      if (current && message.method === 'assertion.run') {
        current.commandSent = time;
        current.commandTimeout = message.timeoutMilliseconds;
        current.requestIdentifier = message.requestId;
      } else if (current && message.kind === 'cancel') current.cancellationSent = time;
    }
    return originalWrite.call(this, chunk, ...arguments_);
  };
  let input = Buffer.alloc(0);
  client.process.stdout.prependListener('data', chunk => {
    const time = performance.now();
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4 && input.length >= input.readUInt32LE(0) + 4) {
      const length = input.readUInt32LE(0);
      const message = JSON.parse(input.subarray(4, length + 4).toString());
      input = input.subarray(length + 4);
      if (current && message.requestId === current.requestIdentifier) {
        current.replyReceived = time;
        current.replyKind = message.kind;
        current.replyError = message.error?.code;
      }
    }
  });
  for (let index = 0; index < 30; index++) {
    current = { index, started: performance.now() };
    await assert.rejects(expect(page.locator('#missing')).toBeVisible({ timeout: 25 }));
    current.finished = performance.now();
    samples.push(current);
    current = undefined;
  }
  client.request = originalRequest;
  client.process.stdin.write = originalWrite;
} finally { await browser.close(); }
await writeFile('.cache/timeout-boundary-001/results.json', JSON.stringify({ scope: 'Instrumented native timeout boundary probe; wrappers perturb timing and are not speed evidence.', samples }, null, 2) + '\n');
