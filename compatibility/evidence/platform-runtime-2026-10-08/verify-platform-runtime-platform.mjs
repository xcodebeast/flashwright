import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { identifyBrowser } from '../tools/browser-identity.mjs';
import { readEngineConfiguration } from '../tools/engine-configuration.mjs';

const [destination, mode = 'default'] = process.argv.slice(2);
assert.equal(process.env.FLASHWRIGHT_RESIDENT_ASSERTIONS, mode === 'off' ? '0' : undefined);
assert.ok(mode === 'default' || mode === 'off');
await mkdir(destination);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = await sourceManifest();
const driverSha256 = digest(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
const report = {
  started: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH), driverSha256, sources,
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'shared-native-development-host',
  containerImage: process.env.FLASHWRIGHT_CONTAINER_IMAGE ?? null,
  engineConfiguration: readEngineConfiguration(), assertionSwitch: process.env.FLASHWRIGHT_RESIDENT_ASSERTIONS ?? null,
  scope: 'Focused platform runtime verification: library ownership, caller deadlines, complete lifecycle suite, packed automatic runtime resolution, artifact integrity, runner and packed runner consumers. No publication or performance claim.',
  checks: [], status: 'running',
};
const commands = [
  ...(process.platform === 'linux' ? [
    ['cargo', 'fmt', '--all', '--check'],
    ['cargo', 'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings'],
    ['python3', 'tools/watchdog.py', '--timeout', '120', '--report-directory', 'compatibility/evidence/resources', '--', 'cargo', 'test', '--workspace', '--locked'],
  ] : []),
  ...['typecheck', 'test:library', 'test:lifecycle', 'test:packed', 'test:platform-runtime', 'test:native-runner', 'test:packed-runner'].map(name => ['npm', 'run', name]),
];
for (const [index, command] of commands.entries()) {
  console.log(`Verifying: ${command.join(' ')}`);
  const chunks = [];
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: resolve('compatibility/m1') } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); chunks.push(chunk); });
  const outcome = await new Promise(resolve => {
    child.on('error', error => resolve({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const contents = Buffer.concat(chunks);
  const log = `${index + 1}.log`;
  await writeFile(`${destination}/${log}`, contents);
  report.checks.push({ command, ...outcome, log, sha256: digest(contents) });
  if (outcome.code !== 0) break;
}
report.sourceChangedDuringVerification = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
report.driverChangedDuringVerification = driverSha256 !== digest(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
report.browserChangedDuringVerification = report.browser.sha256 !== digest(await readFile(report.browser.executablePath));
report.status = report.checks.length === commands.length && report.checks.every(check => check.code === 0) && !report.sourceChangedDuringVerification && !report.driverChangedDuringVerification && !report.browserChangedDuringVerification ? 'passed' : 'failed';
report.finished = new Date().toISOString();
await mkdir(`${destination}/artifacts`);
for (const name of ['native-runner', 'packed-library', 'packed-runner']) {
  const filename = `${name}-${process.platform}-${process.arch}-${process.versions.node}.json`;
  try { await copyFile(`compatibility/evidence/${filename}`, `${destination}/artifacts/${filename}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile(`${destination}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`Platform runtime verification ${report.status}: ${destination}/report.json`);
process.exitCode = report.status === 'passed' ? 0 : 1;
