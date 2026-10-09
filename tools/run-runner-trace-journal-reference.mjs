import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { utils, iso } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const destination = resolve(process.argv[2] ?? `compatibility/evidence/runner-journal-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputPaths = [
  'runner-trace-journal', 'runner-trace-record', 'trace-resources', 'trace-archive', 'errors',
].flatMap(name => [`packages/flashwright-core/src/${name}.ts`, `packages/flashwright-core/dist/commonjs/${name}.js`]);
inputPaths.push('tools/run-runner-trace-journal-reference.mjs', 'tools/javascript-runtime.mjs', 'tools/watchdog.py', 'compatibility/m2/runner-trace-journal/journal.spec.cjs', 'compatibility/m2/runner-trace-journal/playwright.config.cjs', 'node_modules/playwright/lib/worker/workerProcessEntry.js', 'node_modules/playwright-core/lib/coreBundle.js');
const inputs = async () => Object.fromEntries(await Promise.all(inputPaths.map(async path => [path, hash(await readFile(path))])));
const report = { status: 'running', ...runtimeMetadata, inputs: await inputs(), comparisons: [], scope: 'Same-attempt normalized-record journal comparison with the actual pinned runner, including final hook and fixture boundary. The reference still owns its original arrays and conversions in this observer fixture. No automatic candidate policy, adapter admission or aggregate native capture claim.' };
const archives = [];
async function zipContents(path) {
  const archive = new utils.ZipFile(path);
  try {
    const names = await archive.entries();
    return Object.fromEntries(await Promise.all(names.map(async name => [name, await archive.read(name)])));
  } finally { archive.close(); }
}
try {
  for (const name of ['journal.spec.cjs', 'playwright.config.cjs']) await writeFile(join(destination, name), await readFile(`compatibility/m2/runner-trace-journal/${name}`));
  const output = join(destination, 'output');
  const child = spawn('python3', ['tools/watchdog.py', '--timeout', '90', '--report-directory', join(destination, 'watchdog'), '--', process.execPath, 'node_modules/playwright/cli.js', 'test', '--config', join(destination, 'playwright.config.cjs')], {
    stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_JOURNAL_OUTPUT: output, FLASHWRIGHT_JOURNAL_RESULTS: join(destination, 'results.json'), FLASHWRIGHT_JOURNAL_MODULE: resolve('packages/flashwright-core/dist/commonjs/runner-trace-journal.js') },
  });
  const code = await new Promise((complete, reject) => { child.on('error', reject); child.on('close', complete); });
  report.exitCode = code;
  assert.equal(code, 0, 'pinned runner fixture must preserve all expected outcomes');
  const results = JSON.parse(await readFile(join(destination, 'results.json'), 'utf8'));
  report.stats = results.stats;
  assert.equal(results.stats.expected, 8); assert.equal(results.stats.unexpected + results.stats.flaky + results.stats.skipped, 0);
  for (const path of (await readdir(output, { recursive: true })).filter(path => path.endsWith('comparison.json')).sort()) {
    const comparison = JSON.parse(await readFile(join(output, path), 'utf8'));
    const reference = await zipContents(comparison.reference); const candidate = await zipContents(comparison.journal);
    assert.deepEqual(Object.keys(candidate).sort(), Object.keys(reference).sort(), `${path}: exact entry names`);
    let resourceBytes = 0;
    for (const name of Object.keys(reference)) {
      if (name === 'test.trace') continue;
      assert.deepEqual(candidate[name], reference[name], `${path}: exact original resource ${name}`);
      resourceBytes += candidate[name].length;
    }
    const records = bytes => bytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
    const referenceRecords = records(reference['test.trace']); const candidateRecords = records(candidate['test.trace']);
    assert.deepEqual(candidateRecords, referenceRecords, `${path}: every runner record must match`);
    // A timeout assigned inside fixture teardown belongs to that slot, not the test timeout.
    assert.equal(candidateRecords[0].testTimeout, comparison.title.startsWith('mutation') ? 8888 : 10000);
    const loader = new iso.TraceLoader();
    await loader.load({ entryNames: async () => Object.keys(candidate), readText: async name => candidate[name]?.toString(), hasEntry: async name => Object.hasOwn(candidate, name), isLive: () => false });
    assert.equal(loader.contextEntries.length, 1);
    report.comparisons.push({ path, title: comparison.title, status: comparison.status, options: comparison.options, records: candidateRecords.length, resources: Object.keys(candidate).length - 1, resourceBytes, referenceSha256: hash(await readFile(comparison.reference)), journalSha256: hash(await readFile(comparison.journal)) });
    archives.push(comparison.reference, comparison.journal);
  }
  assert.equal(report.comparisons.length, 8);
  execFileSync('python3', ['-c', 'import sys,zipfile\nfor path in sys.argv[1:]:\n with zipfile.ZipFile(path) as archive: assert archive.testzip() is None, path', ...archives]);
  assert.deepEqual(await inputs(), report.inputs);
  report.status = 'passed'; report.archiveCount = archives.length;
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally { await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`Runner journal comparison: ${destination}/report.json`); }
