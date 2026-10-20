import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyRunnerFailureDiagnostics } from '../benchmarks/runner-suite-diagnostics.mjs';

const commonSource = await readFile(new URL('../benchmarks/runner-suite/workloads.spec.mjs', import.meta.url), 'utf8');
const sourceLines = commonSource.split('\n');
const assertionLine = sourceLines.findIndex(line => line.includes("await expect(page.locator('#missing')).toBeVisible")) + 1;
const assertionColumn = sourceLines[assertionLine - 1].indexOf('.toBeVisible') + 1;
const declarationLine = sourceLines.findIndex(line => line.includes('test(`${workload}/${phase}/${iteration}`')) + 1;
const declarationColumn = sourceLines[declarationLine - 1].indexOf('test(');
const defaultSnapshot = '- text: Name\n- textbox "Name"\n- button "Increment"\n- button "Save"\n- status: Ready\n- text: "0"';

function sourceFrame(fullSource, headline, column = assertionColumn) {
  const firstLine = fullSource ? 1 : assertionLine - 2;
  const lastLine = fullSource ? sourceLines.length : assertionLine + 3;
  const frame = [];
  for (let number = firstLine; number <= lastLine; number++) {
    const marker = number === assertionLine ? '>' : ' ';
    const padding = fullSource ? ' '.repeat(String(sourceLines.length).length - String(number).length + 1) : ' ';
    frame.push(`${marker} ${number}${padding}| ${sourceLines[number - 1]}`);
    if (number === assertionLine) frame.push(`     | ${' '.repeat(column - 1)}^${fullSource ? ` ${headline}` : ''}`);
  }
  return frame.join('\n');
}

/** Synthetic reports retain the real controlled source and both pinned diagnostic wording styles. */
async function fixture(engine = 'playwright', launchIndex = 0, runtime = { name: 'bun', version: '1.4.2' }) {
  const columnOffset = runtime.name === 'node' ? 1 : 0;
  const callColumn = assertionColumn + columnOffset;
  const testColumn = declarationColumn + columnOffset;
  const directory = await mkdtemp(join(tmpdir(), 'flashwright-runner-diagnostics-'));
  const sourcePath = join(directory, 'project', 'workloads.spec.mjs');
  await mkdir(join(directory, 'project'));
  await writeFile(sourcePath, commonSource);
  const configuration = { warmupIterations: 3, measuredIterations: 12, expectedFailureTimeoutMilliseconds: 250,
    workloads: ['noop', 'interaction', 'assertion', 'navigation', 'setup', 'backend', 'failure'] };
  const workloads = configuration.workloads.slice(launchIndex).concat(configuration.workloads.slice(0, launchIndex));
  const specifications = [];
  for (const workload of workloads) for (const [phase, count] of [['warmup', 3], ['sample', 12]]) {
    for (let index = 0; index < count; index++) {
      const title = `${workload}/${phase}/${index}`;
      const failure = workload === 'failure';
      const result = { status: failure ? 'failed' : 'passed', retry: 0, errors: [], attachments: [] };
      if (failure) {
        const message = engine === 'playwright'
          ? "Error: expect(locator).toBeVisible() failed\n\nLocator: locator('#missing')\nExpected: visible\nTimeout: 250ms\nError: element(s) not found\n\nCall log:\n  - Expect \"to.be.visible\" with timeout 250ms\n  - waiting for locator('#missing')\n"
          : 'Error: expect(locator("#missing")).toBeVisible(expected)\nTimed out after 250ms\nLocator: locator("#missing")\nExpected: "visible"\nReceived: no matching element';
        const location = { file: sourcePath, line: assertionLine, column: callColumn };
        const stackLocation = `    at ${sourcePath}:${assertionLine}:${callColumn}`;
        const snippet = sourceFrame(false, undefined, callColumn);
        result.error = { message, location, stack: `${message}\n${stackLocation}`, snippet };
        result.errorLocation = { ...location };
        result.errors.push({ location: { ...location }, message: `${message}\n\n${snippet}\n${stackLocation}` });
        const documentPath = join(directory, 'test-output', `workloads-${title.replaceAll('/', '-')}`, 'error-context.md');
        await mkdir(join(directory, 'test-output', `workloads-${title.replaceAll('/', '-')}`), { recursive: true });
        const document = `# Instructions\n\n- Following Playwright test failed.\n\n# Test info\n\n- Name: workloads.spec.mjs >> ${title}\n- Location: ${sourcePath}:${declarationLine}:${testColumn}\n\n# Error details\n\n\`\`\`\n${message}\n\`\`\`\n\n\`\`\`yaml\n${defaultSnapshot}\n\`\`\`\n\n# Test source\n\n\`\`\`ts\n${sourceFrame(true, message.split('\n')[0], callColumn)}\n\`\`\``;
        await writeFile(documentPath, document);
        result.attachments.push({ name: 'error-context', contentType: 'text/markdown', path: documentPath });
      }
      specifications.push({ title, file: 'workloads.spec.mjs', line: declarationLine, column: testColumn,
        tests: [{ expectedStatus: 'passed', status: failure ? 'unexpected' : 'expected', results: [result] }] });
    }
  }
  const report = { engine, launchIndex, runtime, configuration, runner: { errors: [], suites: [{ suites: [{ specs: specifications }] }] } };
  return { directory, sourcePath, specifications, report };
}

