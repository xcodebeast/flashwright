import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { utils } = require('playwright-core/lib/coreBundle');
const input = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
await mkdir(destination, { recursive: true });
const reportBytes = await readFile(join(input, 'report.json'));
const original = JSON.parse(reportBytes);
assert.equal(original.status, 'passed');
assert(original.publicRunner && original.publicFixtures);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const results = JSON.parse(await readFile(join(input, 'results.json'), 'utf8'));
const specs = suites => suites.flatMap(suite => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]);
const stock = specs(results.suites).filter(spec => spec.title === 'stock page fixture captures assertions and attachments').flatMap(spec => spec.tests);
assert.equal(stock.length, 3);
const report = { status: 'running', sourceReportSha256: hash(reportBytes), browser: original.browser, cases: [] };
try {
  for (const test of stock) {
    const attempt = test.results[0];
    const originalTrace = attempt.attachments.find(attachment => attachment.name === 'trace').path;
    const trace = join(destination, `${test.projectName}.zip`);
    await writeFile(trace, await readFile(originalTrace));
    const archive = new utils.ZipFile(trace);
    try {
      const records = (await archive.read('0-trace.trace')).toString().trim().split('\n').map(JSON.parse);
      const action = records.find(event => event.type === 'before' && event.method === 'evaluateExpression');
      assert(action);
      const caller = action.stack[0];
      const sourceName = `resources/src@${createHash('sha1').update(caller.file).digest('hex')}.txt`;
      const sourceText = (await archive.read(sourceName)).toString();
      assert(sourceText.includes('stock fixture parent'));
      report.cases.push({ label: test.projectName, trace, traceSha256: hash(await readFile(trace)), sourcePath: caller.file, sourceText, callerLine: caller.line, parentTitle: 'stock fixture parent' });
    } finally { archive.close(); }
  }
  assert.equal(report.cases.length, 3);
  // Reuse the actual pinned viewer check, including blocked workstation source fallback.
  const viewerInput = join(destination, 'viewer-input.json');
  await writeFile(viewerInput, JSON.stringify({ ...report, status: 'passed' }, null, 2));
  const child = spawn(process.execPath, ['tools/test-trace-source-viewer.mjs', viewerInput], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
  const exitCode = await new Promise((complete, reject) => { child.on('error', reject); child.on('close', complete); });
  await writeFile(join(destination, 'viewer.log'), output);
  assert.equal(exitCode, 0, output);
  const path = output.match(/Trace source viewer evidence: (.+\/report.json)/)?.[1];
  assert(path);
  const viewer = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(viewer.status, 'passed');
  assert.equal(viewer.cases.length, 3);
  report.viewerReport = path;
  report.viewerReportSha256 = hash(await readFile(path));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error }));
}
