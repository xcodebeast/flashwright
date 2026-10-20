import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { reconstructFinalGoalLinuxFamily, linuxFamilyEvidenceLimits } from './final-goal-linux-family.mjs';
import { reconstructFinalGoalLinuxResourceEvidence } from './final-goal-linux-evidence.mjs';
import { verifyFinalGoalEvidence } from './verify-final-goal.mjs';
import { finalGoalHash } from '../benchmarks/final-goal-contract.mjs';
const fixture = JSON.parse(await readFile(new URL('../compatibility/evidence/fixtures/linux-cgroup-originals-synthetic.json', import.meta.url)));
const baselineBytes = await readFile(new URL('../benchmarks/configurations/runner-suite.json', import.meta.url));
const commonSource = await readFile(new URL('../benchmarks/runner-suite/workloads.spec.mjs', import.meta.url));
const policy = JSON.parse(await readFile(new URL('../crates/flashwright-browser/src/chromium-launch-policy.json', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const lines = commonSource.toString().split('\n');
const declarationLine = lines.findIndex(line => line.includes('test(`${workload}/${phase}/${iteration}`')) + 1;
const declarationColumn = lines[declarationLine - 1].indexOf('test(');
const assertionLine = lines.findIndex(line => line.includes("await expect(page.locator('#missing')).toBeVisible")) + 1;
const assertionColumn = lines[assertionLine - 1].indexOf('.toBeVisible') + 1;
function frame(full, headline) {
  const rows = [];
  for (let line = full ? 1 : assertionLine - 2; line <= (full ? lines.length : assertionLine + 3); line++) {
    rows.push(`${line === assertionLine ? '>' : ' '} ${line}${full ? ' '.repeat(String(lines.length).length - String(line).length + 1) : ' '}| ${lines[line - 1]}`);
    if (line === assertionLine) rows.push(`     | ${' '.repeat(assertionColumn - 1)}^${full ? ' ' + headline : ''}`);
  }
  return rows.join('\n');
}

// All process/resource identities and documents here are synthetic. Only the canonical workload bytes are real.
function bundle({ family = 'interaction', engine = 'flashwright', workers = 1, change = () => {} } = {}) {
  const originals = Object.fromEntries(Object.entries(fixture.originals).map(([key, raw]) => [key, JSON.parse(raw)]));
  const directory = '/synthetic/missing/family', project = directory + '/project', workspace = '/synthetic/missing';
  const configuration = JSON.parse(baselineBytes); configuration.workloads = [family]; configuration.workers = workers;
  const browser = { executablePath: '/synthetic/chrome', sha256: 'a'.repeat(64), version: configuration.browserVersion };
  const native = engine === 'flashwright', failed = family === 'failure';
  const entry = workspace + (native ? '/packages/flashwright-test/dist/commonjs/index.js' : '/node_modules/.bun/@playwright+test@1.60.0/node_modules/@playwright/test/index.js');
  const cli = workspace + (native ? '/packages/flashwright-test/cli.cjs' : '/node_modules/.bun/playwright@1.60.0/node_modules/playwright/cli.js');
  const guard = workspace + '/benchmarks/native-backend-guard.mjs';
  const runnerConfiguration = { testDir: '.', testMatch: 'workloads.spec.mjs', workers, fullyParallel: workers === 4,
    retries: 0, repeatEach: 1, maxFailures: 0, forbidOnly: true, timeout: 30000, expect: { timeout: 5000 },
    outputDir: directory + '/test-output', reporter: [['json', { outputFile: directory + '/runner-report.json' }]],
    use: { headless: true, viewport: configuration.viewport, trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 5000, navigationTimeout: 10000 } };
  const sourceBytes = {
    'workloads.spec.mjs': commonSource,
    'suite-configuration.json': Buffer.from(JSON.stringify({ configuration, launchIndex: 0 }) + '\n'),
    'adapter.mjs': Buffer.from((native ? `import { forbidUpstreamBrowserBackend } from "file://${guard}";\nforbidUpstreamBrowserBackend();\n` : '') + `export { test, expect, defineConfig } from "file://${entry}";\nexport const nativeBackendGuardActive = ${native};\n`),
    'runner.config.mjs': Buffer.from(`import { defineConfig } from './adapter.mjs';\nconst configuration = ${JSON.stringify(runnerConfiguration)};\nconfiguration.use.baseURL = process.env.FLASHWRIGHT_TEST_BASE_URL;\nconfiguration.use.launchOptions = { executablePath: process.env.FLASHWRIGHT_BROWSER_PATH };\nexport default defineConfig(configuration);\n`),
  };
  const titles = [['warmup', 3], ['sample', 12]].flatMap(([phase, count]) => Array.from({ length: count }, (_, index) => `${family}/${phase}/${index}`));
  const prepared = { schemaVersion: 1, directory, project, workspaceDirectory: workspace, engine, family, workers, configuration, runnerConfiguration, browser,
    driverPath: '/synthetic/driver', expectedTitles: titles, originalWorkloadSha256: hash(commonSource), originalConfigurationSha256: hash(baselineBytes),
    generatedFiles: Object.fromEntries(Object.entries(sourceBytes).map(([name, bytes]) => [name, hash(bytes)])),
    ownerCommand: ['/synthetic/bun', workspace + '/owner.mjs', directory], runnerCommand: ['/synthetic/bun', cli, 'test', '--config', project + '/runner.config.mjs'] };
  const documents = { artifacts: [] };
  const specs = titles.map((title, index) => {
    const workerIndex = failed ? index : index % workers;
    const observation = { title, milliseconds: 1, isolation: { localStorage: null, sessionStorage: null, cookies: '' }, contextReused: false,
      browserVersion: configuration.browserVersion, nativeBackendGuardActive: native, runtime: { name: 'bun', version: '1.4.2' }, workerProcess: 1000 + workerIndex,
      trustedClicks: ['interaction', 'backend'].includes(family) ? 1 : 0, untrustedClicks: 0, trustedChanges: family === 'backend' ? 1 : 0, untrustedChanges: 0,
      applicationCount: family === 'interaction' ? 1 : 0, viewport: configuration.viewport, focused: true, visibilityState: 'visible' };
    const launch = native ? 'flashwright:browser <launching> ' + JSON.stringify({ executable: browser.executablePath, arguments: policy.headless })
      : 'pw:browser <launching> ' + browser.executablePath + ' ' + policy.headless.join(' ');
    const result = { status: failed ? 'failed' : 'passed', retry: 0, duration: 1, workerIndex, parallelIndex: index % workers,
      annotations: [{ type: 'runner-suite-observation', description: JSON.stringify(observation) }], errors: [], attachments: [],
      stderr: failed || index < workers ? [{ text: launch.slice(0, 70) }, { text: launch.slice(70) + '\n' }] : [] };
    if (failed) {
      const sourcePath = project + '/workloads.spec.mjs';
      const message = 'Error: expect(locator("#missing")).toBeVisible(expected)\nTimed out after 250ms\nLocator: locator("#missing")\nExpected: "visible"\nReceived: no matching element';
      const location = { file: sourcePath, line: assertionLine, column: assertionColumn }, stack = `    at ${sourcePath}:${assertionLine}:${assertionColumn}`;
      result.error = { message, location, stack: message + '\n' + stack, snippet: frame(false) }; result.errorLocation = location;
      result.errors = [{ location, message: message + '\n\n' + frame(false) + '\n' + stack }];
      const path = directory + '/test-output/workloads-' + title.replaceAll('/', '-') + '/error-context.md';
      const snapshot = '- text: Name\n- textbox "Name"\n- button "Increment"\n- button "Save"\n- status: Ready\n- text: "0"';
      const document = `# Test info\n\n- Name: workloads.spec.mjs >> ${title}\n- Location: ${sourcePath}:${declarationLine}:${declarationColumn}\n\n# Error details\n\n\`\`\`\n${message}\n\`\`\`\n\n\`\`\`yaml\n${snapshot}\n\`\`\`\n\n# Test source\n\n\`\`\`ts\n${frame(true, message.split('\n')[0])}\n\`\`\``;
      result.attachments.push({ name: 'error-context', contentType: 'text/markdown', path });
      documents.artifacts.push({ path, bytes: Buffer.from(document).toString('base64') });
    }
    return { id: 'original-' + index, title, file: 'workloads.spec.mjs', line: declarationLine, column: declarationColumn,
      tests: [{ expectedStatus: 'passed', status: failed ? 'unexpected' : 'expected', results: [result] }] };
  });
  const reporter = { errors: [], config: { workers, fullyParallel: workers === 4, maxFailures: 0, forbidOnly: true, projects: [{ retries: 0, repeatEach: 1 }] },
    suites: [{ specs }], stats: { expected: failed ? 0 : 15, unexpected: failed ? 15 : 0, skipped: 0, flaky: 0 } };
  const owner = { family, engine, workers, status: 'completed-owner', failures: [], serviceClosed: true, runnerCommand: prepared.runnerCommand,
    runnerExit: { code: failed ? 1 : 0, signal: null }, backend: { documents: family === 'navigation' ? 30 : 15, backendRequests: family === 'backend' ? 15 : 0, otherRequests: 0 },
    clock: { captureIdentity: originals.capture.captureIdentity, domain: 'linux-clock-monotonic', originNanoseconds: '200', implementation: 'clock_gettime(CLOCK_MONOTONIC)' },
    events: ['fixture-start-requested', 'fixture-listening', 'runner-spawn-requested', 'runner-closed', 'runner-streams-retained', 'reporter-output-readable', 'fixture-close-requested', 'fixture-closed', 'owner-report-write-requested'].map((name, index) => ({ name, nanoseconds: String(250 + index * 10) })) };
  const sources = [prepared.ownerCommand[1], entry, cli, ...(native ? [guard] : []), '/synthetic/bun'].map(path => ({ path, resolvedPath: path, bytes: 1, sha256: 'a'.repeat(64) }));
  originals.native.originalWait.exitCode = 0; originals.native.originalWait.status = 0;
  originals.capture.native.originalWrapperWait = structuredClone(originals.native.originalWait);
  change({ prepared, owner, reporter, sourceBytes, documents, sources, originals });
  const files = new Map();
  const retain = (path, originalPath, bytes) => { files.set(path, bytes); return { path, originalPath, bytes: bytes.length, sha256: hash(bytes) }; };
  const preparedReceipt = retain('inputs/prepared.json', directory + '/prepared.json', encode(prepared));
  const generated = Object.entries(sourceBytes).map(([name, bytes]) => retain('inputs/' + name, project + '/' + name, bytes));
  const inputs = [preparedReceipt, ...generated].map(({ originalPath, bytes, sha256 }) => ({ path: originalPath, resolvedPath: originalPath, bytes, sha256 }));
  for (const name of ['before', 'after']) {
    originals[name].workloadCommand = prepared.ownerCommand;
    originals[name].inputs = { executables: { runtime: { path: '/synthetic/bun', resolvedPath: '/synthetic/bun' }, browser: { path: browser.executablePath, sha256: browser.sha256 }, driver: { path: prepared.driverPath } }, files: [...sources, ...inputs] };
  }
  originals.capture.workloadCommand = prepared.ownerCommand;
  originals.capture.wrapperCommand.splice(-2, 2, ...prepared.ownerCommand);
  originals.capture.collectorCommand.splice(-2, 2, ...prepared.ownerCommand);
  originals.native.commandBytes = originals.capture.wrapperCommand;
  originals.capture.workloadClock = { schemaVersion: 1, type: 'monotonic', implementation: 'clock_gettime(CLOCK_MONOTONIC)', identity: originals.capture.captureIdentity, originNanoseconds: '200', resolutionSeconds: 1e-9 };
  const outputs = [['owner-report.json', encode(owner)], ['runner-report.json', encode(reporter)], ['runner-stdout.txt', Buffer.alloc(0)], ['runner-stderr.txt', Buffer.alloc(0)], ['diagnostic-documents.json', encode(documents)]]
    .map(([name, bytes]) => retain('outputs/' + name, directory + '/' + name, bytes));
  originals.capture.requestedOutputs = outputs.map(r => r.originalPath);
  originals.capture.capturedOutputs = outputs.map(({ originalPath, bytes, sha256 }) => ({ path: originalPath, resolvedPath: originalPath, bytes, sha256 }));
  const resourceManifest = { schemaVersion: 1, accountingClass: fixture.header.accountingClass, files: {} };
  for (const name of ['before', 'after', 'native']) {
    const { originalPath, ...receipt } = retain('originals/' + name + '.json', '/unused', encode(originals[name]));
    resourceManifest.files[name] = receipt;
    const key = name === 'native' ? 'nativeReceipt' : name;
    originals.capture[key] = { ...originals.capture[key], bytes: receipt.bytes, sha256: receipt.sha256 };
  }
  const { originalPath, ...captureReceipt } = retain('originals/capture.json', '/unused', encode(originals.capture));
  resourceManifest.files.capture = captureReceipt;
  const outputManifest = { schemaVersion: 1, accountingClass: fixture.header.accountingClass, captureSha256: captureReceipt.sha256, outputs };
  const manifest = { schemaVersion: 1, accountingClass: fixture.header.accountingClass, captureSha256: captureReceipt.sha256, prepared: preparedReceipt, generated };
  const reads = [];
  return { files, reads, args: { resourceManifest, outputManifest, manifest, family, engine, workers, readBytes: async (receipt, limits) => {
    assert(!receipt.path.startsWith('/'), 'Historical names must never be opened'); reads.push(receipt.path);
    const bytes = files.get(receipt.path); assert(bytes); assert.equal(bytes.length, limits.expectedSize); assert(bytes.length <= limits.maximumFileBytes); return bytes;
  } } };
}

for (const family of ['interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure']) for (const engine of ['playwright', 'flashwright']) for (const workers of [1, 4])
  test(`reconstructs retained ${family}/${engine}/${workers} without historical files`, async () => {
    const result = await reconstructFinalGoalLinuxFamily(bundle({ family, engine, workers }).args);
    assert.equal(result.tests.length, 15); assert.equal(result.actualFailures, family === 'failure' ? 15 : 0);
    assert.equal(result.reportedBrowserLaunches, family === 'failure' ? 15 : workers);
    assert.equal(result.diagnosticContent?.casesPerEngine ?? 0, family === 'failure' ? 15 : 0);
    for (const key of ['resourceAdmission', 'performanceAccepted', 'nativeContextOwnershipVerified', 'callbackDispatchVerified', 'nativeCleanObservedTeardown']) assert.equal(result[key], false);
  });
for (const [name, change] of [
  ['substituted workload', d => d.sourceBytes['workloads.spec.mjs'] = Buffer.from('different callback')],
  ['changed assertion delay', d => d.prepared.configuration.delayedAssertionMilliseconds = 0],
  ['executed delay override', d => { const c = JSON.parse(d.sourceBytes['suite-configuration.json']); c.configuration.delayedAssertionMilliseconds = 0; d.sourceBytes['suite-configuration.json'] = encode(c); }],
  ['changed launch index', d => { const c = JSON.parse(d.sourceBytes['suite-configuration.json']); c.launchIndex = 1; d.sourceBytes['suite-configuration.json'] = encode(c); }],
  ['substituted adapter', d => d.sourceBytes['adapter.mjs'] = Buffer.from('export * from "foreign"')],
  ['runner retry override', d => d.prepared.runnerConfiguration.retries = 1],
  ['substituted runner command', d => d.prepared.runnerCommand[1] = '/foreign/cli'],
  ['uncaptured adapter dependency', d => d.sources.splice(1, 1)],
  ['contradictory source alias', d => d.sources.push({ ...d.sources[1], path: '/alias', sha256: 'b'.repeat(64) })],
  ['wrong browser path', d => d.prepared.browser.executablePath = '/substitute'],
  ['changed source declaration', d => d.reporter.suites[0].specs[0].line++],
  ['missing original attempt', d => d.reporter.suites[0].specs.pop()],
  ['foreign owner clock', d => d.owner.clock.captureIdentity = 'b'.repeat(32)],
  ['outside command interval', d => d.owner.events[0].nanoseconds = '1'],
  ['reversed owner events', d => d.owner.events.reverse()],
  ['service still open', d => d.owner.serviceClosed = false],
  ['hidden owner failure', d => d.owner.failures.push('failed')],
  ['missing launch', d => d.reporter.suites[0].specs[0].tests[0].results[0].stderr = []],
  ['foreign launch policy', d => d.reporter.suites[0].specs[0].tests[0].results[0].stderr[0].text = 'changed'],
  ['unexpected diagnostic', d => d.documents.artifacts.push({ path: '/foreign', bytes: 'eA==' })],
]) test('rejects captured family mismatch: ' + name, async () => {
  const b = bundle({ change: d => { change(d); for (const [name, bytes] of Object.entries(d.sourceBytes)) d.prepared.generatedFiles[name] = hash(bytes); } });
  await assert.rejects(() => reconstructFinalGoalLinuxFamily(b.args));
});
for (const [name, change] of [
  ['failure promoted to success', d => d.owner.runnerExit.code = 0],
  ['missing document', d => d.documents.artifacts.pop()],
  ['borrowed document', d => d.documents.artifacts[1] = d.documents.artifacts[0]],
  ['noncanonical base64', d => d.documents.artifacts[0].bytes += '\n'],
  ['oversized document', d => d.documents.artifacts[0].bytes = Buffer.alloc(linuxFamilyEvidenceLimits.maximumDocumentBytes + 1).toString('base64')],
  ['missing predicate evidence', d => d.documents.artifacts[0].bytes = Buffer.from('no observation before the deadline').toString('base64')],
  ['wrong snapshot', d => d.documents.artifacts[0].bytes = Buffer.from(Buffer.from(d.documents.artifacts[0].bytes, 'base64').toString().replace('status: Ready', 'status: Wrong')).toString('base64')],
  ['changed source caret', d => d.reporter.suites[0].specs[0].tests[0].results[0].errorLocation.column++],
]) test('rejects captured failure evidence: ' + name, async () => {
  await assert.rejects(() => reconstructFinalGoalLinuxFamily(bundle({ family: 'failure', change }).args));
});
for (const [name, change] of [
  ['borrowed capture', a => a.manifest.captureSha256 = 'b'.repeat(64)],
  ['missing generated file', a => a.manifest.generated.pop()],
  ['extra output', a => a.outputManifest.outputs.push(a.outputManifest.outputs[0])],
  ['oversized structured output', a => a.outputManifest.outputs[1].bytes = linuxFamilyEvidenceLimits.maximumFileBytes + 1],
  ['absolute retained path', a => a.manifest.prepared.path = '/historical/file'],
  ['retained traversal', a => a.manifest.prepared.path = '../file'],
  ['input/output alias', a => a.manifest.prepared.path = a.outputManifest.outputs[0].path],
  ['duplicate original input', a => a.manifest.generated[0].originalPath = a.manifest.prepared.originalPath],
  ['oversized input', a => a.manifest.prepared.bytes = linuxFamilyEvidenceLimits.maximumFileBytes + 1],
  ['aggregate input limit', a => { for (const r of [a.manifest.prepared, ...a.manifest.generated]) r.bytes = linuxFamilyEvidenceLimits.maximumFileBytes; }],
]) test('invalid family manifest rejects before reads: ' + name, async () => {
  const b = bundle(); change(b.args); await assert.rejects(() => reconstructFinalGoalLinuxFamily(b.args)); assert.deepEqual(b.reads, []);
});
test('changed retained input rejects without executing its contents', async () => {
  const b = bundle(), r = b.args.manifest.generated[0]; b.files.set(r.path, Buffer.alloc(r.bytes, 120));
  await assert.rejects(() => reconstructFinalGoalLinuxFamily(b.args), /input bytes changed/);
});
test('changed captured input receipt rejects before any selected input read', async () => {
  const b = bundle(); b.args.manifest.generated[0].sha256 = 'f'.repeat(64);
  await assert.rejects(() => reconstructFinalGoalLinuxFamily(b.args), /differs from original capture/);
  assert(b.reads.every(path => !path.startsWith('inputs/')));
});

test('draft campaign reconstructs a controlled family while leaving all nine final scenarios unaccepted', async () => {
  const b = bundle({ family: 'failure' });
  const configuration = JSON.parse(await readFile(new URL('../benchmarks/configurations/final-goal-linux.json', import.meta.url)));
  const temporaryRoot = fileURLToPath(new URL('../workbench/final-goal-linux-family-tests/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'draft-'));
  try {
    const save = async (path, value) => { const bytes = encode(value); await writeFile(join(directory, path), bytes); return { path, sha256: hash(bytes) }; };
    for (const [path, bytes] of b.files) { await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), bytes); }
    const resources = await reconstructFinalGoalLinuxResourceEvidence(b.args.resourceManifest, b.args.readBytes);
    const report = { tests: [] }, evidence = [];
    for (const [kind, path, value] of [['report', 'report.json', report], ['resources', 'resources.json', resources],
      ['linux-cgroup-originals', 'originals.json', b.args.resourceManifest], ['linux-captured-outputs', 'outputs.json', b.args.outputManifest],
      ['linux-controlled-family', 'family.json', b.args.manifest]]) evidence.push({ kind, ...await save(path, value) });
    const campaign = { schemaVersion: 1, configuration: await save('configuration.json', configuration),
      declaration: await save('declaration.json', { schemaVersion: 1, status: 'draft', configurationSha256: finalGoalHash(configuration),
        accountingClass: configuration.accountingClass, resourceContext: { accountingClass: configuration.accountingClass } }), scenarios: [] };
    let selected;
    for (const scenario of configuration.scenarios) {
      const result = { id: scenario.id, cells: configuration.cells.map((cell, index) => scenario.id === 'runner-failure' && index === 0
        ? { id: cell.id, status: 'noncomparable', reason: 'Synthetic reported failure fixture; final admission absent', attempts: [{ runs: { flashwright: { report, resources, evidence } } }] }
        : { id: cell.id, status: 'unmeasured', attempts: [] }) };
      if (scenario.id === 'runner-failure') selected = result;
      campaign.scenarios.push({ ...await save(scenario.id + '.json', result), scenarioId: scenario.id });
    }
    await save('campaign.json', campaign);
    const result = await verifyFinalGoalEvidence(directory);
    assert.equal(result.analysis.goalAccepted, false); assert.equal(result.analysis.declaredScenarioCount, 9);
    assert.equal(result.linuxControlledFamilyOutcomes.length, 1);
    assert.equal(result.linuxControlledFamilyOutcomes[0].actualFailures, 15);
    assert.equal(result.linuxControlledFamilyOutcomes[0].diagnosticContent.casesPerEngine, 15);
    assert.equal(result.linuxControlledFamilyOutcomes[0].performanceAccepted, false);
    assert.deepEqual(result.linuxApplicationOutcomes, []);
    const originalEvidence = [...evidence];
    for (const [name, change, expected] of [
      ['duplicate family', () => evidence.push(originalEvidence.at(-1)), /unique Linux controlled-family/],
      ['missing outputs', () => evidence.splice(evidence.findIndex(r => r.kind === 'linux-captured-outputs'), 1), /require captured outputs/],
      ['mixed workload roles', () => evidence.push({ ...originalEvidence.at(-1), kind: 'linux-application-workload' }), /Cannot mix/],
    ]) {
      change();
      const entry = campaign.scenarios.find(s => s.scenarioId === 'runner-failure');
      Object.assign(entry, await save('runner-failure.json', selected)); await save('campaign.json', campaign);
      await assert.rejects(() => verifyFinalGoalEvidence(directory), expected, name);
      evidence.splice(0, evidence.length, ...originalEvidence);
    }
    for (const [kind, value] of [['linux-controlled-family', b.args.manifest], ['linux-cgroup-originals', b.args.resourceManifest], ['linux-captured-outputs', b.args.outputManifest]]) {
      const receipt = evidence.find(r => r.kind === kind);
      for (const key of ['schemaVersion', 'schema\\u0056ersion']) {
        const duplicateManifest = Buffer.from('{"' + key + '":2,' + JSON.stringify(value).slice(1));
        await writeFile(join(directory, receipt.path), duplicateManifest); receipt.sha256 = hash(duplicateManifest);
        Object.assign(campaign.scenarios.find(s => s.scenarioId === 'runner-failure'), await save('runner-failure.json', selected)); await save('campaign.json', campaign);
        await assert.rejects(() => verifyFinalGoalEvidence(directory), /Duplicate application JSON property/);
      }
      Object.assign(receipt, await save(receipt.path, value));
    }
    Object.assign(campaign.scenarios.find(s => s.scenarioId === 'runner-failure'), await save('runner-failure.json', selected)); await save('campaign.json', campaign);
    await writeFile(join(directory, b.args.manifest.generated[0].path), Buffer.from('substituted source'));
    await assert.rejects(() => verifyFinalGoalEvidence(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