async function withFixture(run, engine = 'playwright', launchIndex = 0, runtime) {
  const state = await fixture(engine, launchIndex, runtime);
  try { return await run(state); }
  finally { await rm(state.directory, { recursive: true, force: true }); }
}

function failure(state, index = 0) {
  return state.specifications.filter(specification => specification.title.startsWith('failure/'))[index].tests[0].results[0];
}

async function changeDocument(state, change) {
  const path = failure(state).attachments[0].path;
  await writeFile(path, change(await readFile(path, 'utf8')));
}

const verify = state => verifyRunnerFailureDiagnostics(state.report, state.directory);

for (const engine of ['playwright', 'flashwright']) test(`${engine} admits all controlled cases and original useful failure diagnostics`, () => withFixture(async state => {
  const receipt = await verify(state);
  assert.equal(receipt.status, 'passed-controlled-runner-diagnostics');
  assert.equal(receipt.controlledDiagnosticAdmissionPassed, true);
  assert.equal(receipt.suiteCaseCount, 105);
  assert.equal(receipt.casesPerEngine, 15);
  assert.equal(receipt.successfulCasesWithoutArtifacts, 90);
  assert.equal(receipt.equivalentPredicateEvidence, true);
  assert.equal(receipt.expectedFailureTimeoutMilliseconds, 250);
  for (const diagnostic of Object.values(receipt.cases)) {
    assert.deepEqual(diagnostic.callSite, { line: assertionLine, column: assertionColumn });
    assert.equal(diagnostic.retainedPredicateObservation, true);
    assert.equal(diagnostic.errorMeaningVerified, true);
    assert.equal(diagnostic.captureKind, 'matcher-observation');
    for (const field of ['sourceSha256', 'snapshotSha256', 'normalizedSourceFrameSha256', 'documentSha256']) assert.match(diagnostic[field], /^[0-9a-f]{64}$/);
  }
  assert.match(receipt.scope, /static controlled runner fixture only/);
  assert.match(receipt.differences.join(' '), /call-log wording.*Exact Markdown bytes are not promised/s);
  assert.deepEqual(await verify(state), receipt, 'Receipt must be deterministic');
}, engine));

test('both diagnostic wordings yield identical source, source-frame and snapshot identities', async () => {
  const reference = await withFixture(verify, 'playwright');
  const candidate = await withFixture(verify, 'flashwright');
  assert.deepEqual(Object.keys(candidate.cases), Object.keys(reference.cases));
  for (const title of Object.keys(reference.cases)) {
    for (const field of ['sourceSha256', 'snapshotSha256', 'normalizedSourceFrameSha256', 'callSite']) assert.deepEqual(candidate.cases[title][field], reference.cases[title][field]);
    assert.notEqual(candidate.cases[title].documentSha256, reference.cases[title].documentSha256);
  }
});

