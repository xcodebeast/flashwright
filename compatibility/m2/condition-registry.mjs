import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { createLifecycleTarget } from './lifecycle-target.mjs';
import { verifyConditionQueryBatches } from './condition-query-batches.mjs';
import { verifyConditionFallbackCadence } from './condition-fallback-cadence.mjs';

const sources = await sourceManifest();
const sourceNames = ['playwright-injected.js', 'serialization.cjs', 'locator-runtime.js', 'condition-registry.js'];
const [injectedSource, codecSource, locatorSource, registrySource] = await Promise.all(sourceNames.map(name => readFile(`packages/resident-runtime/${name}`, 'utf8')));
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const fontBytes = await readFile('compatibility/m2/fixtures/zero-advance.ttf');
const fontMetadata = JSON.parse(await readFile('compatibility/m2/fixtures/zero-advance.json', 'utf8'));
assert.equal(createHash('sha256').update(fontBytes).digest('hex'), fontMetadata.fontSha256);
assert.equal(createHash('sha256').update(await readFile('compatibility/m2/fixtures/' + fontMetadata.generator)).digest('hex'), fontMetadata.generatorSha256);
const browser = await chromium.launch({ executablePath: browserPath });
const page = await browser.newPage();
let session = await page.context().newCDPSession(page);
const cases = [];
let executionContextId;
const fontRequests = new Map();
const fontServer = createServer((request, response) => {
  const accept = fontRequests.get(request.url);
  if (!accept) { response.writeHead(404); response.end(); return; }
  fontRequests.delete(request.url);
  accept(response);
});
fontServer.listen(0, '127.0.0.1');
await once(fontServer, 'listening');

