import { open, mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { Locator, Page, failure, type AriaSnapshotTemplate, type AssertionOptions } from '@flashwright/core';
import type { ExpectMatcherState, MatcherReturnType, TestInfo } from 'flashwright-upstream-runner/test';
import { upstreamRequire } from './upstream-runtime.js';

interface SnapshotTestInfo extends TestInfo {
  _resolveSnapshotPaths(kind: 'aria', name: string | undefined, index: 'dontUpdateSnapshotIndex' | 'updateSnapshotIndex', extension?: string): { absoluteSnapshotPath: string };
}
interface SnapshotConfiguration {
  testInfo: SnapshotTestInfo | null;
  ignoreSnapshots: boolean;
  updateSnapshots: 'missing' | 'all' | 'changed' | 'none';
  toMatchAriaSnapshot?: { children?: 'contain' | 'equal' | 'deep-equal' };
}
interface SnapshotOptions { name?: string; timeout?: number }
type SnapshotResult = MatcherReturnType & { softError?: Error; shouldNotRetryTest?: boolean; suggestedRebaseline?: string };
const { expectConfig } = upstreamRequire('./lib/matchers/expect.js') as { expectConfig(): SnapshotConfiguration };
const { iso: isomorphic } = upstreamRequire('playwright-core/lib/coreBundle') as {
  iso: { parseAriaSnapshotUnsafe(yaml: unknown, source: string): AriaSnapshotTemplate; escapeTemplateString(source: string): string };
};
const { yaml } = upstreamRequire('playwright-core/lib/utilsBundle') as { yaml: unknown };

/** Match the pinned indentation normalization before parsing or emitting a rebaseline. */
function unindent(snapshot: string): string {
  const lines = snapshot.split('\n').filter(line => line.trim());
  let indentation = 100;
  for (const line of lines) indentation = Math.min(indentation, /^\s*/.exec(line)![0].length);
  return lines.map(line => line.substring(indentation)).join('\n');
}

const maximumTemplateUnits = 100000;

function validateTemplateSize(template: string): void {
  if (template.length > maximumTemplateUnits) throw failure('ResourceLimitError', 'expect.toMatchAriaSnapshot', 'ARIA template exceeds 100000 UTF-16 units');
}

/** Bound file allocation before decoding; UTF-8 needs at most three bytes per UTF-16 unit. */
async function readSnapshotBaseline(path: string): Promise<string> {
  const file = await open(path, 'r').catch(() => undefined);
  if (!file) return '';
  const bytes = Buffer.alloc(maximumTemplateUnits * 3 + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
  } catch {
    return '';
  } finally {
    await file.close();
  }
  if (length === bytes.length) throw failure('ResourceLimitError', 'expect.toMatchAriaSnapshot', 'ARIA template exceeds its UTF-8 byte limit');
  const template = bytes.subarray(0, length).toString('utf8');
  validateTemplateSize(template);
  return template;
}

function validateOptions(options: SnapshotOptions, named: boolean): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('InvalidArgumentError', 'expect.toMatchAriaSnapshot', 'options must be an object');
  for (const name of Object.keys(options)) {
    if (name !== 'timeout' && !(named && name === 'name')) throw failure('UnsupportedFeatureError', `expect.toMatchAriaSnapshot.${name}`, 'snapshot option is not implemented');
  }
  if (options.name !== undefined && typeof options.name !== 'string') throw failure('InvalidArgumentError', 'expect.toMatchAriaSnapshot.name', 'expected a string');
}

