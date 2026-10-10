import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sourceManifest } from './source-manifest.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';

const destination = resolve(process.argv[2] ?? '.cache/downloads');
await mkdir(destination, { recursive: true });
const sources = await sourceManifest();
const report = { schemaVersion: 1, status: 'running', ...runtimeMetadata, sources, runs: [], scope: 'Thirteen shared Download outcomes and one separately asserted stream-close reference difference per engine/mode. Traces finalize before context closure; context-close-active remains untraced in both modes. No performance claim.' };
try {
  for (const engine of ['playwright', 'flashwright']) {
    for (const traced of [false, true]) {
      const name = `${engine}-${traced ? 'trace' : 'plain'}`;
      const output = join(destination, name);
      let stdout = '', stderr = '';
      const child = spawn(process.execPath, ['compatibility/m2/downloads.mjs', output, engine, ...(traced ? ['--trace'] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
      await writeFile(join(destination, `${name}.stdout`), stdout);
      await writeFile(join(destination, `${name}.stderr`), stderr);
      const bytes = await readFile(join(output, 'report.json'));
      const result = JSON.parse(bytes);
      report.runs.push({ name, exitCode, report: join(name, 'report.json'), sha256: createHash('sha256').update(bytes).digest('hex'), checks: result.checks });
      await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      assert.equal(exitCode, 0, `${name}: ${stderr}`);
      assert.equal(result.status, 'passed', name);
      assert.equal(result.checks.length, 14);
      assert.equal(result.checks.filter(check => check.classification === 'shared-outcome').length, 13);
    }
  }
  assert.deepEqual(await sourceManifest(), sources, 'Source changed during Download verification');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, runs: report.runs.length }));
}
