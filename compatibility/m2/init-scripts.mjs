import assert from 'node:assert/strict';
import { createHttpFixture } from '../../tools/http-fixture.mjs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';

const destination = `compatibility/evidence/init-scripts-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', schemaVersion: 1, reference: '1.60.0', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, candidateChecks: [], scope: 'Page/context init scripts and disposable registrations on owned pages and same-process frames. No ordering guarantee, popup/worker/OOP support or performance claim.' };
const application = `<!doctype html><script>window.application = {context:globalThis.contextSeed??null,page:globalThis.pageSeed??null,argument:globalThis.argument??null,raw:globalThis.raw??null};</script>`;
const fixture = createHttpFixture((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(application + (request.url === '/parent' ? '<iframe name="child" src="/child"></iframe>' : request.url === '/remote-parent' ? `<iframe name="cross-origin" src="http://localhost:${server.address().port}/child"></iframe>` : ''));
});
const { server } = fixture;
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const pathScript = join(destination, 'preload.js');
await writeFile(pathScript, 'globalThis.pathSeed = "loaded from file";');
const applicationState = page => page.evaluate(() => window.application);

/** Initial subscribed diagnostics arrive after page ownership; later listeners do not replay history. */
async function initialDiagnostics(browser) {
  const context = await browser.newContext();
  const records = { contextConsole: [], pageConsole: [], pageErrors: [] };
  const pending = [];
  const retainConsole = (messages, message) => {
    const record = { text: message.text(), hasPage: !!message.page() }; messages.push(record);
    pending.push(Promise.all(message.args().map(handle => handle.jsonValue())).then(values => { record.values = values; }));
  };
  context.on('console', message => retainConsole(records.contextConsole, message));
  context.on('page', page => {
    page.on('console', message => retainConsole(records.pageConsole, message));
    page.on('pageerror', error => records.pageErrors.push(error.message));
  });
  await context.addInitScript(() => { console.log('initial diagnostics', { value: 42 }); throw new Error('initial error'); });
  const page = await context.newPage();
  await page.evaluate(() => 42); await Promise.all(pending);
  assert.equal(records.contextConsole.length, 1); assert.equal(records.pageConsole.length, 1);
  assert.deepEqual(records.pageErrors, ['initial error']);
  assert.deepEqual(records.contextConsole, records.pageConsole);
  await context.close();

  const pageOnlyContext = await browser.newContext();
  const pageOnly = [];
  pageOnlyContext.on('page', page => page.on('console', message => pageOnly.push(message.text())));
  await pageOnlyContext.addInitScript(() => console.log('page-only initial diagnostics'));
  const pageOnlyPage = await pageOnlyContext.newPage(); await pageOnlyPage.evaluate(() => 42);
  assert.deepEqual(pageOnly, []);
  await pageOnlyPage.goto(origin + '/page-console');
  assert.deepEqual(pageOnly, ['page-only initial diagnostics']);
  await pageOnlyContext.close();
  return { ...records, pageOnly };
}

/** Collecting state must not execute a user's preload on internal origin pages. */
async function storageWithoutInitSideEffects(browser) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('initializations', String(Number(localStorage.getItem('initializations') ?? '0') + 1));
  });
  const page = await context.newPage(); await page.goto(origin + '/storage');
  assert.equal(await page.evaluate(() => localStorage.getItem('initializations')), '1');
  await page.close();
  const state = await context.storageState();
  assert.equal(state.origins[0].localStorage.find(entry => entry.name === 'initializations').value, '1');
  const second = await context.storageState(); assert.deepEqual(second, state);
  await context.close();
  return state.origins[0].localStorage;
}

/** Hostnames alone do not prove a process boundary: shell and full Chrome differ here. */
async function crossOriginInitialization(name, browser) {
  const context = await browser.newContext();
  await context.addInitScript('globalThis.contextSeed = "registered";');
  const page = await context.newPage();
  try {
    if (name === 'playwright') {
      await page.goto(origin + '/remote-parent');
      assert.equal(await page.frame('cross-origin').evaluate(() => globalThis.contextSeed), 'registered');
      const session = await context.newCDPSession(page);
      try {
        const defaultWorlds = [];
        session.on('Runtime.executionContextCreated', ({ context }) => {
          if (context.auxData?.isDefault) defaultWorlds.push(context.auxData.frameId);
        });
        await session.send('Runtime.enable');
        const { frameTree } = await session.send('Page.getFrameTree');
        const { targetInfos } = await session.send('Target.getTargets');
        assert.ok(defaultWorlds.includes(frameTree.frame.id));
        const localChild = frameTree.childFrames?.find(child => child.frame.name === 'cross-origin');
        const remoteChild = targetInfos.find(target => target.type === 'iframe' && target.parentFrameId === frameTree.frame.id && target.url === `http://localhost:${server.address().port}/child`);
        const sameProcess = !!localChild && defaultWorlds.includes(localChild.frame.id);
        assert.notEqual(sameProcess, !!remoteChild, 'The fixture must prove exactly one child-frame process placement');
        report.crossOriginFrame = { placement: sameProcess ? 'same-process' : 'out-of-process', defaultWorlds, frameTree, remoteTarget: remoteChild ?? null };
      } finally { await session.detach(); }
    } else if (report.crossOriginFrame.placement === 'out-of-process') {
      await assert.rejects(page.goto(origin + '/remote-parent'), error => error.name === 'UnsupportedFeatureError');
      await assert.rejects(page.evaluate(() => 42), error => error.name === 'UnsupportedFeatureError');
      report.candidateChecks.push('Proven out-of-process child transition fails the affected scripted page explicitly');
    } else {
      await page.goto(origin + '/remote-parent');
      assert.equal(await page.frame('cross-origin').evaluate(() => globalThis.contextSeed), 'registered');
      report.candidateChecks.push('Proven same-process cross-origin child receives inherited init scripts; this browser run does not exercise out-of-process rejection');
    }
  } finally { await context.close(); }
}

