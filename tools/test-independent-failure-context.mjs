import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import filesystem from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = resolve(import.meta.dirname, '..');
const directory = await filesystem.mkdtemp(join(root, 'workbench/independent-output-tests-'));
const filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const modules = new Map();
let failDocumentWrite = false;
let snapshotReadBytes = 0;
const measuredFilesystem = {
  ...filesystem,
  async writeFile(path, ...args) {
    if (failDocumentWrite && String(path).includes('error-context.md.')) throw Error('injected optional document write failure');
    return filesystem.writeFile(path, ...args);
  },
  async open(path, ...args) {
    const file = await filesystem.open(path, ...args);
    if (!String(path).includes('attachments')) return file;
    return {
      stat: () => file.stat(), close: () => file.close(),
      async read(buffer, offset, length, position) {
        const result = await file.read(buffer, offset, length, position);
        snapshotReadBytes += result.bytesRead;
        return result;
      },
    };
  },
};

/** Exercise current source while a peer owns package builds; fail on any upstream runtime import. */
async function loadSource(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const source = await filesystem.readFile(file, 'utf8');
  const compiled = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }, fileName: file, reportDiagnostics: true });
  assert.equal(compiled.diagnostics?.length, 0);
  const module = { exports: {} }; modules.set(file, module);
  const dependencies = new Map();
  for (const match of compiled.outputText.matchAll(/require\("([^"\n]+)"\)/g)) {
    const specifier = match[1];
    if (specifier === './tracing.js') dependencies.set(specifier, { runIndependentTraceStep: (_info, _title, callback) => callback() });
    else if (specifier.startsWith('.')) dependencies.set(specifier, await loadSource(resolve(dirname(file), specifier.replace(/\.js$/, '.ts'))));
  }
  const scopedRequire = specifier => {
    if (dependencies.has(specifier)) return dependencies.get(specifier);
    if (specifier === 'node:fs/promises') return measuredFilesystem;
    if (specifier === '@flashwright/core') return { failure(name, method, message) { return Object.assign(new Error(`${method}: ${message}`), { name }); } };
    assert.ok(!/upstream|playwright/.test(specifier), `Forbidden runtime import: ${specifier}`);
    return require(specifier);
  };
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, require: scopedRequire, __filename: file, __dirname: dirname(file), process, Buffer, Error, AggregateError, AbortController, performance, setTimeout, clearTimeout, setImmediate, queueMicrotask }, { filename: file });
  return module.exports;
}
const { SuiteCollector } = await loadSource(join(root, 'packages/flashwright-runner/src/independent/suite-collector.ts'));
const { SuiteWorker } = await loadSource(join(root, 'packages/flashwright-runner/src/independent/suite-runtime.ts'));
const { beginOutput, finishOutput, currentIndependentInfo } = await loadSource(join(root, 'packages/flashwright-runner/src/independent/output.ts'));
const { maximumFailureContextBytes, maximumFailureContextDiagnosticCharacters } = await loadSource(join(root, 'packages/flashwright-runner/src/failure-context-format.ts'));
let ordinal = 0;
async function run(declare, finalize) {
  const collector = new SuiteCollector(), api = collector.createTest();
  await collector.collect(filename, () => declare(api));
  const tests = collector.seal();
  const worker = new SuiteWorker(tests[0].pool), outputRoot = join(directory, String(++ordinal));
  const output = await worker.run(tests, { onBegin: (test, info) => beginOutput(test, info, outputRoot), onResult: result => finishOutput(result, finalize) });
  await worker.close();
  const attempts = [];
  for (const subdirectory of await filesystem.readdir(outputRoot)) {
    const path = join(outputRoot, subdirectory);
    const record = JSON.parse(await filesystem.readFile(join(path, 'attempt.json'), 'utf8'));
    const attachment = record.attachments.find(value => value.name === 'error-context');
    attempts.push({ record, path, document: attachment && await filesystem.readFile(attachment.path, 'utf8') });
  }
  return { tests, output, attempts };
}

