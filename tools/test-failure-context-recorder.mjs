import assert from 'node:assert/strict';
import filesystem from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import typescript from 'typescript';

const require = createRequire(import.meta.url);
const upstreamRequire = createRequire(join(dirname(require.resolve('playwright/package.json')), 'package.json'));
let publicationFailure;
let formattingFailure = false;
const writes = [];
const renames = [];
const publishingFilesystem = {
  ...filesystem,
  async writeFile(path, contents, options) {
    writes.push({ path, contents, options });
    if (publicationFailure === 'write') throw Error('injected publication write failure');
    return filesystem.writeFile(path, contents, options);
  },
  async rename(source, destination) {
    renames.push({ source, destination });
    if (publicationFailure === 'rename') throw Error('injected publication rename failure');
    return filesystem.rename(source, destination);
  },
};

async function loadModule(relativePath, replacements = {}) {
  const sourcePath = resolve(relativePath);
  const compiled = typescript.transpileModule(await filesystem.readFile(sourcePath, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.length, 0);
  const module = { exports: {} };
  const scopedRequire = name => replacements[name] ?? require(name);
  vm.runInNewContext(compiled.outputText, { exports: module.exports, module, require: scopedRequire, Buffer, process }, { filename: sourcePath });
  return module.exports;
}

const formatter = await loadModule('packages/flashwright-runner/src/failure-context-format.ts', {
  './upstream-runtime.js': { upstreamRequire },
});
const artifactErrors = await loadModule('packages/flashwright-runner/src/artifact-errors.ts');
const { FailureContextScopes } = await loadModule('packages/flashwright-runner/src/failure-context-recorder.ts', {
  'node:fs/promises': publishingFilesystem,
  './artifact-errors.js': artifactErrors,
  './failure-context-format.js': {
    ...formatter,
    async buildFailureContext(options) {
      if (formattingFailure) throw Error('injected optional formatter failure');
      return formatter.buildFailureContext(options);
    },
  },
});

const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-failure-context-recorder-'));
const previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
const report = { status: 'running', runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, checks: [] };
let nextAttempt = 0;

async function check(name, callback) {
  await callback();
  report.checks.push(name);
}

function testInfo(options = {}) {
  const ordinal = ++nextAttempt;
  const outputDirectory = join(directory, `attempt-${ordinal}`);
  const outputCalls = [];
  return {
    titlePath: ['suite', `test ${ordinal}`], file: join(directory, 'missing-test-source.ts'), line: 17, column: 3,
    errors: [Object.freeze({ message: `original failure ${ordinal}` })],
    status: 'failed', expectedStatus: 'passed', retry: 0, attachments: [],
    outputDirectory, outputCalls,
    outputPath(name) { outputCalls.push(name); return join(outputDirectory, name); },
    ...options,
  };
}

function context(...pages) { return { pages: () => pages }; }
function page(name) { return { name }; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function turns() { for (let index = 0; index < 6; index++) await Promise.resolve(); }
async function document(info) { return filesystem.readFile(join(info.outputDirectory, 'error-context.md'), 'utf8'); }
async function assertNoDocument(info) {
  await assert.rejects(document(info), error => error.code === 'ENOENT');
  assert.equal(info.attachments.length, 0);
}
async function assertDocument(info, pageSnapshot) {
  const expected = await formatter.buildFailureContext({
    titlePath: info.titlePath,
    location: { file: info.file, line: info.line, column: info.column },
    errors: info.errors, pageSnapshot,
  });
  assert.equal(await document(info), expected);
  const attachment = info.attachments.find(entry => entry.name === 'error-context');
  assert.deepEqual({ ...attachment }, { name: 'error-context', contentType: 'text/markdown', path: join(info.outputDirectory, 'error-context.md') });
}
function outcome(info) { return { errors: [...info.errors], status: info.status, expectedStatus: info.expectedStatus }; }
function assertOutcome(info, original) {
  assert.deepEqual(info.errors, original.errors);
  for (let index = 0; index < original.errors.length; index++) assert.equal(info.errors[index], original.errors[index]);
  assert.equal(info.status, original.status);
  assert.equal(info.expectedStatus, original.expectedStatus);
}
function diagnostic(info) {
  const attachments = info.attachments.filter(entry => entry.name === 'error-context-error');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].contentType, 'text/plain');
  assert.ok(attachments[0].body.length <= 16 * 4096 * 4 + 1024);
  return attachments[0].body.toString();
}

