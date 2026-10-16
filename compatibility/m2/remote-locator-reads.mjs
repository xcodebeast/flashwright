import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium as reference } from 'playwright';
// Use the owned byte-identical pinned matcher copy, as in the assertion differential.
import { expect as referenceExpect } from '../../packages/flashwright-runner/dist/upstream/test.mjs';
import { chromium as candidate } from 'flashwright';
import { expect as candidateExpect } from '@flashwright/test';
import { identifyBrowser } from '../../tools/browser-identity.mjs';
import { sourceManifest } from '../../tools/source-manifest.mjs';
import { inspectRemoteAriaTarget } from '../../tools/public-aria-remote-target.mjs';

// The metadata relay preserves protocol bytes. These runs establish functionality,
// actual remote placement and original-session cleanup, never production timing.
const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, status: 'running', platform: process.platform, architecture: process.arch,
  runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version,
  sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), outcomes: {}, placement: {},
  scope: 'Shared remote locator reads, waits and assertions, strictness, nested frames, renderer replacement and original pending-assertion retirement. Public ARIA snapshots remain unsupported; native input has a separate conformance fixture. No performance claim.' };
assert.equal(report.browser.distribution, 'full-chromium', 'This fixture requires actual cross-process frames in full Chromium');
let port;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/root') {
    response.end(`<h1>Parent</h1><iframe id="child" name="child" src="http://localhost:${port}/child"></iframe>`);
  } else if (url.pathname === '/child') {
    response.end(`<h2 id="heading" class="label primary" data-label="value" aria-describedby="description">Remote <b>content</b></h2>
      <span id="description">Description</span><span id="error">Invalid value</span><div id="empty"></div>
      <ul><li>Alpha</li><li>Beta</li></ul><input id="input" value="initial"><input id="checked" type="checkbox" checked>
      <input id="readonly" readonly><button id="disabled" disabled>Disabled</button><div id="hidden" hidden>Hidden</div>
      <input id="invalid" aria-invalid="true" aria-errormessage="error"><select id="selection" multiple><option value="red" selected>Red</option><option value="blue" selected>Blue</option></select>
      <button id="button" aria-label="Publish">Action</button><div id="changing">before</div>
      <iframe id="local" src="/nested"></iframe><iframe id="remote" src="http://127.0.0.1:${port}/nested"></iframe>`);
  } else if (url.pathname === '/nested') {
    response.end('<p>Nested</p>');
  } else {
    response.end(`<p id="successor">${url.pathname.slice(1)}</p>`);
  }
});
server.listen(0); await once(server, 'listening'); port = server.address().port;
const root = `http://127.0.0.1:${port}/root`, child = `http://localhost:${port}/child`;
const environmentNames = ['FLASHWRIGHT_PROFILE_BROWSER_PATH', 'FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY', 'FLASHWRIGHT_PROFILE_CLOCK_PORT'];
const previous = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));

