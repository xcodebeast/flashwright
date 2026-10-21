import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { failure } from '@flashwright/core';
import { resolveIndependentConfig, discoverIndependentTests } from './config.js';
import { runProcessSuite } from './process-runner.js';
import { registerIndependentLoader } from './loader.js';

export async function runIndependentCLI(args: string[]): Promise<number> {
  registerIndependentLoader();
  let configFile: string | undefined, reporter: string | undefined;
  const overrides: { workers?: number; retries?: number; grep?: string; files: string[] } = { files: [] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) { overrides.files.push(argument); continue; }
    const separator = argument.indexOf('=');
    const [flag, inline] = separator === -1 ? [argument, undefined] : [argument.slice(0, separator), argument.slice(separator + 1)];
    if (!['--config','-c','--workers','-j','--retries','--grep','-g','--reporter'].includes(flag!)) throw failure('UnsupportedFeatureError', `independent.${flag}`, 'unsupported independent runner CLI option');
    const value = inline ?? args[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--config' || flag === '-c') configFile = resolve(value);
    else if (flag === '--workers' || flag === '-j') overrides.workers = Number(value);
    else if (flag === '--retries') overrides.retries = Number(value);
    else if (flag === '--grep' || flag === '-g') overrides.grep = value;
    else reporter = value;
  }
  configFile ??= ['playwright.config.ts','playwright.config.js','playwright.config.mts','playwright.config.mjs','playwright.config.cts','playwright.config.cjs'].map(name => resolve(name)).find(existsSync);
  if (!configFile) throw new Error('No configuration found; pass --config <file>');
  const imported = require(configFile) as { default?: unknown };
  const value = imported.default ?? imported;
  const config = resolveIndependentConfig(reporter === undefined ? value : { ...value as object, reporter }, configFile, overrides);
  if (!(await discoverIndependentTests(config)).length) throw new Error('No matching test files');
  const outputDir = join(config.outputDir, 'run-' + randomUUID());
  await mkdir(outputDir, { recursive: true });
  const result = await runProcessSuite({
    modulePath: join(__dirname, 'entry-worker.js'), workers: config.workers, retries: config.retries, timeoutMs: config.timeout,
    env: { FLASHWRIGHT_INDEPENDENT_RUN: JSON.stringify({ configFile, outputDir, overrides }) },
  });
  const attempts = await Promise.all(result.results.map(async outcome => {
    const path = join(outputDir, createHash('sha256').update(outcome.id).digest('hex').slice(0, 20) + '-retry' + outcome.retry, 'attempt.json');
    let artifact: Record<string, unknown> = {};
    try { artifact = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (Object.keys(artifact).length && (artifact.id !== outcome.id || artifact.retry !== outcome.retry)) throw new Error('Attempt output identity mismatch');
    return { ...outcome, attachments: artifact.attachments ?? [], steps: artifact.steps ?? [], attachmentErrors: artifact.attachmentErrors ?? [] };
  }));
  const report = { schemaVersion: 1, runner: 'flashwright-independent', outputDir, ...result, results: attempts };
  await writeFile(join(outputDir, 'run.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  for (const selected of config.reporter) {
    if (selected.name === 'json') {
      const serialized = JSON.stringify(report, null, 2) + '\n';
      if (selected.options.outputFile) { await mkdir(dirname(selected.options.outputFile), { recursive: true }); await writeFile(selected.options.outputFile, serialized); }
      else process.stdout.write(serialized);
    } else {
      for (const attempt of result.results) process.stdout.write(`${attempt.status} ${JSON.parse(attempt.id).slice(1).join(' › ')}${attempt.retry ? ` (retry ${attempt.retry})` : ''}\n`);
      for (const error of [...result.workerErrors, ...result.results.flatMap(r => r.errors)]) process.stderr.write((error.stack || error.message) + '\n');
      process.stdout.write(`${result.status}: ${result.plan?.tests.length ?? 0} tests, ${result.results.length} attempts\nResults: ${join(outputDir, 'run.json')}\n`);
    }
  }
  return result.status === 'passed' && result.results.length ? 0 : 1;
}
