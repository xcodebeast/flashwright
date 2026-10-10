import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium as referenceChromium } from 'playwright';
// This retained runner copy keeps the pinned expect implementation byte-identical.
import { expect as referenceExpect } from '../../packages/flashwright-runner/dist/upstream/test.mjs';
import { chromium as candidateChromium } from 'flashwright';
import { expect as candidateExpect } from '@flashwright/test';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { runtimeMetadata } from '../../tools/javascript-runtime.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';

const destination = resolve(process.argv[2] ?? '.cache/frame-locators');
await mkdir(destination, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const childMarkup = name => `<!doctype html><meta charset="utf-8">
<button id="button" data-testid="primary">${name}</button><input id="text" aria-label="Text" placeholder="Name">
<p>${name}</p><span title="Details">Information</span><img alt="Portrait">
<label for="upload">Upload</label><input id="upload" type="file" multiple>
<input id="check" type="checkbox"><select id="select"><option value="a">Alpha</option><option value="b">Beta</option></select>
<iframe id="nested" name="${name.toLowerCase()}-nested" src="/nested" style="width:350px;height:100px"></iframe>
<script>window.records=[];for(const type of ['click','keydown','input','change'])document.addEventListener(type,event=>records.push({type,target:event.target.id,trusted:event.isTrusted}));</script>`;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/first') return response.end(childMarkup('First'));
  if (request.url === '/second') return response.end(childMarkup('Second'));
  if (request.url === '/nested' || request.url === '/nested-replacement') {
    const name = request.url === '/nested' ? 'Nested' : 'Replacement';
    return response.end(`<!doctype html><button id="nested-button">${name}</button><p>${name}</p>`);
  }
  response.end('<!doctype html><div id="ordinary"></div><iframe class="child" id="first" name="first" src="/first" style="width:480px;height:400px"></iframe><iframe class="child" id="second" name="second" src="/second" style="width:480px;height:400px"></iframe>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  schemaVersion: 1, status: 'running', reference: '1.60.0', ...runtimeMetadata,
  platform: process.platform, architecture: process.arch, checks: [], outcomes: {}, failures: [], traces: {},
  scope: 'Lazy FrameLocator paths on the same pinned stock Chromium executable: characterized absence/cardinality/composition, same-process nesting, native input, uploads, main-world/captured-target ownership, retries, closure and traced forms. No out-of-process, performance, release or visual-fidelity claim.',
};
const fulfilled = (name, operation, value = null) => ({ name, operation, expected: { status: 'fulfilled', value } });
const rejected = (name, operation, category, validateError) => ({ name, operation, expected: { status: 'rejected', category }, validateError });

/** Compare meaningful rejection categories while retaining each original error unmodified. */
function errorCategory(error) {
  const description = `${error.name}: ${error.message}`;
  if (error.name === 'AssertionError') return 'assertion';
  if (/strict mode violation/i.test(description)) return 'strictness';
  if (/toHaveCount|expect\(.*\).*failed/i.test(description)) return 'assertion';
  if (/frame locators are not allowed inside composite locators/i.test(description)) return 'composite-frame';
  if (/frame.*detach|detach.*frame/i.test(description)) return 'frame-detached';
  if (/target.*closed|page.*closed|browser.*closed/i.test(description)) return 'target-closed';
  if (error.name === 'TimeoutError') return 'timeout';
  if (/failed to find frame for selector/i.test(description)) return 'missing-frame';
  if (/<iframe> was expected|expected.*iframe|not.*iframe/i.test(description)) return 'non-frame';
  if (/context.*destroy|context.*closed|context.*not found|stale.*handle/i.test(description)) return 'context-lost';
  if (/parsing.*selector|unexpected token|invalid.*selector/i.test(description)) return 'invalid-selector';
  return 'unclassified';
}
function originalError(error) { return { name: error.name, message: error.message, stack: error.stack ?? null }; }
async function expectRejection(task, category, diagnostics) {
  let rejection;
  try { await task(); }
  catch (error) { rejection = error; diagnostics.push(originalError(error)); }
  assert.ok(rejection, `Expected ${category} rejection`);
  assert.equal(errorCategory(rejection), category, rejection.message);
}

const characterizedCases = [
  rejected('duplicate-frame/click', page => page.frameLocator('.child').locator('button').click(), 'strictness'),
  fulfilled('duplicate-frame/count', page => page.frameLocator('.child').locator('button').count(), 1),
  fulfilled('duplicate-frame/allTextContents', page => page.frameLocator('.child').locator('p').allTextContents(), ['First']),
  rejected('duplicate-frame/isVisible', page => page.frameLocator('.child').locator('button').isVisible(), 'strictness'),
  rejected('duplicate-frame/textContent', page => page.frameLocator('.child').locator('p').textContent(), 'strictness'),
  rejected('duplicate-frame/assert-count', (page, expect) => expect(page.frameLocator('.child').locator('button')).toHaveCount(1, { timeout: 300 }), 'strictness'),
  fulfilled('duplicate-target/count', page => page.frameLocator('#first').locator('button, p').count(), 2),
  fulfilled('missing-frame/count', page => page.frameLocator('#missing').locator('button').count(), 0),
  rejected('missing-frame/allTextContents', page => page.frameLocator('#missing').locator('p').allTextContents(), 'missing-frame'),
  fulfilled('missing-frame/isVisible', page => page.frameLocator('#missing').locator('button').isVisible(), false),
  fulfilled('missing-frame/isHidden', page => page.frameLocator('#missing').locator('button').isHidden(), true),
  fulfilled('missing-frame/wait-hidden', page => page.frameLocator('#missing').locator('button').waitFor({ state: 'hidden' })),
  fulfilled('missing-frame/wait-detached', page => page.frameLocator('#missing').locator('button').waitFor({ state: 'detached' })),
  rejected('missing-frame/wait-visible', page => page.frameLocator('#missing').locator('button').waitFor({ state: 'visible' }), 'timeout'),
  fulfilled('missing-frame/assert-count-zero', (page, expect) => expect(page.frameLocator('#missing').locator('button')).toHaveCount(0, { timeout: 300 })),
  fulfilled('missing-frame/assert-hidden', (page, expect) => expect(page.frameLocator('#missing').locator('button')).toBeHidden({ timeout: 300 })),
  fulfilled('missing-frame/assert-not-visible', (page, expect) => expect(page.frameLocator('#missing').locator('button')).not.toBeVisible({ timeout: 300 })),
  rejected('non-frame/count', page => page.frameLocator('#ordinary').locator('button').count(), 'non-frame'),
  rejected('non-frame/isVisible', page => page.frameLocator('#ordinary').locator('button').isVisible(), 'non-frame'),
  fulfilled('frame-first', page => page.frameLocator('.child').first().locator('p').textContent(), 'First'),
  fulfilled('frame-last', page => page.frameLocator('.child').last().locator('p').textContent(), 'Second'),
  fulfilled('frame-nth', page => page.frameLocator('.child').nth(1).locator('p').textContent(), 'Second'),
  fulfilled('owner', page => page.frameLocator('#second').owner().getAttribute('id'), 'second'),
  fulfilled('contentFrame', page => page.locator('#first').contentFrame().locator('p').textContent(), 'First'),
  fulfilled('scope-locator', page => page.frameLocator('#first').locator(page.locator('p')).textContent(), 'First'),
  fulfilled('same-frame-has', page => page.frameLocator('#first').locator('body', { has: page.frameLocator('#first').locator('p') }).count(), 1),
  rejected('other-frame-has', page => page.frameLocator('#first').locator('body', { has: page.frameLocator('#second').locator('p') }).count(), 'composite-frame'),
  rejected('nested-frame-has', page => page.locator('body', { has: page.frameLocator('#first').locator('p') }).count(), 'composite-frame'),
  fulfilled('frame-appears', async page => {
    await page.evaluate(() => setTimeout(() => { const frame = document.createElement('iframe'); frame.id = 'late'; frame.src = '/second'; document.body.append(frame); }, 50));
    return page.frameLocator('#late').locator('p').textContent();
  }, 'Second'),
  fulfilled('frame-replaced-during-action', async page => {
    await page.frameLocator('#first').locator('button').evaluate(element => { element.style.display = 'none'; });
    await page.evaluate(() => setTimeout(() => { const frame = document.createElement('iframe'); frame.id = 'first'; frame.src = '/second'; document.querySelector('#first').replaceWith(frame); }, 50));
    await page.frameLocator('#first').locator('button').click();
    return page.frameLocator('#first').locator('p').textContent();
  }, 'Second'),
  fulfilled('frame-selector-changed-during-assertion', async (page, expect) => {
    await page.evaluate(() => setTimeout(() => { document.querySelector('#first').id = 'old'; document.querySelector('#second').id = 'first'; }, 50));
    await expect(page.frameLocator('#first').locator('p')).toHaveText('Second', { timeout: 1000 });
    return 'matched-new-frame';
  }, 'matched-new-frame'),
];
assert.equal(characterizedCases.length, 31);

const additionalCases = [
  fulfilled('nested-frame-path', page => page.frameLocator('#first').frameLocator('#nested').locator('p').textContent(), 'Nested'),
  fulfilled('locator-scoped-frame-path', page => page.locator('body').frameLocator('#second').getByRole('button', { name: 'Second' }).textContent(), 'Second'),
  fulfilled('frame-rooted-path', page => {
    const frame = page.frame({ name: 'first' });
    assert.ok(frame);
    return frame.frameLocator('#nested').locator('p').textContent();
  }, 'Nested'),
  fulfilled('owner-contentFrame-roundtrip', page => page.frameLocator('#first').owner().contentFrame().locator('p').textContent(), 'First'),
  fulfilled('getBy-helpers', async page => {
    const frame = page.frameLocator('#first');
    return {
      text: await frame.getByText('First', { exact: true }).count(),
      label: await frame.getByLabel('Text', { exact: true }).getAttribute('id'),
      testId: await frame.getByTestId('primary').getAttribute('id'),
      role: await frame.getByRole('button', { name: 'First', exact: true }).getAttribute('id'),
      placeholder: await frame.getByPlaceholder('Name', { exact: true }).getAttribute('id'),
      alt: await frame.getByAltText('Portrait', { exact: true }).getAttribute('alt'),
      title: await frame.getByTitle('Details', { exact: true }).textContent(),
    };
  }, { text: 2, label: 'text', testId: 'button', role: 'button', placeholder: 'text', alt: 'Portrait', title: 'Information' }),
  fulfilled('same-frame-composite-relative-has', page => page.frameLocator('#first').locator('body', {
    has: page.frameLocator('#first').locator('p').filter({ hasText: 'First' }),
    hasNot: page.locator('#missing'),
  }).count(), 1),
  fulfilled('same-frame-composite-relative-hasNot', page => page.frameLocator('#first').locator('body').filter({
    hasNot: page.frameLocator('#first').locator('p').filter({ hasText: 'Second' }),
  }).count(), 1),
  fulfilled('nested-chain-and-has-normalization', async page => {
    const chained = page.frameLocator('#first').locator('body').locator(page.locator('#nested')).contentFrame();
    const nested = page.frameLocator('#first').frameLocator('#nested');
    return {
      text: await chained.locator('p').textContent(),
      has: await nested.locator('body', { has: nested.locator('p') }).count(),
      hasNot: await nested.locator('body', { hasNot: nested.locator('#missing') }).count(),
    };
  }, { text: 'Nested', has: 1, hasNot: 1 }),
  fulfilled('title-assertion-literal-control-marker', async (page, expect) => {
    await page.evaluate(() => { document.title = 'literal internal:control'; });
    await expect(page).toHaveTitle('literal internal:control');
    return page.title();
  }, 'literal internal:control'),
  fulfilled('text-and-attribute-literal-control-marker', async (page, expect) => {
    await page.frameLocator('#first').locator('p').evaluate(element => {
      element.textContent = 'literal internal:control'; element.setAttribute('data-marker', 'internal:control');
    });
    const text = page.frameLocator('#first').getByText('literal internal:control', { exact: true });
    await expect(text).toHaveText('literal internal:control');
    const attribute = page.frameLocator('#first').locator('[data-marker="internal:control"]');
    await expect(attribute).toHaveText('literal internal:control');
    return { text: await text.textContent(), attribute: await attribute.textContent() };
  }, { text: 'literal internal:control', attribute: 'literal internal:control' }),
  fulfilled('raw-enter-frame-action-strictness', async (page, expect, diagnostics) => {
    const frame = page.frame({ name: 'first' });
    assert.ok(frame);
    const nested = page.frameLocator('#first').frameLocator('#nested').locator('body');
    await nested.evaluate(() => {
      const replacement = document.querySelector('button').cloneNode(true); replacement.id = 'second-button'; document.body.append(replacement);
      window.records = [];
      document.addEventListener('click', event => records.push({ type: event.type, target: event.target.id, trusted: event.isTrusted }));
    });
    const results = [];
    for (const [name, scope, selector, body, target] of [
      ['page', page, '.child >> internal:control=enter-frame >> button', page.frameLocator('#first').locator('body'), 'button'],
      ['frame', frame, '#nested >> internal:control=enter-frame >> button', nested, 'nested-button'],
    ]) {
      await body.evaluate(() => { records.length = 0; });
      await expectRejection(() => scope.click(selector, { strict: true }), 'strictness', diagnostics);
      assert.deepEqual(await body.evaluate(() => records), []);
      for (const strict of [undefined, false]) {
        await body.evaluate(() => { records.length = 0; });
        await scope.click(selector, strict === undefined ? {} : { strict });
        const events = await body.evaluate(() => records.filter(event => event.type === 'click'));
        assert.deepEqual(events, [{ type: 'click', target, trusted: true }]);
        if (name === 'page') assert.deepEqual(await page.frameLocator('#second').locator('body').evaluate(() => records), []);
        results.push({ scope: name, strict: strict ?? 'default', target });
      }
    }
    return results;
  }, [
    { scope: 'page', strict: 'default', target: 'button' }, { scope: 'page', strict: false, target: 'button' },
    { scope: 'frame', strict: 'default', target: 'nested-button' }, { scope: 'frame', strict: false, target: 'nested-button' },
  ]),
  fulfilled('native-pointer-and-keyboard', async page => {
    const frame = page.frameLocator('#first');
    await frame.getByRole('button', { name: 'First' }).click();
    const input = frame.getByLabel('Text');
    await input.fill('text');
    await input.press('End');
    await input.pressSequentially('!');
    const events = await frame.locator('body').evaluate(() => records);
    assert.ok(events.some(event => event.type === 'click' && event.target === 'button'));
    assert.ok(events.some(event => event.type === 'keydown' && event.target === 'text'));
    assert.ok(events.some(event => event.type === 'input' && event.target === 'text'));
    assert.ok(events.every(event => event.trusted));
    assert.equal(await page.frameLocator('#second').getByLabel('Text').inputValue(), '');
    return { value: await input.inputValue(), trusted: true };
  }, { value: 'text!', trusted: true }),
  fulfilled('upload-payload-and-clear', async page => {
    const frame = page.frameLocator('#first');
    const input = frame.getByLabel('Upload');
    await input.setInputFiles({ name: 'payload.txt', mimeType: 'text/plain', buffer: Buffer.from([0, 65, 255, 128]) });
    const files = await input.evaluate(async element => Promise.all([...element.files].map(async file => ({ name: file.name, type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())] }))));
    const events = await frame.locator('body').evaluate(() => records.filter(event => event.target === 'upload'));
    assert.deepEqual(events.map(event => [event.type, event.trusted]), [['input', false], ['change', false]]);
    assert.equal(await page.frameLocator('#second').getByLabel('Upload').evaluate(element => element.files.length), 0);
    await input.setInputFiles([]);
    return { files, cleared: await input.evaluate(element => element.files.length) };
  }, { files: [{ name: 'payload.txt', type: 'text/plain', bytes: [0, 65, 255, 128] }], cleared: 0 }),
  fulfilled('evaluate-child-main-world-once', async page => {
    const result = await page.frameLocator('#first').locator('p').evaluate(element => {
      window.frameMarker = 'child-main';
      window.evaluations = (window.evaluations ?? 0) + 1;
      return { text: element.textContent, marker: window.frameMarker, calls: window.evaluations, main: window === element.ownerDocument.defaultView };
    });
    assert.equal(await page.evaluate(() => typeof window.frameMarker), 'undefined');
    assert.equal(await page.frameLocator('#first').locator('body').evaluate(() => window.frameMarker), 'child-main');
    return result;
  }, { text: 'First', marker: 'child-main', calls: 1, main: true }),
  fulfilled('captured-handle-keeps-replaced-node', async page => {
    const target = page.frameLocator('#first').locator('#button');
    const handle = await target.elementHandle();
    assert.ok(handle);
    try {
      await target.evaluate(element => { const replacement = element.cloneNode(true); replacement.textContent = 'Replacement'; element.replaceWith(replacement); });
      return { original: await handle.evaluate(element => ({ text: element.textContent, attached: element.isConnected })), replacement: await target.textContent() };
    } finally { await handle.dispose(); }
  }, { original: { text: 'First', attached: false }, replacement: 'Replacement' }),
  fulfilled('captured-handle-invalid-after-child-replacement', async (page, expect, diagnostics) => {
    const handle = await page.frameLocator('#first').locator('p').elementHandle();
    assert.ok(handle);
    try {
      await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'first'; frame.src = '/second'; document.querySelector('#first').replaceWith(frame); });
      await expect(page.frameLocator('#first').locator('p')).toHaveText('Second');
      let rejection;
      try { await handle.evaluate(element => element.textContent); }
      catch (error) { rejection = error; diagnostics.push(originalError(error)); }
      assert.ok(rejection);
      assert.match(`${rejection.name}: ${rejection.message}`, /context|detach|closed/i);
      return 'original-context-rejected';
    } finally { await handle.dispose(); }
  }, 'original-context-rejected'),
  rejected('root-frame-detachment', async page => {
    const frame = page.frame({ name: 'first' });
    assert.ok(frame);
    const pending = frame.frameLocator('#nested').locator('#missing').textContent({ timeout: 0 }).then(value => ({ value }), error => ({ error }));
    await page.locator('#first').evaluate(element => element.remove());
    const result = await pending;
    if (result.error) throw result.error;
    return result.value;
  }, 'frame-detached'),
  fulfilled('nested-child-replacement-during-action', async page => {
    const target = page.frameLocator('#first').frameLocator('#nested').locator('button');
    await target.evaluate(element => { element.hidden = true; });
    await page.frameLocator('#first').locator('body').evaluate(() => setTimeout(() => {
      const frame = document.createElement('iframe'); frame.id = 'nested'; frame.src = '/nested-replacement'; document.querySelector('#nested').replaceWith(frame);
    }, 50));
    await target.click();
    return target.textContent();
  }, 'Replacement'),
  fulfilled('timeout-prevents-late-input', async (page, expect, diagnostics) => {
    const target = page.frameLocator('#first').getByLabel('Text');
    await target.evaluate(element => { element.disabled = true; });
    await expectRejection(() => target.fill('late', { timeout: 60 }), 'timeout', diagnostics);
    await target.evaluate(element => { element.disabled = false; });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
    return { value: await target.inputValue(), inputEvents: await target.evaluate(() => records.filter(event => event.type === 'input').length) };
  }, { value: '', inputEvents: 0 }),
  rejected('page-close-cancels-frame-operation', async page => {
    const pending = page.frameLocator('#first').locator('#missing').fill('lost', { timeout: 0 }).then(value => ({ value }), error => ({ error }));
    await page.close();
    const result = await pending;
    if (result.error) throw result.error;
    return result.value;
  }, 'target-closed'),
  rejected('selector-syntax-remains-lazy', page => {
    let locator;
    assert.doesNotThrow(() => { locator = page.frameLocator('[').locator('button'); });
    return locator.count();
  }, 'invalid-selector'),
  rejected('final-selector-error-preserves-lone-surrogate', page => page.frameLocator('#first').locator('css=[data-x="\ud800"').count(), 'invalid-selector', (error, engine) => {
    assert.ok(error.message.includes('\ud800'), 'Malformed selector diagnostics must preserve the original UTF16 surrogate');
    if (engine === 'flashwright') assert.equal(error.name, 'EvaluationError');
  }),
];

