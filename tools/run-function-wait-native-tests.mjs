import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const destination = resolve(process.argv[2]); await mkdir(destination, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(),
  functionalBuild: { incremental: process.env.CARGO_INCREMENTAL, devDebug: process.env.CARGO_PROFILE_DEV_DEBUG, testDebug: process.env.CARGO_PROFILE_TEST_DEBUG },
  scope: 'Real native driver ownership, cancellation, blocked Chromium and application code, admission and failed publication. Controlled fault injection; compact functional build; no performance or release acceptance.' };
try {
  report.browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
  report.driverSha256 = hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
  report.command = ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', join(destination, 'resources'), '--',
    'python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', 'test_function_waits.py'];
  const output = createWriteStream(join(destination, 'native.log'));
  const child = spawn(report.command[0], report.command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => output.write(bytes));
  report.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await new Promise(resolve => output.end(resolve));
  report.logSha256 = hash(await readFile(join(destination, 'native.log')));
  assert.equal(report.exitCode, 0, (await readFile(join(destination, 'native.log'), 'utf8')).slice(-16000));
  assert.deepEqual(await sourceManifest(), report.sources);
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  assert.equal(hash(await readFile(report.browser.executablePath)), report.browser.sha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
