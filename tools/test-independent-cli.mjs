import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { packConsumerPackages } from './packed-artifacts.mjs';
import { installPackedConsumer, cleanupPackedConsumer } from './install-packed-consumer.mjs';
import { applicationCorpusDirectory, loadApplicationCorpus, materializeApplicationTests, applicationTestIdentities } from '../benchmarks/application-corpus.mjs';
const root = resolve(import.meta.dirname, '..');
const directory = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(root, 'workbench/independent-cli-'));
if (process.argv[2]) await mkdir(directory);
assert.ok(directory.startsWith(join(root, 'workbench') + '/'));
const browser = process.env.FLASHWRIGHT_BROWSER_PATH;
assert.ok(browser, 'Set FLASHWRIGHT_BROWSER_PATH to pinned Chromium');
const driver = process.env.FLASHWRIGHT_DRIVER_PATH ?? join(root, 'target/release/flashwright-driver');
const { archives, dependencies } = await packConsumerPackages(directory, { runner: true });
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'independent-runner-consumer', private: true, type: 'module', dependencies: { ...dependencies, '@types/node': '24.10.1' } }));
const installation = await installPackedConsumer(directory, Object.values(archives));
const require = createRequire(join(directory, 'package.json'));
const cli = require.resolve('@flashwright/test/package.json').replace(/package\.json$/, 'cli.cjs');
await writeFile(join(directory, 'guard.cjs'), `const Module=require('node:module');const original=Module._load;Module._load=function(id,...rest){if(/dist[\\\\/]upstream|playwright-core[\\\\/]lib[\\\\/](?:coreBundle|server|client)|flashwright-upstream-runner/.test(id))throw Error('Forbidden upstream backend or scheduler: '+id);return Reflect.apply(original,this,[id,...rest]);};`);
await mkdir(join(directory, 'smoke'));
const testBody = `
import { test, expect } from '@flashwright/test/independent';
import { writeFileSync, readFileSync } from 'node:fs';
const custom = test.extend<{ message: string }>({ message: ['fixture', { option: true }] });
custom('native fixtures and assertions', async ({ page, message }) => {
  writeFileSync(test.info().outputPath('created-by-test.txt'), 'output-path-ready');
  await page.setContent('<button onclick="this.textContent=event.isTrusted?\\'clicked\\':\\'untrusted\\'">ready</button>');
  await test.step('click button', async () => { await page.locator('button').click(); });
  await expect(page.locator('button')).toHaveText('clicked');
  expect(await page.evaluate(() => ({ userAgent: navigator.userAgent, scale: devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches }))).toEqual({ userAgent: 'Flashwright independent integration', scale: 2, dark: true });
  expect(message).toBe('configured');
  expect(readFileSync(test.info().outputPath('created-by-test.txt'),'utf8')).toBe('output-path-ready');
  await test.info().attach('result', { body: Buffer.from('retained bytes'), contentType: 'text/plain' });
});
custom('retry keeps original failure', async ({ page }, info) => {
  await page.setContent('<main>failure snapshot sentinel</main>');
  if (info.retry === 0) throw new Error('original failure sentinel');
  await expect(page.locator('main')).toHaveText('failure snapshot sentinel');
});
`;
await writeFile(join(directory, 'smoke/smoke.spec.ts'), testBody);
await writeFile(join(directory, 'identity.mjs'), `import * as esm from '@flashwright/test/independent';import {createRequire} from 'node:module';import assert from 'node:assert/strict';const cjs=createRequire(import.meta.url)('@flashwright/test/independent');for(const name of ['test','expect','chromium','errors'])assert.equal(esm[name],cjs[name]);`);
const applications = {};
for (const name of ['todomvc', 'svgomg']) {
  const corpus = await loadApplicationCorpus(applicationCorpusDirectory(name));
  await mkdir(join(directory, name));
  const sources = await materializeApplicationTests(corpus, join(directory, name), '@flashwright/test/independent');
  applications[name] = { corpus, sources, expected: applicationTestIdentities(corpus) };
}
// Application sources use the runner's extensionless TypeScript imports.
await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['smoke/**/*.ts', 'todomvc/**/*.ts', 'svgomg/**/*.ts'] }));
execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '--project', join(directory, 'tsconfig.json')], { stdio: 'inherit' });
// The owner starts the fixture server inside its watchdog, so shutdown is in the observed tree lifetime.
await writeFile(join(directory, 'owner.mjs'), `import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {loadApplicationCorpus,applicationCorpusDirectory,startApplicationServer} from ${JSON.stringify(join(root,'benchmarks/application-corpus.mjs'))};const [d,app,runtime,config]=process.argv.slice(2);let server;try{if(app!=='smoke')server=await startApplicationServer(await loadApplicationCorpus(applicationCorpusDirectory(app)));const child=spawn(runtime,['--require',join(d,'guard.cjs'),${JSON.stringify(cli)},'test','--runner=independent','--config',config],{cwd:d,env:{...process.env,...(server?{FLASHWRIGHT_APPLICATION_URL:server.url}:{})},stdio:'inherit'});const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});assert.deepEqual(exit,{code:0,signal:null});}finally{await server?.close();await writeFile(config+'.requests.json',JSON.stringify(server?.requests??[]));}`);
const runs = [];
for (const runtimeName of ['bun', 'node22', 'node24']) {
  const runtime = join(root, runtimeName === 'bun' ? '.tools/bun-v1.4.2-linux-x64/bin/bun' : runtimeName === 'node22' ? '.tools/node-v22.22.0-linux-x64/bin/node' : '.tools/node-v24.15.0-linux-x64/bin/node');
  execFileSync(runtime, ['--require', join(directory, 'guard.cjs'), join(directory, 'identity.mjs')], { cwd: directory, stdio: 'inherit' });
  for (const [application, workers] of [['smoke',2], ['todomvc',1], ['svgomg',1], ['todomvc',4], ['svgomg',4]]) {
    const name = `${runtimeName}-${application}-w${workers}`, outputFile = join(directory, name + '.json'), config = join(directory, name + '.config.cjs');
    const value = { testDir: './' + application, workers, retries: application === 'smoke' ? 1 : 0, outputDir: './results-' + name, use: { launchOptions: { executablePath: browser }, ...(application === 'smoke' ? { message: 'configured', userAgent: 'Flashwright independent integration', deviceScaleFactor: 2, colorScheme: 'dark' } : {}) }, reporter: [['json', { outputFile }]] };
    await writeFile(config, 'module.exports=' + JSON.stringify(value));
    const args = ['-B',join(root,'tools/watchdog.py'),'--timeout','90','--report',join(directory,name+'.resources.json'),'--',process.execPath,join(directory,'owner.mjs'),directory,application,runtime,config];
    const child = spawn('python3', args, { cwd: root, env: { ...process.env, FLASHWRIGHT_DRIVER_PATH: driver }, stdio: ['ignore','pipe','pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    const exit = await new Promise((resolve, reject) => { child.once('error',reject); child.once('close',(code,signal)=>resolve({code,signal})); });
    await writeFile(join(directory,name+'.log'),output);
    assert.deepEqual(exit,{code:0,signal:null},name+' '+output);
    const report = JSON.parse(await readFile(outputFile)), resources = JSON.parse(await readFile(join(directory,name+'.resources.json')));
    assert.equal(report.status,'passed'); assert.deepEqual(report.workerErrors,[]); assert.ok(report.workers.every(w=>w.exitCode===0&&!w.signal&&!w.forcedTermination));
    assert.equal(resources.exitCode,0); for(const flag of ['timedOut','interrupted'])assert.equal(resources[flag],false);assert.deepEqual(resources.cleanupSignals,[]);assert.deepEqual(resources.remainingObservedProcesses,[]);
    if(application==='smoke') {
      assert.deepEqual(report.results.map(r=>[r.retry,r.status]),[[0,'passed'],[0,'failed'],[1,'passed']]);
      const first=report.results[0];assert.equal(await readFile(first.attachments.find(a=>a.name==='result').path,'utf8'),'retained bytes');assert.equal(first.steps[0].status,'passed');
      const failed=report.results[1];assert.match(failed.errors[0].stack,/smoke\.spec\.ts/);const doc=await readFile(failed.attachments.find(a=>a.name==='error-context').path,'utf8');assert.match(doc,/original failure sentinel/);assert.match(doc,/failure snapshot sentinel/);
      assert.notEqual(failed.workerIndex,report.results[2].workerIndex);
    } else {
      const expected=applications[application].expected;assert.equal(report.results.length,expected.length);assert.ok(report.results.every(r=>r.status==='passed'&&r.retry===0));
      assert.deepEqual(report.plan.tests.map(t=>t.title),expected.map(t=>t.title));
      const requests=JSON.parse(await readFile(config+'.requests.json'));assert.ok(requests.length);assert.ok(requests.every(r=>[200,204].includes(r.status)));
    }
    runs.push({runtime:runtimeName,application,workers,tests:report.plan.tests.length,attempts:report.results.length,status:'passed',reportSha256:createHash('sha256').update(await readFile(outputFile)).digest('hex')});
    console.log(name, 'passed');
  }
}
const evidence=join(directory,'verified.json');
await writeFile(evidence,JSON.stringify({status:'passed',packed:true,runs,archives,installation,limitations:['Explicit independent preview; no automatic artifact policies, project orchestration, soft/poll assertions or custom reporters.','No performance claim.']},null,2));
const cleanup=await cleanupPackedConsumer(directory,installation,evidence,import.meta.url);assert.equal(cleanup.status,'passed');
console.log(JSON.stringify({directory,status:'passed',runs:runs.length}));