test('suite counts and title order follow configuration and launch rotation', () => withFixture(async state => {
  state.report.configuration.warmupIterations = 0;
  state.report.configuration.measuredIterations = 2;
  state.specifications.splice(0, state.specifications.length, ...state.specifications.filter(specification => /\/sample\/[01]$/.test(specification.title)));
  const receipt = await verify(state);
  assert.equal(receipt.suiteCaseCount, 14);
  assert.equal(receipt.casesPerEngine, 2);
}, 'flashwright', 3));

test('ANSI reporter messages and relative original document paths preserve diagnostic meaning', () => withFixture(async state => {
  const result = failure(state);
  for (const value of [result.error, result.errors[0]]) value.message = `\u001b[31m${value.message}\u001b[39m`;
  result.error.stack = `\u001b[31m${result.error.stack}\u001b[39m`;
  await changeDocument(state, document => document.replace(`- Location: ${state.sourcePath}`, `- Location: ../../../${state.sourcePath.slice(1)}`));
  assert.equal((await verify(state)).casesPerEngine, 15);
}));

for (const [name, change, reason] of [
  ['missing case', state => state.specifications.pop(), /suite cases/],
  ['duplicate title', state => { state.specifications[0].title = state.specifications[1].title; }, /suite cases/],
  ['wrong workload inventory', state => state.report.configuration.workloads.pop(), /full fixture or its original failure family/],
  ['wrong configured timeout', state => { state.report.configuration.expectedFailureTimeoutMilliseconds = 25; }, /changed assertion timeout/],
  ['runner-level error', state => state.report.runner.errors.push({ message: 'worker crashed' }), /Runner-level/],
  ['multiple tests', state => state.specifications[0].tests.push(state.specifications[0].tests[0]), /exactly one test/],
  ['duplicate attempt', state => state.specifications[0].tests[0].results.push(state.specifications[0].tests[0].results[0]), /original attempt/],
  ['retry replacing original attempt', state => { failure(state).retry = 1; }, /retry/],
  ['suppressed failure', state => { failure(state).status = 'passed'; }, /attempt outcome/],
  ['hidden failure classification', state => { state.specifications.at(-1).tests[0].expectedStatus = 'failed'; }, /remain unexpected/],
  ['missing error', state => { failure(state).errors = []; }, /error count/],
  ['extra error', state => failure(state).errors.push(failure(state).errors[0]), /error count/],
  ['passing case error', state => state.specifications[0].tests[0].results[0].errors.push({ message: 'failure' }), /error count/],
  ['passing case artifact', state => state.specifications[0].tests[0].results[0].attachments.push(failure(state).attachments[0]), /artifact count/],
  ['passing case original error', state => { state.specifications[0].tests[0].results[0].error = failure(state).error; }, /retains a failure/],
  ['wrong declaration file', state => { state.specifications[0].file = 'other.spec.mjs'; }, /declaration source/],
  ['wrong declaration line', state => state.specifications[0].line++, /declaration line/],
  ['wrong declaration column', state => state.specifications[0].column++, /declaration column/],
  ['method-letter callsite', state => failure(state).errors[0].location.column++, /source location differs/],
  ['wrong original callsite', state => failure(state).error.location.line++, /source location differs/],
  ['wrong reporter callsite', state => failure(state).errorLocation.column++, /source location differs/],
  ['wrong original stack', state => { failure(state).error.stack += ':1'; }, /stack call site/],
  ['wrong reporter stack', state => { failure(state).errors[0].message += ':1'; }, /stack call site/],
  ['missing original observation', state => { failure(state).errors[0].message = failure(state).errors[0].message.replace('Error: element(s) not found', 'Received: no observation before the deadline'); }, /missing retained predicate evidence/],
  ['missing attachment', state => { failure(state).attachments = []; }, /artifact count/],
  ['extra attachment', state => failure(state).attachments.push(failure(state).attachments[0]), /artifact count/],
  ['wrong attachment type', state => { failure(state).attachments[0].contentType = 'text/plain'; }, /content type/],
  ['wrong attachment name', state => { failure(state).attachments[0].name = 'later-page'; }, /error-context attachment/],
  ['body-only attachment', state => { failure(state).attachments[0].body = Buffer.from('snapshot').toString('base64'); }, /file custody/],
  ['borrowed attachment', state => { failure(state).attachments = failure(state, 1).attachments; }, /original attempt/],
  ['escaping attachment', state => { failure(state).attachments[0].path = join(state.directory, '..', 'error-context.md'); }, /within test-output/],
  ['relative attachment', state => { failure(state).attachments[0].path = 'test-output/error-context.md'; }, /absolute path/],
  ['unnormalized attachment', state => { failure(state).attachments[0].path = failure(state).attachments[0].path.replace('/test-output/', '/project/../test-output/'); }, /normalized/],
]) test(`rejects ${name}`, () => withFixture(async state => {
  await change(state);
  await assert.rejects(verify(state), reason);
}));

