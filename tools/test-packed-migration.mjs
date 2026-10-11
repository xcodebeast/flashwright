import { installPackedConsumer, cleanupPackedConsumer } from './install-packed-consumer.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { tmpdir } from 'node:os';
import { packConsumerPackages } from './packed-artifacts.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const project = process.argv[2] ?? 'todomvc';
assert.ok(['todomvc', 'svgomg'].includes(project), 'Migration project must be todomvc or svgomg');
const expectedTests = project === 'todomvc' ? 3 : 6;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = await mkdtemp(join(tmpdir(), 'flashwright-packed-migration-'));
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const provenance = JSON.parse(await readFile('compatibility/migration-projects/provenance.json', 'utf8'));
const retainedSources = provenance.sources.filter(source => source.path.startsWith(`compatibility/migration-projects/${project}/`));
assert.equal(retainedSources.length, project === 'todomvc' ? 4 : 1);

const { archives, dependencies } = await packConsumerPackages(directory, { runner: true });
await writeFile(join(directory, 'package.json'), JSON.stringify({
  name: 'flashwright-packed-migration-consumer', private: true, type: 'module',
  dependencies: { ...dependencies, '@playwright/test': '1.60.0', '@types/node': '24.10.1' },
}, null, 2));
const installation = await installPackedConsumer(directory, Object.values(archives));

const sourceEvidence = [];
for (const source of retainedSources) {
  const original = await readFile(source.path, 'utf8');
  assert.equal(hash(original), source.sha256, `Preserved upstream source changed: ${source.path}`);
  const migrated = original.replaceAll("'@playwright/test'", "'@flashwright/test'");
  assert.equal(migrated.replaceAll("'@flashwright/test'", "'@playwright/test'"), original);
  const sourcePath = relative(`compatibility/migration-projects/${project}`, source.path);
  for (const [engine, contents] of [['reference', original], ['flashwright', migrated]]) {
    const destination = join(directory, engine, sourcePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  sourceEvidence.push({ path: source.path, originalSha256: hash(original), migratedSha256: hash(migrated), changes: original === migrated ? [] : ['package import specifiers only'] });
}

await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  include: ['reference/**/*.ts', 'flashwright/**/*.ts'],
}, null, 2));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.json'], { cwd: directory, stdio: 'inherit' });

// Config loading installs the backend guard in the CLI and each worker after owned bootstrap.
await writeFile(join(directory, 'poison.cjs'), `
const { appendFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const upstream = require(join(dirname(require.resolve('@flashwright/runner/package.json')), 'dist/upstream/test.js'));
for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
  for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) browser[method] = async () => { throw new Error('Forbidden upstream browser backend entered'); };
}
upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };
appendFileSync(process.env.FLASHWRIGHT_MIGRATION_POISON_LOG, JSON.stringify({ process: process.pid, arguments: process.argv }) + '\\n');
`);

for (const engine of ['reference', 'flashwright']) {
  const packageName = engine === 'reference' ? '@playwright/test' : '@flashwright/test';
  await writeFile(join(directory, `${engine}.config.mjs`), `
${engine === 'flashwright' ? "import './poison.cjs';" : ''}
import { defineConfig } from '${packageName}';
export default defineConfig({ testDir: './${engine}/tests', workers: 1, timeout: 30000, expect: { timeout: 5000 },
 use: { launchOptions: { executablePath: ${JSON.stringify(browserPath)} }, trace: 'off', video: 'off', screenshot: 'off' },
 outputDir: './${engine}-results', reporter: [['list'], ['json', { outputFile: '${engine}-report.json' }]] });
`);
}

/** Record the public demo's contents without rewriting the preserved fixture's URL. */
async function applicationIdentity() {
  const assets = {};
  const paths = project === 'todomvc'
    ? ['', 'base.css', 'index.css', 'js/director.js', 'js/bundle.js']
    : ['', 'js/page.js', 'js/svgo-worker.js', 'js/gzip-worker.js', 'js/prism-worker.js', 'test-svgs/car-lite.svg', 'changelog.json'];
  for (const path of paths) {
    const url = `https://demo.playwright.dev/${project}/${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, `Cannot identify migration application: ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assets[url] = { sha256: hash(bytes), bytes: bytes.length };
  }
  return assets;
}

function testResults(report) {
  const tests = [];
  function visit(suite, parents) {
    const titles = [...parents, suite.title];
    for (const specification of suite.specs ?? []) {
      for (const test of specification.tests) {
        tests.push({ title: [...titles, specification.title].filter(Boolean).join(' > '), status: test.status, attempts: test.results.map(result => result.status) });
      }
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  for (const suite of report.suites) visit(suite, []);
  return tests;
}

const poisonLog = join(directory, 'poison-log.jsonl');
const evidence = {
  installation, ...runtimeMetadata, platform: process.platform, architecture: process.arch, consumerDirectory: directory,
  browserPath, browserExecutableSha256: hash(await readFile(browserPath)), driverSha256: hash(await readFile(driverPath)),
  sources: sourceEvidence,
  archives: Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, archive]) => [name, { archive, sha256: hash(await readFile(archive)) }]))),
  runs: {}, status: 'running',
  project,
  scope: `Import/config-only migration of ${expectedTests} preserved upstream ${project} tests through freshly packed packages. External public demo application; functional evidence, not a matched performance comparison. Application identities cover listed same-origin code/data assets, not third-party analytics or all optional resources.`,
  remaining: ['offline application reproduction', 'complete preview and replacement capability gates'],
};
const destination = process.argv[3] ?? `compatibility/evidence/migration-${project}-${process.platform}-${process.arch}-${runtimeArtifactLabel}.json`;
await mkdir(dirname(destination), { recursive: true });
try {
  evidence.applicationBefore = await applicationIdentity();
  for (const engine of ['reference', 'flashwright']) {
    const environment = { ...process.env, FLASHWRIGHT_DRIVER_PATH: driverPath, FLASHWRIGHT_BROWSER_PATH: browserPath };
    if (engine === 'flashwright') {
      environment.FLASHWRIGHT_MIGRATION_POISON_LOG = poisonLog;
    }
    const executable = engine === 'reference' ? 'playwright' : 'flashwright';
    const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '120', '--', process.execPath, `node_modules/.bin/${executable}`, 'test', '--config', `${engine}.config.mjs`], { cwd: directory, env: environment, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const report = JSON.parse(await readFile(join(directory, `${engine}-report.json`), 'utf8'));
    evidence.runs[engine] = { code, report, tests: testResults(report) };
    assert.equal(code, 0, `${engine} migration run failed`);
    assert.equal(report.stats.expected, expectedTests);
    assert.equal(report.stats.unexpected, 0);
    assert.equal(report.stats.flaky, 0);
    assert.equal(report.stats.skipped, 0);
    assert.equal(report.errors.length, 0);
  }
  assert.deepEqual(evidence.runs.flashwright.tests, evidence.runs.reference.tests);
  evidence.poisonedProcesses = (await readFile(poisonLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(new Set(evidence.poisonedProcesses.map(entry => entry.process)).size >= 2, 'Upstream backend poison must run in both CLI and worker');
  evidence.applicationAfter = await applicationIdentity();
  assert.deepEqual(evidence.applicationAfter, evidence.applicationBefore, 'Public application changed during migration verification');
  evidence.status = 'passed';
  console.log(`Preserved ${project} migration passed: ${destination}`);
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n');
}

await cleanupPackedConsumer(directory, installation, destination, import.meta.url);
