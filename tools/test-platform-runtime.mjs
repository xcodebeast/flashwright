import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const destination = resolve(`compatibility/evidence/platform-runtime-${process.platform}-${process.arch}-${process.versions.node}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const working = await mkdtemp(resolve('.cache/platform-runtime-consumer-'));
const driver = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver');
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
const sources = await sourceManifest();
const report = { status: 'running', node: process.version, platform: process.platform, architecture: process.arch,
  sources, driverSha256: hash(await readFile(driver)), browser, checks: [],
  scope: 'Private platform tarball and clean offline npm ESM/CommonJS consumers with scripts disabled, no driver override and no Cargo in consumer PATH. No publication, other package manager or performance claim.',
};
function run(label, command, environment, cwd = process.cwd()) {
  const wrapped = ['tools/watchdog.py', '--timeout', '120', '--report-directory', join(destination, 'resources'), '--', ...command];
  const started = performance.now();
  try {
    const output = execFileSync('python3', [resolve(wrapped[0]), ...wrapped.slice(1)], { cwd, env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    report.checks.push({ label, command, code: 0, elapsedMilliseconds: performance.now() - started });
    return output;
  } catch (error) {
    report.checks.push({ label, command, code: error.status ?? null, elapsedMilliseconds: performance.now() - started, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') });
    throw error;
  }
}
try {
  const packageDirectory = join(working, 'runtime');
  const output = run('pack checked runtime and notices', [process.execPath, 'tools/pack-driver-runtime.mjs', '--driver', driver, '--destination', packageDirectory], process.env);
  await writeFile(join(destination, 'pack-output.txt'), output);
  const runtime = JSON.parse(await readFile(join(packageDirectory, 'report.json'), 'utf8'));
  await copyFile(runtime.archive, join(destination, 'driver-runtime.tgz'));
  await copyFile(join(packageDirectory, 'package/runtime.json'), join(destination, 'runtime.json'));
  await copyFile(join(packageDirectory, 'package/provenance.json'), join(destination, 'runtime-provenance.json'));
  report.runtimeArchiveSha256 = hash(await readFile(join(destination, 'driver-runtime.tgz')));
  report.runtimeManifest = runtime.manifest;
  const packedEnvironment = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1', FLASHWRIGHT_BROWSER_PATH: browser.executablePath,
    FLASHWRIGHT_PACKAGED_RUNTIME_ARCHIVE: runtime.archive, FLASHWRIGHT_PACKED_REPORT_DIRECTORY: destination };
  await writeFile(join(destination, 'consumer-output.txt'), run('offline packed ESM/CommonJS consumers without Cargo or driver override', [process.execPath, 'tools/test-packed-package.mjs'], packedEnvironment));
  const consumer = JSON.parse(await readFile(join(destination, `packed-library-${process.platform}-${process.arch}-${process.versions.node}.json`), 'utf8'));
  assert.equal(consumer.runtimeOverride, null);
  assert.equal(consumer.driverSha256, report.driverSha256);
  assert.equal(consumer.packagedRuntime.archiveSha256, report.runtimeArchiveSha256);
  await copyFile(join(consumer.consumerDirectory, consumer.package), join(destination, 'library.tgz'));
  await copyFile('compatibility/m1/runtime-package.mjs', join(consumer.consumerDirectory, 'runtime-package.mjs'));
  const environment = { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PLAYWRIGHT_SKIP_BROWSER_GC: '1', FLASHWRIGHT_BROWSER_PATH: browser.executablePath };
  delete environment.FLASHWRIGHT_DRIVER_PATH;
  await writeFile(join(destination, 'ownership-integrity-output.txt'), run('package ownership, corrupted artifacts and deadlines', [process.execPath, 'runtime-package.mjs'], environment, consumer.consumerDirectory));
  await copyFile(join(consumer.consumerDirectory, 'runtime-package-checks.json'), join(destination, 'runtime-package-checks.json'));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; }
report.sourceChangedDuringVerification = JSON.stringify(sources) !== JSON.stringify(await sourceManifest());
report.driverChangedDuringVerification = report.driverSha256 !== hash(await readFile(driver));
report.browserChangedDuringVerification = browser.sha256 !== hash(await readFile(browser.executablePath));
if (report.sourceChangedDuringVerification || report.driverChangedDuringVerification || report.browserChangedDuringVerification) report.status = 'failed';
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Platform runtime verification ${report.status}: ${destination}/report.json`);
if (report.error) console.error(report.error);
process.exitCode = report.status === 'passed' ? 0 : 1;
