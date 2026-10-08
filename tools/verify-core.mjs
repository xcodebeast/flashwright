import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { readEngineConfiguration } from './engine-configuration.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const started = new Date().toISOString();
const destination = `compatibility/evidence/core-${process.platform}-${process.arch}-${process.versions.node}-${started.replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const sources = await sourceManifest();
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
process.env.FLASHWRIGHT_BROWSER_PATH = browser.executablePath;
const report = {
  schemaVersion: 2, started, browser, node: process.version, platform: process.platform, architecture: process.arch,
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'local-development-host',
  containerImage: process.env.FLASHWRIGHT_CONTAINER_IMAGE ?? null,
  sources, checks: [], status: 'running',
  engineConfiguration: readEngineConfiguration(),
  scope: 'M1/M2 development core, navigation, locator/input, assertion and runner slice plus the three preserved TodoMVC migration tests against the public demo; npm consumers use an explicit driver path. No release or performance claim.',
};
const commands = [
  ['cargo', 'fmt', '--all', '--check'],
  ['cargo', 'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings'],
  ['python3', 'tools/watchdog.py', '--timeout', '120', '--report-directory', 'compatibility/evidence/resources', '--', 'cargo', 'test', '--workspace', '--locked'],
  ['cargo', 'build', '--workspace', '--locked'],
  [process.execPath, 'tools/build-packages.mjs'],
  [process.execPath, 'tools/extract-selector-runtime.mjs', '--check'],
  [process.execPath, 'tools/extract-keyboard-layout.mjs', '--check'],
  [process.execPath, 'tools/extract-chromium-launch-policy.mjs', '--check'],
  ['npm', 'run', 'inventory:check'],
  ['npm', 'run', 'typecheck'],
  ['npm', 'run', 'test:harness'],
  ['python3', '-m', 'unittest', 'discover', '-s', 'tools', '-p', 'test_*.py', '-v'],
  ['npm', 'run', 'test:library'],
  ['npm', 'run', 'test:lifecycle'],
  ['npm', 'run', 'test:navigation'],
  ['npm', 'run', 'test:locators'],
  ['npm', 'run', 'test:pointer'],
  ['npm', 'run', 'test:keyboard'],
  ['npm', 'run', 'test:assertions'],
  ['npm', 'run', 'test:conditions'],
  ['npm', 'run', 'test:native-runner'],
  ['npm', 'run', 'test:packed'],
  ['npm', 'run', 'test:packed-runner'],
  ['npm', 'run', 'test:migration'],
  ['npm', 'run', 'test:benchmark-contract'],
  ['npm', 'run', 'test:resident-load'],
];
for (const [index, command] of commands.entries()) {
  const started = performance.now();
  const log = `${index + 1}-${command[0] === process.execPath ? 'node' : command[0]}.txt`;
  const output = createWriteStream(join(destination, log));
  console.log(`Verifying: ${command.join(' ')}`);
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); output.write(chunk); });
  const result = await new Promise(resolve => {
    child.on('error', error => resolve({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise(resolve => output.end(resolve));
  report.checks.push({ command, ...result, elapsedMilliseconds: performance.now() - started, log, logSha256: hash(await readFile(join(destination, log))) });
  if (result.code !== 0) break;
}
report.sourceChangedDuringVerification = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
report.browserChangedDuringVerification = hash(await readFile(browser.executablePath)) !== browser.sha256;
report.driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver';
report.driverSha256 = await readFile(report.driverPath).then(hash, () => null);
report.status = report.checks.length === commands.length && report.checks.every(check => check.code === 0) && !report.sourceChangedDuringVerification && !report.browserChangedDuringVerification ? 'passed' : 'failed';
report.finished = new Date().toISOString();
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Core verification ${report.status}: ${destination}/report.json`);
process.exitCode = report.status === 'passed' ? 0 : 1;
