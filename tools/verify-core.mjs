import { javascriptRuntime, runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { identifyBrowser } from './browser-identity.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { readEngineConfiguration } from './engine-configuration.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const driverName = process.platform === 'win32' ? 'flashwright-driver.exe' : 'flashwright-driver';
const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH ?? `target/debug/${driverName}`);
const driverBuildProfile = ['debug', 'release'].find(profile => driverPath === resolve(`target/${profile}/${driverName}`));
if (!driverBuildProfile) throw new Error('Core verification must build its selected driver. Set FLASHWRIGHT_DRIVER_PATH to the target/debug or target/release driver in this checkout.');
process.env.FLASHWRIGHT_DRIVER_PATH = driverPath;

const started = new Date().toISOString();
const destination = `compatibility/evidence/core-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${started.replaceAll(':', '-')}`;
await mkdir(destination, { recursive: true });
const sources = await sourceManifest();
const browser = await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath());
process.env.FLASHWRIGHT_BROWSER_PATH = browser.executablePath;
const report = {
  schemaVersion: 2, started, browser, ...runtimeMetadata, platform: process.platform, architecture: process.arch,
  environmentClass: process.env.FLASHWRIGHT_ENVIRONMENT_CLASS ?? 'local-development-host',
  containerImage: process.env.FLASHWRIGHT_CONTAINER_IMAGE ?? null,
  sources, checks: [], status: 'running',
  engineConfiguration: readEngineConfiguration(),
  driverBuildProfile,
  scope: 'M1/M2 development core, navigation, locator/input, assertion and runner slice plus the three preserved TodoMVC migration tests against the public demo; Packed Bun consumers exercise explicit development drivers and automatically selected platform packages. The broader package-manager/alias matrix runs separately with bun run test:package-managers. No release or performance claim.',
};
const commands = [
  ['cargo', 'fmt', '--all', '--check'],
  ['cargo', 'clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings'],
  ['python3', 'tools/watchdog.py', '--timeout', '120', '--report-directory', 'compatibility/evidence/resources', '--', 'cargo', 'test', '--workspace', '--locked'],
  [process.execPath, 'tools/build-driver.mjs', ...(driverBuildProfile === 'release' ? ['--release'] : [])],
  [process.execPath, 'tools/build-packages.mjs'],
  [process.execPath, 'tools/extract-selector-runtime.mjs', '--check'],
  [process.execPath, 'tools/extract-keyboard-layout.mjs', '--check'],
  [process.execPath, 'tools/extract-chromium-launch-policy.mjs', '--check'],
  [process.execPath, 'tools/extract-screenshot-preparation.mjs', '--check'],
  [process.execPath, 'tools/record-page-error-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-handle-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-console-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-init-script-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-history-navigation-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-network-headers-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-routing-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-navigation-waits-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-manual-tracing-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-filmstrip-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-snapshot-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-network-trace-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-dialog-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-dialog-host.mjs'],
  [process.execPath, 'tools/record-download-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-download-host.mjs', join(destination, 'download-host')],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', join(destination, 'download-resources'), '--', process.execPath, 'tools/test-downloads.mjs', join(destination, 'downloads')],
  ['python3', 'tools/verify-download-traces.py', join(destination, 'downloads')],
  ['python3', 'tools/watchdog.py', '--timeout', '60', '--report-directory', join(destination, 'download-viewer-resources'), '--', process.execPath, 'tools/test-download-viewer.mjs', join(destination, 'downloads')],
  [process.execPath, 'tools/test-dialog-control-lane.mjs'],
  [process.execPath, 'tools/test-dialog-trace-hooks.mjs'],
  [process.execPath, 'tools/test-trace-admission.mjs'],
  [process.execPath, 'tools/probe-dialog-public-admission.mjs', join(destination, 'dialog-admission'), '--require-success'],
  ['python3', 'tools/watchdog.py', '--timeout', '120', '--report-directory', join(destination, 'dialog-protocol-resources'), '--', 'python3', '-m', 'unittest', 'discover', '-s', 'compatibility/m1', '-p', 'test_dialogs.py', '-v'],
  [process.execPath, 'tools/test-dialog-native-public.mjs', join(destination, 'dialog-native')],
  [process.execPath, 'tools/run-dialog-tests.mjs', join(destination, 'dialog-shared'), '--candidate'],
  [process.execPath, 'tools/test-trace-capacity.mjs', join(destination, 'trace-capacity')],
  [process.execPath, 'tools/test-manual-tracing.mjs'],
  [process.execPath, 'tools/test-trace-resources.mjs'],
  [process.execPath, 'tools/test-trace-storage-budget.mjs'],
  [process.execPath, 'tools/test-trace-archive.mjs'],
  [process.execPath, 'tools/test-trace-archive-assembly.mjs'],
  [process.execPath, 'tools/test-runner-trace-journal.mjs'],
  [process.execPath, 'tools/test-runner-trace-adoption.mjs'],
  [process.execPath, 'tools/record-owned-runner-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-owned-runner-runtime.mjs'],
  [process.execPath, 'tools/run-runner-trace-start-tests.mjs', join(destination, 'runner-trace-start')],
  [process.execPath, 'tools/test-runner-trace-finalizer.mjs'],
  [process.execPath, 'tools/run-runner-trace-finalizer-tests.mjs'],
  [process.execPath, 'tools/run-runner-trace-finalizer-tests.mjs', '--packed'],
  [process.execPath, 'tools/run-runner-trace-adoption-tests.mjs'],
  [process.execPath, 'tools/run-runner-trace-journal-reference.mjs'],
  [process.execPath, 'tools/test-runner-trace-archives.mjs'],
  [process.execPath, 'tools/test-trace-filmstrip.mjs'],
  [process.execPath, 'tools/test-trace-snapshot-record.mjs', join(destination, 'snapshot-record')],
  [process.execPath, 'tools/test-trace-snapshots.mjs'],
  [process.execPath, 'tools/test-trace-recording-lifecycle.mjs'],
  [process.execPath, 'tools/test-trace-network-entry.mjs', join(destination, 'network-entry')],
  [process.execPath, 'tools/test-trace-network.mjs', join(destination, 'network-host')],
  [process.execPath, 'tools/run-native-network-trace-tests.mjs', join(destination, 'native-network')],
  [process.execPath, 'tools/run-snapshot-resource-tests.mjs', join(destination, 'snapshot-resources'), '--candidate'],
  [process.execPath, 'tools/probe-snapshot-trace-integration.mjs', join(destination, 'snapshot-public')],
  [process.execPath, 'tools/test-traced-locator-mutation.mjs'],
  [process.execPath, javascriptRuntime.name === 'bun' ? 'test' : '--test', './tools/test-pointer-completion.mjs'],
  ['python3', 'tools/watchdog.py', '--timeout', '90', '--report-directory', join(destination, 'pointer-cleanup-resources'), '--', process.execPath, 'tools/test-pointer-cleanup.mjs', join(destination, 'pointer-cleanup')],
  [process.execPath, 'tools/test-caller-locations.mjs'],
  [process.execPath, 'compatibility/m1/client-request-order.mjs'],
  [process.execPath, 'compatibility/m1/navigation-watermark.mjs'],
  [process.execPath, 'tools/test-native-url-pattern.mjs'],
  [process.execPath, 'tools/test-network-references.mjs'],
  [process.execPath, 'tools/test-network-history.mjs'],
  [process.execPath, 'tools/test-routing-host.mjs'],
  [process.execPath, 'tools/record-runner-defaults-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-runner-integration.mjs'],
  [process.execPath, 'tools/record-runner-trace-boundaries-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-runner-trace-off-provenance.mjs', '--check'],
  [process.execPath, 'tools/run-runner-trace-off-tests.mjs'],
  [process.execPath, 'tools/test-runner-artifact-lifecycle.mjs'],
  [process.execPath, 'tools/test-runner-trace-steps.mjs'],
  [process.execPath, 'tools/record-common-matcher-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-aria-matcher-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-aria-template-limits.mjs'],
  [process.execPath, 'tools/record-public-aria-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-public-aria-snapshot.mjs'],
  [process.execPath, 'tools/test-public-aria-packaged-validation.mjs'],
  [process.execPath, javascriptRuntime.name === 'bun' ? 'test' : '--test', './tools/test-public-aria-remote-target.mjs'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', join(destination, 'public-aria-resources'), '--', process.execPath, 'tools/run-public-aria-snapshot-tests.mjs', join(destination, 'public-aria')],
  ['python3', 'tools/watchdog.py', '--timeout', '120', '--report-directory', join(destination, 'public-aria-viewer-resources'), '--', process.execPath, 'tools/test-public-aria-viewer.mjs', join(destination, 'public-aria/report.json'), join(destination, 'public-aria-viewer')],
  [process.execPath, 'tools/run-application-suite.mjs', join(destination, 'offline-todomvc'), 'todomvc'],
  [process.execPath, 'tools/test-matcher-context-runtime.mjs'],
  [process.execPath, 'tools/test-common-matchers.mjs', join(destination, 'common-matchers-host')],
  [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'compatibility/m2/common-matchers-types.ts'],
  [process.execPath, 'tools/run-common-matcher-tests.mjs', join(destination, 'common-matchers'), '--candidate'],
  [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '--project', 'compatibility/m2/runner-defaults/tsconfig.json'],
  [process.execPath, 'tools/record-runner-screenshots-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-runner-screenshots.mjs'],
  [process.execPath, 'tools/record-failure-context-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-failure-context-format.mjs'],
  [process.execPath, 'tools/test-failure-context-recorder.mjs'],
  [process.execPath, 'tools/test-failure-context-snapshot.mjs'],
  [process.execPath, 'tools/test-screenshot-ownership.mjs'],
  [process.execPath, 'tools/test-runner-artifact-coordinator.mjs'],
  ['python3', 'tools/watchdog.py', '--timeout', '60', '--report-directory', join(destination, 'failure-context-resources'), '--', process.execPath, 'tools/test-failure-context-operation.mjs'],
  [process.execPath, 'tools/run-failure-context-tests.mjs', join(destination, 'failure-context')],
  [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '--project', 'compatibility/m2/runner-screenshots/tsconfig.json'],
  [process.execPath, 'tools/record-context-settings-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-element-resolution-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-element-action-provenance.mjs', '--check'],
  [process.execPath, 'tools/generate-file-mime-types.mjs', '--check'],
  [process.execPath, 'tools/record-file-input-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-file-chooser-provenance.mjs', '--check'],
  [process.execPath, 'compatibility/m1/chooser-subscription.mjs'],
  [process.execPath, 'tools/record-sequential-typing-provenance.mjs', '--check'],
  [process.execPath, 'tools/record-selector-action-provenance.mjs', '--check'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', join(destination, 'selector-action-resources'), '--', process.execPath, 'compatibility/m2/selector-actions.mjs', join(destination, 'selector-actions')],
  ['python3', 'tools/verify-selector-action-traces.py', join(destination, 'selector-actions')],
  [process.execPath, 'tools/record-frame-locator-provenance.mjs', '--check'],
  ['python3', 'tools/watchdog.py', '--timeout', '300', '--report-directory', join(destination, 'frame-locator-resources'), '--', process.execPath, 'compatibility/m2/frame-locators.mjs', join(destination, 'frame-locators')],
  ['python3', 'tools/verify-frame-locator-traces.py', join(destination, 'frame-locators')],
  ['python3', 'tools/watchdog.py', '--timeout', '60', '--report-directory', join(destination, 'input-retry-resources'), '--', process.execPath, 'tools/test-input-retry-snapshots.mjs', join(destination, 'input-retry-snapshots')],
  [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '--project', 'compatibility/m2/context-settings-runner/tsconfig.json'],
  [process.execPath, 'tools/record-device-provenance.mjs', '--check'],
  [process.execPath, 'tools/test-device-metadata.mjs'],
  [process.execPath, 'tools/generate-device-descriptors.mjs', '--check'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', 'compatibility/evidence/resources', '--', process.execPath, 'tools/test-device-catalogue.mjs'],
  [process.execPath, 'tools/generate-inventory.mjs', '--check'],
  [process.execPath, javascriptRuntime.name === 'bun' ? 'test' : '--test', './tools/test-parity-catalog.mjs'],
  [process.execPath, javascriptRuntime.name === 'bun' ? 'test' : '--test', './tools/test-competitor-contract.mjs', './tools/test-competitor-sampling.mjs', './tools/test-broad-matrix.mjs', './tools/test-broad-matrix-snapshot.mjs', './tools/test-cypress-contract.mjs', './tools/test-runner-suite-contract.mjs'],
  [process.execPath, javascriptRuntime.name === 'bun' ? 'test' : '--test', './tools/test-runner-suite-diagnostics.mjs'],
  [process.execPath, javascriptRuntime.name === 'bun' ? 'test' : '--test', './tools/test-rust-dependency-notices.mjs'],
  [process.execPath, javascriptRuntime.name === 'bun' ? 'test' : '--test', './tools/test-benchmark-backend-guard.mjs'],
  [process.execPath, 'tools/typecheck.mjs'],
  [process.execPath, javascriptRuntime.name === 'bun' ? 'test' : '--test', './tools/test-harness.mjs', './tools/test-protocol-profile.mjs', './tools/test-attachments.mjs', './tools/test-input-attachments.mjs'],
  ['python3', '-m', 'unittest', 'discover', '-s', 'tools', '-p', 'test_*.py', '-v'],
  [process.execPath, 'tools/run-library-smoke.mjs'],
  [process.execPath, 'tools/run-concurrent-launch-tests.mjs', join(destination, 'concurrent-launch')],
  [process.execPath, 'tools/run-lifecycle-tests.mjs'],
  [process.execPath, 'tools/run-navigation-tests.mjs'],
  [process.execPath, 'tools/run-network-header-tests.mjs'],
  [process.execPath, 'tools/run-request-payload-tests.mjs'],
  [process.execPath, 'tools/run-routing-tests.mjs'],
  [process.execPath, 'tools/run-history-navigation-tests.mjs'],
  [process.execPath, 'tools/run-navigation-wait-tests.mjs'],
  [process.execPath, 'tools/run-locator-tests.mjs'],
  [process.execPath, 'tools/run-pointer-tests.mjs'],
  [process.execPath, 'tools/run-keyboard-tests.mjs'],
  [process.execPath, 'tools/run-sequential-typing-tests.mjs'],
  [process.execPath, 'tools/run-assertion-tests.mjs'],
  [process.execPath, 'tools/run-aria-assertion-tests.mjs', join(destination, 'aria-assertions')],
  [process.execPath, 'tools/run-matcher-context-tests.mjs', join(destination, 'matcher-context')],
  [process.execPath, 'tools/run-condition-tests.mjs'],
  [process.execPath, 'tools/run-native-runner-tests.mjs'],
  [process.execPath, 'tools/test-packed-package.mjs'],
  [process.execPath, 'tools/test-platform-runtime.mjs'],
  [process.execPath, 'tools/test-packed-runner.mjs'],
  [process.execPath, 'tools/test-packed-migration.mjs'],
  [process.execPath, 'tools/test-benchmark-contract.mjs'],
  [process.execPath, 'tools/test-resident-load.mjs'],
  [process.execPath, 'tools/run-storage-tests.mjs'],
  [process.execPath, 'tools/run-screenshot-tests.mjs'],
  [process.execPath, 'tools/run-device-tests.mjs'],
  [process.execPath, 'tools/run-context-settings-tests.mjs'],
  [process.execPath, 'tools/run-context-settings-runner-tests.mjs'],
  ['python3', 'tools/watchdog.py', '--timeout', '180', '--report-directory', 'compatibility/evidence/resources', '--', process.execPath, 'tools/run-device-runner-tests.mjs'],
  [process.execPath, 'tools/run-diagnostic-tests.mjs'],
  [process.execPath, 'tools/run-handle-tests.mjs'],
  [process.execPath, 'tools/run-element-resolution-tests.mjs'],
  [process.execPath, 'tools/run-element-action-tests.mjs'],
  [process.execPath, 'tools/run-file-input-tests.mjs'],
  [process.execPath, 'tools/run-file-chooser-tests.mjs'],
  [process.execPath, 'tools/run-console-tests.mjs'],
  [process.execPath, 'tools/run-init-script-tests.mjs'],
  [process.execPath, 'tools/run-runner-defaults-tests.mjs'],
  [process.execPath, 'tools/run-runner-screenshot-tests.mjs'],
  [process.execPath, 'tools/run-manual-tracing-checks.mjs'],
  [process.execPath, 'tools/run-runner-trace-archive-tests.mjs'],
  [process.execPath, 'tools/run-trace-source-checks.mjs'],
  [process.execPath, 'tools/run-trace-filmstrip-checks.mjs'],
  [process.execPath, 'tools/test-packed-filmstrip.mjs'],
  [process.execPath, 'tools/test-packed-dialogs.mjs', join(destination, 'dialog-packed')],
  [process.execPath, 'tools/test-packed-runner-integration.mjs'],
];
for (const [index, command] of commands.entries()) {
  const started = performance.now();
  const log = `${index + 1}-${command[0] === process.execPath ? javascriptRuntime.name : command[0]}.txt`;
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
report.driverPath = driverPath;
report.driverSha256 = await readFile(report.driverPath).then(hash, () => null);
report.status = report.checks.length === commands.length && report.checks.every(check => check.code === 0) && !report.sourceChangedDuringVerification && !report.browserChangedDuringVerification ? 'passed' : 'failed';
report.finished = new Date().toISOString();
await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Core verification ${report.status}: ${destination}/report.json`);
process.exitCode = report.status === 'passed' ? 0 : 1;