async function run(engine, chromium, expect) {
  const browser = await chromium.launch({ executablePath: report.browser.executablePath });
  const outcomes = report.outcomes[engine] = [];
  try {
    for (const traced of [false, true]) {
      const context = await browser.newContext();
      context.setDefaultTimeout(2000);
      if (traced) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      try {
        for (const specification of [...characterizedCases, ...additionalCases]) {
          const page = await context.newPage();
          const outcome = { name: specification.name, traced, diagnostics: [] };
          outcomes.push(outcome);
          try {
            await page.goto(origin);
            page.setDefaultTimeout(specification.name === 'missing-frame/wait-visible' ? 300 : 2000);
            try { outcome.status = 'fulfilled'; outcome.value = await specification.operation(page, expect, outcome.diagnostics) ?? null; }
            catch (error) { outcome.status = 'rejected'; outcome.category = errorCategory(error); outcome.error = originalError(error); }
            if (outcome.status === 'rejected') specification.validateError?.(outcome.error, engine);
            const compared = outcome.status === 'fulfilled' ? { status: outcome.status, value: outcome.value } : { status: outcome.status, category: outcome.category };
            assert.deepEqual(compared, specification.expected);
            report.checks.push(`${engine}/${traced ? 'traced' : 'plain'}/${specification.name}`);
          } catch (error) {
            outcome.validationFailure = originalError(error);
            report.failures.push({ engine, traced, name: specification.name, error: originalError(error) });
          } finally { if (!page.isClosed()) await page.close(); }
        }
      } finally {
        if (traced) {
          const path = join(destination, `${engine}.zip`);
          await context.tracing.stop({ path });
          report.traces[engine] = { path, sha256: hash(await readFile(path)) };
        }
        await context.close();
      }
    }
  } finally { await browser.close(); }
}

