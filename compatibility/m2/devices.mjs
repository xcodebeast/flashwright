import { runtimeMetadata } from '../../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium, devices as referenceDevices } from 'playwright';
import { chromium as flashwrightChromium, devices } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';

assert.deepEqual(devices, referenceDevices, 'all standalone descriptors match the pinned reference');
const hash = value => createHash('sha256').update(value).digest('hex');
const destination = `compatibility/evidence/devices-${process.platform}-${process.arch}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = {
  schemaVersion: 1, reference: '1.60.0', ...runtimeMetadata,
  sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, candidateChecks: [], status: 'running',
  scope: 'Context-owned device profiles, screen, user-agent client hints, document initialization and screenshot scaling. Functional conformance only; workers, popups and out-of-process frames are outside this slice.',
};
const requests = [];
const server = createServer((request, response) => {
  requests.push({ path: request.url, userAgent: request.headers['user-agent'], mobile: request.headers['sec-ch-ua-mobile'], platform: request.headers['sec-ch-ua-platform'] });
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html>${request.url.includes('no-meta') ? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">'}<style>html,body{margin:0;background:rgb(24,48,96)}#box{width:40px;height:30px;background:rgb(192,64,32)}</style><div id="box"></div><script>window.initialDevice = {userAgent:navigator.userAgent,ratio:devicePixelRatio,touch:navigator.maxTouchPoints};</script>${request.url.includes('parent') ? '<iframe name="child" src="/child" style="border:0;width:100px;height:80px"></iframe>' : ''}`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;

function profile(name) {
  return { ...devices[name] }; // Preserve descriptor annotations in ordinary spread usage.
}
const profiles = [
  ['default', {}],
  ['desktop', profile('Desktop Chrome')],
  ['desktop-hidpi', profile('Desktop Chrome HiDPI')],
  ['mobile', profile('Pixel 7')],
  ['safari-descriptor-on-chromium', profile('Desktop Safari')],
  ['firefox-descriptor-on-chromium', profile('Desktop Firefox')],
  ['iphone-descriptor-on-chromium', profile('iPhone 13')],
  ['mobile-landscape', { ...profile('Pixel 7'), viewport: { width: 700, height: 400 }, screen: { width: 915, height: 412 } }],
  ['touch-desktop', { viewport: { width: 320, height: 240 }, hasTouch: true, isMobile: false, deviceScaleFactor: 1.5 }],
  ['mobile-without-touch', { viewport: { width: 320, height: 240 }, isMobile: true, hasTouch: false }],
  ['zero-scale-default', { viewport: { width: 320, height: 240 }, deviceScaleFactor: 0 }],
  ['empty-user-agent', { userAgent: '' }],
  ['custom-user-agent', { userAgent: 'ContextDeviceConformance/1.0' }],
  ['natural-viewport', { viewport: null, isMobile: false, hasTouch: true, screen: { width: 400, height: 300 } }],
];

async function snapshot(page) {
  return page.evaluate(async () => ({
    initial: window.initialDevice,
    userAgent: navigator.userAgent, ratio: devicePixelRatio, touch: navigator.maxTouchPoints,
    touchEvent: 'ontouchstart' in window, coarsePointer: matchMedia('(pointer: coarse)').matches,
    viewport: { width: innerWidth, height: innerHeight },
    screen: { width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight, orientation: screen.orientation.type, angle: screen.orientation.angle },
    clientHints: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['architecture', 'model', 'platformVersion']) : null,
  }));
}

async function screenshot(page, options) {
  const bytes = await page.screenshot(options);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: hash(bytes) };
}

async function run(name, chromium) {
  const result = report.outcomes[name] = {};
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  try {
    const baselineContext = await browser.newContext();
    const baselinePage = await baselineContext.newPage();
    await baselinePage.goto(origin + '/baseline');
    const baseline = await snapshot(baselinePage);
    for (const [label, options] of profiles) {
      const context = await browser.newContext(options);
      try {
        const page = await context.newPage();
        const requestStart = requests.length;
        await page.goto(origin + '/parent');
        const observed = result[label] = { page: await snapshot(page), viewport: page.viewportSize() };
        observed.child = await page.frame('child').evaluate(() => ({ userAgent: navigator.userAgent, ratio: devicePixelRatio, touch: navigator.maxTouchPoints }));
        observed.requests = requests.slice(requestStart).filter(request => ['/parent', '/child'].includes(request.path));
        await page.goto(origin + '/successor');
        assert.deepEqual(await snapshot(page), observed.page, `${name}/${label}: navigation retains the device profile`);
        const secondPage = await context.newPage();
        await secondPage.goto(origin + '/second');
        assert.deepEqual(await snapshot(secondPage), observed.page, `${name}/${label}: later pages inherit the device profile`);
        assert.deepEqual(await snapshot(baselinePage), baseline, `${name}/${label}: another context remains unchanged`);
        if (['touch-desktop', 'mobile', 'mobile-landscape'].includes(label)) {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          observed.screenshots = {};
          for (const scale of ['css', 'device']) {
            observed.screenshots[scale] = await screenshot(page, { scale });
            observed.screenshots[scale + '-clip'] = await screenshot(page, { scale, clip: { x: 0, y: 0, width: 100, height: 80 } });
            observed.screenshots[scale + '-full'] = await screenshot(page, { scale, fullPage: true });
          }
          await page.goto(origin + '/no-meta');
          observed.withoutViewportMeta = await snapshot(page);
          observed.screenshots.noMeta = await screenshot(page, { scale: 'css' });
        }
      } finally { await context.close(); }
    }
    if (name === 'flashwright') {
      for (const options of [
        { defaultBrowserType: 'unknown' }, { isMobile: 'yes' }, { hasTouch: 1 }, { userAgent: 42 }, { screen: null }, { screen: { width: 1, height: 0 } },
        { deviceScaleFactor: -1 }, { deviceScaleFactor: Infinity }, { deviceScaleFactor: NaN },
        { viewport: null, deviceScaleFactor: 1 }, { viewport: null, isMobile: true },
      ]) {
        const before = browser.contexts().length;
        await assert.rejects(browser.newContext(options), error => error.name === 'InvalidArgumentError');
        assert.equal(browser.contexts().length, before, 'invalid options allocate no public context');
      }
      report.candidateChecks.push('Invalid profile validation before allocation');
      const page = await browser.newPage({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 50 });
      await page.goto(origin + '/limit');
      await assert.rejects(page.screenshot(), error => error.name === 'ResourceLimitError');
      const css = await screenshot(page, { scale: 'css' });
      assert.deepEqual([css.width, css.height], [100, 100]);
      await page.close();
      report.candidateChecks.push('Device-scale pixel limits and CSS-scale recovery');
    }
  } finally { await browser.close(); }
}

try {
  await run('playwright', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(await sourceManifest(), report.sources, 'sources remain frozen during conformance');
  assert.equal(createHash('sha256').update(await readFile(report.browser.executablePath)).digest('hex'), report.browser.sha256);
  assert.equal(createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver')).digest('hex'), report.driverSha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error;
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Device conformance evidence: ${destination}/report.json`);
}