for (const [name, change, reason] of [
  ['wrong title', document => document.replace('>> failure/warmup/0', '>> failure/warmup/1'), /document title/],
  ['wrong document declaration line', document => document.replace(`:${declarationLine}:${declarationColumn}\n`, `:${declarationLine + 1}:${declarationColumn}\n`), /declaration line/],
  ['wrong document declaration column', document => document.replace(`:${declarationLine}:${declarationColumn}\n`, `:${declarationLine}:${declarationColumn + 1}\n`), /declaration column/],
  ['wrong document location', document => document.replace('/project/workloads.spec.mjs:', '/project/other.spec.mjs:'), /foreign source/],
  ['wrong source line', document => document.replace('  6  | const contexts = new WeakSet();', '  6  | const contexts = new Set();'), /actual source/],
  ['source omission', document => document.replace('  6  | const contexts = new WeakSet();\n', ''), /contiguous/],
  ['wrong source caret', document => document.replace(`     | ${' '.repeat(assertionColumn - 1)}^`, `     | ${' '.repeat(assertionColumn)}^`), /runtime-reported .toBeVisible/],
  ['missing source caret', document => document.replace(/^     \| .*\n/m, ''), /original caret/],
  ['wrong caret headline', document => document.replace('^ Error: expect(locator).toBeVisible() failed', '^ Unrelated failure'), /runtime-reported .toBeVisible/],
  ['altered fixture YAML', document => document.replace('- status: Ready', '- status: Loading'), /fixture YAML/],
  ['missing fixture YAML entry', document => document.replace('- button "Save"\n', ''), /fixture YAML/],
  ['extra fixture YAML', document => document.replace('```yaml\n', '```yaml\n- button "Other"\n'), /fixture YAML/],
  ['duplicate snapshot', document => document + `\n\`\`\`yaml\n${defaultSnapshot}\n\`\`\``, /exactly one.*snapshot/],
  ['missing observation with later fallback', document => document.replace('Error: element(s) not found', 'Received: no observation before the deadline').replace('```yaml', '# Page snapshot\n\n```yaml'), /missing retained predicate evidence/],
  ['later page fallback with useful-looking message', document => document.replace('```yaml', '# Page snapshot\n\n```yaml'), /later page-snapshot fallback/],
  ['explicit omission', document => document + '\n[Snapshot omitted: size limit]', /incomplete/],
  ['explicit truncation', document => document + '\n[Diagnostic truncated]', /incomplete/],
  ['optional capture error', document => document + '\nSnapshot capture failed: disconnected', /incomplete/],
  ['duplicate error section', document => document + '\n# Error details\n', /exactly one.*Error details/],
  ['partial source window', document => document.replace('  79 | \n', ''), /incomplete/],
]) test(`rejects document ${name}`, () => withFixture(async state => {
  await changeDocument(state, change);
  await assert.rejects(verify(state), reason);
}));

