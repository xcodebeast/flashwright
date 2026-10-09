import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
const require = createRequire(import.meta.url);
const { chromium: reference } = require('playwright-core');
const { chromium: implementation } = require('../packages/flashwright-core/dist/commonjs/index.js');
const { utils, iso } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const { jpegjs } = require('playwright-core/lib/utilsBundle');
const directory = resolve(process.argv[2] ?? `.cache/filmstrip-conformance-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });
const report = { status: 'running', browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH), runtime: { executable: process.execPath, version: process.version, bun: process.versions.bun }, sources: await sourceManifest(), driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'), outcomes: {} };
const idle = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function paint(page, color, noisy = false) {
  await page.evaluate(async ({ color, noisy }) => {
    document.documentElement.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';
    document.body.style.cssText = `margin:0;padding:0;width:100%;height:100%;background:${color};overflow:hidden`;
    clearInterval(globalThis.filmstripPaintTimer);
    let paints = 0;
    globalThis.filmstripPaintTimer = setInterval(() => {
      document.body.style.background = paints++ % 2 ? color : color.replace('240', '239');
      if (paints >= 8) clearInterval(globalThis.filmstripPaintTimer);
    }, 80);
    if (noisy) {
      const canvas = document.createElement('canvas');
      canvas.width = innerWidth; canvas.height = innerHeight;
      document.body.append(canvas);
      const context = canvas.getContext('2d');
      const image = context.createImageData(canvas.width, canvas.height);
      let random = 123456789;
      for (let offset = 0; offset < image.data.length; offset += 4) {
        for (let component = 0; component < 3; component++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; image.data[offset + component] = random >>> 24; }
        image.data[offset + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { color, noisy });
}
async function inspect(path, expectedPages, engine) {
  const archive = new utils.ZipFile(path);
  try {
    const names = await archive.entries();
    const records = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
    const context = records.find(record => record.type === 'context-options');
    const frames = [];
    for (const frame of records.filter(record => record.type === 'screencast-frame')) {
      const bytes = await archive.read(`resources/${frame.sha1}`);
      const decoded = jpegjs.decode(bytes, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
      assert.ok(decoded.width > 0 && decoded.width <= 800 && decoded.height > 0 && decoded.height <= 800);
      assert.ok(Number.isFinite(frame.timestamp) && Number.isFinite(frame.frameSwapWallTime));
      frames.push({ ...frame, imageSha256: hash(bytes), bytes: bytes.length, imageWidth: decoded.width, imageHeight: decoded.height, firstPixel: [...decoded.data.slice(0, 4)] });
    }
    assert.ok(frames.length, `${path}: actual captured images`);
    assert.equal(new Set(frames.map(frame => frame.pageId)).size, expectedPages);
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
    assert.equal(loader.contextEntries[0].pages.length, expectedPages);
    if (engine === 'flashwright') {
      const clock = context.flashwrightClock;
      assert.ok(clock && Number.isFinite(clock.offset) && clock.uncertainty >= 0);
      assert.equal(clock.uncertainty, (clock.hostAfter - clock.hostBefore) / 2);
      const midpoint = (clock.hostAfter + clock.hostBefore) / 2;
      assert.ok(Math.abs(clock.nativeTime + clock.offset - midpoint) <= 2 * Number.EPSILON * Math.max(1, Math.abs(midpoint)), 'clock mapping arithmetic stays within floating-point rounding');
    }
    return { path, sha256: hash(await readFile(path)), context, frames, actions: records.filter(record => ['before', 'after'].includes(record.type)), sourceEntries: names.filter(name => name.startsWith('resources/src@')) };
  } finally { archive.close(); }
}
async function run(engine, chromium) {
  const output = join(directory, engine);
  await mkdir(output);
  const traces = report.outcomes[engine] = {};
  const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
  try {
    for (const [name, options] of [['default', {}], ['null-viewport', { viewport: null }], ['odd-scale-two', { viewport: { width: 1001, height: 701 }, deviceScaleFactor: 2 }], ['tiny-three', { viewport: { width: 3, height: 3 } }], ['tiny-one', { viewport: { width: 1, height: 1 } }], ['noise-square', { viewport: { width: 800, height: 800 } }], ['large-scale-two', { viewport: { width: 2400, height: 1600 }, deviceScaleFactor: 2 }]]) {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        await context.tracing.start({ screenshots: true, snapshots: false, sources: false });
        await paint(page, 'rgb(240, 0, 0)', name === 'noise-square');
        await idle(250);
        const path = join(output, `${name}.zip`);
        await context.tracing.stop({ path });
        traces[name] = await inspect(path, 1, engine);
        assert.ok(traces[name].frames.some(frame => name === 'noise-square' || frame.firstPixel[0] > 200 && frame.firstPixel[1] < 30 && frame.firstPixel[2] < 30), `${name}: archived rendered content`);
      } finally { await context.close(); }
    }
    const context = await browser.newContext({ viewport: { width: 1001, height: 701 } });
    try {
      await context.tracing.start({ screenshots: true, snapshots: false, sources: true });
      const first = await context.newPage();
      await paint(first, 'rgb(240, 0, 0)');
      await idle(200);
      const second = await context.newPage();
      await paint(second, 'rgb(0, 240, 0)');
      await idle(200);
      await second.close();
      const pending = first.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
      await idle(50);
      await context.tracing.stopChunk({ path: join(output, 'lifecycle-first.zip') });
      await idle(100);
      await context.tracing.startChunk();
      await paint(first, 'rgb(0, 0, 240)');
      await pending;
      await idle(200);
      await context.tracing.stop({ path: join(output, 'lifecycle-second.zip') });
      traces['lifecycle-first'] = await inspect(join(output, 'lifecycle-first.zip'), 2, engine);
      traces['lifecycle-second'] = await inspect(join(output, 'lifecycle-second.zip'), 1, engine);
      assert.ok(traces['lifecycle-first'].sourceEntries.length);
      assert.ok(traces['lifecycle-second'].sourceEntries.length);
      assert.ok(traces['lifecycle-second'].frames.some(frame => frame.firstPixel[2] > 200 && frame.firstPixel[0] < 30));
      const unfinished = traces['lifecycle-first'].actions.findLast(action => action.type === 'before' && ['evaluate', 'evaluateExpression'].includes(action.method));
      assert.ok(unfinished);
      assert.ok(!traces['lifecycle-first'].actions.some(action => action.type === 'after' && action.callId === unfinished.callId));
      assert.ok(!traces['lifecycle-second'].actions.some(action => action.callId === unfinished.callId));
    } finally { await context.close(); }
  } finally { await browser.close(); }
}
try {
  await run('playwright', reference);
  await run('flashwright', implementation);
  for (const [name, trace] of Object.entries(report.outcomes.playwright)) {
    const actual = report.outcomes.flashwright[name];
    const geometry = frame => JSON.stringify([frame.width, frame.height, frame.imageWidth, frame.imageHeight]);
    if (name === 'lifecycle-first') {
      // Full Chrome can emit transient surface sizes when opening or closing another page.
      // Preserve those frames; require each lane to also contain the configured stable image.
      for (const candidate of [actual, trace]) {
        for (const pageId of new Set(candidate.frames.map(frame => frame.pageId))) {
          assert.ok(candidate.frames.some(frame => frame.pageId === pageId && frame.width === 1001 && frame.height === 701 && frame.imageWidth === 800 && frame.imageHeight === 560), `${name}: configured geometry in every lane`);
        }
      }
    } else {
      const referenceGeometry = geometry(trace.frames.at(-1));
      assert.ok(actual.frames.some(frame => geometry(frame) === referenceGeometry), `${name}: geometry of the final reference frame is present`);
    }
  }
  execFileSync('python3', ['-c', 'import sys,zipfile; [zipfile.ZipFile(path).testzip() is None or (_ for _ in ()).throw(AssertionError(path)) for path in sys.argv[1:]]', ...Object.values(report.outcomes).flatMap(traces => Object.values(traces).map(trace => trace.path))]);
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Filmstrip evidence: ${directory}/report.json`); }
