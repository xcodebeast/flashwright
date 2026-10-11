import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeTitle = 'native reply keeps the transformed helper location';
const deadlineTitle = 'test deadline keeps the pending helper location';
const startupTimeoutMilliseconds = 60_000;
const pendingTimeoutMilliseconds = 5_000;
const watchdogTimeoutSeconds = 300;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const withoutColors = text => text.replace(/\u001b\[[0-9;]*m/g, '');

/** Check the original TypeScript frame, including the exact caret column. */
function verifySourceFrame(text, sourceLine, line, column) {
  const rows = withoutColors(text).split('\n');
  const markedRows = rows.flatMap((row, index) => /^>\s+\d+\s+\|/.test(row) ? [index] : []);
  assert.equal(markedRows.length, 1, 'Retain exactly one original source frame');
  const index = markedRows[0];
  assert.equal(rows[index], `> ${line} | ${sourceLine}`, 'Retain the exact typed helper call line');
  const caret = rows[index + 1]?.match(/^ +\| ( *)\^(?: .*)?$/);
  assert.ok(caret, 'Retain the caret immediately below the helper call');
  assert.equal(caret[1].length, column - 1, 'Retain the exact original call column');
}

/** Verify real runner reports without invoking another runner or browser. */
export async function verifyRunnerReport(runnerReport, helperPath, testOutputDirectory) {
  const helperSource = await readFile(helperPath, 'utf8');
  const sourceLines = helperSource.split('\n');
  const callLines = sourceLines.flatMap((sourceLine, index) => sourceLine.includes('await page.getByRole') ? [index] : []);
  assert.equal(callLines.length, 1);
  assert.match(helperSource, /import type \{ Page \}/);
  assert.match(helperSource, /type ProbeLabel = string;/);
  assert.match(helperSource, /page: Page, timeout: number\): Promise<void>/);
  assert.match(helperSource, /const label: ProbeLabel/);
  const sourceLine = sourceLines[callLines[0]];
  const line = callLines[0] + 1;
  const column = sourceLine.indexOf('click(') + 1;
  assert.ok(column > 0);
  const expectedLocation = { file: helperPath, line, column };
  const specifications = [];
  function visit(suites) {
    for (const suite of suites) {
      specifications.push(...(suite.specs ?? []));
      visit(suite.suites ?? []);
    }
  }
  visit(runnerReport.suites);
  assert.deepEqual(specifications.map(specification => specification.title), [nativeTitle, deadlineTitle]);
  assert.deepEqual(runnerReport.errors, [], 'No collection or global runner failure');
  assert.equal(runnerReport.stats.expected, 0);
  assert.equal(runnerReport.stats.unexpected, 2);
  assert.equal(runnerReport.stats.skipped, 0);
  assert.equal(runnerReport.stats.flaky, 0);
  const cases = [];
  for (const [index, specification] of specifications.entries()) {
    assert.equal(specification.tests.length, 1);
    const test = specification.tests[0];
    assert.equal(test.expectedStatus, 'passed', 'Keep the two original unexpected failures');
    assert.equal(test.status, 'unexpected');
    assert.equal(test.results.length, 1);
    const result = test.results[0];
    assert.equal(result.status, index === 0 ? 'failed' : 'timedOut');
    assert.equal(result.retry, 0);
    assert.equal(result.errors.length, index === 0 ? 1 : 2);
    const headline = index === 0 ? 'TimeoutError: locator.click:' : 'TargetClosedError: locator.click:';
    const locatedErrors = result.errors.filter(error => error.location);
    assert.equal(locatedErrors.length, 1);
    const error = locatedErrors[0];
    assert.deepEqual(error.location, expectedLocation);
    assert.ok(withoutColors(error.message).startsWith(headline));
    assert.ok(error.message.includes('last observation: locator resolved to no elements'));
    assert.ok(error.message.includes(`${helperPath}:${line}:${column}`), 'Serialized stack retains the original helper');
    verifySourceFrame(error.message, sourceLine, line, column);
    if (index === 0) {
      assert.deepEqual(result.error.location, expectedLocation);
      verifySourceFrame(result.error.snippet, sourceLine, line, column);
      assert.ok(result.error.message.startsWith(headline));
      assert.match(result.error.message, /operation (?:exceeded its deadline|deadline exceeded)/);
      assert.ok(result.error.stack.includes(`${helperPath}:${line}:${column}`));
    } else {
      assert.equal(withoutColors(result.errors[0].message), `Test timeout of ${test.timeout}ms exceeded.`);
      assert.equal(result.errors[0].location, undefined, 'Keep the primary test timeout distinct from the secondary target closure');
    }
    const documents = result.attachments.filter(attachment => attachment.name === 'error-context');
    assert.equal(documents.length, 1);
    assert.equal(documents[0].contentType, 'text/markdown');
    const documentPath = resolve(documents[0].path);
    const documentRelativePath = relative(await realpath(testOutputDirectory), await realpath(documentPath));
    assert.ok(documentRelativePath && !documentRelativePath.startsWith('..') && !documentRelativePath.startsWith('/'));
    const document = await readFile(documentPath, 'utf8');
    verifySourceFrame(document, sourceLine, line, column);
    assert.ok(document.includes(headline));
    if (index === 1) assert.ok(document.includes(`Test timeout of ${test.timeout}ms exceeded.`));
    assert.ok(document.includes('button "Existing"'), 'Retain the real page snapshot');
    assert.ok(!document.includes('errors.js') && !document.includes('errors.ts'), 'The document must frame the user helper');
    cases.push({ title: specification.title, status: result.status, retry: result.retry,
      location: expectedLocation, documentPath, documentSha256: hash(document) });
  }
  return cases;
}

