import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { sourceManifest } from '../tools/source-manifest.mjs';
import { identifyBrowser } from '../tools/browser-identity.mjs';

const destination = process.argv[2];
await mkdir(destination);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = await sourceManifest();
const driverSha256 = digest(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
const report = {
  schemaVersion: 1, started: new Date().toISOString(), node: process.version,
  platform: process.platform, architecture: process.arch,
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH),
  driverPath: process.env.FLASHWRIGHT_DRIVER_PATH, driverSha256, sources,
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'local-development-host',
  containerImage: process.env.FLASHWRIGHT_CONTAINER_IMAGE ?? null,
  residentAssertions: process.env.FLASHWRIGHT_RESIDENT_ASSERTIONS === '1', conditionInstrumentation: false,
  scope: 'Focused console, handle and pageerror differentials, value/library, package/type, transport, caller deadlines, native console, handle, guardian and watchdog lifecycle and negotiated-output-limit conformance. Linux also runs Rust checks. No full Linux core, performance or release claim.',
  checks: [], status: 'running',
};
const commands = [
  ...(process.platform === 'linux' ? [
    ['cargo', 'fmt', '--all', '--check'],
    ['cargo', 'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings'],
    ['python3', 'tools/watchdog.py', '--timeout', '120', '--report-directory', 'compatibility/evidence/resources', '--', 'cargo', 'test', '--workspace', '--locked'],
  ] : []),
  [process.execPath, 'tools/record-handle-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-console-provenance.mjs', '--check'],
  ...['typecheck', 'test:harness', 'test:library', 'test:diagnostics', 'test:handles', 'test:console', 'test:packed'].map(script => ['npm', 'run', script]),
  [process.execPath, 'compatibility/m1/client-deadline.mjs'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', 'compatibility/evidence/resources', '--', 'python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', 'output_limits.py'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', 'compatibility/evidence/resources', '--', 'python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', 'test_handles.py'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', 'compatibility/evidence/resources', '--', 'python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', 'test_console.py'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', 'compatibility/evidence/resources', '--', 'python3', '-m', 'unittest', 'tools.test_watchdog', '-v'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', 'compatibility/evidence/resources', '--', 'python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', 'test_lifecycle.py'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', 'compatibility/evidence/resources', '--', 'python3', 'tools/run-python-tests.py', '--start-directory', 'compatibility/m1', '--pattern', 'watchdog_lifecycle.py'],
];
for (const [index, command] of commands.entries()) {
  console.log(`Verifying: ${command.join(' ')}`);
  const chunks = [];
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); chunks.push(chunk); });
  const result = await new Promise(resolve => { child.on('error', error => resolve({ code: null, error: error.message })); child.on('close', (code, signal) => resolve({ code, signal })); });
  const contents = Buffer.concat(chunks); const log = `${index + 1}.log`;
  await writeFile(`${destination}/${log}`, contents);
  report.checks.push({ command, ...result, log, sha256: digest(contents) });
  if (result.code !== 0) break;
}
report.sourceChangedDuringVerification = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
report.driverChangedDuringVerification = driverSha256 !== digest(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
report.browserChangedDuringVerification = report.browser.sha256 !== digest(await readFile(report.browser.executablePath));
report.status = report.checks.length === commands.length && report.checks.every(check => check.code === 0) && !report.sourceChangedDuringVerification && !report.driverChangedDuringVerification && !report.browserChangedDuringVerification ? 'passed' : 'failed';
report.finished = new Date().toISOString();
await mkdir(`${destination}/artifacts`);
const filename = `packed-library-${process.platform}-${process.arch}-${process.versions.node}.json`;
try { await copyFile(`compatibility/evidence/${filename}`, `${destination}/artifacts/${filename}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(`${destination}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`Focused console verification ${report.status}: ${destination}/report.json`);
process.exitCode = report.status === 'passed' ? 0 : 1;