async function run(name, chromium) {
  const outcomes = report.outcomes[name] = {};
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  try {
    outcomes.initialDiagnostics = await initialDiagnostics(browser);
    outcomes.storageWithoutInitSideEffects = await storageWithoutInitSideEffects(browser);
    const context = await browser.newContext();
    const original = await context.newPage();
    await original.goto(origin + '/first');
    const contextScript = await context.addInitScript(seed => { globalThis.contextSeed = seed; }, 'context');
    assert.equal(typeof contextScript.dispose, 'function');
    assert.equal(typeof contextScript[Symbol.asyncDispose], 'function');
    outcomes.noRetroactiveContext = await original.evaluate(() => globalThis.contextSeed ?? null);
    assert.equal(outcomes.noRetroactiveContext, null);
    const pageScript = await original.addInitScript({ content: 'globalThis.pageSeed = "page";' });
    outcomes.noRetroactivePage = await original.evaluate(() => globalThis.pageSeed ?? null);
    assert.equal(outcomes.noRetroactivePage, null);
    const later = await context.newPage();
    outcomes.initialBlank = await later.evaluate(() => ({ context: globalThis.contextSeed ?? null, page: globalThis.pageSeed ?? null }));
    assert.deepEqual(outcomes.initialBlank, { context: 'context', page: null });
    await original.goto(origin + '/parent');
    outcomes.main = await applicationState(original);
    outcomes.child = await applicationState(original.frame('child'));
    assert.deepEqual(outcomes.main, { context: 'context', page: 'page', argument: null, raw: null });
    assert.deepEqual(outcomes.child, outcomes.main);
    await later.goto(origin + '/later');
    outcomes.contextOnly = await applicationState(later);
    assert.equal(outcomes.contextOnly.context, 'context'); assert.equal(outcomes.contextOnly.page, null);
    await pageScript.dispose(); await pageScript.dispose();
    outcomes.disposalDoesNotUndo = await original.evaluate(() => globalThis.pageSeed);
    assert.equal(outcomes.disposalDoesNotUndo, 'page');
    await original.goto(origin + '/successor');
    outcomes.afterPageDisposal = await applicationState(original);
    assert.equal(outcomes.afterPageDisposal.page, null);
    assert.equal(outcomes.afterPageDisposal.context, 'context');
    await contextScript[Symbol.asyncDispose]();
    for (const page of [original, later, await context.newPage()]) {
      await page.goto(origin + '/removed');
      assert.deepEqual(await applicationState(page), { context: null, page: null, argument: null, raw: null });
    }
    outcomes.contextDisposal = 'existing and future pages no longer execute';

    const argument = { text: '\uD800\0\uDC00', date: new Date('2020-01-02T03:04:05Z'), omitted: undefined, array: [undefined, NaN, Infinity, -0] };
    const argumentScript = await original.addInitScript(value => { globalThis.argument = value; }, argument);
    const rawScript = await original.addInitScript('globalThis.raw = String.raw`é\\n\uD800`;');
    await original.goto(origin + '/arguments');
    outcomes.arguments = await applicationState(original);
    assert.deepEqual(outcomes.arguments.argument, JSON.parse(JSON.stringify(argument)));
    assert.equal(outcomes.arguments.raw, 'é\\n\uD800');
    await argumentScript.dispose(); await rawScript.dispose();

    const fromFile = await original.addInitScript({ path: pathScript });
    const fromContent = await original.addInitScript({ path: '/nonexistent/ignored.js', content: 'globalThis.contentWins = true;' });
    await original.goto(origin + '/sources');
    outcomes.sources = await original.evaluate(() => ({ path: globalThis.pathSeed, content: globalThis.contentWins }));
    assert.deepEqual(outcomes.sources, { path: 'loaded from file', content: true });
    await fromFile.dispose(); await fromContent.dispose();
    const scopedOne = await original.addInitScript('const privateSeed = 1; globalThis.firstScoped = privateSeed;');
    const scopedTwo = await original.addInitScript('const privateSeed = 2; globalThis.secondScoped = privateSeed;');
    await original.goto(origin + '/scope');
    outcomes.independentScopes = await original.evaluate(() => [globalThis.firstScoped, globalThis.secondScoped, typeof globalThis.privateSeed]);
    assert.deepEqual(outcomes.independentScopes, [1, 2, 'undefined']);
    await Promise.all([scopedOne.dispose(), scopedTwo.dispose()]);

    const isolated = await browser.newContext();
    const isolatedPage = await isolated.newPage();
    await isolatedPage.goto(origin + '/isolation');
    assert.deepEqual(await applicationState(isolatedPage), { context: null, page: null, argument: null, raw: null });
    await isolated.close();
    const registrations = await Promise.all(Array.from({ length: 8 }, (_, index) => context.addInitScript(index => { globalThis.initMarkers ??= {}; globalThis.initMarkers[index] = (globalThis.initMarkers[index] ?? 0) + 1; }, index)));
    const simultaneousPages = await Promise.all(Array.from({ length: 4 }, () => context.newPage()));
    for (const page of simultaneousPages) {
      assert.deepEqual(await page.evaluate(() => globalThis.initMarkers), Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index, 1])));
      await page.goto(origin + '/concurrent');
      assert.deepEqual(await page.evaluate(() => globalThis.initMarkers), Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index, 1])));
    }
    await Promise.all(registrations.map(registration => registration.dispose()));
    outcomes.concurrentRegistration = 'each of eight scripts executes once in four independently created pages';
    const afterClose = await original.addInitScript('globalThis.never = true;');
    await original.close(); await afterClose.dispose();
    const afterContextClose = await context.addInitScript('globalThis.never = true;');
    await context.close(); await afterContextClose.dispose();
    outcomes.closedOwnerDisposal = 'idempotent';
    if (name === 'flashwright') {
      const validationContext = await browser.newContext();
      const page = await validationContext.newPage();
      const cyclic = {}; cyclic.self = cyclic;
      for (const [script, argument] of [[{}, undefined], [{ content: 1 }, undefined], ['globalThis.invalid=true', 1], [() => {}, 1n], [() => {}, cyclic]]) {
        await assert.rejects(page.addInitScript(script, argument), error => error.name === 'InvalidArgumentError');
      }
      await assert.rejects(page.addInitScript(' '.repeat(1_000_001)), error => error.name === 'ResourceLimitError');
      await page.goto(origin + '/validation');
      assert.equal(await page.evaluate(() => globalThis.invalid ?? null), null);
      await validationContext.close();
      report.candidateChecks.push('Validation and source limits before browser registration');
    }
    await crossOriginInitialization(name, browser);
  } finally { await browser.close(); }
}
try {
  await run('playwright', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  try { await fixture.close(); }
  catch (error) { report.status = 'failed'; report.cleanupError = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Init-script evidence: ${destination}/report.json`);
}
