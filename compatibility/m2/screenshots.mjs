import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';

const require = createRequire(import.meta.url);
// The pinned reference distribution provides test-only image decoders, never browser commands.
const { PNG, jpegjs } = require(resolve('node_modules/playwright-core/lib/utilsBundle.js'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const destination = `compatibility/evidence/screenshots-${process.platform}-${process.arch}-${process.versions.node}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = { schemaVersion: 1, reference: '1.60.0', sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), node: process.version, platform: process.platform, architecture: process.arch, outcomes: {}, referenceDifferences: {}, candidateChecks: [], status: 'running', scope: 'Page screenshot pixels, dimensions, options, files and preparation cleanup. No performance claim.' };
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const fontBytes = await readFile('compatibility/m2/fixtures/zero-advance.ttf');
const fontWaiters = new Map();
const fontResponses = new Set();
const sockets = new Set();
const server = createServer((request, response) => {
  if (request.url.startsWith('/font-')) {
    fontResponses.add(response);
    response.on('close', () => fontResponses.delete(response));
    fontWaiters.get(request.url)?.(response); fontWaiters.delete(request.url); return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/remote') { response.end('<!doctype html><style>html,body{margin:0;background:yellow}</style><script>requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage("capture-frame-painted", "*")));</script>'); return; }
  if (request.url === '/remote-blocked') { response.end('<!doctype html><script>addEventListener("message", event => { if (event.data === "capture-child-block") { while (true) {} } });</script>'); return; }
  if (request.url === '/successor') { response.end('<!doctype html><body style="background:rgb(11, 22, 33)"><input id="successor" style="caret-color:rgb(44, 55, 66)!important"></body>'); return; }
  response.end('<!doctype html><style>html,body{margin:0}body{width:480px;height:720px;background:linear-gradient(#f00 0 300px,#00f 300px)}#box{position:absolute;left:20px;top:30px;width:80px;height:70px;background:#0f0}</style><div id="box"></div>');
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await delay(20); }
  assert.fail(`Timed out waiting for ${label}`);
}
function imageRecord(bytes) {
  const format = bytes[0] === 0x89 ? 'png' : 'jpeg';
  const image = format === 'png' ? PNG.sync.read(bytes) : jpegjs.decode(bytes, { useTArray: true });
  return { format, width: image.width, height: image.height, pixelsSha256: hash(image.data) };
}
async function startFont(page, name) {
  const path = `/font-${name}.ttf`;
  const requested = new Promise(resolve => fontWaiters.set(path, resolve));
  await page.evaluate(url => {
    document.body.style.cssText = 'margin:0;width:320px;height:240px;background:white';
    document.body.innerHTML = '<input id="caret" style="caret-color:rgb(1, 2, 3)!important"><div id="shadow"></div><span style="font:20px CaptureFont">A</span>';
    const root = document.querySelector('#shadow').attachShadow({ mode: 'open' });
    root.innerHTML = '<textarea style="caret-color:rgb(4, 5, 6)"></textarea>';
    const font = new FontFace('CaptureFont', `url(${url})`); document.fonts.add(font); globalThis.fontLoad = font.load().then(() => true, () => false);
  }, origin + path);
  return requested;
}
function finishFont(response) { response.writeHead(200, { 'content-type': 'font/ttf' }); response.end(fontBytes); }
async function caretState(page) {
  return page.evaluate(() => [document.querySelector('#caret'), document.querySelector('#shadow').shadowRoot.querySelector('textarea')].map(element => [element.style.getPropertyValue('caret-color'), element.style.getPropertyPriority('caret-color')]));
}

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const result = report.outcomes[name] = { images: {}, lifecycle: {} };
  const directory = join(destination, name); await mkdir(directory);
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    await page.goto(origin);
    result.lifecycle.viewportMetrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height, orientation: screen.orientation.type }));
    for (const [label, options] of [
      ['viewport', {}], ['fullPage', { fullPage: true }], ['clip', { clip: { x: 20, y: 30, width: 80, height: 70 } }],
      ['negativeClip', { clip: { x: -10, y: -20, width: 50, height: 70 } }], ['fractionalClip', { clip: { x: 4.2, y: 5.3, width: 20.3, height: 22.8 } }],
      ['fullPageClip', { fullPage: true, clip: { x: 400, y: 650, width: 100, height: 100 } }], ['cssScale', { scale: 'css' }],
      ['jpegDefault', { type: 'jpeg' }], ['jpegLow', { type: 'jpeg', quality: 20 }], ['jpegHigh', { type: 'jpeg', quality: 100 }],
      ['style', { style: '#box {background: rgb(91, 41, 151) !important}' }],
    ]) result.images[label] = imageRecord(await page.screenshot(options));
    assert.deepEqual([result.images.viewport.width, result.images.viewport.height], [320, 240]);
    assert.deepEqual([result.images.fullPage.width, result.images.fullPage.height], [480, 720]);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#box')).backgroundColor), 'rgb(0, 255, 0)');
    await page.evaluate(() => scrollTo(80, 300));
    result.images.scrolled = imageRecord(await page.screenshot());
    await page.evaluate(() => { scrollTo(0, 0); document.body.style.background = 'transparent'; document.documentElement.style.background = 'transparent'; });
    result.images.transparent = imageRecord(await page.screenshot({ omitBackground: true }));
    result.images.opaque = imageRecord(await page.screenshot());
    assert.notEqual(result.images.transparent.pixelsSha256, result.images.opaque.pixelsSha256);
    result.images.jpegOmit = imageRecord(await page.screenshot({ type: 'jpeg', omitBackground: true }));
    assert.deepEqual(result.images.jpegOmit, imageRecord(await page.screenshot({ type: 'jpeg' })));
    for (const [filename, options] of [['nested/capture.png', {}], ['capture.jpg', {}], ['explicit.jpg', { type: 'png' }]]) {
      const path = join(directory, filename);
      const bytes = await page.screenshot({ ...options, path });
      assert.deepEqual(await readFile(path), bytes);
      result.images[filename] = imageRecord(bytes);
    }
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
    const invalidPath = join(directory, 'inferred.PNG'); await writeFile(invalidPath, 'existing');
    await assert.rejects(page.screenshot({ path: invalidPath }));
    assert.equal(await readFile(invalidPath, 'utf8'), 'existing');

    const fontResponse = await startFont(page, name + '-wait');
    const before = await caretState(page);
    let completed = false;
    const waiting = page.screenshot({ timeout: 10000 }).then(bytes => { completed = true; return bytes; });
    void waiting.catch(() => {});
    await waitUntil(async () => (await caretState(page)).every(([color]) => color === 'transparent'), 'hidden caret in document and shadow root');
    assert.equal(completed, false);
    finishFont(fontResponse); result.images.fontReady = imageRecord(await waiting);
    assert.deepEqual(await caretState(page), before);
    result.lifecycle.fontAndCaret = true;

    await page.goto(origin);
    const childFont = await startFont(page, name + '-child');
    await page.evaluate(async () => {
      const frame = document.createElement('iframe'); frame.id = 'child';
      const loaded = new Promise(resolve => frame.onload = resolve);
      frame.srcdoc = '<input style="caret-color:rgb(7, 8, 9)!important">'; document.body.append(frame); await loaded;
    });
    const childCapture = page.screenshot({ timeout: 10000 }); void childCapture.catch(() => {});
    await waitUntil(() => page.evaluate(() => document.querySelector('#child').contentDocument.querySelector('input').style.caretColor === 'transparent'), 'same-process child caret');
    finishFont(childFont); result.images.childCaret = imageRecord(await childCapture);
    assert.equal(await page.evaluate(() => document.querySelector('#child').contentDocument.querySelector('input').style.caretColor), 'rgb(7, 8, 9)');
    result.lifecycle.childRestoration = true;


    await page.goto(origin);
    const cancelledFont = await startFont(page, name + '-cancel');
    const original = await caretState(page);
    const timedOutPath = join(directory, 'timed-out.png'); await writeFile(timedOutPath, 'existing image');
    await assert.rejects(page.screenshot({ timeout: 150, style: 'body { background: purple !important }', path: timedOutPath }), error => error.name === 'TimeoutError');
    assert.equal(await readFile(timedOutPath, 'utf8'), 'existing image');
    assert.deepEqual(await caretState(page), original);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
    finishFont(cancelledFont); await page.evaluate(() => globalThis.fontLoad);
    result.lifecycle.fontTimeout = true;

    for (const fullPage of [false, true]) {
      await page.goto(origin);
      const navigatingFont = await startFont(page, name + '-navigation-' + fullPage);
      const navigatingCapture = page.screenshot({ fullPage, timeout: 10000, style: 'body { background: purple !important }' });
      void navigatingCapture.catch(() => {});
      await waitUntil(async () => (await caretState(page))[0][0] === 'transparent', 'preparation before navigation');
      await page.goto(origin + '/successor');
      result.images['navigationDuringFonts-' + fullPage] = imageRecord(await navigatingCapture);
      navigatingFont.destroy();
      assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, document.querySelector('#successor').style.caretColor, document.querySelector('#successor').style.getPropertyPriority('caret-color')]), ['rgb(11, 22, 33)', 'rgb(44, 55, 66)', 'important']);
      result.images['afterNavigation-' + fullPage] = imageRecord(await page.screenshot());
    }
    result.lifecycle.navigationRestoration = true;

    await page.goto(origin);
    const queuedFont = await startFont(page, name + '-queued');
    const first = page.screenshot({ timeout: 10000, style: 'body { background: red !important }' });
    void first.catch(() => {});
    await waitUntil(async () => (await caretState(page))[0][0] === 'transparent', 'first queued preparation');
    const queued = page.screenshot({ timeout: 120, style: 'body { background: blue !important }' }).then(() => ({ success: true }), error => ({ error }));
    await delay(200);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 0, 0)');
    finishFont(queuedFont); await first;
    assert.equal((await queued).error?.name, 'TimeoutError');
    const afterQueuedExpiry = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    report.referenceDifferences[name] = { expiredQueuedScreenshotBackground: afterQueuedExpiry };
    assert.equal(afterQueuedExpiry, name === 'reference' ? 'rgb(0, 0, 255)' : 'rgb(255, 255, 255)');
    result.lifecycle.queuedDeadline = true;

    await page.goto(origin);
    await page.evaluate(() => {
      document.body.innerHTML = '<div id="finite"></div><div id="infinite"></div>';
      document.body.style.cssText = 'margin:0;width:320px;height:240px;background:white';
      document.head.insertAdjacentHTML('beforeend', '<style>@keyframes move {from{transform:translateX(0)}to{transform:translateX(100px)}}#finite,#infinite{width:20px;height:20px;background:red}#finite{animation:move 100s linear forwards}#infinite{animation:move 100s linear infinite}</style>');
      globalThis.animationEnds = 0; document.querySelector('#finite').addEventListener('animationend', () => animationEnds++);
    });
    result.images.animationsDisabled = imageRecord(await page.screenshot({ animations: 'disabled' }));
    await waitUntil(() => page.evaluate(() => animationEnds === 1), 'finite animation completion');
    assert.equal(await page.evaluate(() => document.querySelector('#infinite').getAnimations()[0].playState), 'running');
    result.lifecycle.animationRestore = true;

    await page.goto(origin);
    await page.evaluate(() => {
      document.body.innerHTML = '<canvas width="2048" height="2048"></canvas>';
      document.body.style.cssText = 'margin:0;width:2048px;height:2048px;background:none';
      const canvas = document.querySelector('canvas'); const context = canvas.getContext('2d');
      const data = context.createImageData(2048, 2048); let value = 123456789;
      for (let index = 0; index < data.data.length; index += 4) {
        value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
        data.data[index] = value & 255; data.data[index + 1] = (value >>> 8) & 255; data.data[index + 2] = (value >>> 16) & 255; data.data[index + 3] = 255;
      }
      context.putImageData(data, 0, 0);
    });
    const large = await page.screenshot({ fullPage: true, timeout: 10000 });
    assert.ok(large.length > 8 * 1024 * 1024);
    result.images.large = imageRecord(large);
    result.lifecycle.largePngBytes = large.length;
    if (name === 'flashwright') {
      const previousPath = join(directory, 'preserved.png'); await writeFile(previousPath, 'previous contents');
      for (const options of [{ quality: 80 }, { mask: [] }, { clip: { x: 0, y: 0, width: 0, height: 10 } }]) {
        await assert.rejects(page.screenshot({ ...options, path: previousPath }));
        assert.equal(await readFile(previousPath, 'utf8'), 'previous contents');
      }
      await page.evaluate(() => { document.body.style.width = '5000px'; document.body.style.height = '5000px'; });
      await assert.rejects(page.screenshot({ fullPage: true }), error => error.name === 'ResourceLimitError');
      assert.equal(await page.evaluate(() => 42), 42);
      report.candidateChecks.push('invalid and unsupported options preserve existing files', 'pixel limit rejects capture without losing the page');
    }

    await page.goto(origin);
    await page.evaluate(async remote => {
      const frame = document.createElement('iframe'); frame.style.cssText = 'position:absolute;left:120px;top:100px;width:100px;height:60px;border:0';
      const loaded = new Promise(resolve => frame.onload = resolve);
      const painted = new Promise(resolve => {
        const receive = event => {
          if (event.source === frame.contentWindow && event.data === 'capture-frame-painted') {
            removeEventListener('message', receive); resolve();
          }
        };
        addEventListener('message', receive);
      });
      frame.src = remote; document.body.append(frame); await Promise.all([loaded, painted]);
      // Load precedes compositing; compare a committed child surface, not a first-paint race.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, origin.replace('127.0.0.1', 'localhost') + '/remote');
    const remoteImage = await page.screenshot({ caret: 'initial' });
    await writeFile(join(directory, 'remote.png'), remoteImage);
    result.images.remoteUnmodified = imageRecord(remoteImage);
    if (name === 'reference') {
      const inspection = await browser.newBrowserCDPSession();
      const { targetInfos } = await inspection.send('Target.getTargets');
      report.crossOriginFramePlacement = targetInfos.some(target => target.type === 'iframe' && target.url.endsWith('/remote')) ? 'out-of-process' : 'same-process';
      await inspection.detach();
    }
    if (report.crossOriginFramePlacement === 'same-process') {
      const child = page.frames().find(frame => frame !== page.mainFrame());
      assert.equal(await child.locator('body').count(), 1);
      result.images.crossOriginPreparation = imageRecord(await page.screenshot({ style: 'body { background: rgb(1, 2, 3) !important }' }));
      assert.notEqual(result.images.crossOriginPreparation.pixelsSha256, result.images.remoteUnmodified.pixelsSha256);
      assert.deepEqual(imageRecord(await page.screenshot()), result.images.remoteUnmodified);
      if (name === 'flashwright') report.candidateChecks.push('same-process cross-origin preparation matches reference and restores original pixels');
    } else if (name === 'flashwright') {
      const child = page.frames().find(frame => frame !== page.mainFrame());
      await assert.rejects(child.locator('body').count(), error => error.name === 'UnsupportedFeatureError');
      await page.evaluate(() => { globalThis.preparationMutations = 0; new MutationObserver(records => preparationMutations += records.length).observe(document.documentElement, { subtree:true, attributes:true, childList:true }); });
      await assert.rejects(page.screenshot(), error => error.name === 'UnsupportedFeatureError');
      assert.equal(await page.evaluate(() => preparationMutations), 0);
      report.candidateChecks.push('cross-process preparation rejects before document changes while unmodified capture succeeds');
    }
    if (report.crossOriginFramePlacement === 'out-of-process') {
      const blockedChildPage = await browser.newPage(); await blockedChildPage.goto(origin);
      console.log(`${name}: setting up blocked child renderer`);
      await blockedChildPage.evaluate(async remote => {
        const frame = document.createElement('iframe');
        const loaded = new Promise(resolve => frame.onload = resolve);
        frame.src = remote; document.body.append(frame); await loaded;
        frame.contentWindow.postMessage('capture-child-block', '*');
      }, origin.replace('127.0.0.1', 'localhost') + '/remote-blocked');
      // Give the deliberately posted fault a turn before testing its deadline, outside capture timing.
      await delay(100);
      console.log(`${name}: capturing with blocked child renderer`);
      await assert.rejects(blockedChildPage.screenshot({ caret: 'initial', timeout: 1500 }), error => error.name === 'TimeoutError');
      console.log(`${name}: blocked child capture timed out; checking parent recovery`);
      assert.equal(await blockedChildPage.evaluate(() => 42), 42);
      await blockedChildPage.evaluate(() => document.querySelector('iframe').remove());
      result.images.remoteTimeoutRecovery = imageRecord(await blockedChildPage.screenshot());
      await blockedChildPage.close();
      result.lifecycle.remoteTimeoutRecovery = true;
    }
    const naturalViewport = await browser.newPage({ viewport: null }); await naturalViewport.goto(origin);
    result.lifecycle.naturalViewportMetrics = await naturalViewport.evaluate(() => ({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height }));
    result.images.naturalViewport = imageRecord(await naturalViewport.screenshot());
    result.images.naturalFullPage = imageRecord(await naturalViewport.screenshot({ fullPage: true, scale: 'css' }));
    await naturalViewport.close();

    const closing = await browser.newPage(); await closing.goto(origin);
    const closingFont = await startFont(closing, name + '-close');
    const closingCapture = closing.screenshot({ timeout: 10000 }).then(() => ({success:true}), error => ({error}));
    await waitUntil(async () => (await caretState(closing))[0][0] === 'transparent', 'closing capture preparation');
    await closing.close();
    assert.ok((await closingCapture).error);
    closingFont.destroy();
    result.lifecycle.pageClosure = true;

    if (name === 'flashwright') {
      const blocked = await browser.newPage(); await blocked.goto(origin);
      await blocked.evaluate(() => {
        document.body.innerHTML = '<input>';
        new MutationObserver(() => { while (true) {} }).observe(document.querySelector('input'), { attributes: true });
      });
      await assert.rejects(blocked.screenshot({ timeout: 3000 }), error => error.name === 'TimeoutError');
      await waitUntil(() => Promise.resolve(blocked.isClosed()), 'uncertain screenshot page retirement');
      assert.equal(await page.evaluate(() => 42), 42);
      report.candidateChecks.push('blocked renderer during screenshot preparation retires its page and preserves a sibling');
    }
    await page.close();
    console.log(`${name}: screenshot pixels, files, fonts, cancellation, queueing, animations and large PNG passed`);
  } finally { await browser.close(); }
}
try {
  await run('reference', referenceChromium); await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = { name: error.name, message: error.message, stack: error.stack }; throw error; }
finally {
  for (const response of fontResponses) response.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  report.sourceChangedDuringVerification = JSON.stringify(report.sources) !== JSON.stringify(await sourceManifest());
  if (report.sourceChangedDuringVerification) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Screenshot differential ${report.status}: ${destination}/report.json`);
}
