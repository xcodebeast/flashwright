import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';

const require = createRequire(import.meta.url);
const { utils, iso } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const destination = resolve(`compatibility/evidence/manual-trace-runner-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
const browserPath = process.env.FLASHWRIGHT_BROWSER_PATH ?? chromium.executablePath();
const driverPath = process.env.FLASHWRIGHT_DRIVER_PATH ?? resolve('target/debug/flashwright-driver');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(destination, { recursive: true });
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(browserPath), driverSha256: hash(await readFile(driverPath)), outcomes: {} };
try {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'compatibility/m2/manual-tracing/playwright.config.ts', 'compatibility/m2/manual-tracing/tracing.spec.ts'], { stdio: 'inherit' });
  for (const engine of ['playwright', 'flashwright']) {
    const directory = join(destination, engine);
    await mkdir(directory);
    for (const name of ['playwright.config.ts', 'tracing.spec.ts']) {
      const source = await readFile(`compatibility/m2/manual-tracing/${name}`, 'utf8');
      await writeFile(join(directory, name), engine === 'playwright' ? source.replaceAll("from '@flashwright/test'", "from '@playwright/test'") : source);
    }
    const resultPath = join(directory, 'results.json');
    const executable = engine === 'playwright' ? 'node_modules/playwright/cli.js' : 'packages/flashwright-test/cli.cjs';
    const child = spawn(process.execPath, [executable, 'test', '--config', join(directory, 'playwright.config.ts')], {
      env: { ...process.env, FLASHWRIGHT_BROWSER_PATH: browserPath, FLASHWRIGHT_DRIVER_PATH: driverPath, FLASHWRIGHT_TRACE_REPORT: resultPath, FLASHWRIGHT_TRACE_OUTPUT: join(directory, 'output') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(join(directory, 'runner.log'));
    child.stdout.on('data', bytes => log.write(bytes));
    child.stderr.on('data', bytes => log.write(bytes));
    let code;
    try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
    finally { await new Promise(resolve => log.end(resolve)); }
    assert.equal(code, 0, `${engine} manual tracing runner case`);
    const results = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(results.errors.length, 0);
    assert.equal(results.stats.expected, 1);
    assert.equal(results.stats.unexpected + results.stats.skipped + results.stats.flaky, 0);
    const attempt = results.suites[0].specs[0].tests[0].results[0];
    assert.equal(attempt.attachments.filter(attachment => attachment.name === 'screenshot').length, 1);
    const attachment = attempt.attachments.find(attachment => attachment.name === 'manual trace');
    assert.ok(attachment);
    const archive = new utils.ZipFile(attachment.path);
    try {
      const names = await archive.entries();
      const loader = new iso.TraceLoader();
      await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
      const entry = loader.contextEntries[0];
      const evaluations = entry.actions.filter(action => action.method === 'evaluateExpression');
      assert.equal(evaluations.length, 2);
      for (const [index, action] of evaluations.entries()) assert.ok(action.stack.some(location => location.file.endsWith('tracing.spec.ts') && location.line === index + 5), `${engine}: actual TypeScript caller line`);
      assert.ok(evaluations[1].error.message.includes('original runner browser error'));
      assert.ok(entry.events.some(event => event.type === 'console' && event.text === 'runner trace diagnostic'));
      assert.equal(entry.hasSource, false);
      report.outcomes[engine] = { stats: results.stats, manualTraceSha256: hash(await readFile(attachment.path)), callerLines: [5, 6], originalErrorPreserved: true, screenshots: 1 };
    } finally { archive.close(); }
  }
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Manual trace runner evidence: ${destination}/report.json`);
}
