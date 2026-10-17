import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium as candidate } from 'flashwright';
import { chromium as reference } from 'playwright';
import { runtimeMetadata } from './javascript-runtime.mjs';

const output = resolve(process.argv[2]);
const selected = process.argv[3] ?? 'both';
assert.ok(['both', 'candidate', 'reference'].includes(selected));
await mkdir(output, { recursive: false });
const require = createRequire(import.meta.url);
const { iso, utils } = require('playwright-core/lib/coreBundle');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
assert.ok(browserPath, 'Select the verification browser explicitly');
const report = {
  status: 'running', ...runtimeMetadata,
  scope: 'Raw keyboard snapshot phases and original input-lock timing, with pinned viewer replay. No performance claim.',
  browserSha256: hash(await readFile(browserPath)),
  driverSha256: selected === 'reference' ? null : hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)),
  sourceSha256: hash(await readFile(new URL(import.meta.url))), engines: [],
};
async function inspect(path) {
  const archive = new utils.ZipFile(path);
  try {
    const records = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
    const storage = new iso.SnapshotStorage();
    const snapshots = new Map();
    for (const { snapshot } of records.filter(record => record.type === 'frame-snapshot')) {
      assert.ok(snapshot.isMainFrame);
      assert.ok(!snapshots.has(snapshot.snapshotName), 'No duplicate snapshot phase');
      const html = storage.addFrameSnapshot('context', snapshot, []).render().html;
      snapshots.set(snapshot.snapshotName, html);
    }
    const calls = records.filter(record => record.type === 'before' && ['keyboardType', 'keyboardPress', 'keyboardInsertText', 'press'].includes(record.method));
    return { records, snapshots, calls, sha256: hash(await readFile(path)) };
  } finally { archive.close(); }
}
function checkPhases(trace, expected) {
  assert.equal(trace.calls.length, expected.length);
  return trace.calls.map((call, index) => {
    const [method, before, after] = expected[index];
    assert.equal(call.method, method);
    const input = trace.records.filter(record => record.type === 'input' && record.callId === call.callId);
    const complete = trace.records.filter(record => record.type === 'after' && record.callId === call.callId);
    assert.equal(input.length, 1, `${method} has exactly one input phase`);
    assert.equal(complete.length, 1);
    assert.ok(!complete[0].error);
    const names = [input[0].inputSnapshot, complete[0].afterSnapshot];
    if (method === 'press') {
      assert.ok(call.beforeSnapshot, 'Locator input retains its before phase');
      names.unshift(call.beforeSnapshot);
    } else assert.equal(call.beforeSnapshot, undefined, `${method} does not advertise a before snapshot`);
    const owned = [...trace.snapshots.keys()].filter(name => name.endsWith(`@${call.callId}`));
    assert.deepEqual(owned.sort(), [...names].sort(), 'Every advertised phase has exactly one actual snapshot, without surplus phases');
    for (const name of names) {
      const actual = trace.records.filter(record => record.type === 'frame-snapshot' && record.snapshot.snapshotName === name);
      assert.equal(actual.length, 1);
      assert.equal(actual[0].snapshot.callId, call.callId);
      assert.equal(actual[0].snapshot.pageId, call.pageId);
      const value = name === complete[0].afterSnapshot ? after : before;
      const state = trace.snapshots.get(name)?.match(/<p\b[^>]*\bid="state"[^>]*>([^<]*)<\/p>/i)?.[1];
      assert.equal(state, `state:${value}`, `${method} ${name} preserves DOM state ${JSON.stringify(value)}`);
    }
    return { method, before, after, phases: method === 'press' ? ['before', 'input', 'after'] : ['input', 'after'] };
  });
}
try {
  for (const [name, engine] of [['reference', reference], ['candidate', candidate]]) {
    if (selected !== 'both' && selected !== name) continue;
    const result = { name, status: 'running', checks: [] }; report.engines.push(result);
    const browser = await engine.launch({ executablePath: browserPath });
    try {
      const context = await browser.newContext(); const page = await context.newPage();
      await page.goto('data:text/html,<input id="input"><p id="state">state:</p><script>window.inputEvents=[];input.oninput=e=>{inputEvents.push({trusted:e.isTrusted,value:input.value});document.querySelector("%23state").textContent="state:"+input.value;}</script>');
      await page.locator('#input').focus();
      await context.tracing.start({ snapshots: true, screenshots: false, sources: false });
      await page.keyboard.type('ab', { delay: 25 });
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText('Ω');
      await page.keyboard.type('');
      await page.keyboard.press('Shift');
      await page.locator('#input').press('End');
      const path = join(output, `${name}-ordinary.zip`);
      await context.tracing.stop({ path });
      const trace = await inspect(path);
      result.checks.push({ name: 'ordinary, empty typing, modifier and locator phases', archiveSha256: trace.sha256,
        calls: checkPhases(trace, [['keyboardType', '', 'ab'], ['keyboardPress', 'ab', 'a'], ['keyboardInsertText', 'a', 'aΩ'], ['keyboardType', 'aΩ', 'aΩ'], ['keyboardPress', 'aΩ', 'aΩ'], ['press', 'aΩ', 'aΩ']]) });
      assert.deepEqual(await page.evaluate(() => inputEvents), [{ trusted: true, value: 'a' }, { trusted: true, value: 'ab' }, { trusted: true, value: 'a' }, { trusted: true, value: 'aΩ' }]);
      await context.tracing.start({ snapshots: false });
      await page.keyboard.type('z');
      await page.keyboard.press('Backspace');
      const disabledPath = join(output, `${name}-disabled.zip`);
      await context.tracing.stop({ path: disabledPath });
      const disabled = await inspect(disabledPath);
      assert.equal(disabled.calls.length, 2);
      assert.equal(disabled.snapshots.size, 0);
      assert.ok(disabled.records.every(record => !record.beforeSnapshot && !record.inputSnapshot && !record.afterSnapshot));
      result.checks.push({ name: 'disabled snapshots retain keyboard actions without DOM phases', archiveSha256: disabled.sha256 });
      await context.close(); result.status = 'passed';
    } finally { await browser.close(); }
  }
  assert.equal(hash(await readFile(browserPath)), report.browserSha256);
  if (report.driverSha256) assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(new URL(import.meta.url))), report.sourceSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