/** Generated runtime files are excluded by sourceManifest, so freeze them separately. */
async function builtRuntimeManifest() {
  const manifest = {};
  async function visit(path) {
    if ((await stat(path)).isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else manifest[relative(projectDirectory, path)] = hash(await readFile(path));
  }
  for (const name of ['flashwright-core', 'flashwright-runner', 'flashwright-test']) {
    await visit(join(projectDirectory, 'packages', name, 'dist'));
  }
  return manifest;
}

async function executableIdentity(path) {
  return { path: resolve(path), realPath: await realpath(path), sha256: hash(await readFile(path)) };
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

async function runRunner(command, environment, destination) {
  const stdout = await open(join(destination, 'runner.stdout'), 'wx');
  const stderr = await open(join(destination, 'runner.stderr'), 'wx');
  try {
    const child = spawn(command[0], command.slice(1), {
      cwd: projectDirectory, env: environment, stdio: ['ignore', stdout.fd, stderr.fd],
    });
    return await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => accept({ exitCode, signal }));
    });
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
}

async function main() {
  if (process.argv[2] === '--help') {
    console.log('Usage: FLASHWRIGHT_BROWSER_PATH=<browser> FLASHWRIGHT_DRIVER_PATH=<driver> <runtime> tools/test-native-error-attribution.mjs <fresh-output-directory>');
    return;
  }
  assert.equal(process.argv.length, 3, 'Pass one fresh output directory');
  assert.equal(await realpath(process.cwd()), await realpath(projectDirectory), 'Run from this tool’s checkout so source identities describe the executed checkout');
  const destination = resolve(process.argv[2]);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  const report = { status: 'running', ...runtimeMetadata, destination,
    scope: 'Actual development CLI, transformed typed helper, native operation deadline and test deadline with secondary TargetClosedError. Diagnostic correctness and supervisor cleanup only; no performance or release admission.',
    performanceAdmission: false, cases: [] };
  let inputPaths;
  try {
    assert.ok(process.env.FLASHWRIGHT_BROWSER_PATH, 'Set FLASHWRIGHT_BROWSER_PATH');
    assert.ok(process.env.FLASHWRIGHT_DRIVER_PATH, 'Set FLASHWRIGHT_DRIVER_PATH');
    const browserPath = resolve(process.env.FLASHWRIGHT_BROWSER_PATH);
    const driverPath = resolve(process.env.FLASHWRIGHT_DRIVER_PATH);
    const pythonPath = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 10_000 }).trim();
    report.browser = await identifyBrowser(browserPath);
    const fixtureDirectory = join(destination, 'fixture');
    await mkdir(fixtureDirectory);
    const facadePath = join(projectDirectory, 'packages/flashwright-test/dist/commonjs/index.js');
    const helperPath = join(fixtureDirectory, 'caller-helper.ts');
    const specificationPath = join(fixtureDirectory, 'caller.spec.ts');
    const configurationPath = join(destination, 'runner.config.mjs');
    const runnerReportPath = join(destination, 'runner-report.json');
    const testOutputDirectory = join(destination, 'test-output');
    // An absolute development import reproduces checkout frames; a node_modules alias would mask them.
    await writeFile(helperPath, `import type { Page } from ${JSON.stringify(facadePath)};
type ProbeLabel = string;

export async function failFromHelper(page: Page, timeout: number): Promise<void> {
  const label: ProbeLabel = 'missing helper button';
  await page.getByRole('button', { name: label }).click({ timeout });
}
`, { flag: 'wx' });
    await writeFile(specificationPath, `import { test } from ${JSON.stringify(facadePath)};
import { failFromHelper } from './caller-helper';

test(${JSON.stringify(nativeTitle)}, async ({ page }) => {
  await page.evaluate(() => { document.body.innerHTML = '<button>Existing</button>'; });
  await failFromHelper(page, 100);
});

test(${JSON.stringify(deadlineTitle)}, async ({ page }) => {
  await page.evaluate(() => { document.body.innerHTML = '<button>Existing</button>'; });
  // Worker uptime bounds time already charged to this test, including fixture startup.
  test.setTimeout(Math.ceil(process.uptime() * 1000) + ${pendingTimeoutMilliseconds});
  await failFromHelper(page, 0);
});
`, { flag: 'wx' });
    const configuration = { testDir: fixtureDirectory, testMatch: '**/caller.spec.ts', workers: 1,
      retries: 0, repeatEach: 1, timeout: startupTimeoutMilliseconds, outputDir: testOutputDirectory,
      reporter: [['json', { outputFile: runnerReportPath }]],
      use: { trace: 'off', video: 'off', screenshot: 'off', headless: true,
        launchOptions: { executablePath: browserPath } } };
    await writeFile(configurationPath, `import { defineConfig } from ${JSON.stringify(facadePath)};\nexport default defineConfig(${JSON.stringify(configuration, null, 2)});\n`, { flag: 'wx' });
    inputPaths = { runtime: process.execPath, python: pythonPath, browser: browserPath, driver: driverPath,
      helper: helperPath, specification: specificationPath, configuration: configurationPath };
    async function captureInputs() {
      const executables = {};
      for (const name of ['runtime', 'python', 'browser', 'driver']) executables[name] = await executableIdentity(inputPaths[name]);
      const fixtures = {};
      for (const name of ['helper', 'specification', 'configuration']) fixtures[inputPaths[name]] = hash(await readFile(inputPaths[name]));
      return { sources: await sourceManifest(), builtRuntime: await builtRuntimeManifest(), executables, fixtures };
    }
    report.inputsBefore = await captureInputs();
    report.command = [pythonPath, join(projectDirectory, 'tools/watchdog.py'), '--timeout', String(watchdogTimeoutSeconds),
      '--report', join(destination, 'resources.json'), '--', process.execPath,
      join(projectDirectory, 'packages/flashwright-test/cli.cjs'), 'test', '--config', configurationPath];
    await writeJson(join(destination, 'inputs.json'), { ...runtimeMetadata, browser: report.browser,
      command: report.command, inputs: report.inputsBefore });
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(FLASHWRIGHT_|PW_|PLAYWRIGHT_)/.test(name) && !['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'DEBUG', 'FORCE_COLOR'].includes(name)));
    Object.assign(environment, { FLASHWRIGHT_BROWSER_PATH: browserPath, FLASHWRIGHT_DRIVER_PATH: driverPath,
      PLAYWRIGHT_FORCE_TTY: '0', NO_COLOR: '1' });
    try {
      report.runner = await runRunner(report.command, environment, destination);
      assert.deepEqual(report.runner, { exitCode: 1, signal: null }, 'The two intentionally failing tests must produce runner exit 1');
      const resources = JSON.parse(await readFile(join(destination, 'resources.json'), 'utf8'));
      const watchdogDelimiter = report.command.indexOf('--');
      assert.ok(watchdogDelimiter >= 0);
      assert.deepEqual(resources.command, report.command.slice(watchdogDelimiter + 1), 'The resource report must describe this original runner command');
      assert.ok(Number.isInteger(resources.ownerLaunch?.process) && resources.ownerLaunch.process > 0, 'Retain a positive integer original runner PID');
      report.ownerProcess = resources.ownerLaunch.process;
      assert.equal(resources.exitCode, 1);
      assert.equal(resources.timedOut, false);
      assert.equal(resources.interrupted, false);
      assert.deepEqual(resources.cleanupSignals, []);
      assert.deepEqual(resources.remainingObservedProcesses, []);
      report.cases = await verifyRunnerReport(JSON.parse(await readFile(runnerReportPath, 'utf8')), helperPath, testOutputDirectory);
    } catch (error) {
      report.runnerFailure = { name: error.name, message: error.message, stack: error.stack };
      throw error;
    } finally {
      report.inputsAfter = await captureInputs();
      report.inputsUnchanged = JSON.stringify(report.inputsAfter) === JSON.stringify(report.inputsBefore);
      assert.deepEqual(report.inputsAfter, report.inputsBefore, 'Sources, built runtime, executables and generated fixtures must remain unchanged');
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { name: error.name, message: error.message, stack: error.stack };
    process.exitCode = 1;
  } finally {
    report.retainedArtifacts = {};
    for (const name of ['runner.stdout', 'runner.stderr', 'runner-report.json', 'resources.json']) {
      try { report.retainedArtifacts[name] = hash(await readFile(join(destination, name))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await writeJson(join(destination, 'report.json'), report);
    console.log(JSON.stringify({ status: report.status, ...runtimeMetadata, cases: report.cases.length,
      report: join(destination, 'report.json'), ...(report.error ? { error: report.error.message } : {}) }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
