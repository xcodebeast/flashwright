import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants as filesystemConstants } from 'node:fs';
import filesystem from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import typescript from 'typescript';

const require = createRequire(import.meta.url);
const referenceDirectory = dirname(require.resolve('playwright/package.json'));
const upstreamRequire = createRequire(join(referenceDirectory, 'package.json'));
const { buildErrorContext } = upstreamRequire('./lib/errorContext.js');
const sourcePath = resolve('packages/flashwright-runner/src/failure-context-format.ts');
const source = await filesystem.readFile(sourcePath, 'utf8');
const compiled = typescript.transpileModule(source, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  fileName: sourcePath,
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length, 0);
const observations = { opens: [], reads: [], closes: 0 };
let failSourceRead = false;
const measuredFilesystem = {
  async open(path, flags) {
    observations.opens.push({ path, flags });
    const file = await filesystem.open(path, flags);
    return {
      stat: () => file.stat(),
      read: async (buffer, offset, length, position) => {
        observations.reads.push({ bufferBytes: buffer.length, length });
        if (failSourceRead)
          throw Error('injected source read failure');
        return file.read(buffer, offset, length, position);
      },
      close: async () => { observations.closes++; await file.close(); },
    };
  },
};
const scopedRequire = name => {
  if (name === './upstream-runtime.js')
    throw new Error('Failure-context formatting must not initialize the upstream runtime');
  if (name === 'node:fs/promises')
    return measuredFilesystem;
  return require(name);
};
const module = { exports: {} };
vm.runInNewContext(compiled.outputText, { exports: module.exports, module, require: scopedRequire, Buffer, process }, { filename: sourcePath });
const {
  buildFailureContext,
  parseFailureContextLocation,
  maximumFailureContextBytes,
  maximumFailureContextDiagnosticCharacters,
  maximumFailureContextErrors,
  maximumFailureContextStackLines,
  maximumFailureContextSourceBytes,
  maximumFailureContextSourceCharacters,
  failureContextSourceReadBytes,
} = module.exports;
const directory = await filesystem.mkdtemp(join(tmpdir(), 'flashwright-failure-context-'));
const report = { status: 'running', runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, checks: [] };

async function check(name, callback) {
  await callback();
  report.checks.push(name);
}

const location = file => ({ file, line: 150, column: 7 });
const error = (file, message = 'Error: meaningful failure', line = 150, column = 7) => ({
  message,
  stack: `${message}\n    at testBody (${file}:${line}:${column})`,
});
const options = (file, errors = [error(file)]) => ({
  titlePath: ['suite', 'nested title', 'fails meaningfully'],
  location: location(file),
  errors,
});
function assertBounded(markdown) {
  assert.ok(Buffer.byteLength(markdown) <= maximumFailureContextBytes);
}