/** Keep snapshot policy and baseline writes in the owned runner; only the predicate runs natively. */
export async function toMatchAriaSnapshot(this: ExpectMatcherState, actual: Locator | Page, expectedOrOptions?: string | SnapshotOptions, options: { timeout?: number } = {}): Promise<SnapshotResult> {
  const name = 'toMatchAriaSnapshot';
  if (!(actual instanceof Locator) && !(actual instanceof Page)) throw failure('InvalidArgumentError', `expect.${name}`, 'expected a Flashwright Page or Locator');
  const configuration = expectConfig();
  if (!configuration.testInfo) throw failure('InvalidArgumentError', `expect.${name}`, 'must be called during a test');
  if (configuration.ignoreSnapshots) return { name, pass: !this.isNot, expected: '', message: () => '' };
  const inline = typeof expectedOrOptions === 'string';
  const selected: SnapshotOptions = inline ? options : expectedOrOptions ?? {};
  validateOptions(selected, !inline);
  const timeout = selected.timeout ?? this.timeout;
  let expected = inline ? expectedOrOptions : '';
  let expectedPath: string | undefined;
  if (!inline) {
    const testInfo = configuration.testInfo;
    const legacy = testInfo._resolveSnapshotPaths('aria', selected.name, 'dontUpdateSnapshotIndex', '.yml').absoluteSnapshotPath;
    expectedPath = testInfo._resolveSnapshotPaths('aria', selected.name, 'updateSnapshotIndex').absoluteSnapshotPath;
    if (!await access(expectedPath).then(() => true, () => false) && await access(legacy).then(() => true, () => false)) expectedPath = legacy;
    expected = await readSnapshotBaseline(expectedPath);
  }
  validateTemplateSize(expected);
  const generateMissing = configuration.updateSnapshots === 'missing' && !expected;
  if (generateMissing && this.isNot) return { name, pass: true, message: () => 'Matchers using ".not" cannot generate new baselines' };
  if (generateMissing) expected = '- none "Generating new baseline"';
  expected = unindent(expected);
  if (configuration.toMatchAriaSnapshot?.children && !/^- \/children:/m.test(expected)) expected = `- /children: ${configuration.toMatchAriaSnapshot.children}\n${expected}`;
  validateTemplateSize(expected);
  let template: AriaSnapshotTemplate;
  try { template = isomorphic.parseAriaSnapshotUnsafe(yaml, expected); }
  catch (error) { throw failure('InvalidArgumentError', `expect.${name}`, error instanceof Error ? error.message : String(error)); }
  const capture: AssertionOptions['ariaSnapshotCapture'] = this.isNot ? undefined
    : configuration.updateSnapshots === 'all' || generateMissing ? 'always'
    : configuration.updateSnapshots === 'changed' ? 'mismatch' : undefined;
  if (inline && capture && process.versions.bun) throw failure('UnsupportedFeatureError', `expect.${name}`, 'Bun inline baseline generation/update is unavailable because the pinned runner cannot resolve its call-site column; use a named file baseline or run this update under Node');
  const request: AssertionOptions = { expression: 'to.match.aria', expectedValue: template, isNot: this.isNot, ...(capture ? { ariaSnapshotCapture: capture } : {}) };
  const result = actual instanceof Locator ? await actual.runAssertion(request, timeout) : await actual.mainFrame().runAssertion(null, request, timeout);
  const received = result.received as { raw?: string; regex?: string } | undefined;
  const message = () => [
    this.utils.matcherHint(name, actual instanceof Locator ? actual.toString() : 'page', 'expected', { isNot: this.isNot, promise: this.promise }),
    ...(result.timedOut ? [`Timed out after ${timeout}ms`] : []),
    `Expected${this.isNot ? ' not' : ''}: ${this.utils.printExpected(expected)}`,
    !result.observed ? 'Received: no observation before the deadline' : result.missingReceived ? 'Received: no matching element' : `Received: ${this.utils.printReceived(received?.raw)}`,
    ...(result.diagnosticTruncated ? ['Received diagnostic was truncated to its retention limit.'] : []),
  ].join('\n');
  const update = !this.isNot && (configuration.updateSnapshots === 'all' || generateMissing || configuration.updateSnapshots === 'changed' && !result.matches);
  if (update && result.observed && !result.missingReceived) {
    if (result.diagnosticTruncated || typeof received?.regex !== 'string') throw failure('ProtocolError', `expect.${name}`, 'baseline generation did not retain a complete snapshot');
    if (expectedPath) {
      await mkdir(dirname(expectedPath), { recursive: true });
      await writeFile(expectedPath, received.regex, 'utf8');
      const path = relative(process.cwd(), expectedPath);
      if (configuration.updateSnapshots === 'missing') return { name, pass: true, message: () => '', softError: new Error(`A snapshot does not exist at ${path}, writing actual.`), shouldNotRetryTest: true };
      console.log(`A snapshot is generated at ${path}.`);
      return { name, pass: true, message: () => '' };
    }
    const body = received.regex.split('\n').map(line => `{indent}  ${line}`).join('\n');
    const suggestedRebaseline = '`\n' + isomorphic.escapeTemplateString(body) + '\n{indent}`';
    return { name, pass: true, message: () => '', suggestedRebaseline,
      ...(configuration.updateSnapshots === 'missing' ? { softError: new Error('A snapshot is not provided, generating new baseline.'), shouldNotRetryTest: true } : {}) };
  }
  return { name, expected, pass: result.matches, actual: received?.raw, message, ...(result.timedOut ? { timeout } : {}) };
}
