import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SuiteCollector } from '../packages/flashwright-runner/dist/commonjs/independent/suite-collector.js';
import { SuiteWorker } from '../packages/flashwright-runner/dist/commonjs/independent/suite-runtime.js';
import { beginOutput, finishOutput, currentIndependentInfo, independentStep } from '../packages/flashwright-runner/dist/commonjs/independent/output.js';

const workbench = path.resolve('workbench');
await mkdir(workbench, { recursive: true });

async function fixture(body) {
  const root = await mkdtemp(path.join(workbench, 'independent-output-'));
  try { await body(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function collect(root, declare) {
  const collector = new SuiteCollector();
  const api = collector.createTest();
  await collector.collect(path.join(root, 'output.spec.ts'), () => declare(api));
  return collector.seal();
}

const options = root => ({ onBegin: (planned, info) => beginOutput(planned, info, root), onResult: finishOutput });
const attemptRecord = info => readFile(path.join(info.outputDir, 'attempt.json'), 'utf8').then(JSON.parse);

test('outputPath creates fresh retry directories for immediate writes and rejects traversal before effects', async () => fixture(async root => {
  const infos = [];
  const tests = await collect(root, test => test('fresh attempt', () => {
    const info = currentIndependentInfo();
    infos.push(info);
    assert.equal(existsSync(info.outputDir), false);
    const outside = path.join(root, 'escaped', 'outside.txt');
    assert.throws(() => info.outputPath('..', 'escaped', 'outside.txt'), { name: 'InvalidArgumentError' });
    assert.throws(() => info.outputPath(outside), { name: 'InvalidArgumentError' });
    assert.equal(existsSync(info.outputDir), false);
    assert.equal(existsSync(path.dirname(outside)), false);
    const file = info.outputPath('immediate.txt');
    writeFileSync(file, `retry ${info.retry}`);
  }));
  const worker = new SuiteWorker(tests[0].pool);
  try {
    for (const retry of [0, 1]) {
      const result = await worker.run(tests, { ...options(root), retries: new Map([[tests[0].id, retry]]) });
      assert.deepEqual(result.results.map(result => result.status), ['passed']);
      assert.deepEqual(result.teardownErrors, []);
    }
  } finally { assert.deepEqual(await worker.close(), []); }
  assert.notEqual(infos[0].outputDir, infos[1].outputDir);
  for (const info of infos) {
    assert.equal(await readFile(path.join(info.outputDir, 'immediate.txt'), 'utf8'), `retry ${info.retry}`);
    assert.equal((await attemptRecord(info)).retry, info.retry);
  }
  await assert.rejects(access(path.join(root, 'escaped')), { code: 'ENOENT' });
}));

test('body and path attachments preserve bytes and drain accepted unawaited work before publication', async () => fixture(async root => {
  const source = path.join(root, 'source.bin');
  const sourceBytes = Buffer.from([0, 255, 13, 10, 128, 1]);
  const binaryBytes = Buffer.from([0, 1, 255, 254]);
  const pendingBytes = Buffer.alloc(1024 * 1024, 0xa5);
  await writeFile(source, sourceBytes);
  let info, settled = false;
  const tests = await collect(root, test => test('attachment contents', async () => {
    info = currentIndependentInfo();
    await info.attach('unicode text', { body: 'snowman ☃\n', contentType: 'text/plain; charset=utf-8' });
    await info.attach('binary payload', { body: binaryBytes });
    await info.attach('copied source', { path: source, contentType: 'application/custom' });
    const suppliedBytes = Buffer.from(pendingBytes);
    const pending = info.attach('unawaited payload', { body: suppliedBytes });
    suppliedBytes.fill(0);
    void pending.then(() => { settled = true; });
    assert.equal(settled, false);
    assert.equal(info.attachments.some(attachment => attachment.name === 'unawaited payload'), false);
  }));
  const worker = new SuiteWorker(tests[0].pool);
  try {
    const result = await worker.run(tests, options(root));
    assert.equal(result.results[0].status, 'passed');
  } finally { assert.deepEqual(await worker.close(), []); }
  assert.equal(settled, true);
  const record = await attemptRecord(info);
  assert.deepEqual(record.attachmentErrors, []);
  assert.deepEqual(record.attachments.map(attachment => attachment.name), ['unicode text', 'binary payload', 'copied source', 'unawaited payload']);
  const expected = [Buffer.from('snowman ☃\n'), binaryBytes, sourceBytes, pendingBytes];
  for (const [index, attachment] of record.attachments.entries()) {
    assert.deepEqual(await readFile(attachment.path), expected[index]);
    assert.ok(attachment.path.startsWith(info.outputDir + path.sep));
  }
  assert.deepEqual(record.attachments.map(attachment => attachment.contentType), ['text/plain; charset=utf-8', 'application/octet-stream', 'application/custom', 'application/octet-stream']);
}));

test('saved attachment methods reject after their attempt ends and cannot join a successor', async () => fixture(async root => {
  let original, successor;
  const tests = await collect(root, test => {
    test('original', async () => {
      original = currentIndependentInfo();
      await original.attach('original bytes', { body: 'first' });
    });
    test('successor', async () => {
      successor = currentIndependentInfo();
      await assert.rejects(original.attach('stale bytes', { body: 'must not publish' }), { name: 'InvalidArgumentError' });
      await successor.attach('successor bytes', { body: 'second' });
    });
  });
  const worker = new SuiteWorker(tests[0].pool);
  try {
    const result = await worker.run(tests, options(root));
    assert.deepEqual(result.results.map(result => result.status), ['passed', 'passed']);
  } finally { assert.deepEqual(await worker.close(), []); }
  await assert.rejects(original.attach('after close', { body: 'must not publish' }), { name: 'InvalidArgumentError' });
  assert.deepEqual((await attemptRecord(original)).attachments.map(attachment => attachment.name), ['original bytes']);
  assert.deepEqual((await attemptRecord(successor)).attachments.map(attachment => attachment.name), ['successor bytes']);
}));

test('ignored attachment copy rejection remains a publication failure with retained diagnostics', async () => fixture(async root => {
  let info;
  const tests = await collect(root, test => test('ignored missing attachment', () => {
    info = currentIndependentInfo();
    // The output owner attaches its own rejection handler and must retain this
    // failure even when the user never awaits or catches the returned promise.
    void info.attach('missing source', { path: path.join(root, 'missing.bin') });
  }));
  const worker = new SuiteWorker(tests[0].pool);
  try {
    await assert.rejects(worker.run(tests, options(root)), error => error instanceof AggregateError && error.message === 'Attachment publication failed' && error.errors.some(cause => cause.code === 'ENOENT'));
  } finally { assert.deepEqual(await worker.close(), []); }
  const record = await attemptRecord(info);
  assert.deepEqual(record.attachments, []);
  assert.equal(record.attachmentErrors.length, 1);
  assert.match(record.attachmentErrors[0], /ENOENT/);
}));

test('failed body retains its original error alongside attached page snapshot in error-context', async () => fixture(async root => {
  let info;
  const originalError = new Error('original body sentinel');
  const snapshot = '- heading "Snapshot sentinel"\n- button "Save"';
  const tests = await collect(root, test => test('failed body with snapshot', async () => {
    info = currentIndependentInfo();
    await info.attach('page-snapshot', { body: snapshot, contentType: 'text/yaml' });
    throw originalError;
  }));
  const worker = new SuiteWorker(tests[0].pool);
  try {
    const result = await worker.run(tests, options(root));
    assert.equal(result.results[0].status, 'failed');
    assert.deepEqual(result.results[0].errors.map(failure => failure.phase), ['body']);
    assert.equal(result.results[0].errors[0].error, originalError);
  } finally { assert.deepEqual(await worker.close(), []); }
  const record = await attemptRecord(info);
  const context = record.attachments.find(attachment => attachment.name === 'error-context');
  assert.equal(context.contentType, 'text/markdown');
  assert.equal(path.basename(context.path), 'error-context.md');
  const document = await readFile(context.path, 'utf8');
  assert.ok(document.includes(originalError.stack));
  assert.ok(document.includes(snapshot));
  assert.match(document, /## Failure/);
  assert.match(document, /## Page snapshot/);
  assert.ok(document.includes(tests[0].file));
}));

test('nested steps preserve return identity and record original parent indices', async () => fixture(async root => {
  let info;
  const returned = { value: 'original return object' };
  const tests = await collect(root, test => test('nested step results', async () => {
    info = currentIndependentInfo();
    const result = await independentStep('outer', async () => {
      assert.equal(await independentStep('sync child', () => 42), 42);
      return independentStep('async child', async () => {
        await Promise.resolve();
        return independentStep('grandchild', () => returned);
      });
    });
    assert.equal(result, returned);
    assert.equal(await independentStep('next root', () => 'root value'), 'root value');
  }));
  const worker = new SuiteWorker(tests[0].pool);
  try {
    const result = await worker.run(tests, options(root));
    assert.equal(result.results[0].status, 'passed');
  } finally { assert.deepEqual(await worker.close(), []); }
  const record = await attemptRecord(info);
  assert.deepEqual(record.steps.map(step => [step.title, step.parent, step.status]), [
    ['outer', null, 'passed'], ['sync child', 0, 'passed'], ['async child', 0, 'passed'], ['grandchild', 2, 'passed'], ['next root', null, 'passed'],
  ]);
  for (const step of record.steps) {
    assert.equal(Number.isFinite(step.started), true);
    assert.equal(Number.isFinite(step.duration), true);
    assert.ok(step.duration >= 0);
  }
}));

test('nested failed steps retain the original thrown error in the body result', async () => fixture(async root => {
  let info;
  const originalError = new Error('original nested step error');
  const tests = await collect(root, test => test('nested step failure', async () => {
    info = currentIndependentInfo();
    await independentStep('outer failure', async () => {
      await independentStep('inner failure', () => { throw originalError; });
    });
  }));
  const worker = new SuiteWorker(tests[0].pool);
  try {
    const result = await worker.run(tests, options(root));
    assert.equal(result.results[0].status, 'failed');
    assert.deepEqual(result.results[0].errors.map(failure => failure.phase), ['body']);
    assert.equal(result.results[0].errors[0].error, originalError);
  } finally { assert.deepEqual(await worker.close(), []); }
  const record = await attemptRecord(info);
  assert.deepEqual(record.steps.map(step => [step.title, step.parent, step.status, step.error]), [
    ['outer failure', null, 'failed', String(originalError)], ['inner failure', 0, 'failed', String(originalError)],
  ]);
  const context = record.attachments.find(attachment => attachment.name === 'error-context');
  assert.ok((await readFile(context.path, 'utf8')).includes(originalError.stack));
}));

test('defined step options reject before callback effects or step publication', async () => fixture(async root => {
  let info, effects = 0;
  const tests = await collect(root, test => test('unsupported step options', async () => {
    info = currentIndependentInfo();
    for (const option of [{}, { timeout: 1 }, { box: true }, null, false, 'option']) {
      await assert.rejects(independentStep('must not execute', () => { effects++; }, option), error => error.name === 'UnsupportedFeatureError' && error.details.method === 'test.step.options');
    }
    await assert.rejects(independentStep('extra option', () => { effects++; }, undefined, { timeout: 1 }), { name: 'UnsupportedFeatureError' });
    assert.equal(effects, 0);
    assert.equal(await independentStep('undefined option', () => { effects++; return 'accepted'; }, undefined), 'accepted');
  }));
  const worker = new SuiteWorker(tests[0].pool);
  try {
    const result = await worker.run(tests, options(root));
    assert.equal(result.results[0].status, 'passed');
  } finally { assert.deepEqual(await worker.close(), []); }
  assert.equal(effects, 1);
  assert.deepEqual((await attemptRecord(info)).steps.map(step => [step.title, step.status]), [['undefined option', 'passed']]);
}));