async function evaluate(expression) {
  const result = await session.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function reset(html, observeMutations = true, hiddenChildFrame = false, withholdRegistryFrames = false, withholdRegistryTimer = false) {
  if (executionContextId) await evaluate('globalThis.testConditions?.dispose()');
  if (hiddenChildFrame) {
    await page.setContent('<iframe name="hidden" style="display:none"></iframe>');
    await page.frame('hidden').setContent(html);
  } else await page.setContent(html);
  const { frameTree } = await session.send('Page.getFrameTree');
  const frameId = hiddenChildFrame ? frameTree.childFrames[0].frame.id : frameTree.frame.id;
  await installRegistry(frameId, observeMutations, withholdRegistryFrames, withholdRegistryTimer);
}

async function installRegistry(frameId, observeMutations, withholdRegistryFrames = false, withholdRegistryTimer = false) {
  ({ executionContextId } = await session.send('Page.createIsolatedWorld', { frameId, worldName: '__flashwright_condition_test__' }));
  await evaluate(`(() => {
    const requestAnimationFrame = ${withholdRegistryFrames ? '() => 1' : 'globalThis.requestAnimationFrame.bind(globalThis)'};
    const cancelAnimationFrame = ${withholdRegistryFrames ? '() => {}' : 'globalThis.cancelAnimationFrame.bind(globalThis)'};
    const setTimeout = ${withholdRegistryTimer ? '(callback, milliseconds, ...callbackArguments) => milliseconds === 100 ? -1 : globalThis.setTimeout(callback, milliseconds, ...callbackArguments)' : 'globalThis.setTimeout.bind(globalThis)'};
    const module = {}; ${injectedSource}; const exports = {}; ${codecSource}; ${locatorSource}; ${registrySource};
    const injected = new (module.exports.InjectedScript())(globalThis, {isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:1,browserName:'chromium',shouldPrependErrorPrefix:false,isUtilityWorld:true,customEngines:[]});
    globalThis.testInjected = injected;
    globalThis.createTestLocator = selectorBatchCache => createLocatorRuntime(injected, exports.createValueCodec(), {conditionInstrumentation:true,selectorBatchCache});
    globalThis.testLocator = createTestLocator(true);
    globalThis.testConditions = createConditionRegistry({instrumentation:true,observeMutations:${observeMutations}});
    globalThis.testPromises = new Map();
    globalThis.startCondition = (token, options) => {
      const request = JSON.stringify({selector:options.selector, ...options.request});
      const units = Array.from({length:request.length}, (_, index) => request.charCodeAt(index));
      const promise = testConditions.wait({token,timeoutMilliseconds:options.timeoutMilliseconds === undefined ? 2000 : options.timeoutMilliseconds,isNot:options.isNot ?? false,
        check:() => testLocator.assertion(units, null, options.expression, options.isNot ?? false)});
      testPromises.set(token, promise); return true;
    };
    return true;
  })()`);
}

async function start(options) {
  const token = randomUUID();
  await evaluate(`startCondition(${JSON.stringify(token)}, ${JSON.stringify(options)})`);
  return token;
}

async function finish(token, status = 'matched') {
  const result = await evaluate(`testPromises.get(${JSON.stringify(token)})`);
  await evaluate(`testPromises.delete(${JSON.stringify(token)})`);
  assert.equal(result.status, status, JSON.stringify(result));
  return result;
}

async function clean(label) {
  const state = await evaluate('testConditions.inspect()');
  for (const name of ['activeConditions', 'observedRoots', 'queuedDiscovery', 'queuedConditions']) assert.equal(state[name], 0, `${label}: ${name}`);
  for (const name of ['animationFrameScheduled', 'fallbackTimerScheduled', 'deadlineTimerScheduled', 'discoveryTimerScheduled', 'flushMicrotaskScheduled', 'flushTaskScheduled', 'flushChannelOpen']) assert.equal(state[name], false, `${label}: ${name}`);
  assert.ok(state.maximumChecksBeforeYield <= 32, `${label}: unbounded predicate batch`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await evaluate('testConditions.inspect()'), state, `${label}: work continued after the last condition`);
  cases.push({ name: label, counters: state });
  console.log(`Resident registry: ${label}`);
  return state;
}

const text = (selector, value, extra = {}) => ({ selector, expression: 'to.have.text', request: { expectedText: [{ string: value, normalizeWhiteSpace: true }] }, ...extra });
const state = (selector, expression, extra = {}) => ({ selector, expression, ...extra });

try {
  await verifyConditionQueryBatches({ reset, evaluate, page, cases });
  await verifyConditionFallbackCadence({ reset, evaluate, page, start, finish, clean, cases, registrySource });
  await reset('<p>already true</p>');
  await finish(await start(text('css=p', 'already true')));
  const immediate = await clean('already true skips discovery');
  assert.equal(immediate.discoveryPasses, 0);
  assert.equal(immediate.discoveryVisits, 0);
  assert.equal(immediate.predicateEvaluations, 1);

  await reset('<p>before</p>');
  const delayed = await start(text('css=p', 'after'));
  await page.evaluate(() => { document.querySelector('p').textContent = 'after'; });
  await finish(delayed);
  const mutation = await clean('mutation wakeup runs the complete text predicate');
  assert.ok(mutation.mutationBatches > 0);

  await reset('<p>before</p>');
  const transient = await start(text('css=p', 'brief'));
  await page.evaluate(() => {
    document.querySelector('p').textContent = 'brief';
    setTimeout(() => { document.querySelector('p').textContent = 'after'; }, 0);
  });
  const transientResult = await finish(transient);
  assert.equal(transientResult.observation.received.units.map(unit => String.fromCharCode(unit)).join(''), 'brief');
  await clean('valid transient state can be observed before the next task');

  await reset('<p>before</p>');
  const negated = await start(text('css=p', 'before', { isNot: true }));
  await page.evaluate(() => { document.querySelector('p').textContent = 'different'; });
  await finish(negated);
  await clean('negation checks the new value');

  await reset('<input value="before"><input id="checked" type="checkbox">');
  const property = await start({ selector: 'css=input:not(#checked)', expression: 'to.have.value', request: { expectedText: [{ string: 'after' }] } });
  const checked = await start(state('css=#checked', 'to.be.checked', { request: { expectedValue: { checked: true } } }));
  await page.evaluate(() => { document.querySelector('input').value = 'after'; document.querySelector('#checked').checked = true; });
  await finish(property); await finish(checked);
  const propertyState = await clean('property-only values and checkbox state use fallback');
  assert.equal(propertyState.mutationBatches, 0);
  assert.ok(propertyState.fallbackChecks > 0);

  await reset('<style>p { visibility:hidden }</style><p>target</p>');
  const stylesheet = await start(state('css=p', 'to.be.visible'));
  await page.evaluate(() => { document.styleSheets[0].cssRules[0].style.visibility = 'visible'; });
  await finish(stylesheet);
  const stylesheetState = await clean('CSSOM-only changes use fallback');
  assert.equal(stylesheetState.mutationBatches, 0);
  assert.ok(stylesheetState.fallbackChecks > 0);

  await reset('<style>@keyframes hide { to { transform:scale(0) } } p { animation:hide 100ms linear forwards paused }</style><p>target</p>');
  const animation = await start(state('css=p', 'to.be.hidden'));
  await page.evaluate(() => { document.querySelector('p').getAnimations()[0].play(); });
  await finish(animation);
  const animationState = await clean('CSS animation changes visibility without DOM mutation');
  assert.equal(animationState.mutationBatches, 0);
  assert.ok(animationState.predicateEvaluations > 1);
  assert.equal(await page.locator('p').isVisible(), false);

  await reset('<style>@keyframes reveal { 0%,100% { visibility:hidden } 25%,75% { visibility:visible } } p { animation:reveal 500ms linear both paused }</style><p>target</p>');
  const animatedTransient = await start(state('css=p', 'to.be.visible'));
  await page.evaluate(() => { document.querySelector('p').getAnimations()[0].play(); });
  assert.equal((await finish(animatedTransient)).observation.matches, true);
  await page.evaluate(() => document.querySelector('p').getAnimations()[0].finished.then(() => true));
  assert.equal(await page.locator('p').isVisible(), false);
  const animatedTransientState = await clean('a full predicate observes a transient CSS animation state');
  assert.equal(animatedTransientState.mutationBatches, 0);
  assert.ok(animatedTransientState.fallbackChecks > 0);

  for (const mode of ['ordinary', 'withheld-fallback', 'failed-font']) {
    const family = 'ConditionFont-' + randomUUID();
    const withholdFallback = mode !== 'ordinary';
    await reset(`<style>span { display:inline-block;font:20px "${family}",monospace }</style><span>A</span>`, true, false, withholdFallback, withholdFallback);
    await evaluate(`globalThis.fontEvents=[]; globalThis.recordFontEvent=event=>fontEvents.push(event.type);
      for (const name of ['loadingdone','loadingerror']) document.fonts.addEventListener(name, recordFontEvent); true`);
    const beforeFont = await page.locator('span').boundingBox();
    assert.ok(beforeFont.width > 0);
    const requestPath = '/font/' + randomUUID();
    const requested = new Promise(resolve => fontRequests.set(requestPath, resolve));
    await page.evaluate(({ family, url }) => {
      globalThis.fixtureFont = new FontFace(family, `url(${url})`, { display: 'swap' });
      document.fonts.add(fixtureFont);
      globalThis.fixtureFontLoad = fixtureFont.load().then(() => true, () => false);
    }, { family, url: `http://127.0.0.1:${fontServer.address().port}${requestPath}` });
    const response = await requested;
    assert.equal(await page.evaluate(() => fixtureFont.status), 'loading');
    const fontCondition = await start(state('css=span', 'to.be.hidden', { timeoutMilliseconds: mode === 'failed-font' ? 250 : 2000 }));
    response.writeHead(mode === 'failed-font' ? 404 : 200, { 'content-type': 'font/ttf', 'access-control-allow-origin': '*' });
    response.end(mode === 'failed-font' ? '' : fontBytes);
    assert.equal(await page.evaluate(() => fixtureFontLoad), mode !== 'failed-font');
    const result = await finish(fontCondition, mode === 'failed-font' ? 'expired' : 'matched');
    const afterFont = await page.locator('span').boundingBox();
    const fontEvents = await evaluate('fontEvents');
    const label = mode === 'ordinary' ? 'font loading changes geometry without DOM mutation'
      : mode === 'withheld-fallback' ? 'font completion wakes conditions while registry fallback callbacks are withheld'
      : 'failed font loading wakes a full check without reporting false success';
    const fontState = await clean(label);
    assert.equal(fontState.mutationBatches, 0);
    assert.ok(fontState.predicateEvaluations > 1);
    if (withholdFallback) assert.equal(fontState.fallbackChecks, 0);
    if (mode === 'failed-font') {
      assert.equal(result.observation.matches, false);
      assert.ok(afterFont.width > 0);
      assert.ok(fontEvents.includes('loadingerror'));
    } else {
      assert.equal(afterFont.width, 0);
      assert.ok(fontEvents.includes('loadingdone'));
    }
    cases.at(-1).font = { mode, beforeWidth: beforeFont.width, afterWidth: afterFont.width, events: fontEvents };
    await evaluate(`for (const name of ['loadingdone','loadingerror']) document.fonts.removeEventListener(name, recordFontEvent); true`);
    await page.evaluate(() => { document.fonts.delete(fixtureFont); });
  }

  await reset('<style>@media (min-width:800px) { p { display:none } }</style><p>target</p>');
  const viewport = await start(state('css=p', 'to.be.visible'));
  await page.setViewportSize({ width: 640, height: 480 });
  await finish(viewport);
  await clean('viewport media-query changes invalidate visibility');
  await page.setViewportSize({ width: 1280, height: 720 });

  await reset('<input>');
  const focused = await start(state('css=input', 'to.be.focused'));
  await page.locator('input').focus();
  await finish(focused);
  await clean('focus changes are observed without DOM mutations');

  await reset('<p id="target">before</p>');
  const replacement = await start(text('css=#target', 'replacement'));
  await page.evaluate(() => { document.querySelector('p').outerHTML = '<p id="target">replacement</p>'; });
  await finish(replacement);
  await clean('replacement re-resolves membership');

  await reset('<div id="host"></div>');
  const shadow = await start(text('css=#target', 'shadow'));
  await page.evaluate(() => { document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<p id="target">shadow</p>'; });
  await finish(shadow);
  await clean('new shadow on an existing host uses fallback');

  await reset('<div id="host"></div>');
  await page.evaluate(() => { document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<p>before</p>'; });
  const nestedShadow = await start(text('css=p', 'after'));
  await page.waitForTimeout(40);
  assert.equal((await evaluate('testConditions.inspect()')).observedRoots, 2);
  await page.evaluate(() => { document.querySelector('#host').shadowRoot.querySelector('p').textContent = 'after'; });
  await finish(nestedShadow);
  assert.ok((await clean('existing shadow roots are observed')).mutationBatches > 0);

  await reset('<section></section>');
  await page.evaluate(() => {
    for (let index = 0; index < 600; index++) {
      const host = document.createElement('div');
      host.attachShadow({ mode: 'open' }).innerHTML = '<p>before</p>';
      document.querySelector('section').append(host);
    }
  });
  const boundedRoots = await start(text('css=section > div >> nth=599 >> css=p', 'after'));
  await page.waitForTimeout(100);
  const boundedState = await evaluate('testConditions.inspect()');
  assert.equal(boundedState.observedRoots, 512);
  assert.ok(boundedState.discoveryOverflows > 0);
  await page.evaluate(() => { document.querySelector('section').lastElementChild.shadowRoot.querySelector('p').textContent = 'after'; });
  await finish(boundedRoots);
  await clean('root and discovery bounds retain fallback correctness');

  await reset('<section>' + '<div><span>before</span></div>'.repeat(3000) + '</section>');
  const concurrent = [];
  for (let index = 0; index < 12; index++) concurrent.push(await start(text('css=section > div >> nth=' + index, 'after')));
  await page.waitForTimeout(80);
  const shared = await evaluate('testConditions.inspect()');
  assert.equal(shared.discoveryPasses, 1);
  assert.ok(shared.discoveryVisits > 100 && shared.discoveryVisits < 6100);
  await page.evaluate(() => { for (const element of document.querySelectorAll('section > div')) element.textContent = 'after'; });
  for (const token of concurrent) await finish(token);
  await clean('concurrent conditions share one bounded discovery pass');

  await reset('<section>' + '<p class="item">before</p>'.repeat(4000) + '</section>');
  const fairness = await evaluate(`(async () => {
    const request = JSON.stringify({selector:'css=.item >> nth=3999',expectedText:[{string:'after',normalizeWhiteSpace:true}]});
    const units = Array.from(request, character => character.charCodeAt(0));
    const checks = Array(128).fill(0);
    for (let index = 0; index < checks.length; index++) {
      testPromises.set(String(index), testConditions.wait({token:String(index),check:() => {
        checks[index]++;
        return testLocator.assertion(units, null, 'to.have.text', false);
      }}));
    }
    await Promise.resolve();
    const initialChecks = checks.reduce((total, count) => total + count, 0);
    const startedAt = performance.now();
    const progress = await new Promise(resolve => {
      setTimeout(() => {
        resolve({elapsedMilliseconds:performance.now() - startedAt,
          checks:checks.reduce((total, count) => total + count, 0) - initialChecks});
        document.querySelector('section').lastElementChild.textContent = 'after';
      }, 0);
      document.querySelector('section').setAttribute('data-invalidate', 'true');
    });
    const results = await Promise.all(testPromises.values());
    return {progress,initialChecks,checks,statuses:results.map(result => result.status)};
  })()`);
  assert.equal(fairness.initialChecks, 128);
  assert.ok(fairness.progress.checks < 128, JSON.stringify(fairness.progress));
  assert.deepEqual(fairness.statuses, Array(128).fill('matched'));
  assert.ok(fairness.checks.every(count => count >= 2));
  await clean('128 expensive pending predicates yield to a browser timer and all complete');
  cases.at(-1).progress = fairness.progress;
  cases.at(-1).checksPerCondition = fairness.checks;

  await reset('<p>before</p>');
  const cascade = await evaluate(`(async () => {
    let checks = 0;
    const timer = new Promise(resolve => setTimeout(() => resolve(checks), 0));
    const result = await testConditions.wait({token:'microtask-cascade',check:() => {
      checks++;
      document.querySelector('p').setAttribute('data-check', String(checks));
      return {status:'observation',matches:checks === 64};
    }});
    return {result,checks,checksBeforeTimer:await timer};
  })()`);
  assert.equal(cascade.result.status, 'matched');
  assert.equal(cascade.checks, 64);
  assert.ok(cascade.checksBeforeTimer < 64, JSON.stringify(cascade));
  await clean('repeated microtask invalidations also yield to browser tasks');
  cases.at(-1).checksBeforeTimer = cascade.checksBeforeTimer;

  await reset('<p>before</p>');
  const continuousInvalidation = await evaluate(`(async () => {
    const checks = Array(128).fill(0);
    for (let index = 0; index < checks.length; index++) {
      testPromises.set(String(index), testConditions.wait({token:String(index),timeoutMilliseconds:2000,check:() => {
        checks[index]++;
        return {status:'observation',matches:index === 127 && document.querySelector('p').textContent === 'after'};
      }}));
    }
    await Promise.resolve();
    let mutations = 0;
    const interval = setInterval(() => { document.querySelector('p').setAttribute('data-change', String(++mutations)); }, 0);
    document.querySelector('p').textContent = 'after';
    const result = await testPromises.get('127');
    clearInterval(interval);
    testConditions.dispose();
    await Promise.all(testPromises.values());
    return {result,checks,mutations};
  })()`);
  assert.equal(continuousInvalidation.result.status, 'matched');
  assert.ok(continuousInvalidation.mutations > 0);
  assert.ok(continuousInvalidation.checks.every(count => count >= 2 && count <= 3), JSON.stringify(continuousInvalidation));
  await clean('continuous invalidation preserves the last condition place in the queue');
  cases.at(-1).checksPerCondition = continuousInvalidation.checks;
  cases.at(-1).mutationTasks = continuousInvalidation.mutations;

  await reset('<p>before</p>');
  const retiredQueue = await evaluate(`(async () => {
    let checks = 0;
    for (let index = 0; index < 128; index++) {
      testPromises.set(String(index), testConditions.wait({token:String(index),check:() => {
        checks++; return {status:'observation',matches:false};
      }}));
    }
    await Promise.resolve();
    document.querySelector('p').textContent = 'changed';
    for (let index = 0; index < 4; index++) await Promise.resolve();
    const pending = testConditions.inspect();
    testConditions.dispose();
    const checksAtDisposal = checks;
    const successor = await testConditions.wait({token:'successor',check:() => ({status:'observation',matches:true})});
    const results = await Promise.all(testPromises.values());
    await new Promise(resolve => setTimeout(resolve, 20));
    return {pending,checksAtDisposal,checksAfterRestart:checks,successor,statuses:results.map(result => result.status)};
  })()`);
  assert.ok(retiredQueue.pending.queuedConditions > 0);
  assert.equal(retiredQueue.pending.flushTaskScheduled, true);
  assert.deepEqual(retiredQueue.statuses, Array(128).fill('cancelled'));
  assert.equal(retiredQueue.successor.status, 'matched');
  assert.equal(retiredQueue.checksAfterRestart, retiredQueue.checksAtDisposal);
  await clean('cancellation closes a queued flush before a new condition group starts');

  await reset('<div id="host"></div><p>before</p>');
  await page.evaluate(() => { document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<i>shadow</i>'; });
  const pruning = await start(text('css=p', 'after'));
  await page.waitForTimeout(30);
  assert.equal((await evaluate('testConditions.inspect()')).observedRoots, 2);
  await page.evaluate(() => { document.querySelector('#host').remove(); });
  await page.waitForTimeout(20);
  assert.equal((await evaluate('testConditions.inspect()')).observedRoots, 1);
  await page.evaluate(() => { document.querySelector('p').textContent = 'after'; });
  await finish(pruning);
  await clean('detached shadow roots release observer references');

  await reset('<p>before</p>');
  const expires = await start(text('css=p', 'never', { timeoutMilliseconds: 35 }));
  const expired = await finish(expires, 'expired');
  assert.equal(expired.observation.matches, false);
  await clean('deadline keeps the last full observation');

  await reset('<p>before</p>');
  const cancelled = await start(text('css=p', 'never'));
  assert.equal((await evaluate(`testConditions.cancel(${JSON.stringify(cancelled)})`)).status, 'cancelled');
  await finish(cancelled, 'cancelled');
  await page.evaluate(() => { document.querySelector('p').textContent = 'never'; });
  await clean('cancellation cannot turn into a later success');

  await reset('<p>before</p>');
  const noGap = await evaluate(`(async () => {
    let checks = 0;
    const result = await testConditions.wait({token:'check-subscribe-gap',timeoutMilliseconds:500,check:async () => {
      checks++; const matches = document.querySelector('p').textContent === 'after';
      if (checks === 1) document.querySelector('p').textContent = 'after';
      return {status:'observation',matches};
    }}); return {result,checks};
  })()`);
  assert.equal(noGap.result.status, 'matched');
  assert.ok(noGap.checks >= 2);
  await clean('change during an asynchronous check is not lost');

  await reset('<p>before</p>');
  await evaluate(`(() => {
    testPromises.set('late-check', testConditions.wait({token:'late-check',timeoutMilliseconds:2000,
      check:() => new Promise(resolve => { globalThis.releaseTestCheck = resolve; })})); return true;
  })()`);
  await evaluate('testConditions.cancel("late-check")');
  await finish('late-check', 'cancelled');
  await evaluate('releaseTestCheck({status:"observation",matches:true})');
  await clean('late asynchronous predicate cannot resurrect cancelled work');

  await reset('<p>one</p><p>two</p>');
  await finish(await start(text('css=p', 'one')), 'error');
  await clean('strictness failure is terminal and releases subscriptions');

  await reset('<p>before</p>');
  const expiredCheck = await evaluate(`(async () => {
    return await testConditions.wait({token:'late-success',timeoutMilliseconds:10,check:() => {
      const until=performance.now()+30; while(performance.now()<until) {}
      return {status:'observation',matches:true};
    }});
  })()`);
  assert.equal(expiredCheck.status, 'expired');
  assert.equal(expiredCheck.observation.matches, true);
  await clean('a predicate finishing after its budget cannot report success');

  await reset('<p>before</p>', false);
  const fallback = await start(text('css=p', 'after'));
  await page.evaluate(() => { document.querySelector('p').textContent = 'after'; });
  await finish(fallback);
  const fallbackState = await clean('observer-off path preserves full predicate behavior');
  assert.equal(fallbackState.discoveryVisits, 0);
  assert.ok(fallbackState.fallbackChecks > 0);

  await reset('<input value="before">', false, true);
  const hiddenFrame = await start({ selector: 'css=input', expression: 'to.have.value', request: { expectedText: [{ string: 'after' }] } });
  await page.frame('hidden').evaluate(() => { document.querySelector('input').value = 'after'; });
  await finish(hiddenFrame);
  await clean('property fallback works in a real hidden child frame');

  // Suppress only this isolated registry's frame callbacks; the real DOM, app realm
  // and browser timers remain unchanged. A hidden frame alone does not stop RAFs.
  await reset('<input value="before">', false, false, true);
  const withheldFrames = await start({ selector: 'css=input', expression: 'to.have.value', request: { expectedText: [{ string: 'after' }] } });
  await page.waitForTimeout(130);
  const beforeTimerChange = await evaluate('testConditions.inspect()');
  await page.evaluate(() => { document.querySelector('input').value = 'after'; });
  await finish(withheldFrames);
  const afterTimerChange = await clean('timer fallback works when registry frame callbacks are withheld');
  assert.equal(afterTimerChange.animationFrameChecks, 0);
  assert.ok(afterTimerChange.timerFallbackChecks > beforeTimerChange.timerFallbackChecks);

  for (const mode of ['unbounded', 'deadline', 'cancelled']) {
    const originalSession = session;
    const originalExecutionContextId = executionContextId;
    const target = await createLifecycleTarget(browser);
    session = target;
    executionContextId = undefined;
    async function application(expression) {
      const result = await target.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    try {
      await application(`document.body.innerHTML='<input value="before">';
        globalThis.lifecycleState={freezeCount:0,resumeCount:0,timerCallbacks:0,frameCallbacks:0};
        document.addEventListener('freeze',()=>lifecycleState.freezeCount++);
        document.addEventListener('resume',()=>{lifecycleState.resumeCount++;document.querySelector('input').value='after';});
        setInterval(()=>lifecycleState.timerCallbacks++,10);
        requestAnimationFrame(function frame(){lifecycleState.frameCallbacks++;requestAnimationFrame(frame);}); true`);
      const { frameTree } = await target.send('Page.getFrameTree');
      await installRegistry(frameTree.frame.id, false);
      await target.send('Page.setWebLifecycleState', { state: 'frozen' });
      let lifecycle;
      for (let attempt = 0; attempt < 100; attempt++) {
        lifecycle = await application('({...lifecycleState,visibility:document.visibilityState})');
        if (lifecycle.freezeCount === 1) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(lifecycle.freezeCount, 1, 'CDP acknowledgement alone does not prove a page froze');
      assert.equal(lifecycle.visibility, 'hidden');
      const token = await start({ selector: 'css=input', expression: 'to.have.value', request: { expectedText: [{ string: 'after' }] }, timeoutMilliseconds: mode === 'deadline' ? 750 : null });
      const before = await evaluate('testConditions.inspect()');
      assert.equal(before.activeConditions, 1);
      await new Promise(resolve => setTimeout(resolve, mode === 'deadline' ? 900 : 150));
      const suspended = await evaluate('testConditions.inspect()');
      assert.deepEqual(suspended, before, 'registry callbacks ran while the target was frozen');
      assert.deepEqual(await application('({...lifecycleState,visibility:document.visibilityState})'), lifecycle, 'application callbacks ran while the target was frozen');
      if (mode === 'cancelled') {
        assert.equal((await evaluate(`testConditions.cancel(${JSON.stringify(token)})`)).status, 'cancelled');
      }
      await target.send('Page.setWebLifecycleState', { state: 'active' });
      const result = await finish(token, mode === 'deadline' ? 'expired' : mode === 'cancelled' ? 'cancelled' : 'matched');
      const recovered = await application('({...lifecycleState,visibility:document.visibilityState,value:document.querySelector("input").value})');
      assert.equal(recovered.resumeCount, 1);
      assert.equal(recovered.value, 'after');
      if (mode !== 'unbounded') assert.equal(result.observation.matches, false);
      const label = mode === 'unbounded' ? 'a truly frozen page resumes property detection through the timer fallback'
        : mode === 'deadline' ? 'a deadline passed during real suspension cannot become a late success'
        : 'cancellation during real suspension cannot resurrect on resume';
      const recoveredState = await clean(label);
      if (mode === 'unbounded') {
        assert.equal(recoveredState.animationFrameChecks, 0);
        assert.ok(recoveredState.timerFallbackChecks > 0);
      }
      cases.at(-1).lifecycle = { mode, suspended: lifecycle, recovered, frozenRegistry: suspended,
        scope: 'Separate CDP target without the reference driver focus/visibility emulation; real lifecycle suspension, not a default-launch or performance claim.' };
    } finally {
      try { await target.close(); }
      finally { session = originalSession; executionContextId = originalExecutionContextId; }
    }
  }

  await reset('<p>before</p><section></section>');
  const mutationStorm = await start(text('css=p', 'after'));
  await page.evaluate(() => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 2000; index++) fragment.append(document.createElement('div'));
    document.querySelector('section').append(fragment);
    const paragraph = document.querySelector('p');
    for (let index = 0; index < 2000; index++) paragraph.dataset.sequence = String(index);
    paragraph.textContent = 'after';
  });
  await finish(mutationStorm);
  const stormState = await clean('mutation storms cap discovery admission and still check the final predicate');
  assert.ok(stormState.discoveryOverflows > 0);
  assert.ok(stormState.mutationRecordsVisited <= stormState.mutationBatches * 512);
  assert.ok(stormState.addedNodesVisited <= stormState.mutationBatches * 512);

  await reset('<p>before</p>');
  const limit = await evaluate(`(async () => {
    for (let index=0; index<128; index++) testPromises.set(String(index),testConditions.wait({token:String(index),check:() => ({status:'observation',matches:false})}));
    const overflow = await testConditions.wait({token:'overflow',check:() => ({status:'observation',matches:true})});
    let duplicateRejected = false;
    try { testConditions.wait({token:'0',check:() => ({status:'observation',matches:true})}); } catch { duplicateRejected=true; }
    testConditions.dispose(); const results=await Promise.all(testPromises.values());
    return {overflow,duplicateRejected,statuses:results.map(result=>result.status)};
  })()`);
  assert.equal(limit.overflow.status, 'limit');
  assert.equal(limit.duplicateRejected, true);
  assert.deepEqual(limit.statuses, Array(128).fill('cancelled'));
  await clean('registration bound and bulk disposal release all work');

  await reset('<p>before</p>');
  await page.evaluate(() => { globalThis.testConditions = { wait: () => ({status:'matched'}) }; });
  await finish(await start(text('css=p', 'never', { timeoutMilliseconds: 30 })), 'expired');
  await clean('application realm cannot forge an isolated condition outcome');

  await reset('<p>before</p>');
  const navigation = await start(text('css=p', 'never'));
  const oldResult = evaluate(`testPromises.get(${JSON.stringify(navigation)})`).then(result => result.status, error => error.message);
  await page.goto('data:text/html,<p>successor</p>');
  const oldOutcome = await oldResult;
  assert.ok(oldOutcome === 'cancelled' || /context|navigat|collected/i.test(oldOutcome), oldOutcome);
  executionContextId = undefined;
  await reset('<p>successor</p>');
  await finish(await start(text('css=p', 'successor')));
  await clean('document transition retires the old registry');

  const finalSources = await sourceManifest();
  assert.deepEqual(finalSources, sources, 'sources changed during the registry experiment');
  const destinationDirectory = process.env.FLASHWRIGHT_CONDITION_EVIDENCE_DIRECTORY ?? 'compatibility/evidence';
  await mkdir(destinationDirectory, { recursive: true });
  const destination = join(destinationDirectory, `resident-registry-${process.platform}-${process.arch}-${process.versions.node}-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(destination, JSON.stringify({ status:'passed',node:process.version,platform:process.platform,architecture:process.arch,browserVersion:browser.version(),browserPath,
    browserSha256:createHash('sha256').update(await readFile(browserPath)).digest('hex'),
    environmentClass:process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'local-development-host',containerImage:process.env.FLASHWRIGHT_CONTAINER_IMAGE ?? null,sources,cases,
    sourceHashes:Object.fromEntries(sourceNames.map((name,index)=>[name,createHash('sha256').update([injectedSource,codecSource,locatorSource,registrySource][index]).digest('hex')])),
    fontFixture:fontMetadata,
    scope:'Isolated registry correctness using the complete assertion predicate, including explicit fallback withholding and separate real lifecycle targets without focus emulation. Host deadlines, production ownership and performance require their separate integration evidence.' }, null, 2)+'\n');
  console.log(`Resident registry evidence: ${destination}`);
} finally {
  await browser.close();
  fontServer.closeAllConnections();
  await new Promise(resolve => fontServer.close(resolve));
}