try {
  report.fixtureSha256 = hash(await readFile(new URL(import.meta.url)));
  report.sources = await sourceManifest();
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath());
  const referenceManifest = JSON.parse(await readFile('compatibility/reference-manifest.json', 'utf8'));
  assert.equal(report.browser.version, referenceManifest.reference.chromiumVersion, 'Frame-locator conformance requires the pinned Chromium version');
  assert.ok(['full-chromium', 'chromium-headless-shell'].includes(report.browser.distribution), 'Frame-locator conformance requires a stock Chromium distribution');
  report.caseCountPerEngine = (characterizedCases.length + additionalCases.length) * 2;
  await run('reference', referenceChromium, referenceExpect);
  await run('flashwright', candidateChromium, candidateExpect);
  const semanticOutcomes = outcomes => outcomes.map(({ name, traced, status, value, category }) => ({ name, traced, status, ...(status === 'fulfilled' ? { value } : { category }) }));
  assert.deepEqual(semanticOutcomes(report.outcomes.flashwright), semanticOutcomes(report.outcomes.reference));
  assert.equal(report.failures.length, 0, 'All case results must satisfy the independently declared outcomes');
  assert.equal(report.checks.length, report.caseCountPerEngine * 2);
  report.sourceChangedDuringVerification = JSON.stringify(await sourceManifest()) !== JSON.stringify(report.sources);
  report.driverChangedDuringVerification = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)) !== report.driverSha256;
  report.browserChangedDuringVerification = hash(await readFile(report.browser.executablePath)) !== report.browser.sha256;
  assert.equal(report.sourceChangedDuringVerification, false);
  assert.equal(report.driverChangedDuringVerification, false);
  assert.equal(report.browserChangedDuringVerification, false);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = originalError(error); process.exitCode = 1; }
finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failures: report.failures.length, destination }));
}