try {
  await check('ordinary failure publishes the formatter document atomically with first-page fallback exactly once', async () => {
    const firstPage = page('first');
    const subject = context(firstPage, page('second'));
    const info = testInfo();
    Object.freeze(info.errors);
    const original = outcome(info);
    const captured = [];
    const scopes = new FailureContextScopes({ capture: async (subject, timeout) => {
      captured.push({ subject, timeout }); return '- heading "Failing page"';
    } });
    scopes.start(info, [subject]);
    scopes.start(info, [subject]);
    const completion = scopes.finish(info, [subject]);
    assert.equal(scopes.finish(info, [subject]), completion);
    await completion;
    await scopes.finish(info, [subject]);
    await scopes.beforeContextClose(subject);
    scopes.start(info, [subject]);
    await scopes.finish(info, [subject]);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].subject, firstPage);
    assert.ok(captured[0].timeout > 0 && captured[0].timeout <= 5000);
    assert.deepEqual(info.outputCalls, ['error-context.md']);
    assert.equal(info.attachments.length, 1);
    await assertDocument(info, '- heading "Failing page"');
    const write = writes.at(-1);
    const rename = renames.at(-1);
    assert.notEqual(write.path, rename.destination);
    assert.equal(write.path, rename.source);
    assert.equal(write.options.flag, 'wx');
    assert.deepEqual(await filesystem.readdir(info.outputDirectory), ['error-context.md']);
    assertOutcome(info, original);
  });

  await check('successful attempts publish no file while expected failures still retain their errors and document', async () => {
    for (const options of [{ errors: [], status: 'passed' }, { expectedStatus: 'failed' }]) {
      const info = testInfo(options);
      const subject = context(page('expected failure'));
      const original = outcome(info);
      let captures = 0;
      const scopes = new FailureContextScopes({ capture: async () => { captures++; return '- main: expected'; } });
      scopes.start(info, [subject]);
      await scopes.beforeContextClose(subject);
      await scopes.finish(info, [subject]);
      if (info.errors.length) { assert.equal(captures, 1); await assertDocument(info, '- main: expected'); }
      else { assert.equal(captures, 0); await assertNoDocument(info); }
      assertOutcome(info, original);
    }
  });

  await check('truthy PLAYWRIGHT_NO_COPY_PROMPT suppresses only fallback, retaining instructions and publication', async () => {
    try {
      for (const value of ['1', '0']) {
        process.env.PLAYWRIGHT_NO_COPY_PROMPT = value;
        const info = testInfo();
        const subject = context(page('suppressed'));
        const scopes = new FailureContextScopes({ capture: async () => { assert.fail('no-copy capture'); } });
        scopes.start(info, [subject]);
        await scopes.beforeContextClose(subject);
        await scopes.finish(info, [subject]);
        await assertDocument(info, undefined);
        assert.match(await document(info), /# Instructions/);
      }
    } finally { delete process.env.PLAYWRIGHT_NO_COPY_PROMPT; }
  });

  await check('matcher diagnostics suppress fallback and empty matcher text remains eligible', async () => {
    for (const diagnostic of ['- button "Matcher target"', '']) {
      const info = testInfo({ errors: [Object.freeze({ message: 'matcher failed', errorContext: diagnostic })] });
      const subject = context(page('matcher'));
      let captures = 0;
      const scopes = new FailureContextScopes({ capture: async () => { captures++; return '- main: fallback'; } });
      scopes.start(info, [subject]);
      await scopes.finish(info, [subject]);
      assert.equal(captures, diagnostic ? 0 : 1);
      await assertDocument(info, diagnostic ? undefined : '- main: fallback');
    }
  });

  await check('first leftover context with no page, empty capture, or rejected capture does not scan another context', async () => {
    for (const result of ['no-page', 'empty', 'error']) {
      const info = testInfo();
      const first = result === 'no-page' ? context() : context(page('first'));
      const second = context(page('must not scan'));
      let captures = 0;
      const scopes = new FailureContextScopes({ capture: async subject => {
        assert.equal(subject.name, 'first'); captures++;
        if (result === 'error') throw Error('optional snapshot failure');
        return '';
      } });
      scopes.start(info, [first, second]);
      await scopes.finish(info, [first, second]);
      assert.equal(captures, result === 'no-page' ? 0 : 1);
      await assertDocument(info, undefined);
      if (result === 'error') assert.match(diagnostic(info), /optional snapshot failure/);
      else assert.equal(info.attachments.length, 1);
    }
  });

  await check('empty and failed early-close snapshots allow a later owned context to supply fallback', async () => {
    const info = testInfo();
    const subjects = [context(page('empty')), context(page('error')), context(page('later'))];
    const captured = [];
    const scopes = new FailureContextScopes({ capture: async subject => {
      captured.push(subject.name);
      if (subject.name === 'error') throw Error('optional snapshot failure');
      return subject.name === 'empty' ? '' : '- main: later';
    } });
    scopes.start(info, subjects);
    await scopes.beforeContextClose(subjects[0]);
    await scopes.beforeContextClose(subjects[1]);
    await scopes.finish(info, subjects);
    assert.deepEqual(captured, ['empty', 'error', 'later']);
    await assertDocument(info, '- main: later');
    assert.match(diagnostic(info), /optional snapshot failure/);
  });

  await check('concurrent closes serialize capture and finish waits original work without duplicate publication', async () => {
    const first = deferred();
    const second = deferred();
    const info = testInfo();
    const subjects = [context(page('first')), context(page('second')), context(page('third')), context(page('leftover'))];
    const captured = [];
    let active = 0;
    let maximumActive = 0;
    const scopes = new FailureContextScopes({ capture: async subject => {
      maximumActive = Math.max(maximumActive, ++active);
      captured.push(subject.name);
      try { return await (subject.name === 'first' ? first.promise : second.promise); }
      finally { active--; }
    } });
    scopes.start(info, subjects);
    const closes = subjects.slice(0, 3).map(subject => scopes.beforeContextClose(subject));
    const completion = scopes.finish(info, subjects);
    assert.equal(scopes.finish(info, subjects), completion);
    let finished = false;
    void completion.then(() => { finished = true; });
    await turns();
    assert.deepEqual(captured, ['first']);
    assert.equal(finished, false);
    first.resolve('');
    await turns();
    assert.deepEqual(captured, ['first', 'second']);
    assert.equal(finished, false);
    second.resolve('- main: second');
    await Promise.all([...closes, completion]);
    assert.equal(maximumActive, 1);
    assert.deepEqual(captured, ['first', 'second']);
    assert.equal(info.attachments.length, 1);
    await assertDocument(info, '- main: second');
  });

  await check('late creation claims preserve the original attempt across retries and repeated older starts', async () => {
    const originalInfo = testInfo();
    const retryInfo = testInfo({ retry: 1 });
    const oldContext = context(page('original'));
    const retryContext = context(page('retry'));
    const captured = [];
    const scopes = new FailureContextScopes({ capture: async subject => { captured.push(subject.name); return `- main: ${subject.name}`; } });
    scopes.start(originalInfo, []);
    const originalClaim = scopes.claim();
    assert.equal(typeof originalClaim.didCreateContext, 'function');
    scopes.start(retryInfo, [retryContext]);
    scopes.start(originalInfo, []);
    const retryClaim = scopes.claim();
    originalClaim.didCreateContext(oldContext);
    const retryCreatedContext = context(page('retry created'));
    retryClaim.didCreateContext(retryCreatedContext);
    await scopes.beforeContextClose(oldContext);
    await scopes.finish(originalInfo, [retryContext, oldContext]);
    await scopes.finish(retryInfo, [oldContext, retryContext, retryCreatedContext]);
    assert.deepEqual(captured, ['original', 'retry']);
    await assertDocument(originalInfo, '- main: original');
    await assertDocument(retryInfo, '- main: retry');
  });

  await check('sealed old claims cannot retarget a successor; only explicit next start adopts surviving contexts', async () => {
    const originalInfo = testInfo();
    const successorInfo = testInfo();
    const survivor = context(page('survivor'));
    const lateContext = context(page('late old creation'));
    const captured = [];
    const scopes = new FailureContextScopes({ capture: async subject => { captured.push(subject.name); return `- main: ${subject.name}`; } });
    assert.equal(scopes.claim(), undefined);
    scopes.start(originalInfo, [survivor]);
    const oldClaim = scopes.claim();
    await scopes.finish(originalInfo, []);
    scopes.start(successorInfo, [survivor]);
    oldClaim.didCreateContext(lateContext);
    oldClaim.didCreateContext(survivor);
    await scopes.beforeContextClose(lateContext);
    await scopes.finish(successorInfo, [lateContext, survivor]);
    assert.deepEqual(captured, ['survivor']);
    await assertDocument(originalInfo, undefined);
    await assertDocument(successorInfo, '- main: survivor');
  });

  await check('a successor cannot capture another still-active attempt context or an unclaimed context', async () => {
    const originalInfo = testInfo();
    const successorInfo = testInfo();
    const originalContext = context(page('old owner'));
    const successorContext = context(page('new owner'));
    const unclaimedContext = context(page('unclaimed'));
    const scopes = new FailureContextScopes({ capture: async subject => `- main: ${subject.name}` });
    scopes.start(originalInfo, [originalContext]);
    scopes.start(successorInfo, [successorContext]);
    await scopes.finish(successorInfo, [originalContext, unclaimedContext, successorContext]);
    await scopes.finish(originalInfo, [successorContext, originalContext]);
    await assertDocument(originalInfo, '- main: old owner');
    await assertDocument(successorInfo, '- main: new owner');
  });

  await check('overlapping finalization retains original captures while a successful successor remains clean', async () => {
    const pending = deferred();
    const originalInfo = testInfo();
    const successorInfo = testInfo({ errors: [], status: 'passed' });
    const originalContext = context(page('old in flight'));
    const successorContext = context(page('successful successor'));
    const captured = [];
    const scopes = new FailureContextScopes({ capture: async subject => { captured.push(subject.name); return pending.promise; } });
    scopes.start(originalInfo, [originalContext]);
    const closing = scopes.beforeContextClose(originalContext);
    const completion = scopes.finish(originalInfo, []);
    scopes.start(successorInfo, [successorContext]);
    await scopes.beforeContextClose(successorContext);
    await scopes.finish(successorInfo, []);
    await assertNoDocument(successorInfo);
    pending.resolve('- main: original late capture');
    await Promise.all([closing, completion]);
    assert.deepEqual(captured, ['old in flight']);
    await assertDocument(originalInfo, '- main: original late capture');
  });

  await check('one cumulative deadline includes failed captures and prevents dispatch after exhaustion', async () => {
    const info = testInfo();
    const subjects = [context(page('first')), context(page('second')), context(page('third')), context(page('leftover'))];
    let time = 100;
    const captures = [];
    const scopes = new FailureContextScopes({ now: () => time, capture: async (subject, remaining) => {
      captures.push({ name: subject.name, remaining });
      time += subject.name === 'first' ? 3000 : 2000;
      throw Error('bounded capture cancellation settled');
    } });
    scopes.start(info, subjects);
    const closes = subjects.slice(0, 3).map(subject => scopes.beforeContextClose(subject));
    await Promise.all(closes);
    await scopes.finish(info, subjects);
    assert.deepEqual(captures, [{ name: 'first', remaining: 5000 }, { name: 'second', remaining: 2000 }]);
    await assertDocument(info, undefined);
    assert.match(diagnostic(info), /five-second attempt capture deadline exhausted/);
  });

  await check('matcher context arriving during fallback suppresses the retained page snapshot at publication', async () => {
    const pending = deferred();
    const info = testInfo();
    const subject = context(page('late matcher'));
    const scopes = new FailureContextScopes({ capture: async () => pending.promise });
    scopes.start(info, [subject]);
    const close = scopes.beforeContextClose(subject);
    await turns();
    info.errors.push(Object.freeze({ message: 'later matcher failure', errorContext: '- button "Original matcher"' }));
    const completion = scopes.finish(info, []);
    pending.resolve('- main: obsolete fallback');
    await Promise.all([close, completion]);
    await assertDocument(info, undefined);
    assert.equal((await document(info)).includes('obsolete fallback'), false);
  });

  await check('page collection getters and mutation are observed only on the original owned context', async () => {
    const info = testInfo();
    const throwing = { pages() { throw Error('closed collection unavailable'); } };
    const currentPages = [page('old page')];
    const mutable = { pages: () => currentPages };
    const scopes = new FailureContextScopes({ capture: async subject => `- main: ${subject.name}` });
    scopes.start(info, [throwing, mutable]);
    await scopes.beforeContextClose(throwing);
    currentPages.splice(0, 1, page('current page'));
    await scopes.finish(info, [throwing, mutable]);
    await assertDocument(info, '- main: current page');
    assert.match(diagnostic(info), /closed collection unavailable/);
    const getterInfo = testInfo({ errors: [Object.freeze({ message: 'getter failure', get errorContext() { throw Error('optional getter failed'); } })] });
    const original = outcome(getterInfo);
    scopes.start(getterInfo, [mutable]);
    await scopes.beforeContextClose(mutable);
    await scopes.finish(getterInfo, [mutable]);
    assertOutcome(getterInfo, original);
    assert.match(diagnostic(getterInfo), /optional getter failed/);
  });

  await check('pending close admission is bounded and omitted fallback work is visible in one diagnostic attachment', async () => {
    const pending = deferred();
    const info = testInfo();
    const subjects = Array.from({ length: 130 }, (_, index) => context(page(`page ${index}`)));
    let captures = 0;
    const scopes = new FailureContextScopes({ capture: async () => { captures++; return pending.promise; } });
    scopes.start(info, subjects);
    const closes = subjects.map(subject => scopes.beforeContextClose(subject));
    const completion = scopes.finish(info, subjects);
    pending.resolve('- main: bounded');
    await Promise.all([...closes, completion]);
    assert.equal(captures, 1);
    const diagnostic = info.attachments.filter(entry => entry.name === 'error-context-error');
    assert.equal(diagnostic.length, 1);
    assert.match(diagnostic[0].body.toString(), /omitted.*128 pending captures/);
    assert.ok(diagnostic[0].body.length < 256);
    await assertDocument(info, '- main: bounded');
  });

  await check('large callback snapshots remain bounded and explicitly marked without changing errors', async () => {
    const info = testInfo();
    const subject = context(page('large'));
    const original = outcome(info);
    const scopes = new FailureContextScopes({ capture: async () => 'λ😀'.repeat(100000) });
    scopes.start(info, [subject]);
    await scopes.finish(info, [subject]);
    const markdown = await document(info);
    assert.ok(Buffer.byteLength(markdown) <= formatter.maximumFailureContextBytes);
    assert.match(markdown, /Diagnostic truncated/);
    assertOutcome(info, original);
  });

  await check('publication write, rename, formatter and attachment failures preserve the originating outcome', async () => {
    for (const failure of ['write', 'rename', 'format', 'attachment']) {
      const info = testInfo();
      const original = outcome(info);
      await filesystem.mkdir(info.outputDirectory);
      await filesystem.writeFile(join(info.outputDirectory, 'error-context.md'), 'previous complete artifact');
      const subject = context(page('optional publication'));
      const scopes = new FailureContextScopes({ capture: async () => '- main: captured' });
      scopes.start(info, [subject]);
      publicationFailure = failure;
      formattingFailure = failure === 'format';
      if (failure === 'attachment') info.attachments.push = () => { throw Error('reporter attachment failure'); };
      try {
        const completion = scopes.finish(info, [subject]);
        await completion;
        assert.equal(scopes.finish(info, [subject]), completion);
      } finally { publicationFailure = undefined; formattingFailure = false; }
      assertOutcome(info, original);
      if (failure === 'attachment') assert.equal(info.attachments.length, 0);
      else assert.match(diagnostic(info), failure === 'format' ? /optional formatter failure/ : /publication.*failure/);
      assert.deepEqual(await filesystem.readdir(info.outputDirectory), ['error-context.md']);
      if (failure !== 'attachment') assert.equal(await document(info), 'previous complete artifact');
      else assert.match(await document(info), /# Page snapshot/);
    }
  });

  await check('errors with no meaningful message or snapshot do not publish an empty document', async () => {
    const info = testInfo({ errors: [Object.freeze({})] });
    const scopes = new FailureContextScopes({ capture: async () => '' });
    scopes.start(info, []);
    await scopes.finish(info, []);
    await assertNoDocument(info);
  });

  report.status = 'passed';
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
  await filesystem.rm(directory, { recursive: true, force: true });
}