test('declarations, original failure source/caret, matcher YAML and finalize attachments retain one attempt', async () => {
  let original;
  const previous = Error.prepareStackTrace;
  const collector = new SuiteCollector(), api = collector.createTest();
  Error.prepareStackTrace = () => { throw Error('caller formatter must not run for declarations'); };
  try { await collector.collect(filename, () => api('declaration', () => {})); }
  finally { Error.prepareStackTrace = previous; }
  assert.equal(collector.seal()[0].location.file, filename);
  assert.ok(collector.seal()[0].location.line > 0);
  const result = await run(api => {
    api('original failure', async () => {
      await currentIndependentInfo().attach('accepted input', { body: 'user attachment' });
      original = new Error('original assertion failed');
      original.matcherResult = { ariaSnapshot: '- button "Original observation"' };
      throw original;
    });
  }, async info => {
    assert.ok(info.line > 0 && info.column > 0);
    assert.equal(info.attachments.filter(attachment => attachment.name === 'error-context').length, 1);
    assert.equal(info.attachments.filter(attachment => attachment.name === 'accepted input').length, 1);
    info.attachments.push({ name: 'trace-finalized', path: 'trace.zip', contentType: 'application/zip' });
  });
  assert.equal(result.output.results[0].errors[0].error, original);
  assert.equal(result.output.results[0].status, 'failed');
  const attempt = result.attempts[0];
  assert.match(attempt.document, /# Test info/);
  assert.match(attempt.document, /# Test source/);
  assert.match(attempt.document, /\^ original assertion failed/);
  assert.match(attempt.document, /Original observation/);
  assert.match(attempt.document, /original = new Error\('original assertion failed'\)/);
  assert.equal(attempt.record.location.line, result.tests[0].location.line);
  assert.equal(attempt.record.errors[0].message, original.message);
  assert.equal(attempt.record.errors[0].stack, original.stack);
  assert.equal(attempt.record.attachments.at(-1).name, 'trace-finalized');
  assert.ok(!(await filesystem.readdir(attempt.path)).some(name => name.endsWith('.tmp')));
});

test('large errors and fallback attachments produce explicitly bounded failure documents', async () => {
  snapshotReadBytes = 0;
  const result = await run(api => api('bounded failure', async () => {
    await currentIndependentInfo().attach('page-snapshot', { body: '- text: ' + 'λ😀'.repeat(maximumFailureContextBytes) });
    throw new Error('large message ' + '😀'.repeat(maximumFailureContextBytes));
  }));
  assert.ok(Buffer.byteLength(result.attempts[0].document) <= maximumFailureContextBytes);
  assert.match(result.attempts[0].document, /[Tt]runcated/);
  assert.match(result.attempts[0].document, /# Page snapshot/);
  assert.ok(snapshotReadBytes > 0 && snapshotReadBytes <= (maximumFailureContextDiagnosticCharacters + 1) * 3);
  assert.ok(result.attempts[0].record.errors[0].message.length <= maximumFailureContextDiagnosticCharacters + 1);
});

test('optional failure-document writes preserve expected failures and still finalize artifacts', async () => {
  let finalized = false;
  failDocumentWrite = true;
  let result;
  try { result = await run(api => api.fail('expected failure', () => { throw new Error('original expected failure'); }), async () => { finalized = true; }); }
  finally { failDocumentWrite = false; }
  assert.equal(finalized, true);
  assert.equal(result.output.results[0].expectedStatus, 'failed');
  assert.equal(result.output.results[0].errors[0].error.message, 'original expected failure');
  assert.equal(result.attempts[0].document, undefined);
  assert.match(result.attempts[0].record.failureContextErrors[0], /injected optional document write failure/);
  assert.ok(!(await filesystem.readdir(result.attempts[0].path)).some(name => name.endsWith('.tmp')));
});

test('a passing successor has no inherited errors, source frame or document', async () => {
  const result = await run(api => api('clean successor', () => {}));
  assert.equal(result.output.results[0].status, 'passed');
  assert.equal(result.attempts[0].document, undefined);
  assert.deepEqual(result.attempts[0].record.errors, []);
  assert.deepEqual(result.attempts[0].record.attachments, []);
});

test('custom error getters and coercion hooks are omitted without losing data messages', async () => {
  let reads = 0;
  const original = new Error('safe original message');
  Object.defineProperty(original, 'stack', { get() { reads++; throw new Error('custom stack getter'); } });
  original.toString = () => { reads++; throw new Error('custom coercion'); };
  const result = await run(api => api('safe error data', () => { throw original; }));
  assert.equal(reads, 0);
  assert.equal(result.output.results[0].errors[0].error, original);
  assert.equal(result.attempts[0].record.errors[0].message, 'safe original message');
  assert.match(result.attempts[0].document, /safe original message/);
});
