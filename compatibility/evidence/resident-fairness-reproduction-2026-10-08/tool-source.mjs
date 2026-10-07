import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { sourceManifest } from '../tools/source-manifest.mjs';

const sources = await sourceManifest();
const sourceNames = ['playwright-injected.js', 'serialization.cjs', 'locator-runtime.js', 'condition-registry.js'];
const [injectedSource, codecSource, locatorSource, registrySource] = await Promise.all(sourceNames.map(name => readFile(`packages/resident-runtime/${name}`, 'utf8')));
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const browser = await chromium.launch({ executablePath: browserPath });
const page = await browser.newPage();
const session = await page.context().newCDPSession(page);
const cases = [];
let executionContextId;

async function evaluate(expression) {
  const result = await session.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function reset(html, observeMutations = true, hiddenChildFrame = false, withholdRegistryFrames = false) {
  if (executionContextId) await evaluate('globalThis.testConditions?.dispose()');
  if (hiddenChildFrame) {
    await page.setContent('<iframe name="hidden" style="display:none"></iframe>');
    await page.frame('hidden').setContent(html);
  } else await page.setContent(html);
  const { frameTree } = await session.send('Page.getFrameTree');
  const frameId = hiddenChildFrame ? frameTree.childFrames[0].frame.id : frameTree.frame.id;
  ({ executionContextId } = await session.send('Page.createIsolatedWorld', { frameId, worldName: '__flashwright_condition_test__' }));
  await evaluate(`(() => {
    const requestAnimationFrame = ${withholdRegistryFrames ? '() => 1' : 'globalThis.requestAnimationFrame.bind(globalThis)'};
    const cancelAnimationFrame = ${withholdRegistryFrames ? '() => {}' : 'globalThis.cancelAnimationFrame.bind(globalThis)'};
    const module = {}; ${injectedSource}; const exports = {}; ${codecSource}; ${locatorSource}; ${registrySource};
    const injected = new (module.exports.InjectedScript())(globalThis, {isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:1,browserName:'chromium',shouldPrependErrorPrefix:false,isUtilityWorld:true,customEngines:[]});
    globalThis.testLocator = createLocatorRuntime(injected, exports.createValueCodec());
    globalThis.testConditions = createConditionRegistry({instrumentation:true,observeMutations:${observeMutations}});
    globalThis.testPromises = new Map();
    globalThis.startCondition = (token, options) => {
      const request = JSON.stringify({selector:options.selector, ...options.request});
      const units = Array.from({length:request.length}, (_, index) => request.charCodeAt(index));
      const promise = testConditions.wait({token,timeoutMilliseconds:options.timeoutMilliseconds ?? 2000,isNot:options.isNot ?? false,
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
  for (const name of ['activeConditions', 'observedRoots', 'queuedDiscovery']) assert.equal(state[name], 0, `${label}: ${name}`);
  for (const name of ['animationFrameScheduled', 'fallbackTimerScheduled', 'deadlineTimerScheduled', 'discoveryTimerScheduled']) assert.equal(state[name], false, `${label}: ${name}`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await evaluate('testConditions.inspect()'), state, `${label}: work continued after the last condition`);
  cases.push({ name: label, counters: state });
  console.log(`Resident registry: ${label}`);
  return state;
}

const text = (selector, value, extra = {}) => ({ selector, expression: 'to.have.text', request: { expectedText: [{ string: value, normalizeWhiteSpace: true }] }, ...extra });
const state = (selector, expression, extra = {}) => ({ selector, expression, ...extra });

try {
  await reset('<section>' + '<p class="item">before</p>'.repeat(4000) + '</section>');
  const result = await evaluate(`(async () => {
    const request=JSON.stringify({selector:'css=.item >> nth=3999',expectedText:[{string:'after',normalizeWhiteSpace:true}]});
    const units=Array.from(request, character=>character.charCodeAt(0));
    let checks=0;
    for(let index=0;index<128;index++) testPromises.set(String(index),testConditions.wait({token:String(index),check:()=> {
      checks++; return testLocator.assertion(units,null,'to.have.text',false);
    }}));
    await Promise.resolve();
    const initialChecks=checks;
    const start=performance.now();
    const timer=new Promise(resolve=>setTimeout(()=>resolve({elapsedMilliseconds:performance.now()-start,checks:checks-initialChecks}),0));
    document.querySelector('section').setAttribute('data-invalidate','true');
    const progress=await timer;
    testConditions.dispose();
    const results=await Promise.all(testPromises.values());
    return {progress,initialChecks,statuses:results.map(result=>result.status),counters:testConditions.inspect()};
  })()`);
  console.log(JSON.stringify(result,null,2));
} finally { await browser.close(); }
