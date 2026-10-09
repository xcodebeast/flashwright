import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { installPackedConsumer } from './install-packed-consumer.mjs';
import { sourceManifest } from './source-manifest.mjs';
import { identifyBrowser } from './browser-identity.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import { createHttpFixture } from './http-fixture.mjs';
const require = createRequire(import.meta.url);
const { utils, iso } = require(resolve(dirname(require.resolve('playwright-core/package.json')), 'lib/coreBundle.js'));
const { jpegjs } = require('playwright-core/lib/utilsBundle');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = resolve(process.argv[2] ?? `compatibility/evidence/packed-filmstrip-${process.platform}-${process.arch}-${runtimeArtifactLabel}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });
const consumer = await mkdtemp(join(tmpdir(), 'flashwright-packed-filmstrip-'));
const report = { status: 'running', ...runtimeMetadata, sources: await sourceManifest(), browser: await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH), driverSha256: hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)), cases: [] };
const { server, close: closeServer } = createHttpFixture((request, response) => {
  if (request.url === '/style.css') { response.setHeader('content-type', 'text/css'); response.end('#network-style { color: rgb(20, 40, 60); }'); }
  else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><link rel="stylesheet" href="/style.css"><span id="network-style">original resource</span>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const { archives, dependencies } = await packConsumerPackages(directory, { runner: true });
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'packed-filmstrip-consumer', private: true, type: 'module', dependencies: { ...dependencies, '@playwright/test': 'npm:@flashwright/test@0.0.0', playwright: 'npm:flashwright@0.0.0', '@types/node': '24.10.1' } }));
  report.installation = await installPackedConsumer(consumer, Object.values(archives));
  report.packages = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, path]) => [name, { path, sha256: hash(await readFile(path)) }])));
  await writeFile(join(consumer, 'poison.cjs'), `
const upstream = require('flashwright-upstream-runner/test');
for (const browser of [upstream.chromium, upstream.firefox, upstream.webkit]) {
  for (const method of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) browser[method] = async () => { throw new Error('Forbidden upstream browser backend entered'); };
}
upstream.request.newContext = async () => { throw new Error('Forbidden upstream request backend entered'); };
`);
  const source = "import './poison.cjs';\n" + await readFile('compatibility/m2/trace-filmstrip/filmstrip.spec.ts', 'utf8');
  const callerLine = source.split('\n').findIndex(line => line.includes('const result = await page.evaluate')) + 1;
  for (const filename of ['filmstrip-esm.spec.ts', 'filmstrip-commonjs.spec.cts']) await writeFile(join(consumer, filename), source);
  await copyFile('compatibility/m2/trace-filmstrip/playwright.config.ts', join(consumer, 'playwright.config.ts'));
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'filmstrip-esm.spec.ts', 'filmstrip-commonjs.spec.cts', 'playwright.config.ts'], { cwd: consumer, stdio: 'inherit' });
  const resultPath = join(directory, 'results.json');
  const child = spawn(process.execPath, ['node_modules/.bin/flashwright', 'test', '--config', 'playwright.config.ts'], { cwd: consumer, env: { ...process.env, FLASHWRIGHT_FILMSTRIP_REPORT: resultPath, FLASHWRIGHT_FILMSTRIP_OUTPUT: join(directory, 'output'), FLASHWRIGHT_FILMSTRIP_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(directory, 'runner.log'), log);
  assert.equal(code, 0, log);
  const results = JSON.parse(await readFile(resultPath));
  assert.equal(results.stats.expected, 2); assert.equal(results.stats.unexpected + results.stats.skipped + results.stats.flaky, 0); assert.deepEqual(results.errors, []);
  const specifications = suites => suites.flatMap(suite => [...suite.specs, ...specifications(suite.suites ?? [])]);
  for (const specification of specifications(results.suites)) {
    const attachments = specification.tests[0].results[0].attachments;
    assert.equal(attachments.filter(attachment => attachment.name === 'screenshot').length, 1);
    const attachment = attachments.find(attachment => attachment.name === 'manual filmstrip');
    assert.ok(attachment);
    const archive = new utils.ZipFile(attachment.path);
    try {
      const names = await archive.entries();
      const events = (await archive.read('trace.trace')).toString().trim().split('\n').map(JSON.parse);
      const snapshots = events.filter(event => event.type === 'frame-snapshot');
      assert.ok(snapshots.length);
      const network = (await archive.read('trace.network')).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
      const stylesheet = network.find(event => event.snapshot.request.url === `${origin}/style.css` && event.snapshot.response.content._sha1)?.snapshot;
      assert.ok(stylesheet, 'packed public snapshots must retain original network resources');
      const stylesheetBytes = await archive.read(`resources/${stylesheet.response.content._sha1}`);
      assert.equal(stylesheetBytes.toString(), '#network-style { color: rgb(20, 40, 60); }');
      const fileAssignments = events.filter(event => event.type === 'before' && event.class === 'FileChooser' && event.method === 'setInputFiles' && event.title === 'filechooser.setFiles');
      assert.equal(fileAssignments.length, 1);
      assert.equal(events.filter(event => event.type === 'before' && event.class === 'ElementHandle' && event.method === 'setInputFiles').length, 0);
      assert.ok(events.some(event => event.type === 'after' && event.callId === fileAssignments[0].callId && !event.error));
      const frames = events.filter(event => event.type === 'screencast-frame');
      assert.ok(frames.length);
      const images = [];
      for (const frame of frames) {
        const bytes = await archive.read(`resources/${frame.sha1}`);
        const decoded = jpegjs.decode(bytes, { useTArray: true });
        images.push({ sha256: hash(bytes), width: decoded.width, height: decoded.height, firstPixel: [...decoded.data.slice(0, 4)] });
      }
      assert.ok(images.some(image => image.firstPixel[0] > 200 && image.firstPixel[1] < 30 && image.firstPixel[2] < 30));
      const sourcePath = await realpath(join(consumer, specification.file));
      const sourceName = `resources/src@${createHash('sha1').update(sourcePath).digest('hex')}.txt`;
      assert.equal((await archive.read(sourceName)).toString(), source);
      const loader = new iso.TraceLoader();
      await loader.load({ entryNames: async () => names, readText: async name => names.includes(name) ? (await archive.read(name)).toString() : undefined, hasEntry: async name => names.includes(name), isLive: () => false });
      assert.ok(loader.contextEntries[0].actions.some(action => action.stack?.some(location => location.file === sourcePath && location.line === callerLine)));
      report.cases.push({ file: specification.file, trace: attachment.path, traceSha256: hash(await readFile(attachment.path)), snapshots: snapshots.length, stylesheetSha256: hash(stylesheetBytes), frames, images, sourceName, callerLine, automaticScreenshots: 1, fileAssignments: fileAssignments.length, upstreamBrowserAndRequestPoisoned: true });
    } finally { archive.close(); }
  }
  execFileSync('python3', ['-c', 'import sys,zipfile; [zipfile.ZipFile(path).testzip() is None or (_ for _ in ()).throw(AssertionError(path)) for path in sys.argv[1:]]', ...report.cases.map(item => item.trace)]);
  assert.deepEqual(await sourceManifest(), report.sources);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await closeServer();
  try {
    const installationLog = join(directory, 'install.log');
    await copyFile(join(consumer, 'install.log'), installationLog);
    report.installationLog = { path: installationLog, sha256: hash(await readFile(installationLog)) };
    if (report.installation) { assert.equal(report.installationLog.sha256, report.installation.logSha256); report.installation.log = installationLog; }
  } catch (error) {
    if (report.installation || error.code !== 'ENOENT') { report.status = 'failed'; report.installationLogError = error.message; process.exitCode = 1; }
  }
  await rm(consumer, { recursive: true, force: true });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Packed filmstrip evidence: ${directory}/report.json`);
}
