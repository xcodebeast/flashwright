import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const destination = resolve(`compatibility/evidence/platform-runtime-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const working = await mkdtemp(resolve('.cache/platform-runtime-consumer-'));
const driver = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver');
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
const sources = await sourceManifest();
const report = { status: 'running', ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  sources, driverSha256: hash(await readFile(driver)), browser, checks: [],
  scope: 'Private platform tarball and clean offline ESM/CommonJS consumers installed with Bun, with scripts disabled, no driver override and no Cargo in consumer PATH. No publication, other package manager or performance claim.',
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
  const provenance = JSON.parse(await readFile(join(destination, 'runtime-provenance.json'), 'utf8'));
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', provenance.target], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  const resolved = new Set(metadata.resolve.nodes.map(node => node.id));
  const workspaceMembers = new Set(metadata.workspace_members);
  const dependencies = metadata.packages.filter(dependency => resolved.has(dependency.id) && !workspaceMembers.has(dependency.id));
  const identity = dependency => `${dependency.name}@${dependency.version}`;
  assert.deepEqual(provenance.dependencies.map(identity).sort(), dependencies.map(identity).sort(), 'Every resolved external dependency needs packaged notices, including vendored dependencies');
  const archiveFiles = execFileSync('tar', ['-tzf', runtime.archive], { encoding: 'utf8' }).split('\n').filter(path => path && !path.endsWith('/'));
  for (const dependency of provenance.dependencies) assert.ok(archiveFiles.some(path => path.startsWith(`package/${dependency.directory}/`)), `Archive omits ${identity(dependency)} notices`);
  const checkedNoticeBytes = [];
  for (const dependency of dependencies.filter(dependency => !dependency.source)) {
    const expected = await readFile(join(dirname(dependency.manifest_path), 'LICENSE'));
    const actual = execFileSync('tar', ['-xOf', runtime.archive, `package/licenses/rust-dependencies/${dependency.name}-${dependency.version}/LICENSE`]);
    assert.deepEqual(actual, expected);
    checkedNoticeBytes.push({ dependency: identity(dependency), sha256: hash(actual) });
  }
  const supplements = JSON.parse(await readFile('compatibility/upstream/rust-license-supplements.json', 'utf8'));
  for (const supplement of supplements.dependencies.filter(supplement => dependencies.some(dependency => identity(dependency) === identity(supplement)))) {
    const name = supplement.licensePath.split('/').at(-1);
    const actual = execFileSync('tar', ['-xOf', runtime.archive, `package/licenses/rust-dependencies/${supplement.name}-${supplement.version}/${name}`]);
    assert.equal(hash(actual), supplement.licenseSha256);
    checkedNoticeBytes.push({ dependency: identity(supplement), sha256: hash(actual) });
  }
  report.dependencyNoticeAudit = { dependencies: dependencies.length, checkedNoticeBytes };
  report.runtimeArchiveSha256 = hash(await readFile(join(destination, 'driver-runtime.tgz')));
  report.runtimeManifest = runtime.manifest;
  const packedEnvironment = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1', FLASHWRIGHT_BROWSER_PATH: browser.executablePath,
    FLASHWRIGHT_PACKAGED_RUNTIME_ARCHIVE: runtime.archive, FLASHWRIGHT_PACKED_REPORT_DIRECTORY: destination };
  await writeFile(join(destination, 'consumer-output.txt'), run('offline packed ESM/CommonJS consumers without Cargo or driver override', [process.execPath, 'tools/test-packed-package.mjs'], packedEnvironment));
  const consumer = JSON.parse(await readFile(join(destination, `packed-library-${process.platform}-${process.arch}-${runtimeArtifactLabel}.json`), 'utf8'));
  assert.equal(consumer.runtimeOverride, null);
  assert.equal(consumer.driverSha256, report.driverSha256);
  assert.equal(consumer.packagedRuntime.archiveSha256, report.runtimeArchiveSha256);
  await copyFile(join(consumer.consumerDirectory, consumer.package), join(destination, 'library.tgz'));
  for (const [name, artifact] of Object.entries(consumer.implementationArchives)) await copyFile(artifact.archive, join(destination, `${name}.tgz`));
  // Only retained evidence is consumed here; the installation has finished cleanup.
  assert.equal(consumer.runtimeIntegrity?.status, 'passed');
  const integrityBytes = await readFile(join(consumer.consumerDirectory, 'runtime-package-checks.json'));
  assert.equal(hash(integrityBytes), consumer.runtimeIntegrity.reportSha256);
  report.runtimeIntegrity = consumer.runtimeIntegrity;
  await copyFile(join(consumer.consumerDirectory, 'ownership-integrity-output.txt'), join(destination, 'ownership-integrity-output.txt'));
  await copyFile(join(consumer.consumerDirectory, 'runtime-package-checks.json'), join(destination, 'runtime-package-checks.json'));
  const cleanupBytes = await readFile(join(consumer.consumerDirectory, 'cleanup-receipt.json'));
  const cleanup = JSON.parse(cleanupBytes);
  assert.equal(cleanup.status, 'passed');
  for (const name of ['node_modules', 'install-cache']) {
    await assert.rejects(lstat(join(consumer.consumerDirectory, name)), { code: 'ENOENT' });
  }
  assert.equal(cleanup.retainedInputsBefore[join(cleanup.consumerDirectory, 'runtime-package-checks.json')], consumer.runtimeIntegrity.reportSha256);
  report.consumerCleanup = { status: cleanup.status, receiptSha256: hash(cleanupBytes), removedPaths: cleanup.removedPaths };
  await copyFile(join(consumer.consumerDirectory, 'cleanup-receipt.json'), join(destination, 'consumer-cleanup.json'));
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
