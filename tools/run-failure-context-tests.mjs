import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHttpFixture } from './http-fixture.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata } from './javascript-runtime.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { startConsumerRegistry } from './consumer-registry.mjs';
import { requireBun } from './bun-toolchain.mjs';

const require = createRequire(import.meta.url);
const { utils } = require('playwright-core/lib/coreBundle');

assert.ok(process.argv[2], 'Usage: run-failure-context-tests.mjs OUTPUT_DIRECTORY');
const destination = resolve(process.argv[2]);
const packed = process.argv.includes('--packed');
let consumer, registry;
await mkdir(destination, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', ...runtimeMetadata, packed, sources: await sourceManifest(),
  browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH),
  driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)),
  noCopyPrompt: !!process.env.PLAYWRIGHT_NO_COPY_PROMPT, artifactsEnabled: !!process.env.FLASHWRIGHT_FAILURE_CONTEXT_ARTIFACTS, outcomes: {},
  scope: 'Default failure documents with single-document fallback; rendered child-frame composition is explicitly omitted.' };
const { server, close } = createHttpFixture((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(request.url === '/frame' ? '<!doctype html><h1>Framed body</h1><iframe src="/child"></iframe>'
    : request.url === '/child' ? '<!doctype html><button>Child button</button>'
    : request.url === '/successor' ? '<!doctype html><h1>Successor body</h1><button>Successor</button>'
    : '<!doctype html><title>Failure fixture</title><h1>Original body</h1><button>Original</button>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const specifications = suites => suites.flatMap(suite => [...suite.specs, ...specifications(suite.suites ?? [])]);
const fallback = text => text?.match(/\n# Page snapshot\n\n```yaml\n([\s\S]*?)\n```/)?.[1];
try {
  if (packed) {
    const { archives } = await packConsumerPackages(destination, { runner: true });
    report.packages = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, { path, sha256: hash(await readFile(path)) }])));
    consumer = await mkdtemp(join(tmpdir(), 'flashwright-failure-context-'));
    registry = await startConsumerRegistry(Object.values(archives));
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'failure-context-consumer', private: true, dependencies: { '@flashwright/test': '0.0.0', flashwright: '0.0.0' } }));
    const install = spawn(requireBun(), ['install', '--ignore-scripts', '--omit=optional', '--omit=peer', '--registry', registry.url], { cwd: consumer, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(consumer, 'cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    install.stdout.on('data', bytes => output.push(bytes)); install.stderr.on('data', bytes => output.push(bytes));
    const [code] = await once(install, 'close');
    await writeFile(join(destination, 'install.log'), Buffer.concat(output)); assert.equal(code, 0);
    for (const name of ['artifacts.spec.cjs', 'playwright.config.cjs']) await writeFile(join(consumer, name), await readFile(`compatibility/m2/failure-context/${name}`));
  }
  for (const engine of ['playwright', 'flashwright']) {
    const directory = join(destination, engine); await mkdir(directory);
    const packedCandidate = packed && engine === 'flashwright';
    const consumerRequire = packedCandidate ? createRequire(join(consumer, 'package.json')) : undefined;
    const command = engine === 'playwright' ? resolve('node_modules/playwright/cli.js') : packedCandidate ? join(dirname(consumerRequire.resolve('@flashwright/test/package.json')), 'cli.cjs') : resolve('packages/flashwright-test/cli.cjs');
    const configuration = packedCandidate ? join(consumer, 'playwright.config.cjs') : resolve('compatibility/m2/failure-context/playwright.config.cjs');
    const child = spawn('python3', [resolve('tools/watchdog.py'), '--timeout', '240', '--report', join(directory, 'resources.json'), '--', process.execPath,
      command, 'test', '--config', configuration], { cwd: packedCandidate ? consumer : process.cwd(),
      env: { ...process.env, FLASHWRIGHT_FAILURE_CONTEXT_ENGINE: engine,
        FLASHWRIGHT_FAILURE_CONTEXT_URL: `http://127.0.0.1:${server.address().port}`,
        FLASHWRIGHT_FAILURE_CONTEXT_REPORT: join(directory, 'runner.json'), FLASHWRIGHT_FAILURE_CONTEXT_OUTPUT: join(directory, 'artifacts') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [], errors = [];
    child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes));
    const [code, signal] = await once(child, 'close');
    await writeFile(join(directory, 'stdout.txt'), Buffer.concat(output));
    await writeFile(join(directory, 'stderr.txt'), Buffer.concat(errors));
    assert.equal(code, 0, engine); assert.equal(signal, null);
    const resources = JSON.parse(await readFile(join(directory, 'resources.json'), 'utf8'));
    assert.equal(resources.timedOut, false); assert.deepEqual(resources.cleanupSignals, []); assert.deepEqual(resources.remainingObservedProcesses, []);
    const runner = JSON.parse(await readFile(join(directory, 'runner.json'), 'utf8'));
    assert.equal(runner.stats.unexpected + runner.stats.skipped, 0); assert.equal(runner.stats.flaky, 1);
    const cases = specifications(runner.suites); assert.equal(cases.length, 14);
    report.outcomes[engine] = {};
    for (const specification of cases) {
      const attempts = specification.tests[0].results;
      assert.equal(attempts.length, specification.title.startsWith('retry ') ? 2 : 1);
      report.outcomes[engine][specification.title] = [];
      for (const attempt of attempts) {
        const attachments = attempt.attachments.filter(item => item.name === 'error-context');
        const failing = attempt.status === 'failed';
        const expectedDocuments = failing ? engine === 'playwright' && specification.title === 'suite context survives hook scopes' ? 2 : 1 : 0;
        assert.equal(attachments.length, expectedDocuments, `${engine}: ${specification.title}`);
        if (attachments.length > 1) assert.equal(new Set(attachments.map(item => item.path)).size, 1, 'reference duplicate points to the same final document');
        let text;
        if (attachments.length) {
          assert.equal(attachments[0].contentType, 'text/markdown');
          const bytes = await readFile(attachments[0].path); text = bytes.toString('utf8');
          if (engine === 'flashwright') assert.ok(bytes.length <= 256 * 1024);
          assert.match(text, /# Test info/); assert.match(text, /# Error details/); assert.match(text, /# Test source/);
        }
        if (text && specification.title === 'afterAll error remains in final document') assert.match(text, /Failure from afterAll hook/);
        let traceDocument;
        if (report.artifactsEnabled) {
          const traces = attempt.attachments.filter(item => item.name === 'trace');
          assert.equal(traces.length, 1, `${engine}: trace ${specification.title}`);
          assert.equal(attempt.attachments.filter(item => item.name === 'trace-error' || item.name === 'screenshot-error').length, 0);
          const archive = new utils.ZipFile(traces[0].path);
          try {
            const records = (await archive.read('test.trace')).toString('utf8').trim().split('\n').map(JSON.parse);
            const document = records.flatMap(record => record.attachments ?? []).find(item => item.name === 'error-context');
            assert.equal(!!document, failing, `${engine}: trace embeds failure document`);
            if (document) {
              const bytes = await archive.read(`resources/${document.sha1}`);
              assert.equal(bytes.toString('utf8'), text, `${engine}: trace document matches final reporter artifact`);
              traceDocument = hash(bytes);
            }
          } finally { archive.close(); }
        }
        report.outcomes[engine][specification.title].push({ status: attempt.status, retry: attempt.retry,
          errors: attempt.errors.length, document: text !== undefined, documentAttachments: attachments.length, documentSha256: text === undefined ? null : hash(text),
          pageSnapshot: fallback(text) ?? null, traceDocumentSha256: traceDocument ?? null,
          originalMatcherDiagnostic: text?.includes('- button "Original"') ?? false,
          diagnostics: attempt.attachments.filter(item => item.name === 'error-context-error'),
        });
      }
    }
  }
  const snapshots = new Set(['generic failure captures first page body', 'count failure uses page fallback',
    'context close retains its original page', 'owned page close captures context fallback', 'suite context survives hook scopes', 'retry does not inherit previous failure document']);
  for (const [title, references] of Object.entries(report.outcomes.playwright)) {
    const candidates = report.outcomes.flashwright[title];
    assert.deepEqual(candidates.map(item => [item.status, item.retry, item.errors, item.document]), references.map(item => [item.status, item.retry, item.errors, item.document]), title);
    for (let index = 0; index < references.length; index++) {
      const reference = references[index], candidate = candidates[index];
      if (report.noCopyPrompt || !candidate.document || !snapshots.has(title) && !title.startsWith('oversized ') && !title.startsWith('child frame ')) {
        assert.equal(reference.pageSnapshot, null, title); assert.equal(candidate.pageSnapshot, null, title);
      } else if (title.startsWith('child frame ')) {
        assert.match(reference.pageSnapshot, /Child button/); assert.equal(candidate.pageSnapshot, null);
        assert.equal(candidate.diagnostics.length, 1, 'child-frame omission remains explicit');
      } else if (title.startsWith('oversized ')) {
        assert.ok(reference.pageSnapshot.length > 16384); assert.ok(candidate.pageSnapshot.length <= 16384);
        assert.match(candidate.pageSnapshot, /\[Page snapshot truncated: diagnostic size limit reached\.\]$/);
      } else {
        assert.equal(candidate.pageSnapshot, reference.pageSnapshot, title);
        assert.match(candidate.pageSnapshot, /Original body/);
        assert.doesNotMatch(candidate.pageSnapshot, /Successor/);
      }
    }
    if (title.startsWith('matcher ')) assert.equal(candidates[0].originalMatcherDiagnostic, true);
  }
  assert.deepEqual(await sourceManifest(), report.sources, 'sources changed during failure context verification');
  assert.equal(hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), report.driverSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
finally { await registry?.close(); await close(); await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log('Default failure context: shared attempts, ordinary snapshot text, explicit bounded/frame differences and retry isolation passed.');
