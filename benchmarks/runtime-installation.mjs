import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { startFixtureServer } from './fixture-server.mjs';
import { quantile } from './statistics.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = await sourceManifest();
const browserIdentity = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
const sourceNames = ['playwright-injected.js', 'serialization.cjs', 'condition-registry.js', 'locator-runtime.js'];
const [injectedSource, codecSource, registrySource, locatorSource] = await Promise.all(sourceNames.map(name => readFile(`packages/resident-runtime/${name}`, 'utf8')));
const configuration = { independentLaunches: 4, warmupIterations: 3, measuredIterations: 12, variants: ['injected-only', 'declarations', 'combined', 'split', 'scoped', 'escaped'] };
const injectedOptions = { isUnderTest: false, sdkLanguage: 'javascript', testIdAttributeName: 'data-testid', stableRafCount: 1, browserName: 'chromium', shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: [] };
const constructInjected = `const injected = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(injectedOptions)}); globalThis.probeInjected = injected;`;
const literalLocatorSource = locatorSource.replace('\\u2026 [diagnostic truncated]', '… [diagnostic truncated]');
assert.ok(literalLocatorSource.includes('… [diagnostic truncated]'));
const declarations = `const exports = {}; ${codecSource}; ${registrySource}; ${literalLocatorSource};`;
const constructWrapper = `globalThis.probeRuntime = createLocatorRuntime(globalThis.probeInjected, exports.createValueCodec());`;
const scripts = {
  'injected-only': [`(() => { const started = performance.now(); const module = {}; ${injectedSource}; const declared = performance.now(); ${constructInjected} return { declarations: declared-started, construction: performance.now()-declared }; })()`],
  declarations: [`(() => { const started = performance.now(); const module = {}; ${injectedSource}; ${declarations}; const declared = performance.now(); ${constructInjected} return { declarations: declared-started, construction: performance.now()-declared }; })()`],
  combined: [`(() => { const started = performance.now(); const module = {}; ${injectedSource}; ${declarations}; const declared = performance.now(); ${constructInjected} const constructed = performance.now(); ${constructWrapper} return { declarations: declared-started, construction: constructed-declared, wrapper: performance.now()-constructed }; })()`],
};
scripts.escaped = [scripts.combined[0].replaceAll('…', '\\u2026')];
assert.notEqual(scripts.escaped[0], scripts.combined[0]);
assert.ok(Array.from(scripts.escaped[0]).every(character => character.charCodeAt(0) < 128));
scripts.scoped = [`(() => { const injectedMeasurements = ${scripts['injected-only'][0]}; const started = performance.now(); ${declarations}; const declared = performance.now(); ${constructWrapper} return { ...injectedMeasurements, wrapperDeclarations: declared-started, wrapper: performance.now()-declared }; })()`];
scripts.split = [scripts['injected-only'][0], `(() => { const started = performance.now(); ${declarations}; const declared = performance.now(); ${constructWrapper} return { declarations: declared-started, wrapper: performance.now()-declared }; })()`];
const destination = resolve('compatibility/evidence', `runtime-installation-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0,8)}`);
await mkdir(destination, { recursive: true });
const metadata = {
  kind: 'instrumented-runtime-component-diagnostic', schemaVersion: 2, sources, browser: browserIdentity, configuration,
  node: process.version, platform: process.platform, architecture: process.arch,
  sourceHashes: Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, hash(await readFile(`packages/resident-runtime/${name}`))]))),
  scripts: Object.fromEntries(Object.entries(scripts).map(([name, expressions]) => [name, expressions.map((expression, index) => ({ path: `script-${name}-${index}.js`, sha256: hash(expression), utf16Units: expression.length }))])),
  scope: 'Component attribution through a direct CDP session on fresh documents. Injected-only and declarations variants omit the wrapper and are not equivalent engines or proposed fast paths. Split, combined, scoped and escaped construct the full runtime. The literal control reconstructs only the diagnostic ellipsis from its production Unicode escape. Escaped uses the equivalent ASCII source, preserving the runtime value. Every sample navigates the same real HTTP fixture to a verified new loader. Timed command intervals include Playwright CDP transport; in-renderer marks exclude parsing before the first statement. No production speed claim.',
};
await writeFile(`${destination}/metadata.json`, JSON.stringify(metadata, null, 2)+'\n', { flag: 'wx' });
await writeFile(`${destination}/tool-source.mjs`, await readFile(new URL(import.meta.url)), { flag: 'wx' });
for (const [name, expressions] of Object.entries(scripts)) {
  for (const [index, expression] of expressions.entries()) await writeFile(`${destination}/script-${name}-${index}.js`, expression, { flag: 'wx' });
}
const samples = [];
const server = await startFixtureServer(20);
try {
  for (let launchIndex = 0; launchIndex < configuration.independentLaunches; launchIndex++) {
    const browser = await chromium.launch({ executablePath: browserIdentity.executablePath, headless: true });
    try {
      const page = await browser.newPage();
      const session = await page.context().newCDPSession(page);
      let previousLoader;
      for (let iteration = 0; iteration < configuration.warmupIterations + configuration.measuredIterations; iteration++) {
        const offset = (iteration + launchIndex) % configuration.variants.length;
        for (const variant of configuration.variants.slice(offset).concat(configuration.variants.slice(0,offset))) {
          await page.goto(`${server.origin}/fixture?runtime-probe=${launchIndex}-${iteration}-${variant}`);
          const { frameTree } = await session.send('Page.getFrameTree');
          assert.notEqual(frameTree.frame.loaderId, previousLoader, 'Each installation must use a fresh document');
          previousLoader = frameTree.frame.loaderId;
          const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: '__flashwright_runtime_installation_probe__' });
          const intervals = [];
          for (const expression of scripts[variant]) {
            const started = performance.now();
            const result = await session.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
            intervals.push({ milliseconds: performance.now()-started, renderer: result.result?.value });
            assert.equal(result.exceptionDetails, undefined);
          }
          const verified = await session.send('Runtime.evaluate', { expression: `probeInjected.querySelectorAll(probeInjected.parseSelector('#count'), document).length === 1 && ${['combined','split','scoped','escaped'].includes(variant) ? "typeof probeRuntime.assertion === 'function'" : 'true'}`, contextId: executionContextId, returnByValue: true });
          assert.equal(verified.result.value, true);
          let diagnostics;
          if (['combined','split','scoped','escaped'].includes(variant)) {
            const checked = await session.send('Runtime.evaluate', {
              expression: `(async () => {
                document.querySelector('#count').textContent = 'x'.repeat(5000);
                const request = JSON.stringify({selector:'#count',expectedText:[{string:'different'}]});
                const units = Array.from({length:request.length}, (_,index)=>request.charCodeAt(index));
                const observation = await probeRuntime.assertion(units, null, 'to.have.text', false);
                return {matches:observation.matches,truncated:observation.diagnosticTruncated,received:String.fromCharCode(...observation.received.units)};
              })()`, contextId: executionContextId, returnByValue: true, awaitPromise: true,
            });
            assert.equal(checked.exceptionDetails, undefined);
            assert.deepEqual(checked.result.value, { matches: false, truncated: true, received: 'x'.repeat(4096)+'… [diagnostic truncated]' });
            diagnostics = checked.result.value;
          }
          samples.push({ launchIndex, iteration, variant, loader: previousLoader, executionContextId, diagnostics, phase: iteration < configuration.warmupIterations ? 'warmup' : 'measured', intervals });
        }
      }
    } finally { await browser.close(); }
    await writeFile(`${destination}/samples.json`, JSON.stringify(samples,null,2)+'\n');
    console.log(`Retained component diagnostic launch ${launchIndex+1}/${configuration.independentLaunches}`);
  }
} finally { await server.close(); }
assert.deepEqual(await sourceManifest(), sources);
assert.equal(hash(await readFile(browserIdentity.executablePath)), browserIdentity.sha256);
const median = values => quantile(values, 0.5);
const summary = Object.fromEntries(configuration.variants.map(variant => {
  const selected = samples.filter(sample => sample.phase==='measured' && sample.variant===variant);
  const renderer = field => median(selected.map(sample => sample.intervals.reduce((total,interval)=>total+(interval.renderer[field] ?? 0),0)));
  return [variant,{ measuredSamples: selected.length, commandMedianMilliseconds: median(selected.map(sample=>sample.intervals.reduce((total,interval)=>total+interval.milliseconds,0))), renderer: { declarations: renderer('declarations'), construction: renderer('construction'), wrapperDeclarations: renderer('wrapperDeclarations'), wrapper: renderer('wrapper') } }];
}));
const retainedNames = ['metadata.json', 'samples.json', 'tool-source.mjs', ...Object.values(metadata.scripts).flat().map(script => script.path)];
const retainedFileHashes = Object.fromEntries(await Promise.all(retainedNames.map(async name => [name, hash(await readFile(`${destination}/${name}`))])));
await writeFile(`${destination}/report.json`,JSON.stringify({status:'passed',summary,retainedFileHashes},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({destination,summary},null,2));