try {
  await check('independent stack locations preserve pinned Node, Bun, file URL, Windows, eval and parenthesized paths', async () => {
    const { parseErrorStack } = upstreamRequire('playwright-core/lib/coreBundle').iso;
    for (const [separator, stack] of [
      ['/', 'Error: failure\n    at callback (/tmp/test.ts:21:9)'],
      ['/', 'Error: failure\n    at /tmp/test.ts:21:9'],
      ['/', 'Error: failure\n    at callback (file:///tmp/source%20%CE%BB.ts:21:9)'],
      ['\\', 'Error: failure\n    at callback (file:///C:/test%20source/spec.ts:21:9)'],
      ['\\', 'Error: failure\n    at callback (C:\\project\\test.ts:21:9)'],
      ['/', 'Error: failure\n    at callback (/tmp/folder (copy)/test.ts:21:9)'],
      ['/', 'Error: failure\n    at callback (eval at compute (/tmp/outer.ts:1:2), /tmp/test.ts:21:9)'],
      ['/', 'Error: failure\n    at process.nextTick (node:internal/process:10:1)\n    at helper (/tmp/node_modules/helper/index.js:2:3)\n    at callback (/tmp/test.ts:21:9)'],
      ['/', 'Error: no stack frame'],
    ]) {
      const actual = parseFailureContextLocation(stack, separator);
      assert.deepEqual(actual && JSON.parse(JSON.stringify(actual)), parseErrorStack(stack, separator).location);
    }
  });
  const ordinarySource = join(directory, 'ordinary-source.ts');
  await filesystem.writeFile(ordinarySource, Array.from({ length: 350 }, (_, index) => `const value${index + 1} = 'line λ😀 ${index + 1}';`).join('\n'));

  await check('ordinary 201-line frame, title, location and copy prompt exactly match the pinned formatter', async () => {
    const input = { ...options(ordinarySource), pageSnapshot: '- heading "A failing page"' };
    assert.equal(await buildFailureContext(input), buildErrorContext(input));
    const frame = (await buildFailureContext(input)).split('```ts\n')[1].split('\n```')[0];
    assert.equal(frame.split('\n').length, 202);
    assert.match(frame, /> 150 \|/);
    assert.match(frame, /  50  \|/);
    assert.match(frame, /  250 \|/);
  });

  await check('ANSI message removal, multiline messages and matcher YAML match the reference', async () => {
    const failure = { ...error(ordinarySource, '\u001b[31mError: expected value\u001b[39m\nsecond line'), errorContext: '- button "Submit"\n  - text: mismatch' };
    const input = { ...options(ordinarySource, [failure]), pageSnapshot: '- main: "Page"' };
    const actual = await buildFailureContext(input);
    assert.equal(actual, buildErrorContext(input));
    assert.equal(actual.includes('\u001b'), false);
  });

  await check('the last meaningful error selects source while empty errors and absent page snapshots preserve reference output', async () => {
    const input = options(ordinarySource, [error(ordinarySource, 'first failure', 40), { stack: 'ignored stack' }, error(ordinarySource, 'last failure', 310), { message: '' }]);
    assert.equal(await buildFailureContext(input), buildErrorContext(input));
    assert.match(await buildFailureContext(input), /> 310 \|/);
    for (const errors of [[], [{}], [{ message: '' }]])
      assert.equal(await buildFailureContext(options(ordinarySource, errors)), undefined);
    const snapshotOnly = { ...options(ordinarySource, [{}]), pageSnapshot: '- heading "Only snapshot"' };
    assert.equal(await buildFailureContext(snapshotOnly), buildErrorContext(snapshotOnly));
  });

  await check('source boundaries and trailing newlines match the reference', async () => {
    const shortSource = join(directory, 'short-source.ts');
    for (const content of ['', 'first', 'first\nsecond\n']) {
      await filesystem.writeFile(shortSource, content);
      const input = options(shortSource, [error(shortSource, 'short failure', 1, 1)]);
      assert.equal(await buildFailureContext(input), buildErrorContext(input));
    }
  });

  await check('shortened source retains the reference caret when the error line is beyond current EOF', async () => {
    const shortenedSource = join(directory, 'shortened-source.ts');
    await filesystem.writeFile(shortenedSource, 'first\nsecond');
    for (const line of [3, 150]) {
      const input = options(shortenedSource, [error(shortenedSource, 'failure before source shrank', line, 7)]);
      const actual = await buildFailureContext(input);
      assert.equal(actual, buildErrorContext(input));
      assert.match(actual, /\^ failure before source shrank/);
    }
  });

  await check('streamed source UTF-8 decoding matches the reference across chunk boundaries and invalid bytes', async () => {
    const unicodeSource = join(directory, 'unicode-source.ts');
    const bytes = Buffer.concat([Buffer.alloc(failureContextSourceReadBytes - 1, 120), Buffer.from('😀\nnext λ\n'), Buffer.from([0xff, 0xc0, 0xe2])]);
    await filesystem.writeFile(unicodeSource, bytes);
    // The long first line is outside this source window; decoding still crosses it.
    await filesystem.writeFile(unicodeSource, Buffer.concat([bytes, Buffer.from('\n'.repeat(150) + 'failure here\n')]));
    const input = options(unicodeSource, [error(unicodeSource, 'unicode failure', 153)]);
    assert.equal(await buildFailureContext(input), buildErrorContext(input));
    assert.ok(observations.reads.length > 1);
  });

  await check('missing and unreadable source omit the frame without replacing the failure', async () => {
    for (const file of [join(directory, 'missing.ts'), directory]) {
      const input = options(file);
      const actual = await buildFailureContext(input);
      if (file !== directory)
        assert.equal(actual, buildErrorContext(input));
      assert.match(actual, /meaningful failure/);
      assert.equal(actual.includes('# Test source'), false);
    }
  });

  await check('oversized source is rejected before any content read and states the omission', async () => {
    const largeSource = join(directory, 'oversized.ts');
    const file = await filesystem.open(largeSource, 'w');
    try { await file.truncate(maximumFailureContextSourceBytes + 1); } finally { await file.close(); }
    const readsBefore = observations.reads.length;
    const actual = await buildFailureContext(options(largeSource));
    assert.equal(observations.reads.length, readsBefore);
    assert.match(actual, /Test source omitted: file exceeds/);
    assert.match(actual, /meaningful failure/);
    assertBounded(actual);
  });

  await check('nonregular files and source read failures settle without replacing the original error', async () => {
    const pipe = join(directory, 'source-pipe');
    execFileSync('mkfifo', [pipe]);
    const readsBefore = observations.reads.length;
    const pipeResult = await buildFailureContext(options(pipe));
    assert.match(pipeResult, /meaningful failure/);
    assert.equal(pipeResult.includes('# Test source'), false);
    assert.equal(observations.reads.length, readsBefore);
    failSourceRead = true;
    try {
      const actual = await buildFailureContext(options(ordinarySource));
      assert.match(actual, /meaningful failure/);
      assert.equal(actual.includes('injected source read failure'), false);
      assert.equal(actual.includes('# Test source'), false);
    } finally { failSourceRead = false; }
  });

  await check('oversized source windows and extreme source columns omit frames explicitly', async () => {
    const largeLine = join(directory, 'large-line.ts');
    await filesystem.writeFile(largeLine, 'x'.repeat(maximumFailureContextSourceCharacters + 1));
    const actual = await buildFailureContext(options(largeLine, [error(largeLine, 'large line failure', 1)]));
    assert.match(actual, /Test source omitted: frame exceeds/);
    assertBounded(actual);
    const wideColumn = await buildFailureContext(options(ordinarySource, [error(ordinarySource, 'column failure', 150, Number.MAX_SAFE_INTEGER)]));
    assert.match(wideColumn, /Test source omitted: column exceeds/);
    assertBounded(wideColumn);
  });

  await check('large messages, matcher contexts, titles, paths and snapshots stay bounded with explicit truncation', async () => {
    const hugeText = 'λ😀'.repeat(maximumFailureContextBytes);
    const failures = Array.from({ length: maximumFailureContextErrors }, () => ({ message: hugeText, errorContext: hugeText }));
    for (const input of [
      options(ordinarySource, [{ message: hugeText }]),
      options(ordinarySource, [{ message: 'matcher failure', errorContext: hugeText }]),
      { ...options(ordinarySource, []), pageSnapshot: hugeText },
      { ...options(ordinarySource, []), titlePath: [hugeText], pageSnapshot: 'page' },
      { ...options(ordinarySource, []), location: location(hugeText), pageSnapshot: 'page' },
      options(ordinarySource, failures),
    ]) {
      const actual = await buildFailureContext(input);
      assertBounded(actual);
      assert.match(actual, /[Tt]runcated/);
    }
    assert.match(await buildFailureContext(options(ordinarySource, failures)), /Failure context truncated: diagnostic size limit reached/);
  });

  await check('many errors retain at most sixteen detail blocks and still select the final meaningful source', async () => {
    const failures = Array.from({ length: 10000 }, (_, index) => ({ message: `failure ${index}` }));
    failures.push(error(ordinarySource, 'final source failure', 310));
    const actual = await buildFailureContext(options(ordinarySource, failures));
    assert.equal((actual.match(/\n```\nfailure /g) || []).length, maximumFailureContextErrors);
    assert.match(actual, /Additional error details omitted/);
    assert.match(actual, /> 310 \|/);
    assert.match(actual, /\^ final source failure/);
    assertBounded(actual);
  });

  await check('oversized stack text and stack line arrays are rejected before parsing or source reads', async () => {
    for (const stack of ['x'.repeat(maximumFailureContextDiagnosticCharacters + 1), '\n'.repeat(maximumFailureContextStackLines)]) {
      const readsBefore = observations.reads.length;
      const actual = await buildFailureContext(options(ordinarySource, [{ message: 'original stack failure', stack }]));
      assert.match(actual, /Test source omitted: stack exceeds/);
      assert.match(actual, /original stack failure/);
      assert.equal(observations.reads.length, readsBefore);
      assertBounded(actual);
    }
  });

  await check('every source read and allocation is bounded and every successfully opened descriptor closes', async () => {
    assert.ok(observations.reads.length > 0);
    for (const read of observations.reads) {
      assert.ok(read.bufferBytes <= failureContextSourceReadBytes);
      assert.ok(read.length <= failureContextSourceReadBytes);
    }
    for (const opened of observations.opens)
      assert.equal(opened.flags, filesystemConstants.O_RDONLY | filesystemConstants.O_NONBLOCK);
    assert.equal(observations.closes, observations.opens.filter(opened => !opened.path.endsWith('missing.ts')).length);
  });

  report.status = 'passed';
  report.limits = { maximumFailureContextBytes, maximumFailureContextSourceBytes, failureContextSourceReadBytes };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await filesystem.rm(directory, { recursive: true, force: true });
}
