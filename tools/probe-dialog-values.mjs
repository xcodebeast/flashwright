import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';

const implementation = process.argv.includes('--candidate') ? 'flashwright' : 'playwright';
const { chromium } = createRequire(import.meta.url)(implementation);
const output = resolve(process.argv[2]);
assert(process.env.FLASHWRIGHT_BROWSER_PATH);
await mkdir(output);
const units = text => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const report = { status: 'running', implementation, ...runtimeMetadata, observations: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let browser;
const environmentNames = ['FLASHWRIGHT_PROFILE_BROWSER_PATH', 'FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY', 'FLASHWRIGHT_PROFILE_CLOCK_PORT'];
const previousEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
async function capturedWire() {
  const files = await readdir(join(output, 'wire'));
  assert.equal(files.length, 1);
  const records = (await readFile(join(output, 'wire', files[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { files, records };
}
try {
  report.sourceHashes = await sourceManifest();
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  process.env.FLASHWRIGHT_PROFILE_BROWSER_PATH = process.env.FLASHWRIGHT_BROWSER_PATH;
  process.env.FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY = join(output, 'wire');
  process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT = '0';
  browser = await chromium.launch({ executablePath: resolve('tools/dialog-protocol-proxy.py') });
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const text = '\u0000 high:\ud800 low:\udfff pair:\ud83d\ude80 quote:" slash:\\ newline:\n';
  report.inputUnits = units(text);
  for (const type of ['alert', 'confirm', 'prompt']) {
    for (const replacement of [undefined, text]) {
      const opened = page.waitForEvent('dialog');
      const evaluated = page.evaluate(({ type, text }) => {
        if (type === 'alert') return alert(text);
        if (type === 'confirm') return confirm(text);
        return prompt(text, text);
      }, { type, text }).then(value => ({ value }), error => ({ error: error.message }));
      const dialog = await opened;
      const observation = { type, replacement: replacement === undefined ? 'omitted' : 'mixed UTF-16', messageUnits: units(dialog.message()), defaultUnits: units(dialog.defaultValue()) };
      await dialog.accept(replacement);
      const outcome = await evaluated;
      if (outcome.error) throw new Error(outcome.error);
      observation.result = typeof outcome.value === 'string' ? { units: units(outcome.value) } : { type: typeof outcome.value, value: outcome.value };
      report.observations.push(observation);
      await save();
    }
  }
  const captured = await capturedWire();
  report.wireFiles = captured.files;
  report.dialogWire = captured.records.filter(record => record.kind === 'dialogWire');
  assert.equal(report.dialogWire.filter(record => record.direction === 'send').length, 6);
  assert.equal(report.dialogWire.filter(record => record.direction === 'receive').length, 12);
  report.captureCompleted = 'All original dialog frames captured after the six page-observed results and before browser.close.';
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  try { await browser?.close(); } catch (error) { report.status = 'failed'; report.cleanupError = error.stack; process.exitCode = 1; }
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  try {
    const { records } = await capturedWire();
    const terminal = records.filter(record => record.kind === 'exit');
    if (terminal.length) {
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].exitCode, 0);
      assert.deepEqual(terminal[0].failures, []);
      report.proxyTerminal = terminal[0];
    } else {
      assert.equal(implementation, 'flashwright');
      report.proxyTerminal = 'Native browser closure returned after guardian cleanup; wrapper exit record absent. External watchdog must verify no surviving owned processes.';
    }
  } catch (error) { report.status = 'failed'; report.wireError = error.stack; process.exitCode = 1; }
  try { if (report.sourceHashes) assert.deepEqual(await sourceManifest(), report.sourceHashes); } catch (error) { report.status = 'failed'; report.identityError = error.stack; process.exitCode = 1; }
  await save();
  console.log(JSON.stringify({ status: report.status, implementation, observations: report.observations, error: report.error }));
}
