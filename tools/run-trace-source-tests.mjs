import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { installPackedConsumer } from './install-packed-consumer.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { utils, iso } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const alias = path => `resources/src@${createHash('sha1').update(path).digest('hex')}.txt`;
const destination = resolve(`compatibility/evidence/trace-sources-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(browserPath), driverSha256: hash(await readFile(driverPath)), cases: [] };
const environment = { ...process.env, FLASHWRIGHT_BROWSER_PATH: browserPath, FLASHWRIGHT_DRIVER_PATH: driverPath };
async function run(arguments_, cwd, logPath, additions = {}) {
  const log = createWriteStream(logPath);
  const child = spawn(process.execPath, arguments_, { cwd, env: { ...environment, ...additions }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => log.write(bytes)); child.stderr.on('data', bytes => log.write(bytes));
  try { assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }), 0, `source capture command: ${arguments_.join(' ')}`); }
  finally { await new Promise(resolve => log.end(resolve)); }
}
async function inspect(path, sourcePath, expectedSource, expectedLine, label) {
  const archive = new utils.ZipFile(path);
  try {
    const names = await archive.entries();
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
    const actions = loader.contextEntries.flatMap(context => context.actions).filter(action => action.method === 'evaluateExpression');
    assert.equal(actions.length, 1);
    assert.ok(actions[0].stack.some(frame => frame.file === sourcePath && frame.line === expectedLine), `${label}: actual mapped caller line`);
    if (expectedSource === undefined) assert.equal(names.includes(alias(sourcePath)), false, `${label}: deleted caller file not reused`);
    else assert.equal((await archive.read(alias(sourcePath))).toString(), expectedSource, `${label}: exact source bytes at export`);
    const case_ = { label, trace: path, traceSha256: hash(await readFile(path)), sourcePath, sourceAlias: alias(sourcePath), sourceSha256: expectedSource === undefined ? null : hash(expectedSource), sourceText: expectedSource ?? null, callerLine: expectedLine };
    report.cases.push(case_);
  } finally { archive.close(); }
}
try {
  const consumer = await mkdtemp(join(tmpdir(), 'flashwright-packed-source-'));
  const { archives, dependencies } = await packConsumerPackages(consumer, { runner: true });
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'flashwright-source-consumer', private: true, type: 'module', dependencies: { ...dependencies, '@types/node': '24.10.1' } }, null, 2));
  report.installation = await installPackedConsumer(consumer, Object.values(archives));
  report.archives = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, { path, sha256: hash(await readFile(path)) }])));
  const standaloneSource = await readFile('compatibility/m2/trace-sources/standalone.ts', 'utf8');
  const standaloneLine = standaloneSource.split('\n').findIndex(line => line.includes('const value: number = await page.evaluate')) + 1;
  for (const engine of ['playwright', 'flashwright']) {
    const output = join(destination, `standalone-${engine}`); await mkdir(output);
    const sourceFile = join(consumer, `standalone-${engine}.ts`); await writeFile(sourceFile, standaloneSource);
    const sourcePath = await realpath(sourceFile);
    await writeFile(join(output, 'original-source.txt'), standaloneSource);
    const library = engine === 'playwright' ? import.meta.resolve('playwright') : 'flashwright';
    await run([sourcePath], consumer, join(output, 'process.log'), { FLASHWRIGHT_SOURCE_LIBRARY: library, FLASHWRIGHT_SOURCE_OUTPUT: output });
    for (const version of ['original', 'changed', 'missing']) {
      const expected = version === 'missing' ? undefined : standaloneSource + (version === 'changed' ? '\n// changed source at export\n' : '');
      await inspect(join(output, `${version}.zip`), sourcePath, expected, standaloneLine, `standalone-${engine}-${version}`);
    }
  }
  const runnerSource = await readFile('compatibility/m2/trace-sources/sources.spec.ts', 'utf8');
  const runnerLine = runnerSource.split('\n').findIndex(line => line.includes('const value = await page.evaluate')) + 1;
  for (const name of ['sources-esm.spec.ts', 'sources-commonjs.spec.cts']) await writeFile(join(consumer, name), runnerSource);
  await copyFile('compatibility/m2/trace-sources/playwright.config.ts', join(consumer, 'playwright.config.ts'));
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'sources-esm.spec.ts', 'sources-commonjs.spec.cts', 'playwright.config.ts'], { cwd: consumer, stdio: 'inherit' });
  const packedOutput = join(destination, 'packed'); await mkdir(packedOutput);
  const resultPath = join(packedOutput, 'results.json');
  await run(['node_modules/.bin/flashwright', 'test', '--config', 'playwright.config.ts'], consumer, join(packedOutput, 'process.log'), { FLASHWRIGHT_SOURCE_OUTPUT: join(packedOutput, 'output'), FLASHWRIGHT_SOURCE_REPORT: resultPath });
  const results = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(results.stats.expected, 2); assert.equal(results.stats.unexpected + results.stats.flaky + results.stats.skipped, 0); assert.deepEqual(results.errors, []);
  function specifications(suites) { return suites.flatMap(suite => [...suite.specs, ...specifications(suite.suites ?? [])]); }
  for (const specification of specifications(results.suites)) {
    const sourcePath = await realpath(join(consumer, specification.file));
    const attachments = specification.tests[0].results[0].attachments;
    const trace = attachments.find(attachment => attachment.name === 'manual sources'); assert.ok(trace);
    await inspect(trace.path, sourcePath, runnerSource, runnerLine, `packed-${specification.file}`);
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Trace source evidence: ${destination}/report.json`); }