async function run(name, chromium, expect) {
  const wire = join(destination, name); await mkdir(wire);
  process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH = report.browser.executablePath;
  process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY = wire;
  process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT = '0';
  const browser = await chromium.launch({ executablePath: resolve('tools/frame-placement-proxy.py') });
  const outcomes = report.outcomes[name] = [];
  try {
    const context = await browser.newContext(); context.setDefaultTimeout(2500);
    const page = await context.newPage(); await page.goto(root);
    const files = (await readdir(wire)).filter(name => name.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const records = async () => (await readFile(join(wire, files[0]), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    report.placement[name] = inspectRemoteAriaTarget(await records(), root, child);
    assert.equal(report.placement[name].placement, 'out-of-process');
    const frame = page.frame('child'); assert.ok(frame);
    const nested = page.frameLocator('#child');
    const heading = nested.locator('#heading');
    assert.deepEqual(await Promise.all([heading.textContent(), heading.getAttribute('id'), frame.locator('li').count(),
      page.locator('h1').textContent()]), ['Remote content', 'heading', 2, 'Parent']);
    assert.equal(await heading.textContent(), 'Remote content');
    assert.equal(await heading.innerText(), 'Remote content');
    assert.equal(await heading.innerHTML(), 'Remote <b>content</b>');
    assert.equal(await heading.getAttribute('data-label'), 'value');
    assert.equal(await heading.getAttribute('absent'), null);
    assert.equal(await nested.locator('li').count(), 2);
    assert.deepEqual(await nested.locator('li').allTextContents(), ['Alpha', 'Beta']);
    assert.deepEqual(await nested.locator('li').allInnerTexts(), ['Alpha', 'Beta']);
    assert.equal(await nested.locator('#input').inputValue(), 'initial');
    assert.equal(await heading.isVisible(), true);
    assert.equal(await nested.locator('#hidden').isHidden(), true);
    assert.equal(await nested.locator('#absent').isVisible(), false);
    assert.equal(await nested.locator('#absent').isHidden(), true);
    assert.equal(await nested.locator('#input').isEnabled(), true);
    assert.equal(await nested.locator('#disabled').isDisabled(), true);
    assert.equal(await nested.locator('#input').isEditable(), true);
    assert.equal(await nested.locator('#readonly').isEditable(), false);
    assert.equal(await nested.locator('#checked').isChecked(), true);
    await assert.rejects(nested.locator('li').textContent(), /strict mode violation/);
    await assert.rejects(nested.locator('#input').isChecked(), /checkbox|radio/i);
    await assert.rejects(nested.locator('#absent').textContent({ timeout: 80 }), error => error.name === 'TimeoutError');
    outcomes.push('remote reads, booleans, strictness and missing-element deadline');
    assert.equal(await nested.frameLocator('#local').locator('p').textContent(), 'Nested');
    assert.equal(await nested.frameLocator('#remote').locator('p').textContent(), 'Nested');
    outcomes.push('nested local and remote frame paths');

    await expect(heading).toHaveText('Remote content');
    await expect(nested.locator('li')).toHaveText(['Alpha', 'Beta']);
    await expect(nested.locator('li')).toHaveCount(2);
    await expect(heading).toHaveAttribute('data-label', 'value');
    await expect(heading).toHaveCSS('display', 'block');
    await expect(nested.locator('#input')).toHaveValue('initial');
    await expect(nested.locator('#checked')).toBeChecked();
    await expect(nested.locator('#disabled')).toBeDisabled();
    await expect(nested.locator('#hidden')).toBeHidden();
    await expect(nested.getByRole('button', { name: 'Publish' })).toHaveAccessibleName('Publish');
    await expect(heading).toHaveAccessibleDescription('Description');
    await expect(nested.locator('#invalid')).toHaveAccessibleErrorMessage('Invalid value');
    await expect(heading).toHaveClass('label primary');
    await expect(heading).toContainClass('primary');
    await expect(heading).toHaveId('heading');
    await expect(heading).toHaveRole('heading');
    await expect(heading).toBeAttached();
    await expect(nested.locator('#absent')).not.toBeAttached();
    await expect(nested.locator('#input')).toBeEditable();
    await expect(nested.locator('#readonly')).toBeEditable({ editable: false });
    await expect(nested.locator('#empty')).toBeEmpty();
    await expect(nested.locator('#selection')).toHaveValues(['red', 'blue']);
    await frame.evaluate(() => document.querySelector('#input').focus());
    await expect(nested.locator('#input')).toBeFocused();
    await expect(heading).not.toHaveText('different');
    outcomes.push('shared remote assertion predicates and negation');

    await frame.evaluate(() => setTimeout(() => {
      document.querySelector('#changing').textContent = 'after';
      document.querySelector('#hidden').hidden = false;
    }, 40));
    await Promise.all([expect(frame.locator('#changing')).toHaveText('after'), nested.locator('#hidden').waitFor()]);
    await frame.evaluate(() => document.querySelector('#hidden').remove());
    await nested.locator('#hidden').waitFor({ state: 'detached' });
    await nested.locator('#absent').waitFor({ state: 'hidden' });
    let mismatch;
    try { await expect(frame.locator('#changing')).toHaveText('never', { timeout: 100 }); }
    catch (error) { mismatch = error; }
    assert.ok(mismatch); assert.match(mismatch.message, /never/); assert.match(mismatch.message, /after/);
    assert.equal(await heading.textContent(), 'Remote content');
    outcomes.push('delayed resident assertion, selector waits and original timeout observation');

    const replacement = expect(nested.locator('#successor')).toHaveText('replacement', { timeout: 2500 });
    await page.evaluate(url => {
      const previous = document.querySelector('#child');
      const next = document.createElement('iframe'); next.id = previous.id; next.name = 'replacement'; next.src = url;
      previous.replaceWith(next);
    }, `http://localhost:${port}/replacement`);
    await replacement;
    assert.equal(frame.isDetached(), true);
    const replacementFrame = page.frame('replacement'); assert.ok(replacementFrame);
    outcomes.push('lazy path resolves a replacement iframe without reusing the detached Frame');

    const remoteSnapshotError = error => error.name === 'UnsupportedFeatureError' && /out-of-process/i.test(error.message);
    if (name === 'flashwright') {
      await assert.rejects(nested.locator('#successor').ariaSnapshot(), remoteSnapshotError);
      assert.equal(await nested.locator('#successor').textContent(), 'replacement');
    }

    const changing = expect(replacementFrame.locator('#successor')).toHaveText('returned', { timeout: 2500 });
    await page.evaluate(url => { document.querySelector('#child').src = url; }, `http://127.0.0.1:${port}/returned`);
    await changing;
    assert.equal(await nested.locator('#successor').textContent(), 'returned');
    await page.evaluate(url => { document.querySelector('#child').src = url; }, `http://localhost:${port}/remote-again`);
    await expect(nested.locator('#successor')).toHaveText('remote-again');
    assert.equal(await replacementFrame.locator('#successor').textContent(), 'remote-again');
    outcomes.push('pending direct-frame assertion follows renderer return; lazy path follows remote successor');

    // For the candidate, wait for its original resident call to enter the wire
    // before removing the frame, so teardown cannot pass by pre-dispatch failure.
    const offset = (await records()).length;
    const pending = expect(replacementFrame.locator('#absent')).toHaveText('unreachable', { timeout: 10000 }).then(
      () => ({ passed: true }), error => ({ error }));
    if (name === 'flashwright') {
      const source = 'function(request, deadline, expression, isNot, token) { return globalThis.__flashwrightLocatorRuntime.waitForAssertion(request, deadline, expression, isNot, token); }';
      const digest = hash(Buffer.from(source, 'utf16le'));
      const deadline = Date.now() + 2500;
      while (!(await records()).slice(offset).some(record => record.kind === 'send' && record.scriptSha256 === digest)) {
        assert.ok(Date.now() < deadline, 'resident assertion must dispatch before removal');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } else await new Promise(resolve => setTimeout(resolve, 50));
    const removedAt = Date.now();
    await page.evaluate(() => document.querySelector('#child').remove());
    const settled = await pending;
    assert.ok(settled.error);
    // The pinned reference formats this early detachment as an unmatched
    // assertion ("element(s) not found"), rather than exposing a detach message.
    assert.equal(replacementFrame.isDetached(), true);
    assert.ok(Date.now() - removedAt < 2500, 'detachment must end the original assertion before its long timeout');
    assert.equal(await page.locator('h1').textContent(), 'Parent');
    outcomes.push('original pending remote assertion retires on detachment while parent remains usable');
    await context.close();
    if (name === 'flashwright') {
      const blockedContext = await browser.newContext();
      let blockedRead;
      try {
        const parent = await blockedContext.newPage();
        const blockedRoot = root + '?case=blocked';
        await parent.goto(blockedRoot);
        const placement = inspectRemoteAriaTarget(await records(), blockedRoot, child);
        const blocked = parent.frame('child');
        await blocked.evaluate(() => { setTimeout(() => { while (true) {} }, 20); });
        await new Promise(resolve => setTimeout(resolve, 60));
        const start = (await records()).length;
        blockedRead = blocked.locator('h2').textContent({ timeout: 0 }).then(
          value => ({ value }), error => ({ error }));
        let creation;
        const deadline = Date.now() + 2500;
        while (!creation) {
          creation = (await records()).slice(start).find(record => record.kind === 'send' &&
            record.method === 'Page.createIsolatedWorld' && record.sessionId === placement.childSessionId);
          assert.ok(Date.now() < deadline, 'blocked child initialization must reach its original renderer');
          if (!creation) await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(await parent.locator('h1').textContent({ timeout: 500 }), 'Parent');
        const afterParentRead = await records();
        assert.equal(afterParentRead.some(record => record.kind === 'receive' && record.id === creation.id &&
          record.sessionId === creation.sessionId), false, 'child setup must remain pending during successful parent read');
        report.candidateLifecycle = { blockedSetup: creation, placement,
          parentReadSucceededWhileChildPending: true };
      } finally {
        await blockedContext.close();
        if (blockedRead) {
          const result = await blockedRead;
          assert.ok(result.error, 'context closure must end the unbounded original read');
          if (report.candidateLifecycle) report.candidateLifecycle.originalReadClosed = true;
        }
      }
    }
  } finally { await browser.close(); }
}

async function runAriaRunner(engine) {
  const directory = join(destination, `${engine}-aria-runner`); await mkdir(directory);
  const testSource = `import assert from 'node:assert/strict';
import {test,expect} from ${JSON.stringify(import.meta.resolve(engine === 'playwright' ? '@playwright/test' : '@flashwright/test'))};
test('remote ARIA predicates preserve retry and original mismatch', async ({page,context}) => {
  await page.goto(${JSON.stringify(root)});
  const child = page.frameLocator('#child');
  ${engine === 'playwright' ? `const session = await context.newCDPSession(page);
  try { const {targetInfos} = await session.send('Target.getTargets'); assert(targetInfos.some(target => target.type === 'iframe' && target.url === ${JSON.stringify(child)})); }
  finally { await session.detach(); }` : `await assert.rejects(child.locator('#input').ariaSnapshot(), error => error.name === 'UnsupportedFeatureError' && /out-of-process/.test(error.message));
  assert.equal(await child.locator('#input').inputValue(), 'initial');`}
  const heading = child.locator('#heading');
  await expect(heading).toMatchAriaSnapshot('- heading "Remote content" [level=2]');
  await expect(heading).not.toMatchAriaSnapshot('- heading "Different" [level=2]');
  await page.frame('child').evaluate(() => { setTimeout(() => { document.querySelector('#heading').textContent = 'Next'; }, 40); });
  await expect(heading).toMatchAriaSnapshot('- heading "Next" [level=2]');
  await assert.rejects(expect(heading).toMatchAriaSnapshot('- heading "Wrong" [level=2]', {timeout:100}), error => /Wrong/.test(error.message) && /Next/.test(error.message));
});\n`;
  const configuration = { testDir: directory, testMatch: '*.spec.mjs', workers: 1, retries: 0,
    outputDir: join(directory, 'artifacts'), reporter: [['json', { outputFile: join(directory, 'runner.json') }]],
    use: { headless: true, launchOptions: { executablePath: report.browser.executablePath }, trace: 'off', video: 'off', screenshot: 'off' } };
  const configSource = `export default ${JSON.stringify(configuration)};\n`;
  const specPath = join(directory, 'remote.spec.mjs'), configPath = join(directory, 'config.mjs');
  await writeFile(specPath, testSource, { flag: 'wx' }); await writeFile(configPath, configSource, { flag: 'wx' });
  const cli = engine === 'flashwright' ? resolve('packages/flashwright-test/cli.cjs')
    : join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  const childProcess = spawn(process.execPath, [cli, 'test', '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  childProcess.stdout.on('data', chunk => stdout.push(chunk)); childProcess.stderr.on('data', chunk => stderr.push(chunk));
  const [code, signal] = await once(childProcess, 'close');
  await writeFile(join(directory, 'stdout.txt'), Buffer.concat(stdout)); await writeFile(join(directory, 'stderr.txt'), Buffer.concat(stderr));
  const runner = JSON.parse(await readFile(join(directory, 'runner.json'), 'utf8'));
  (report.runnerCases ??= []).push({ engine, code, signal, stats: runner.stats, specSha256: hash(testSource), configSha256: hash(configSource) });
  assert.equal(code, 0, `${engine} remote ARIA runner failed`); assert.equal(signal, null);
  assert.deepEqual(runner.errors, []); assert.equal(runner.stats.expected, 1);
  assert.equal(runner.stats.unexpected, 0); assert.equal(runner.stats.skipped, 0); assert.equal(runner.stats.flaky, 0);
  const specs = suites => suites.flatMap(suite => [...suite.specs, ...specs(suite.suites ?? [])]);
  const tests = specs(runner.suites); assert.equal(tests.length, 1);
  assert.deepEqual(tests[0].tests[0].results.map(result => [result.status, result.retry]), [['passed', 0]]);
  assert.equal(await readFile(specPath, 'utf8'), testSource); assert.equal(await readFile(configPath, 'utf8'), configSource);
}

try {
  await run('playwright', reference, referenceExpect);
  await run('flashwright', candidate, candidateExpect);
  assert.deepEqual(report.outcomes.flashwright, report.outcomes.playwright);
  await runAriaRunner('playwright');
  await runAriaRunner('flashwright');
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  for (const name of environmentNames) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, outcomes: report.outcomes, error: report.error }));
