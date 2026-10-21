import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { failure } from '@flashwright/core';
import { resolveIndependentConfig, resolveIndependentProjects, discoverIndependentTests, type IndependentProjectsOverrides } from './config.js';
import { runProcessSuite, type ProcessSuiteResult } from './process-runner.js';
import { registerIndependentLoader } from './loader.js';

export async function runIndependentCLI(args: string[]): Promise<number> {
  registerIndependentLoader();
  let configFile: string | undefined, reporter: string | undefined;
  const overrides: IndependentProjectsOverrides = { files: [] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) { overrides.files!.push(argument); continue; }
    const separator = argument.indexOf('=');
    const [flag, inline] = separator === -1 ? [argument, undefined] : [argument.slice(0, separator), argument.slice(separator + 1)];
    if (!['--config','-c','--workers','-j','--retries','--grep','-g','--reporter','--project'].includes(flag!)) throw failure('UnsupportedFeatureError', `independent.${flag}`, 'unsupported independent runner CLI option');
    const value = inline ?? args[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--config' || flag === '-c') configFile = resolve(value);
    else if (flag === '--workers' || flag === '-j') overrides.workers = Number(value);
    else if (flag === '--retries') overrides.retries = Number(value);
    else if (flag === '--grep' || flag === '-g') overrides.grep = value;
    else if (flag === '--project') (overrides.project ??= []).push(value);
    else reporter = value;
  }
  configFile ??= ['playwright.config.ts','playwright.config.js','playwright.config.mts','playwright.config.mjs','playwright.config.cts','playwright.config.cjs'].map(name => resolve(name)).find(existsSync);
  if (!configFile) throw new Error('No configuration found; pass --config <file>');
  const imported = require(configFile) as { default?: unknown };
  const value = imported.default ?? imported;
  let projects = resolveIndependentProjects(value, configFile, overrides);
  const rootValue = { ...value as Record<string, unknown> };
  delete rootValue.projects;
  if (reporter !== undefined) rootValue.reporter = reporter;
  const { project: _selection, ...rootOverrides } = overrides;
  const config = resolveIndependentConfig(rootValue, configFile, rootOverrides);
  if (!(await Promise.all(projects.map(project => discoverIndependentTests(project.config)))).some(files => files.length)) throw new Error('No matching test files');
  const runName = 'run-' + randomUUID();
  const outputDir = join(config.outputDir, runName);
  await mkdir(outputDir, { recursive: true });
  const result: ProcessSuiteResult = { status: 'passed', plan: { tests: [], groups: [] }, results: [], workerErrors: [], workers: [] };
  const projectResults: { name: string; status: 'passed' | 'failed' | 'skipped'; blockedBy: string[]; outputDir?: string; tests: number; metadata?: Record<string, unknown> }[] = [];
  const attempts: Record<string, unknown>[] = [];
  let executionOverrides = overrides;
  if (overrides.grep !== undefined || overrides.files?.length) {
    const selected = overrides.project?.length ? new Set(overrides.project) : new Set(projects.map(project => project.name));
    const active: string[] = [];
    for (const project of projects.filter(project => selected.has(project.name))) {
      const collection = await runProcessSuite({
        modulePath: join(__dirname, 'entry-worker.js'), workers: 1, collectOnly: true, workerIndexBase: result.workers.length,
        env: { FLASHWRIGHT_INDEPENDENT_RUN: JSON.stringify({ configFile, outputDir, projectName: project.name, overrides: { ...overrides, project: project.name ? [project.name] : undefined } }) },
      });
      result.workers.push(...collection.workers);
      result.workerErrors.push(...collection.workerErrors);
      if (collection.status === 'failed') result.status = 'failed';
      if (collection.plan?.tests.length) active.push(project.name);
    }
    if (result.status === 'failed' || !active.length) {
      if (!active.length) result.workerErrors.push({ phase: 'collection', message: 'No matching tests' });
      result.status = 'failed'; projects = [];
    } else {
      executionOverrides = { ...overrides, project: active[0] === '' ? [] : active };
      projects = resolveIndependentProjects(value, configFile, executionOverrides);
    }
  }
  for (const project of projects) {
    const blockedBy = project.dependencies.filter(name => projectResults.find(previous => previous.name === name)?.status !== 'passed');
    if (blockedBy.length) {
      projectResults.push({ name: project.name, status: 'skipped', blockedBy, tests: 0 });
      result.status = 'failed';
      continue;
    }
    const projectDirectory = project.name ? join(project.config.outputDir, runName, 'project-' + createHash('sha256').update(project.name).digest('hex').slice(0, 20)) : outputDir;
    const run = await runProcessSuite({
      modulePath: join(__dirname, 'entry-worker.js'), workers: config.workers, workerIndexBase: result.workers.length,
      retries: project.config.retries, timeoutMs: project.config.timeout,
      env: { FLASHWRIGHT_INDEPENDENT_RUN: JSON.stringify({ configFile, outputDir: projectDirectory, projectName: project.name, overrides: executionOverrides }) },
    });
    projectResults.push({ name: project.name, status: run.status, blockedBy: [], outputDir: projectDirectory, tests: run.plan?.tests.length ?? 0, metadata: project.config.metadata });
    if (run.status === 'failed') result.status = 'failed';
    const identity = (id: string): string => project.name ? JSON.stringify([project.name, ...JSON.parse(id) as unknown[]]) : id;
    for (const outcome of run.results) {
      const path = join(projectDirectory, createHash('sha256').update(outcome.id).digest('hex').slice(0, 20) + '-retry' + outcome.retry, 'attempt.json');
      let artifact: Record<string, unknown> = {};
      try { artifact = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (Object.keys(artifact).length && (artifact.id !== outcome.id || artifact.retry !== outcome.retry)) throw new Error('Attempt output identity mismatch');
      const normalized = { ...outcome, id: identity(outcome.id), projectName: project.name };
      result.results.push(normalized);
      attempts.push({ ...normalized, annotations: artifact.annotations ?? [], attachments: artifact.attachments ?? [], steps: artifact.steps ?? [], attachmentErrors: artifact.attachmentErrors ?? [] });
    }
    const groupOffset = result.plan!.groups.length;
    result.plan!.tests.push(...(run.plan?.tests ?? []).map(test => ({ ...test, id: identity(test.id), projectName: project.name })));
    result.plan!.groups.push(...(run.plan?.groups ?? []).map(group => ({ ...group, id: groupOffset + group.id, tests: group.tests.map(identity) })));
    result.workers.push(...run.workers);
    result.workerErrors.push(...run.workerErrors.map(error => ({ ...error, projectName: project.name })));
  }
  const report = { schemaVersion: 1, runner: 'flashwright-independent', outputDir, projects: projectResults, ...result, results: attempts };
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
