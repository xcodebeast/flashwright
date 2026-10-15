import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { jpegjs } = require('playwright-core/lib/utilsBundle');
const { sampleTraceClock } = require('../packages/flashwright-core/dist/commonjs/trace-filmstrip.js');
const checks = [];
const details = {};
const idle = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const server = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><body>filmstrip storage fixture</body>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
async function check(name, callback) { await callback(); checks.push(name); }
const report = { status: 'running', checks, details };
try {
  browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  await check('off leaves the filmstrip command path unused', async () => {
    const context = await browser.newContext();
    const client = context.client;
    const original = client.request;
    const commands = [];
    client.request = function(method, ...arguments_) { commands.push(method); return original.call(this, method, ...arguments_); };
    try {
      const page = await context.newPage();
      await context.tracing.start();
      assert.equal(await page.evaluate(() => 42), 42);
      await context.tracing.stop();
      assert.deepEqual(commands.filter(method => method.includes('.filmstrip.')), []);
    } finally { client.request = original; await context.close(); }
  });
  await check('delayed metadata collection retains native capture time and tokens are single-consumption', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const client = context.client;
    const parameters = { context: context.identifier, generation: 'delayed' };
    const command = (stage, extra = {}) => client.request(`context.trace.filmstrip.${stage}`, { ...parameters, ...extra }, 5000);
    try {
      const clock = await sampleTraceClock(client, context.identifier);
      const before = performance.now();
      await command('start');
      await page.evaluate(() => { document.body.style.background = 'red'; });
      // Stock Linux Chromium can take more than 200 ms to deliver its initial
      // screencast surface. This is capture setup, before the delayed-pull marker.
      await idle(600);
      const marker = await client.request('context.trace.filmstrip.clock', { context: context.identifier }, 2000);
      await idle(300);
      const collectedAt = performance.now();
      const reply = await command('pull');
      assert.ok(reply.frames.some(frame => frame.timestamp <= marker.monotonicTime));
      const frame = reply.frames.find(frame => frame.timestamp <= marker.monotonicTime);
      const mapped = frame.timestamp + clock.offset;
      assert.ok(mapped >= before - clock.uncertainty);
      assert.ok(collectedAt - mapped >= 250 - clock.uncertainty);
      const bytes = await client.requestBinary('context.trace.filmstrip.take', { ...parameters, token: frame.token }, 2000);
      assert.equal(bytes.length, frame.byteLength);
      const decoded = jpegjs.decode(bytes, { useTArray: true });
      details.delayed = { clock, before, marker, collectedAt, frame, mapped, collectionDelay: collectedAt - mapped, imageWidth: decoded.width, imageHeight: decoded.height };
      // The earliest compositor image can still use its startup surface. The shared corpus checks stable geometry.
      assert.ok(decoded.width > 0 && decoded.width <= 800);
      assert.ok(decoded.height > 0 && decoded.height <= 450);
      await assert.rejects(client.requestBinary('context.trace.filmstrip.take', { ...parameters, token: frame.token }, 2000), { name: 'InvalidArgumentError' });
      await assert.rejects(command('pull', { generation: 'stale' }), { name: 'InvalidArgumentError' });
      await command('activity', { generation: 'stale', page: page.identifier });
      await command('seal'); await command('dispose');
      assert.equal(await page.evaluate(() => 43), 43);
    } finally { await context.close(); }
  });
  await check('new public pages and storage interception keep separate capture subjects', async () => {
    const context = await browser.newContext();
    const client = context.client;
    const parameters = { context: context.identifier, generation: 'storage' };
    try {
      await client.request('context.trace.filmstrip.start', parameters, 2000);
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(() => { localStorage.setItem('captured', 'original'); document.body.style.background = 'blue'; });
      const storage = await context.storageState();
      assert.deepEqual(storage.origins, [{ origin, localStorage: [{ name: 'captured', value: 'original' }] }]);
      await idle(250);
      await page.close();
      await client.request('context.trace.filmstrip.seal', parameters, 2000);
      const frames = (await client.request('context.trace.filmstrip.pull', parameters, 2000)).frames;
      assert.ok(frames.length);
      assert.deepEqual([...new Set(frames.map(frame => frame.page))], [page.identifier]);
      for (const frame of frames) assert.equal((await client.requestBinary('context.trace.filmstrip.take', { ...parameters, token: frame.token }, 2000)).length, frame.byteLength);
      await client.request('context.trace.filmstrip.dispose', parameters, 2000);
      details.storageFrames = frames.length;
    } finally { await context.close(); }
  });
  await check('claimed but unconsumed noisy frames exhaust the recording bound without harming the page', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 800 } });
    const page = await context.newPage();
    const client = context.client;
    const parameters = { context: context.identifier, generation: 'overflow' };
    try {
      await page.evaluate(() => {
        document.body.style.cssText = 'margin:0';
        const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 800; document.body.append(canvas);
        const context = canvas.getContext('2d'); const image = context.createImageData(800, 800);
        let random = 123456789;
        for (let offset = 0; offset < image.data.length; offset += 4) {
          for (let component = 0; component < 3; component++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; image.data[offset + component] = random >>> 24; }
          image.data[offset + 3] = 255;
        }
        context.putImageData(image, 0, 0);
        let count = 0;
        const animate = () => { context.fillStyle = count++ % 2 ? 'red' : 'blue'; context.fillRect(0, 0, 100, 100); globalThis.filmstripAnimation = requestAnimationFrame(animate); };
        animate();
      });
      await client.request('context.trace.filmstrip.start', parameters, 2000);
      const started = performance.now();
      let error;
      let claimed = 0;
      let claimedBytes = 0;
      while (performance.now() - started < 8000 && !error) {
        await client.request('context.trace.filmstrip.activity', { ...parameters, page: page.identifier }, 2000);
        await idle(50);
        try {
          const frames = (await client.request('context.trace.filmstrip.pull', parameters, 2000)).frames;
          claimed += frames.length;
          claimedBytes += frames.reduce((sum, frame) => sum + frame.byteLength, 0);
        } catch (caught) { error = caught; }
      }
      assert.equal(error?.name, 'ResourceLimitError');
      assert.ok(claimed > 0 && claimed <= 128);
      assert.ok(claimedBytes < 16 * 1024 * 1024);
      assert.equal(await page.evaluate(() => { cancelAnimationFrame(globalThis.filmstripAnimation); return 42; }), 42);
      await client.request('context.trace.filmstrip.dispose', parameters, 5000);
      await context.tracing.start({ screenshots: true });
      await page.evaluate(() => { document.body.style.background = 'green'; });
      await context.tracing.stop();
      details.overflow = { claimed, claimedBytes, elapsed: performance.now() - started, error: error.message };
    } finally { await context.close(); }
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
