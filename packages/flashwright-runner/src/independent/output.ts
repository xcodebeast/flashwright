import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { failure } from '@flashwright/core';
import { currentFiniteTestInfo, type FiniteTestInfo, type SuiteTestResult } from './suite-runtime.js';
import type { PlannedTest } from './suite-collector.js';
import type { IndependentConfig } from './config.js';

export interface IndependentAttachment { name: string; path: string; contentType: string }
export interface IndependentStep { title: string; started: number; duration: number; status: 'running' | 'passed' | 'failed'; parent: number | null; error?: string }
export interface IndependentTestInfo extends FiniteTestInfo {
  readonly outputDir: string;
  readonly titlePath: readonly string[];
  readonly project: IndependentConfig & { readonly name: string };
  readonly annotations: { type: string; description?: string }[];
  readonly attachments: IndependentAttachment[];
  outputPath(...segments: string[]): string;
  attach(name: string, options: { body?: string | Buffer; path?: string; contentType?: string }): Promise<void>;
}
interface AttemptOutput { info: IndependentTestInfo; open: boolean; pending: Set<Promise<void>>; errors: unknown[]; steps: IndependentStep[] }
const outputs = new WeakMap<FiniteTestInfo, AttemptOutput>();
const byId = new Map<string, AttemptOutput>();
const stepScope = new AsyncLocalStorage<{ owner: AttemptOutput; index: number }>();
export function currentIndependentInfo(): IndependentTestInfo {
  const output = outputs.get(currentFiniteTestInfo());
  if (!output?.open) throw failure('InvalidArgumentError', 'test.info', 'independent attempt output scope has ended');
  return output.info;
}
export function beginOutput(test: PlannedTest, info: FiniteTestInfo, root: string, project?: IndependentConfig & { readonly name: string }): void {
  const outputDir = join(root, createHash('sha256').update(test.id).digest('hex').slice(0, 20) + '-retry' + info.retry);
  const outputPath = (...segments: string[]): string => {
    const target = resolve(outputDir, ...segments);
    if (target !== outputDir && !target.startsWith(outputDir + sep)) throw failure('InvalidArgumentError', 'testInfo.outputPath', 'path must remain inside the original attempt directory');
    mkdirSync(outputDir, { recursive: true });
    return target;
  };
  const attachments: IndependentAttachment[] = [];
  const enriched = Object.assign(info, { outputDir, titlePath: test.titlePath, project: project!, annotations: [] as { type: string; description?: string }[], attachments, outputPath, attach });
  const output: AttemptOutput = { info: enriched, open: true, pending: new Set(), errors: [], steps: [] };
  outputs.set(info, output); byId.set(test.id, output);
  function attach(name: string, options: { body?: string | Buffer; path?: string; contentType?: string }): Promise<void> {
    if (!output.open || currentFiniteTestInfo() !== info) return Promise.reject(failure('InvalidArgumentError', 'testInfo.attach', 'attachment belongs to an inactive attempt'));
    if (typeof name !== 'string' || !options || (options.body === undefined) === (options.path === undefined)) return Promise.reject(failure('InvalidArgumentError', 'testInfo.attach', 'provide exactly one body or path'));
    const body = typeof options.body === 'string' ? Buffer.from(options.body) : options.body === undefined ? undefined : Buffer.from(options.body);
    const source = options.path === undefined ? undefined : resolve(options.path);
    const target = outputPath('attachments', randomUUID() + (source ? '-' + basename(source) : '.bin'));
    const operation = (async () => {
      await mkdir(join(outputDir, 'attachments'), { recursive: true });
      if (source) await copyFile(source, target); else await writeFile(target, body!, { flag: 'wx' });
      attachments.push({ name, path: target, contentType: options.contentType ?? (typeof options.body === 'string' ? 'text/plain' : 'application/octet-stream') });
    })();
    output.pending.add(operation);
    void operation.then(() => output.pending.delete(operation), error => { output.errors.push(error); output.pending.delete(operation); });
    return operation;
  }
}
export async function independentStep<T>(title: string, callback: () => Promise<T> | T, ...options: unknown[]): Promise<T> {
  if (options.some(option => option !== undefined)) throw failure('UnsupportedFeatureError', 'test.step.options', 'step options are not integrated with the independent runner');
  const info = currentIndependentInfo(), owner = outputs.get(info)!;
  const parent = stepScope.getStore();
  const step: IndependentStep = { title, started: performance.now(), duration: 0, status: 'running', parent: parent?.owner === owner ? parent.index : null };
  const index = owner.steps.push(step) - 1;
  try { const value = await stepScope.run({ owner, index }, callback); step.status = 'passed'; return value; }
  catch (error) { step.status = 'failed'; step.error = String(error); throw error; }
  finally { step.duration = performance.now() - step.started; }
}
export async function finishOutput(result: SuiteTestResult): Promise<void> {
  const owner = byId.get(result.test.id);
  if (!owner) throw new Error('Missing original attempt output');
  owner.open = false;
  await Promise.allSettled([...owner.pending]);
  const record = { id: result.test.id, retry: owner.info.retry, annotations: owner.info.annotations, attachments: owner.info.attachments, steps: owner.steps, attachmentErrors: owner.errors.map(String) };
  await mkdir(owner.info.outputDir, { recursive: true });
  if (result.errors.length) {
    const errors = result.errors.map(e => e.error instanceof Error ? e.error.stack ?? e.error.message : String(e.error)).join('\n\n').slice(0, 32768);
    let snapshot = '';
    const attachment = owner.info.attachments.find(a => a.name === 'page-snapshot');
    if (attachment) snapshot = (await readFile(attachment.path, 'utf8')).slice(0, 32768);
    const document = `# ${result.test.title}\n\nSource: ${result.test.file}\n\n## Failure\n\n\`\`\`text\n${errors}\n\`\`\`\n${snapshot ? `\n## Page snapshot\n\n\`\`\`yaml\n${snapshot}\n\`\`\`\n` : ''}`;
    const path = owner.info.outputPath('error-context.md');
    await writeFile(path, document, { flag: 'wx' });
    record.attachments.push({ name: 'error-context', path, contentType: 'text/markdown' });
  }
  await writeFile(owner.info.outputPath('attempt.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
  byId.delete(result.test.id);
  if (owner.errors.length) throw new AggregateError(owner.errors, 'Attachment publication failed');
}
