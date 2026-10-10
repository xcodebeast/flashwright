import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { reportRuntime } from '../tools/javascript-runtime.mjs';
import { runnerSpecifications } from './runner-suite-contract.mjs';

const maximumDocumentBytes = 256 * 1024;
const maximumSourceBytes = 8 * 1024 * 1024;
const controlledWorkloads = ['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure'];
const expectedSnapshot = '- text: Name\n- textbox "Name"\n- button "Increment"\n- button "Save"\n- status: Ready\n- text: "0"';
const declarationText = '    test(`${workload}/${phase}/${iteration}`, async ({ page }) => {';
const assertionText = "        await expect(page.locator('#missing')).toBeVisible({ timeout: configuration.expectedFailureTimeoutMilliseconds });";

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Read only the named retained fixture files, refusing symlinks, special files and oversized inputs. */
async function readRetainedFile(directory, path, maximumBytes) {
  const relativePath = relative(directory, path);
  const components = relativePath.split(sep);
  assert.ok(relativePath && !isAbsolute(relativePath) && !components.includes('..'), `File escapes retained directory: ${path}`);
  let currentPath = directory;
  const root = await lstat(directory);
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), 'Retained directory must be an ordinary directory');
  let fileStatus;
  for (const [index, component] of components.entries()) {
    currentPath = join(currentPath, component);
    fileStatus = await lstat(currentPath);
    assert.ok(!fileStatus.isSymbolicLink(), `Symlink is not retained file custody: ${currentPath}`);
    assert.ok(index === components.length - 1 ? fileStatus.isFile() : fileStatus.isDirectory(), `Unexpected file type: ${currentPath}`);
  }
  assert.ok(fileStatus.size <= maximumBytes, `Retained file exceeds ${maximumBytes} bytes: ${path}`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const openedStatus = await file.stat();
    assert.ok(openedStatus.isFile() && openedStatus.dev === fileStatus.dev && openedStatus.ino === fileStatus.ino, 'Retained file changed during admission');
    assert.ok(openedStatus.size <= maximumBytes, `Retained file exceeds ${maximumBytes} bytes: ${path}`);
    const bytes = Buffer.alloc(openedStatus.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    assert.equal(length, openedStatus.size, 'Retained file size changed during admission');
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

function uniqueMatch(text, expression, description) {
  const matches = [...text.matchAll(expression)];
  assert.equal(matches.length, 1, `Expected exactly one ${description}`);
  return matches[0];
}

function verifyDiagnosticMeaning(text, timeoutMilliseconds, title) {
  assert.doesNotMatch(text, /no observation before the deadline/i,
    `${title}: missing retained predicate evidence; a later fallback cannot establish an original observation`);
  assert.doesNotMatch(text, /# Page snapshot/i, `${title}: later page-snapshot fallback cannot establish original predicate evidence`);
  assert.doesNotMatch(text, /omitt?ed|truncat|capture[^\n]*(?:error|fail)|(?:error|fail)[^\n]*captur/i, `${title}: incomplete or failed diagnostic capture`);
  assert.match(text, /toBeVisible/, `${title}: missing original assertion`);
  assert.match(text, /Locator: locator\(['"]#missing['"]\)/, `${title}: missing original locator`);
  assert.match(text, /^Expected: ["']?visible["']?$/m, `${title}: missing visible expectation`);
  const timeout = uniqueMatch(text, /^(?:Timeout: |Timed out after )(\d+)ms$/gm, `${title} original timeout`);
  assert.equal(Number(timeout[1]), timeoutMilliseconds, `${title}: changed assertion timeout`);
  assert.match(text, /^(?:Error: element\(s\) not found|Received: no matching element)$/m,
    `${title}: missing retained missing-element predicate observation`);
}

function verifyLocation(location, expected, description) {
  assert.deepEqual(location, expected, `${description}: original source location differs`);
}

/** Preserve every source character; only the engine-specific caret error headline is normalized. */
function verifySourceFrame(frame, sourceLines, callSite, fullSource, headline) {
  const lines = frame.split('\n');
  const caret = `     | ${' '.repeat(callSite.column - 1)}^`;
  let previousNumber = fullSource ? 0 : Math.max(1, callSite.line - 2) - 1;
  let caretCount = 0;
  let highlightedCount = 0;
  const normalized = [];
  const sourceNumbers = [];
  for (const line of lines) {
    if (line.startsWith('     | ')) {
      caretCount++;
      assert.equal(previousNumber, callSite.line, 'Source caret must immediately follow the failing source line');
      assert.equal(line, fullSource ? `${caret} ${headline}` : caret, 'Source caret must match the runtime-reported .toBeVisible call site');
      normalized.push(caret);
      continue;
    }
    const sourceLine = line.match(/^([ >]) (\d+)( *)\| (.*)$/);
    assert.ok(sourceLine, `Unexpected source-frame line: ${line}`);
    const number = Number(sourceLine[2]);
    assert.ok(number > 0 && number <= sourceLines.length, 'Source frame has a foreign line number');
    assert.equal(number, previousNumber + 1, 'Source frame lines must be contiguous');
    const expectedMarker = number === callSite.line ? '>' : ' ';
    assert.equal(sourceLine[1], expectedMarker, 'Source frame highlights the wrong line');
    if (expectedMarker === '>') highlightedCount++;
    assert.equal(sourceLine[4], sourceLines[number - 1], `Source frame differs from actual source on line ${number}`);
    const padding = fullSource ? ' '.repeat(String(sourceLines.length).length - String(number).length + 1) : ' ';
    assert.equal(sourceLine[3], padding, 'Source-frame line-number padding differs');
    previousNumber = number;
    sourceNumbers.push(number);
    normalized.push(line);
  }
  assert.equal(caretCount, 1, 'Source frame must have exactly one original caret');
  assert.equal(highlightedCount, 1, 'Source frame must highlight the original failure');
  const first = fullSource ? 1 : Math.max(1, callSite.line - 2);
  const last = fullSource ? sourceLines.length : Math.min(sourceLines.length, callSite.line + 3);
  assert.deepEqual(sourceNumbers, Array.from({ length: last - first + 1 }, (_, index) => first + index), 'Source frame is incomplete');
  return normalized.join('\n');
}

function verifyDocumentLocation(file, directory, sourcePath) {
  if (isAbsolute(file)) {
    assert.equal(file, sourcePath, 'Document names a foreign source file');
    return;
  }
  // The reporter renders this relative to its original cwd, which historical sample.json did not retain.
  const suffix = file.replace(/^(?:\.\.\/)+/, '');
  assert.ok(!suffix.split('/').some(component => component === '.' || component === '..' || component === ''), 'Invalid relative document source path');
  assert.ok(suffix.endsWith(`${basename(directory)}/project/workloads.spec.mjs`) && sourcePath.endsWith(`/${suffix}`),
    'Document must name the exact retained source directory and file');
}

/** Admit useful diagnostics only for this static controlled fixture; this is not general artifact or byte parity. */
export async function verifyRunnerFailureDiagnostics(report, directory, { recordedDirectory = resolve(directory) } = {}) {
  const physicalDirectory = resolve(directory);
  assert.ok(typeof recordedDirectory === 'string' && isAbsolute(recordedDirectory) && resolve(recordedDirectory) === recordedDirectory && !recordedDirectory.includes('%'),
    'Recorded diagnostic directory must be an exact normalized absolute path');
  const originalDirectory = recordedDirectory;
  assert.ok(['playwright', 'flashwright'].includes(report.engine), 'Unknown diagnostic engine');
  const configuration = report.configuration;
  assert.deepEqual(configuration.workloads, controlledWorkloads, 'Diagnostics admission supports only the controlled seven-workload fixture');
  for (const count of [configuration.warmupIterations, configuration.measuredIterations]) {
    assert.ok(Number.isInteger(count) && count >= 0, 'Invalid workload iteration count');
  }
  const iterations = configuration.warmupIterations + configuration.measuredIterations;
  assert.ok(iterations > 0 && iterations <= 1000, 'Controlled fixture requires between one and 1000 iterations per workload');
  assert.ok(Number.isInteger(configuration.expectedFailureTimeoutMilliseconds) && configuration.expectedFailureTimeoutMilliseconds > 0, 'Invalid expected failure timeout');
  assert.ok(Number.isInteger(report.launchIndex) && report.launchIndex >= 0, 'Invalid launch index');
  const sourcePath = join(originalDirectory, 'project', 'workloads.spec.mjs');
  const sourceBytes = await readRetainedFile(physicalDirectory, join(physicalDirectory, 'project', 'workloads.spec.mjs'), maximumSourceBytes);
  const commonSourceBytes = await readFile(new URL('./runner-suite/workloads.spec.mjs', import.meta.url));
  assert.deepEqual(sourceBytes, commonSourceBytes, 'Retained source must equal the common controlled fixture');
  const sourceLines = sourceBytes.toString('utf8').split('\n');
  const declarationLine = sourceLines.indexOf(declarationText) + 1;
  const assertionLine = sourceLines.indexOf(assertionText) + 1;
  assert.equal(sourceLines.filter(line => line === declarationText).length, 1, 'Controlled test declaration changed');
  assert.equal(sourceLines.filter(line => line === assertionText).length, 1, 'Controlled failing assertion changed');
  const runtime = reportRuntime(report);
  assert.ok(runtime.name === 'bun' ? runtime.version === '1.4.2' : ['22.22.0', '24.15.0'].includes(runtime.version),
    'Diagnostic source locations require a verified runtime version');
  // The pinned Bun runner reports both source columns one character before the pinned Node runners.
  const runtimeColumnOffset = runtime.name === 'node' ? 1 : 0;
  const declarationColumn = declarationText.indexOf('test(') + runtimeColumnOffset;
  const callSite = { line: assertionLine, column: assertionText.indexOf('.toBeVisible') + 1 + runtimeColumnOffset };
  const originalLocation = { file: sourcePath, ...callSite };
  const offset = report.launchIndex % controlledWorkloads.length;
  const workloads = controlledWorkloads.slice(offset).concat(controlledWorkloads.slice(0, offset));
  const titles = workloads.flatMap(workload => [['warmup', configuration.warmupIterations], ['sample', configuration.measuredIterations]]
    .flatMap(([phase, count]) => Array.from({ length: count }, (_, index) => `${workload}/${phase}/${index}`)));
  const specifications = runnerSpecifications(report.runner.suites);
  assert.deepEqual(specifications.map(specification => specification.title), titles, 'Controlled suite cases are missing, duplicated or reordered');
  assert.deepEqual(report.runner.errors, [], 'Runner-level failures invalidate diagnostic comparison');
  const cases = {};
  const paths = new Set();
  for (const specification of specifications) {
    const title = specification.title;
    assert.equal(specification.file, 'workloads.spec.mjs', `${title}: foreign declaration source`);
    assert.equal(specification.line, declarationLine, `${title}: changed test declaration line`);
    assert.equal(specification.column, declarationColumn, `${title}: changed test declaration column`);
    assert.equal(specification.tests.length, 1, `${title}: expected exactly one test`);
    const test = specification.tests[0];
    const failure = title.startsWith('failure/');
    assert.equal(test.expectedStatus, 'passed', `${title}: failure must remain unexpected`);
    assert.equal(test.status, failure ? 'unexpected' : 'expected', `${title}: changed outcome classification`);
    assert.equal(test.results.length, 1, `${title}: expected exactly one original attempt`);
    const result = test.results[0];
    assert.equal(result.retry, 0, `${title}: retry cannot replace the original attempt`);
    assert.equal(result.status, failure ? 'failed' : 'passed', `${title}: changed attempt outcome`);
    assert.equal(result.errors.length, failure ? 1 : 0, `${title}: changed error count`);
    assert.equal(result.attachments.length, failure ? 1 : 0, `${title}: changed artifact count`);
    if (!failure) {
      assert.ok(!result.error && !result.errorLocation, `${title}: passing case retains a failure`);
      continue;
    }
    const error = result.errors[0];
    verifyLocation(error.location, originalLocation, title);
    verifyLocation(result.error?.location, originalLocation, `${title} original error`);
    verifyLocation(result.errorLocation, originalLocation, `${title} reporter error`);
    const message = stripVTControlCharacters(error.message);
    verifyDiagnosticMeaning(message, configuration.expectedFailureTimeoutMilliseconds, title);
    const originalMessage = stripVTControlCharacters(result.error.message);
    const originalStack = stripVTControlCharacters(result.error.stack);
    verifyDiagnosticMeaning(originalMessage, configuration.expectedFailureTimeoutMilliseconds, title);
    assert.ok(originalStack.startsWith(originalMessage), `${title}: stack lost the original error`);
    const stackLocation = `    at ${sourcePath}:${callSite.line}:${callSite.column}`;
    assert.equal(originalStack.split('\n').at(-1), stackLocation, `${title}: changed original stack call site`);
    assert.equal(message.split('\n').at(-1), stackLocation, `${title}: changed reporter stack call site`);
    const snippet = stripVTControlCharacters(result.error.snippet);
    verifySourceFrame(snippet, sourceLines, callSite, false);
    assert.equal(message, `${originalMessage}\n\n${snippet}\n${stackLocation}`, `${title}: reporter message lost original diagnostics or source frame`);
    const attachment = result.attachments[0];
    assert.equal(attachment.name, 'error-context', `${title}: missing error-context attachment`);
    assert.equal(attachment.contentType, 'text/markdown', `${title}: wrong attachment content type`);
    assert.equal(attachment.body, undefined, `${title}: error-context must retain original file custody`);
    assert.ok(typeof attachment.path === 'string' && isAbsolute(attachment.path), `${title}: attachment must link an original absolute path`);
    const documentPath = resolve(attachment.path);
    assert.equal(attachment.path, documentPath, `${title}: attachment path must be normalized`);
    assert.equal(documentPath, join(originalDirectory, 'test-output', `workloads-${title.replaceAll('/', '-')}`, 'error-context.md'),
      `${title}: attachment must belong to this original attempt within test-output`);
    assert.ok(!paths.has(documentPath), `${title}: borrowed diagnostic attachment`);
    paths.add(documentPath);
    // Verify the recorded attachment first, then map only its verified relative suffix into retained custody.
    const documentBytes = await readRetainedFile(physicalDirectory, join(physicalDirectory, relative(originalDirectory, documentPath)), maximumDocumentBytes);
    const document = documentBytes.toString('utf8');
    verifyDiagnosticMeaning(document, configuration.expectedFailureTimeoutMilliseconds, title);
    for (const heading of ['Test info', 'Error details', 'Test source']) {
      uniqueMatch(document, new RegExp(`^# ${heading}$`, 'gm'), `${title} ${heading} section`);
    }
    const name = uniqueMatch(document, /^- Name: (.+)$/gm, `${title} test title`);
    assert.equal(name[1], `workloads.spec.mjs >> ${title}`, `${title}: document title differs`);
    const location = uniqueMatch(document, /^- Location: (.+):(\d+):(\d+)$/gm, `${title} declaration location`);
    verifyDocumentLocation(location[1], originalDirectory, sourcePath);
    assert.equal(Number(location[2]), declarationLine, `${title}: document declaration line differs`);
    assert.equal(Number(location[3]), declarationColumn, `${title}: document declaration column differs`);
    const details = uniqueMatch(document, /# Error details\n\n```\n([\s\S]*?)\n```/g, `${title} original error details`);
    assert.equal(details[1], originalMessage, `${title}: document did not retain the original assertion error`);
    const snapshot = uniqueMatch(document, /```yaml\n([\s\S]*?)\n```/g, `${title} default snapshot`);
    assert.equal(snapshot[1], expectedSnapshot, `${title}: default fixture YAML differs`);
    const sourceFrame = uniqueMatch(document, /# Test source\n\n```ts\n([\s\S]*?)\n```/g, `${title} complete source frame`);
    const normalizedSourceFrame = verifySourceFrame(sourceFrame[1], sourceLines, callSite, true, originalMessage.split('\n')[0]);
    cases[title] = { sourceSha256: hash(sourceBytes), snapshotSha256: hash(snapshot[1]),
      normalizedSourceFrameSha256: hash(normalizedSourceFrame), documentSha256: hash(documentBytes), callSite,
      retainedPredicateObservation: true, captureKind: 'matcher-observation', errorMeaningVerified: true };
  }
  assert.equal(Object.keys(cases).length, iterations, 'All intentional failures must retain diagnostic evidence');
  return { schemaVersion: 1, status: 'passed-controlled-runner-diagnostics', controlledDiagnosticAdmissionPassed: true,
    casesPerEngine: iterations, suiteCaseCount: titles.length, successfulCasesWithoutArtifacts: titles.length - iterations,
    expectedFailureTimeoutMilliseconds: configuration.expectedFailureTimeoutMilliseconds, equivalentPredicateEvidence: true, cases,
    differences: ['Public diagnostic wording and locator quoting differ; reference retry call-log wording is not reproduced.',
      'Only source-frame caret error headlines are normalized; actual source characters are preserved. Exact Markdown bytes are not promised.'],
    scope: 'Useful original missing-element observations, exact common source/call sites and default YAML for this static controlled runner fixture only. Later page-snapshot fallbacks cannot prove retained original predicate evidence. No general artifact parity, exact diagnostic byte parity or performance acceptance.' };
}
