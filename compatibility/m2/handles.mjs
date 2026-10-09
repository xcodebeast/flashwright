import { runtimeMetadata, runtimeArtifactLabel } from '../../tools/javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
import { chromium as flashwrightChromium, JSHandle, ElementHandle } from 'flashwright';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { identifyBrowser } from '../../tools/browser-identity.mjs';

const destination = `compatibility/evidence/handles-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const report = {
  schemaVersion: 1, reference: '1.60.0', sources: await sourceManifest(),
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath()),
  driverSha256: createHash('sha256').update(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)).digest('hex'),
  ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  outcomes: {}, referenceDifferences: {}, status: 'running',
  scope: 'JSHandle lifecycle, supported value serialization, original-context evaluation and same-process frames. Element actions, cross-context element adoption and additional jsonValue classes remain unsupported. No performance claim.',
};
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');

async function run(name, chromium) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcomes = report.outcomes[name] = {};
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const sibling = await context.newPage();
    const primitives = [undefined, null, true, false, 42, -0, NaN, Infinity, -Infinity, 'é😃\ud800\udfff\0'];
    for (const value of primitives) {
      const handle = await page.evaluateHandle(value => value, value);
      assert.deepEqual(await handle.jsonValue(), value);
      assert.deepEqual(await handle.evaluate(value => value), value);
      assert.deepEqual(await sibling.evaluate(value => value, handle), value);
      assert.equal(handle.toString(), String(value));
      assert.equal(handle.asElement(), null);
      assert.equal((await handle.getProperties()).size, 0);
      if (name === 'flashwright') assert(handle instanceof JSHandle);
      await handle.dispose(); await handle.dispose();
      await assert.rejects(handle.jsonValue(), /disposed|closed/i);
      await assert.rejects(page.evaluate(value => value, handle), /disposed|closed|guid/i);
    }
    outcomes.primitiveRoundTripsAndDisposal = primitives.length;

    const graph = await page.evaluateHandle(() => {
      const shared = { value: 7 }; const result = { shared, again: shared, date: new Date('2024-01-02T03:04:05Z'), expression: /é\s/giu };
      result.self = result; return result;
    });
    const value = await graph.jsonValue();
    assert.equal(value, value.self); assert.equal(value.shared, value.again);
    assert.deepEqual(value.date, new Date('2024-01-02T03:04:05Z')); assert.deepEqual(value.expression, /é\s/giu);
    const argument = { first: graph, second: [graph] }; argument.self = argument;
    assert.deepEqual(await page.evaluate(argument => [argument.first === argument.second[0], argument === argument.self, argument.first === argument.first.self], argument), [true, true, true]);
    const returned = await graph.evaluateHandle((value, argument) => ({ value, argument }), graph);
    assert.equal(await returned.evaluate(value => value.value === value.argument), true);
    await graph.dispose();
    assert.equal(await returned.evaluate(value => value.value.shared.value), 7);
    await returned[Symbol.asyncDispose]();
    outcomes.graphIdentityAndNestedArguments = true;

    const parent = await page.evaluateHandle(() => {
      globalThis.getterCalls = 0;
      const shared = { answer: 42 };
      const result = { first: shared, second: shared, '\ud800\0é': 'unicode', get getter() { getterCalls++; return shared; } };
      Object.defineProperty(result, 'hidden', { value: 'secret' }); result.self = result; return result;
    });
    const properties = await parent.getProperties();
    assert.deepEqual([...properties.keys()], ['first', 'second', '\ud800\0é', 'self']);
    assert.equal(await page.evaluate(() => getterCalls), 0);
    assert.equal(await properties.get('\ud800\0é').jsonValue(), 'unicode');
    assert.equal(await page.evaluate(([first, second]) => first === second, [properties.get('first'), properties.get('second')]), true);
    const getter = await parent.getProperty('getter');
    assert.deepEqual(await getter.jsonValue(), { answer: 42 });
    assert.equal(await page.evaluate(() => getterCalls), 1);
    const hidden = await parent.getProperty('hidden'); assert.equal(await hidden.jsonValue(), 'secret');
    const absent = await parent.getProperty('missing'); assert.equal(await absent.jsonValue(), undefined);
    await parent.dispose(); await properties.get('first').dispose();
    assert.deepEqual(await properties.get('second').jsonValue(), { answer: 42 });
    assert.equal(await properties.get('self').evaluate(value => value.self === value), true);
    for (const handle of [...properties.values(), getter, hidden, absent]) await handle.dispose();
    outcomes.propertyIdentityUnicodeGetterAndIndependentDisposal = true;

    const node = await page.evaluateHandle(() => { const element = document.createElement('button'); element.textContent = 'original'; document.body.appendChild(element); return element; });
    assert.equal(node.asElement(), node); assert.equal(node.toString(), 'JSHandle@node');
    if (name === 'flashwright') assert(node instanceof ElementHandle);
    assert.equal(await node.jsonValue(), 'ref: <Node>');
    assert.deepEqual(await page.evaluate(element => ({ node: element, document, window }), node), { node: 'ref: <Node>', document: 'ref: <Document>', window: 'ref: <Window>' });
    await page.evaluate(() => { document.querySelector('button').remove(); const replacement = document.createElement('button'); replacement.textContent = 'replacement'; document.body.appendChild(replacement); });
    assert.deepEqual(await node.evaluate(element => [element.textContent, element.isConnected]), ['original', false]);
    const documentHandle = await page.evaluateHandle(() => document);
    assert.equal(documentHandle.asElement(), documentHandle); assert.equal(await documentHandle.jsonValue(), 'ref: <Document>');
    const windowHandle = await page.evaluateHandle(() => window);
    assert.equal(windowHandle.asElement(), null); assert.equal(await windowHandle.jsonValue(), 'ref: <Window>');
    await node.dispose(); await documentHandle.dispose(); await windowHandle.dispose();
    outcomes.elementIdentityAndReferenceSerialization = true;

    const functionHandle = await page.evaluateHandle(() => value => value + 1);
    assert.equal(await functionHandle.evaluate((operation, value) => operation(value), 41), 42);
    const symbol = await page.evaluateHandle(() => Symbol('unique'));
    assert.equal(await symbol.evaluate(value => value.description), 'unique');
    const map = await page.evaluateHandle(() => new Map([['key', { value: 42 }]]));
    assert.equal(await map.evaluate(value => value.get('key').value), 42);
    await functionHandle.dispose(); await symbol.dispose(); await map.dispose();
    outcomes.nonserializableObjectsRemainEvaluable = true;

    await assert.rejects(page.evaluateHandle(() => { throw new Error('handle failure\ud800'); }), error => error.message.includes('handle failure\ud800'));
    const rejector = await page.evaluateHandle(() => ({ get broken() { globalThis.failedGetterCalls = (globalThis.failedGetterCalls ?? 0) + 1; throw new Error('getter failure'); } }));
    await assert.rejects(rejector.getProperty('broken'), /getter failure/);
    assert.equal(await page.evaluate(() => failedGetterCalls), 1); await rejector.dispose();
    const pending = page.evaluateHandle(() => new Promise(resolve => { globalThis.completeHandle = resolve; }));
    await page.evaluate(async () => { while (!globalThis.completeHandle) await new Promise(resolve => setTimeout(resolve, 0)); completeHandle({ answer: 42 }); });
    const completed = await pending; assert.deepEqual(await completed.jsonValue(), { answer: 42 }); await completed.dispose();
    outcomes.errorsRunOnceAndEvaluationIsConcurrent = true;

    const crossPageObject = await page.evaluateHandle(() => ({ answer: 42 }));
    await assert.rejects(sibling.evaluate(value => { globalThis.foreignHandleExecuted = true; return value; }, crossPageObject), /context/i);
    assert.equal(await sibling.evaluate(() => globalThis.foreignHandleExecuted), undefined);
    await crossPageObject.dispose(); outcomes.foreignObjectRejectedBeforeExecution = true;

    await page.evaluate(() => new Promise(resolve => { const frame = document.createElement('iframe'); frame.name = 'child'; frame.onload = () => resolve(true); frame.srcdoc = '<p>child</p>'; document.body.appendChild(frame); }));
    const frame = page.frames().find(frame => frame.name() === 'child'); assert(frame);
    assert.equal(await frame.evaluate(() => document.querySelector('p').textContent), 'child');
    const frameHandle = await frame.evaluateHandle(() => ({ label: 'original child' }));
    const framePrimitive = await frame.evaluateHandle(() => 7);
    assert.equal(await frameHandle.evaluate(value => value.label), 'original child');
    assert.equal(await page.evaluate(value => value, framePrimitive), 7);
    await assert.rejects(page.evaluate(value => value, frameHandle), /context/i);
    await page.evaluate(() => document.querySelector('iframe').remove());
    await assert.rejects(frameHandle.evaluate(value => value.label), /context|detach|closed/i);
    await assert.rejects(frame.evaluate(() => 42), /context|detach|closed/i);
    assert.equal(await framePrimitive.jsonValue(), 7);
    await frameHandle.dispose(); await framePrimitive.dispose(); outcomes.sameProcessFrameOwnership = true;

    const aliveNumber = await page.evaluateHandle(() => 7);
    const aliveObject = await page.evaluateHandle(() => ({ answer: 42 }));
    await page.goto('data:text/html,<p>successor</p>');
    assert.equal(await aliveNumber.jsonValue(), 7);
    assert.equal(await sibling.evaluate(value => value, aliveNumber), 7);
    await assert.rejects(aliveNumber.evaluate(value => value), /context|destroyed/i);
    await assert.rejects(aliveObject.jsonValue(), /context|destroyed/i);
    assert.equal(await page.evaluate(() => document.querySelector('p').textContent), 'successor');
    await aliveObject.dispose(); await page.close();
    await assert.rejects(aliveNumber.jsonValue(), /closed|disposed/i);
    await assert.rejects(sibling.evaluate(value => value, aliveNumber), /closed|disposed|guid/i);
    await aliveNumber.dispose(); outcomes.navigationAndCloseOwnership = true;

    const bigint = await sibling.evaluateHandle(() => 12345678901234567890n);
    const bigintValue = await bigint.jsonValue();
    report.referenceDifferences[name] = {
      bigintPreview: bigint.toString(), bigintJsonType: typeof bigintValue, bigintJsonText: String(bigintValue),
      bigintArgument: await sibling.evaluate(value => ({ type: typeof value, text: String(value) }), bigint),
      bigintReceiver: await bigint.evaluate(value => ({ type: typeof value, text: String(value) })),
    };
    await bigint.dispose();
  } finally { await browser.close(); }
}

try {
  await run('reference', referenceChromium);
  await run('flashwright', flashwrightChromium);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.reference);
  const referenceBigint = { type: 'undefined', text: 'undefined' };
  const nativeBigint = { type: 'bigint', text: '12345678901234567890' };
  assert.deepEqual(report.referenceDifferences.reference, { bigintPreview: 'undefined', bigintJsonType: 'undefined', bigintJsonText: 'undefined', bigintArgument: referenceBigint, bigintReceiver: referenceBigint });
  assert.deepEqual(report.referenceDifferences.flashwright, { bigintPreview: nativeBigint.text, bigintJsonType: 'bigint', bigintJsonText: nativeBigint.text, bigintArgument: nativeBigint, bigintReceiver: nativeBigint });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { name: error.name, message: error.message, stack: error.stack }; throw error;
} finally {
  report.sourceChangedDuringVerification = JSON.stringify(report.sources) !== JSON.stringify(await sourceManifest());
  if (report.sourceChangedDuringVerification) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Handle differential ${report.status}: ${destination}/report.json`);
}
