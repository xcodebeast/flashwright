import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { identifyBrowser } from '../tools/browser-identity.mjs';

const destination = '.cache/attachments-node22';
await mkdir(destination);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = await sourceManifest();
const driverSha256 = digest(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
const report = {
  schemaVersion: 1, started: new Date().toISOString(), node: process.version,
  platform: process.platform, architecture: process.arch,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH),
  driverPath: process.env.FLASHWRIGHT_DRIVER_PATH, driverSha256, sources,
  residentAssertions: process.env.FLASHWRIGHT_RESIDENT_ASSERTIONS === '1',
  conditionInstrumentation: false,
  scope: 'Focused Node 22 attachment framing, library, navigation and packed-consumer conformance on Chromium headless shell with residency disabled; no performance or release claim.',
  checks: [], status: 'running',
};
for (const script of ['test:harness', 'test:library', 'test:navigation', 'test:packed']) {
  const command = ['npm', 'run', script];
  console.log(`Verifying: ${command.join(' ')}`);
  const chunks = [];
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); chunks.push(chunk); });
  const result = await new Promise(resolve => {
    child.on('error', error => resolve({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const contents = Buffer.concat(chunks);
  const log = script.replace(':', '-') + '.log';
  await writeFile(`${destination}/${log}`, contents);
  report.checks.push({ command, ...result, log, sha256: digest(contents) });
  if (result.code !== 0) break;
}
report.sourceChangedDuringVerification = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
report.driverChangedDuringVerification = driverSha256 !== digest(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
report.browserChangedDuringVerification = report.browser.sha256 !== digest(await readFile(report.browser.executablePath));
report.status = report.checks.length === 4 && report.checks.every(check => check.code === 0) && !report.sourceChangedDuringVerification && !report.driverChangedDuringVerification && !report.browserChangedDuringVerification ? 'passed' : 'failed';
report.finished = new Date().toISOString();
await mkdir(`${destination}/artifacts`);
for (const name of ['navigation', 'packed-library']) {
  const filename = `${name}-${process.platform}-${process.arch}-${process.versions.node}.json`;
  try { await copyFile(`compatibility/evidence/${filename}`, `${destination}/artifacts/${filename}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile(`${destination}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`Node 22 verification ${report.status}: ${destination}/report.json`);
process.exitCode = report.status === 'passed' ? 0 : 1;
