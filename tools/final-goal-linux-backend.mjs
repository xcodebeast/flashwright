import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finalGoalAccountingClasses } from '../benchmarks/final-goal-resource-policy.mjs';
import { verifyBackendSuiteOutcomes } from './backend-suite-outcomes.mjs';
import { reconstructFinalGoalLinuxCapturedOutputs, reconstructFinalGoalLinuxResourceEvidence } from './final-goal-linux-evidence.mjs';
import { decodeLinuxApplicationJson as decodeJson } from './final-goal-linux-json.mjs';

export const linuxBackendEvidenceLimits = Object.freeze({ maximumFileBytes: 4 * 1024 ** 2, maximumAggregateInputBytes: 16 * 1024 ** 2 });
export const linuxBackendBrowserProfile = Object.freeze({ version: '148.0.7778.96', distribution: 'full-chromium',
  bytes: 276917464, sha256: 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f' });
const sourceInventory = decodeJson(await readFile(new URL('../benchmarks/configurations/backend-consumer-sources.json', import.meta.url)));
const outputNames = ['owner-report.json', 'runner-report.json', 'runner-stdout.txt', 'runner-stderr.txt', 'runner-resources.json',
  'native-launches.json', 'project/playwright/.auth/user.json', 'listener.json', 'api.log', 'postgres.log', 'mailpit.log'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absolute = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !/[\0\\%\r\n]/.test(path) && posix.isAbsolute(path) && posix.normalize(path) === path;
const relative = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !/[\0\\]/.test(path) && !posix.isAbsolute(path) && posix.normalize(path) === path
  && !path.split('/').some(part => ['', '.', '..'].includes(part));
const timestamp = value => {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(value), 'Invalid backend owner timestamp'); return BigInt(value);
};

function validateManifest(manifest, resourceManifest, outputManifest) {
  assert.deepEqual(Object.keys(manifest ?? {}).sort(), ['accountingClass', 'captureSha256', 'consumer', 'prepared', 'schemaVersion', 'workspaceDirectory', 'wrapper']);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.accountingClass, finalGoalAccountingClasses.linux);
  assert(absolute(manifest.workspaceDirectory));
  assert.match(manifest.captureSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(manifest.captureSha256, resourceManifest.files?.capture?.sha256, 'Backend manifest borrows another capture');
  assert.equal(manifest.captureSha256, outputManifest.captureSha256);
  assert.deepEqual(Object.keys(resourceManifest.files ?? {}).sort(), ['after', 'before', 'capture', 'native']);
  assert(Array.isArray(manifest.consumer) && manifest.consumer.length === 30, 'Expected 28 original consumer and two generated inputs');
  assert(Array.isArray(outputManifest.outputs) && outputManifest.outputs.length === outputNames.length, 'Expected eleven backend outputs');
  for (const index of [0, 1, 4, 5, 6, 7]) assert(Number.isSafeInteger(outputManifest.outputs[index]?.bytes)
    && outputManifest.outputs[index].bytes > 0 && outputManifest.outputs[index].bytes <= linuxBackendEvidenceLimits.maximumFileBytes,
  'Backend structured output byte limit exceeded');
  const paths = new Set([...Object.values(resourceManifest.files), ...outputManifest.outputs].map(r => r.path));
  const originals = new Set(); let total = 0;
  for (const r of [manifest.prepared, ...manifest.consumer, manifest.wrapper]) {
    assert.deepEqual(Object.keys(r ?? {}).sort(), ['bytes', 'originalPath', 'path', 'sha256']);
    assert(relative(r.path) && !paths.has(r.path), 'Backend retained path must be unique and contained');
    assert(absolute(r.originalPath) && !originals.has(r.originalPath), 'Invalid or reused backend original path');
    assert(Number.isSafeInteger(r.bytes) && r.bytes > 0 && r.bytes <= linuxBackendEvidenceLimits.maximumFileBytes, 'Backend input byte limit exceeded');
    assert.match(r.sha256 ?? '', /^[a-f0-9]{64}$/); paths.add(r.path); originals.add(r.originalPath); total += r.bytes;
  }
  assert(total <= linuxBackendEvidenceLimits.maximumAggregateInputBytes, 'Backend input aggregate limit exceeded');
}

// Reproduce the historical generator independently; never execute retained config or resolve its imports.
function configurationSource(prepared, workspace) {
  const native = prepared.engine === 'flashwright';
  const module = native ? 'backend-corpus-candidate.mjs' : 'backend-corpus-reference.mjs';
  const factory = native ? 'createBackendCorpusCandidateConfigurationData' : 'createBackendCorpusReferenceConfigurationData';
  const moduleURL = pathToFileURL(posix.join(workspace, 'tools', module)).href;
  const guard = native ? `
import { verifyBackendCorpusCandidateIdentity } from ${JSON.stringify(moduleURL)};
import { forbidUpstreamBrowserBackend } from ${JSON.stringify(pathToFileURL(posix.join(workspace, 'benchmarks/native-backend-guard.mjs')).href)};
const requireCanonical = createRequire(${JSON.stringify(posix.join(workspace, 'package.json'))});
verifyBackendCorpusCandidateIdentity(frontend, requireCanonical('@flashwright/test'));
forbidUpstreamBrowserBackend();
` : `if (requireConsumer('@playwright/test/package.json').version !== '1.60.0') throw new Error('Reference version differs');\n`;
  return Buffer.from(`import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ${factory} } from ${JSON.stringify(moduleURL)};
if (resolve(process.cwd()) !== ${JSON.stringify(prepared.project)}) throw new Error('Wrong consumer working directory');
const requireConsumer = createRequire(import.meta.url);
const frontend = requireConsumer('@playwright/test');
${guard}
const options = ${JSON.stringify(prepared.options)};
options.backendURL = process.env.FLASHWRIGHT_BACKEND_URL;
const configuration = ${factory}(options);
configuration.projects[1].use = { ...frontend.devices['Desktop Chrome'], ...configuration.projects[1].use };
configuration.use.trace = 'on-first-retry';
export default frontend.defineConfig(configuration);
`);
}
function wrapperSource(browser) {
  assert(!browser.includes("'"), 'Unsupported quoted original browser path');
  return Buffer.from(`#!/usr/bin/python3
"""Record the original launch and exec the pinned stock browser unchanged."""
import json
import os
import sys
from pathlib import Path

executable = Path('${browser}').resolve(strict=True)
record = Path(os.environ['FLASHWRIGHT_NATIVE_LAUNCH_DIRECTORY']) / (str(os.getpid()) + '.json')
with record.open('x') as stream:
    json.dump({'mode': 'stock', 'pid': os.getpid(), 'executable': str(executable),
        'argv': [str(executable), *sys.argv[1:]]}, stream, indent=2)
os.execv(executable, [str(executable), *sys.argv[1:]])
`);
}

/** Pinned passing backend profile. Historical paths are names, never filesystem authority. */
export async function reconstructFinalGoalLinuxBackend({ resourceManifest, outputManifest, manifest, readBytes, engine, workers }) {
  assert(['playwright', 'flashwright'].includes(engine) && [1, 4].includes(workers));
  validateManifest(manifest, resourceManifest, outputManifest);
  const retained = new Map(), needed = new Set([resourceManifest.files.capture.path, resourceManifest.files.before.path,
    ...[0, 1, 4, 5, 6, 7].map(index => outputManifest.outputs[index].path)]);
  const reader = async (receipt, limits) => { const bytes = await readBytes(receipt, limits); if (needed.has(receipt.path)) retained.set(receipt.path, bytes); return bytes; };
  const outputs = await reconstructFinalGoalLinuxCapturedOutputs(resourceManifest, outputManifest, reader);
  const resources = await reconstructFinalGoalLinuxResourceEvidence(resourceManifest, reader);
  // The original-resource parser has already strictly decoded these larger inventories.
  const original = key => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(retained.get(resourceManifest.files[key].path)));
  const capture = original('capture'), before = original('before');
  assert(Array.isArray(before.inputs.files) && before.inputs.files.length <= 65536);
  const inputs = new Map();
  for (const r of before.inputs.files) { assert(absolute(r.path) && !inputs.has(r.path), 'Duplicate or invalid captured input path'); inputs.set(r.path, r); }
  const captured = path => {
    assert(absolute(path));
    const matches = before.inputs.files.filter(r => r.path === path || r.resolvedPath === path);
    assert(matches.length, 'Backend dependency is not captured');
    for (const r of matches) {
      assert.match(r.sha256 ?? '', /^[a-f0-9]{64}$/); assert(Number.isSafeInteger(r.bytes) && r.bytes > 0);
      assert.equal(r.sha256, matches[0].sha256, 'Captured aliases disagree'); assert.equal(r.bytes, matches[0].bytes, 'Captured aliases disagree');
    }
    return matches[0];
  };
  const readInput = async r => {
    const c = inputs.get(r.originalPath);
    assert(c && c.sha256 === r.sha256 && c.bytes === r.bytes, 'Backend input differs from original capture');
    const bytes = await readBytes(r, { maximumFileBytes: linuxBackendEvidenceLimits.maximumFileBytes, expectedSize: r.bytes });
    assert(Buffer.isBuffer(bytes) && bytes.length === r.bytes && hash(bytes) === r.sha256, 'Retained backend input bytes changed');
    return bytes;
  };
  const preparedBytes = await readInput(manifest.prepared), prepared = decodeJson(preparedBytes);
  assert.equal(prepared.engine, engine); assert.equal(prepared.workers, workers); assert.equal(prepared.mode, 'stock');
  assert(absolute(prepared.directory)); assert.equal(prepared.project, posix.join(prepared.directory, 'project'));
  assert.equal(manifest.prepared.originalPath, posix.join(prepared.directory, 'prepared.json'));
  const workspace = manifest.workspaceDirectory, native = engine === 'flashwright', base = posix.dirname(prepared.directory);
  const expectedOptions = { frontendDirectory: prepared.project, outputDirectory: posix.join(prepared.directory, 'test-output'),
    jsonReportPath: posix.join(prepared.directory, 'runner-report.json'), browserExecutablePath: posix.join(base, 'stock-browser'), workers,
    ...(native ? { candidateWorkspace: workspace } : {}) };
  assert.deepEqual(prepared.options, expectedOptions);
  const cli = posix.join(workspace, native ? 'packages/flashwright-test/cli.cjs' : 'node_modules/.bun/playwright@1.60.0/node_modules/playwright/cli.js');
  const bun = posix.join(workspace, '.tools/bun-v1.4.2-linux-x64/bin/bun');
  assert.deepEqual(prepared.runnerCommand, [bun, cli, 'test', '--config', posix.join(prepared.project, 'runner.config.mjs')]);
  for (const path of [bun, cli, '/usr/bin/python3', posix.join(base, 'owner.py'), posix.join(base, 'service_stack_owned.py')]) captured(path);
  assert.deepEqual(prepared.ownerCommand, ['/usr/bin/bwrap', '--unshare-user', '--unshare-net', '--bind', '/', '/', '--dev-bind', '/dev', '/dev',
    '--size', '268435456', '--tmpfs', posix.join(prepared.directory, 'service-data'), '--size', '134217728', '--tmpfs', '/dev/shm',
    '--proc', '/proc', '--cap-drop', 'ALL', '--', '/usr/bin/python3', '-B', posix.join(base, 'owner.py'), prepared.directory]);
  assert.deepEqual(prepared.ownerCommand, capture.workloadCommand); assert.equal(prepared.ownerCommand[0], before.inputs.executables.runtime.path);
  assert.equal(prepared.browser.sha256, linuxBackendBrowserProfile.sha256, 'Backend stock browser digest differs');
  assert.equal(prepared.browser.bytes, linuxBackendBrowserProfile.bytes);
  const browserInput = captured(prepared.browser.path);
  assert.equal(browserInput.sha256, prepared.browser.sha256); assert.equal(browserInput.bytes, prepared.browser.bytes);
  assert.equal(browserInput.resolvedPath, before.inputs.executables.browser.resolvedPath);
  assert.equal(prepared.browser.path, before.inputs.executables.browser.path); assert.equal(prepared.browser.sha256, before.inputs.executables.browser.sha256);
  assert.equal(prepared.browser.bytes, before.inputs.executables.browser.bytes); assert.equal(prepared.driverPath, before.inputs.executables.driver.path);
  assert.equal(manifest.wrapper.originalPath, expectedOptions.browserExecutablePath);
  assert.deepEqual(await readInput(manifest.wrapper), wrapperSource(prepared.browser.path), 'Executed wrapper differs from stock policy');
  const dependencyFiles = ['tools/backend-corpus-common.mjs', `tools/backend-corpus-${native ? 'candidate' : 'reference'}.mjs`,
    'benchmarks/configurations/backend-corpus-inventory.json', 'tools/watchdog.py', ...(native ? ['benchmarks/native-backend-guard.mjs'] : [])];
  for (const path of dependencyFiles) {
    const expected = await readFile(new URL('../' + path, import.meta.url)), actual = captured(posix.join(workspace, path));
    assert.equal(actual.sha256, hash(expected), 'Captured backend configuration dependency changed'); assert.equal(actual.bytes, expected.length);
  }
  assert.deepEqual(Object.keys(prepared.aliases).sort(), ['@playwright/test', 'axios', 'dotenv']);
  const frontendPackage = posix.join(workspace, native ? 'packages/flashwright-test' : 'node_modules/.bun/@playwright+test@1.60.0/node_modules/@playwright/test');
  assert.equal(prepared.aliases['@playwright/test'], frontendPackage);
  for (const path of Object.values(prepared.aliases)) captured(posix.join(path, 'package.json'));
  assert.deepEqual(prepared.sources, Object.fromEntries(Object.entries(sourceInventory.files).map(([name, r]) => [name, r.sha256])));
  const expectedGenerated = {
    'package.json': Buffer.from(JSON.stringify({ name: `private-backend-${engine}-${workers}-stock`, private: true, type: 'module',
      description: 'Development consumer with explicitly recorded local dependency aliases; not packed installation.' }) + '\n'),
    'runner.config.mjs': configurationSource(prepared, workspace),
  };
  assert.deepEqual(Object.keys(prepared.generated).sort(), Object.keys(expectedGenerated).sort());
  const names = [...Object.keys(sourceInventory.files), ...Object.keys(expectedGenerated)];
  assert.deepEqual(manifest.consumer.map(r => r.originalPath).sort(), names.map(name => posix.join(prepared.project, name)).sort());
  const consumerPaths = new Set(names.map(name => posix.join(prepared.project, name)));
  for (const path of inputs.keys()) if (path.startsWith(prepared.project + '/tests/') || path.startsWith(prepared.project + '/src/client/'))
    assert(consumerPaths.has(path), 'Unexpected captured backend consumer source');
  for (const receipt of manifest.consumer) {
    const name = posix.relative(prepared.project, receipt.originalPath), bytes = await readInput(receipt);
    if (Object.hasOwn(expectedGenerated, name)) {
      assert.equal(prepared.generated[name], receipt.sha256); assert.deepEqual(bytes, expectedGenerated[name], 'Executed backend configuration changed');
    } else {
      assert.equal(bytes.length, sourceInventory.files[name].bytes); assert.equal(hash(bytes), sourceInventory.files[name].sha256, 'Original backend consumer source changed');
    }
  }
  assert.deepEqual(outputs.outputs.map(r => r.originalPath), outputNames.map(name => posix.join(prepared.directory, name)), 'Unexpected backend output roles or order');
  const outputBytes = index => retained.get(outputManifest.outputs[index].path), outputJson = index => decodeJson(outputBytes(index));
  const owner = outputJson(0), runner = outputJson(1), runnerResources = outputJson(4), launches = outputJson(5).launches;
  assert.equal(owner.preparedSha256, hash(preparedBytes));
  assert.deepEqual(outputJson(7), owner.services.listener, 'Captured listener differs from owner readiness');
  assert.deepEqual(owner.runnerCommand, ['/usr/bin/python3', posix.join(workspace, 'tools/watchdog.py'), '--timeout', '180', '--report',
    posix.join(prepared.directory, 'runner-resources.json'), '--', ...prepared.runnerCommand]);
  assert.equal(resources.wrapperExitCode, 0); assert.equal(resources.observedDrainedMembership, true);
  assert.deepEqual(owner.clock, resources.workloadClock);
  assert.deepEqual(owner.events.map(e => e.name), ['services-start-requested', 'services-ready', 'runner-spawn-requested', 'runner-reaped',
    'outputs-retained', 'service-close-requested', 'services-closed', 'owner-report-write-requested']);
  let previous = timestamp(resources.commandInterval.startedNanoseconds);
  for (const event of owner.events) { const now = timestamp(event.monotonicNanoseconds); assert(now >= previous && now <= timestamp(resources.commandInterval.finishedNanoseconds), 'Owner event escapes original command interval'); previous = now; }
  const outcome = verifyBackendSuiteOutcomes({ prepared, owner, runner, runnerResources, authBytes: outputBytes(6), engine, workers });
  assert(Array.isArray(launches) && launches.length === workers + 1);
  assert.equal(new Set(launches.map(r => r.pid)).size, launches.length, 'Repeated browser launch PID');
  assert(Array.isArray(owner.processExecutableObservations) && owner.processExecutableObservations.length <= 4096);
  const policy = decodeJson(await readFile(new URL('../crates/flashwright-browser/src/chromium-launch-policy.json', import.meta.url))).headless;
  const parentExecutable = native ? before.inputs.executables.driver.resolvedPath : captured(bun).resolvedPath;
  let unavailableArgvSamples = 0;
  for (const launch of launches) {
    assert(Number.isSafeInteger(launch.pid) && launch.pid > 0); assert.equal(launch.mode, 'stock');
    assert.equal(launch.executable, before.inputs.executables.browser.resolvedPath);
    assert(Array.isArray(launch.argv) && launch.argv[0] === launch.executable && launch.argv.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')));
    assert.deepEqual(launch.argv.slice(1).map(arg => arg.startsWith('--user-data-dir=') ? '--user-data-dir=__FLASHWRIGHT_PROFILE__' : arg), policy);
    const observations = owner.processExecutableObservations.filter(r => r.pid === launch.pid && r.executable === launch.executable);
    const complete = observations.find(r => Array.isArray(r.argv) && r.argv.length > 0); assert(complete, 'Missing complete original browser command observation');
    assert(typeof complete.startTicks === 'string' && /^[1-9][0-9]*$/.test(complete.startTicks));
    for (const row of observations) {
      assert.equal(row.startTicks, complete.startTicks); assert.equal(row.parent, complete.parent); assert(Array.isArray(row.argv));
      if (!row.argv.length) { unavailableArgvSamples++; continue; }
      if (JSON.stringify(row.argv) !== JSON.stringify(launch.argv)) {
        assert(launch.argv.every(arg => !/\s/.test(arg)), 'Ambiguous Chromium process title');
        assert.deepEqual(row.argv, [launch.argv.join(' ')], 'Observed browser command differs');
      }
    }
    assert(owner.processExecutableObservations.some(r => r.pid === complete.parent && r.executable === parentExecutable), 'Original browser parent executable missing');
  }
  return { ...outcome, status: 'verified-retained-linux-backend-outcomes', accountingClass: finalGoalAccountingClasses.linux,
    captureIdentity: resources.captureIdentity, captureSha256: manifest.captureSha256, sourceBytesVerified: true,
    originalConsumerFiles: 28, executedConfigurationVerified: true, declaredStockWrapperVerified: true,
    reportedBrowserLaunches: launches.length, unavailableArgvSamples,
    observedDrainedMembership: resources.observedDrainedMembership, nativeCleanObservedTeardown: resources.nativeCleanObservedTeardown,
    scope: 'Pinned corrected consumer/configuration bytes, passing report, original authentication output, reported launch/closure and owner clock joined to retained capture. Source binding does not attest callback execution, loaded libraries, full backend application sources or native process/context custody. Development aliases only; no final resource or performance admission.' };
}