test('source snippet cannot change its caret or actual source even when the document remains correct', () => withFixture(async state => {
  const result = failure(state);
  const originalSnippet = result.error.snippet;
  result.error.snippet = originalSnippet.replace("locator('#missing')", "locator('#other')");
  result.errors[0].message = result.errors[0].message.replace(originalSnippet, result.error.snippet);
  await assert.rejects(verify(state), /actual source/);
}));

test('a changed retained source cannot be admitted by matching changed diagnostics', () => withFixture(async state => {
  await writeFile(state.sourcePath, commonSource.replace('new WeakSet()', 'new Set()'));
  await assert.rejects(verify(state), /common controlled fixture/);
}));

for (const target of ['document', 'document parent', 'source', 'source parent']) test(`rejects a symlink in ${target} custody`, () => withFixture(async state => {
  const documentPath = failure(state).attachments[0].path;
  const path = target === 'document' ? documentPath : target === 'document parent' ? join(state.directory, 'test-output')
    : target === 'source' ? state.sourcePath : join(state.directory, 'project');
  await rename(path, `${path}-original`);
  await symlink(`${path}-original`, path);
  await assert.rejects(verify(state), /Symlink/);
}));

for (const target of ['document', 'source']) test(`rejects oversized ${target} before reading content`, () => withFixture(async state => {
  const path = target === 'document' ? failure(state).attachments[0].path : state.sourcePath;
  const maximumBytes = target === 'document' ? 256 * 1024 : 8 * 1024 * 1024;
  await writeFile(path, Buffer.alloc(maximumBytes + 1));
  await assert.rejects(verify(state), /exceeds/);
}));

test('rejects a non-file diagnostic artifact', () => withFixture(async state => {
  const path = failure(state).attachments[0].path;
  await rm(path);
  await mkdir(path);
  await assert.rejects(verify(state), /Unexpected file type/);
}));

for (const engine of ['playwright', 'flashwright']) for (const version of ['22.22.0', '24.15.0']) {
  test(`${engine} retains exact Node ${version} declaration and assertion columns`, () => withFixture(async state => {
    const receipt = await verify(state);
    for (const diagnostic of Object.values(receipt.cases)) assert.deepEqual(diagnostic.callSite, { line: assertionLine, column: assertionColumn + 1 });
    state.report.runtime = { name: 'bun', version: '1.4.2' };
    await assert.rejects(verify(state), /declaration column/);
  }, engine, 0, { name: 'node', version }));
}

for (const runtime of [undefined, { name: 'node', version: '20.0.0' }, { name: 'bun', version: '1.4.0' }]) {
  test(`rejects unverified runtime ${JSON.stringify(runtime)}`, () => withFixture(async state => {
    state.report.runtime = runtime;
    await assert.rejects(verify(state), /runtime identity|verified runtime version/);
  }));
}

for (const engine of ['playwright', 'flashwright']) test(`${engine} retains all diagnostics in the isolated original failure family`, () => withFixture(async state => {
  state.report.configuration.workloads = ['failure'];
  state.report.runner.suites = [{ specs: state.specifications.filter(spec => spec.title.startsWith('failure/')) }];
  const receipt = await verify(state);
  assert.equal(receipt.suiteCaseCount, 15);
  assert.equal(receipt.casesPerEngine, 15);
  assert.equal(receipt.successfulCasesWithoutArtifacts, 0);
  state.report.runner.suites[0].specs.pop();
  await assert.rejects(verify(state), /missing, duplicated or reordered/);
}, engine));

test('isolated diagnostics reject an arbitrary subset of the original families', () => withFixture(async state => {
  state.report.configuration.workloads = ['interaction', 'failure'];
  await assert.rejects(verify(state), /full fixture or its original failure family/);
}));
