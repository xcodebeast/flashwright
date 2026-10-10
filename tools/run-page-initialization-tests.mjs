import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';

const directory = resolve(process.argv[2] ?? `compatibility/evidence/page-initialization-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH;
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH;
assert(browserPath && driverPath, 'Explicit browser and driver paths are required');
await mkdir(directory);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  status: 'running', ...runtimeMetadata, checks: [],
  scope: 'Unbounded native page creation after actual original root detachment with its setup reply withheld. No performance measurement.',
  browser: await identifyBrowser(browserPath), driverSha256: digest(await readFile(driverPath)), sources: await sourceManifest(),
};
const methods = [
  'Page.enable', 'Page.setLifecycleEventsEnabled', 'Network.enable', 'Runtime.enable', 'Log.enable',
  'Emulation.setEmulatedMedia', 'Emulation.setFocusEmulationEnabled', 'Browser.getWindowForTarget',
  'Browser.setWindowBounds', 'Emulation.setDeviceMetricsOverride', 'Target.setAutoAttach', 'Page.getFrameTree',
  'Security.setIgnoreCertificateErrors', 'Emulation.setScriptExecutionDisabled',
  'Emulation.setTouchEmulationEnabled', 'Emulation.setUserAgentOverride',
];
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');

try {
  await save();
  for (const method of methods) {
    const output = join(directory, method);
    await mkdir(output);
    const resourcesPath = join(output, 'resources.json');
    const check = { method, status: 'running' };
    report.checks.push(check);
    await save();
    const child = spawn('python3', ['tools/watchdog.py', '--timeout', '45', '--report', resourcesPath, '--', 'python3', 'compatibility/m1/page_initialization_driver.py'], {
      env: {
        ...process.env,
        FLASHWRIGHT_BROWSER_PATH: resolve('tools/page-initialization-detach-proxy.py'),
        FLASHWRIGHT_PROFILE_BROWSER_PATH: browserPath,
        FLASHWRIGHT_PROFILE_PROTOCOL_DIRECTORY: join(output, 'protocol'),
        FLASHWRIGHT_PROFILE_CLOCK_PORT: '0',
        FLASHWRIGHT_INITIALIZATION_METHOD: method,
        FLASHWRIGHT_PREPARED_CONTEXTS: '0', FLASHWRIGHT_AUTOMATIC_PREPARATION: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await writeFile(join(output, 'test.txt'), Buffer.concat(chunks));
    const resources = JSON.parse(await readFile(resourcesPath, 'utf8'));
    check.exitCode = code;
    check.clean = resources.cleanupSignals.length === 0 && resources.remainingObservedProcesses.length === 0;
    check.status = code === 0 && check.clean ? 'passed' : 'failed';
    await save();
    assert.equal(check.status, 'passed', `${method}: see ${output}`);
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(digest(await readFile(driverPath)), report.driverSha256);
  assert.deepEqual(await identifyBrowser(browserPath), report.browser);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  await save();
  console.log(`Page initialization evidence: ${join(directory, 'report.json')}`);
}
