import { createServer } from 'node:http';
import { once } from 'node:events';
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
  for (const name of ['activeConditions', 'observedRoots', 'queuedDiscovery', 'queuedConditions']) assert.equal(state[name], 0, `${label}: ${name}`);
  for (const name of ['animationFrameScheduled', 'fallbackTimerScheduled', 'deadlineTimerScheduled', 'discoveryTimerScheduled', 'flushMicrotaskScheduled', 'flushTaskScheduled', 'flushChannelOpen']) assert.equal(state[name], false, `${label}: ${name}`);
  assert.ok(state.maximumChecksBeforeYield <= 8, `${label}: unbounded predicate batch`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await evaluate('testConditions.inspect()'), state, `${label}: work continued after the last condition`);
  cases.push({ name: label, counters: state });
  console.log(`Resident registry: ${label}`);
  return state;
}

const text = (selector, value, extra = {}) => ({ selector, expression: 'to.have.text', request: { expectedText: [{ string: value, normalizeWhiteSpace: true }] }, ...extra });
const state = (selector, expression, extra = {}) => ({ selector, expression, ...extra });


let responseToRelease;
const requested = new Promise(resolve => {
  globalThis.fontRequestArrived = resolve;
});
const font = await readFile('compatibility/m2/fixtures/zero-advance.ttf');
const server = createServer((request,response) => { responseToRelease=response; fontRequestArrived(); });
server.listen(0,'127.0.0.1');await once(server,'listening');
try {
 await reset('<style>span { display:inline-block;font:20px "ConditionFont",monospace }</style><span>A</span>');
 console.log('before',await page.locator('span').boundingBox());
 await page.evaluate(url => {
   globalThis.fixtureFont = new FontFace('ConditionFont', 'url('+url+')', {display:'swap'});
   document.fonts.add(fixtureFont);
   globalThis.fontDone = fixtureFont.load().then(()=>document.fonts.ready);
 },'http://127.0.0.1:'+server.address().port+'/font.ttf');
 await requested;
 const token = await start(state('css=span','to.be.hidden'));
 responseToRelease.writeHead(200,{'content-type':'font/ttf','access-control-allow-origin':'*'});responseToRelease.end(font);
 await page.evaluate(()=>fontDone.then(()=>true));
 console.log('after',await page.locator('span').boundingBox());
 console.log('fontresult',await finish(token));await clean('fontload');
 await reset('<style>@keyframes hide { to { transform:scale(0); } } p { animation:hide .1s linear forwards paused }</style><p>target</p>');
 const animation=await start(state('css=p','to.be.hidden'));
 await page.evaluate(()=>document.querySelector('p').getAnimations()[0].play());
 console.log('animation',await finish(animation));await clean('animation');
 await reset('<input value="before">', false);
 const frozen=await start({selector:'css=input',expression:'to.have.value',request:{expectedText:[{string:'after'}]},timeoutMilliseconds:100});
 await page.evaluate(()=>{ globalThis.freezeCount=0;globalThis.resumeCount=0;document.addEventListener('freeze',()=>freezeCount++);document.addEventListener('resume',()=>resumeCount++); });
 await session.send('Page.setWebLifecycleState',{state:'frozen'});
 const initial=await evaluate('testConditions.inspect()');
 await new Promise(resolve=>setTimeout(resolve,250));
 const still=await evaluate('testConditions.inspect()');
 console.log('suspended',initial,still,await page.evaluate(()=>({freezeCount,resumeCount})));
 await session.send('Page.setWebLifecycleState',{state:'active'});
 console.log('expired',await finish(frozen,'expired'));await clean('frozen');
} finally { await session.send('Page.setWebLifecycleState',{state:'active'}).catch(()=>{});await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
