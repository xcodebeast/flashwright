import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, 'workbench'), { recursive: true });
const directory = await mkdtemp(join(root, 'workbench/independent-tracing-'));
const upstream = createRequire(join(root, 'packages/flashwright-runner/dist/upstream/package.json'));
const { utils, iso } = upstream('playwright-core/lib/coreBundle');
const { independentTraceOptions, shouldRetain } = await import('../packages/flashwright-runner/dist/commonjs/independent/tracing.js');
const modes = ['off', 'on', 'retain-on-failure', 'on-first-retry', 'on-all-retries', 'retain-on-first-failure', 'retain-on-failure-and-retries', 'retry-with-trace'];
const captures = [[false,false,false],[true,true,true],[true,true,true],[false,true,false],[false,true,true],[true,false,false],[true,true,true],[false,true,false]];
for (const [index, mode] of modes.entries()) for (let retry = 0; retry < 3; retry++) {
  assert.equal(!!independentTraceOptions(mode, retry), captures[index][retry], `${mode} retry ${retry}`);
}
assert.throws(() => independentTraceOptions({mode:'on',live:true},0), /live/);
assert.throws(() => independentTraceOptions({mode:'on',unknown:true},0), /not implemented/);

const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<html><body><input aria-label="Name"><button>Save</button><p>API trace sentinel</p></body></html>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
try {
  const prefix = `import {test,expect} from '@flashwright/test/independent';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url); const Module=require('node:module');
for(const file of Object.keys(require.cache)) if(file.includes('coreBundle') || file.includes('workerProcessEntry')) throw Error('Upstream runner/browser runtime loaded: '+file);
const load=Module._load;Module._load=function(id,...args){if(id.includes('coreBundle')||id.includes('workerProcessEntry'))throw Error('Forbidden upstream load '+id);return load.call(this,id,...args)};
async function paint(page){await page.evaluate(()=>new Promise(resolve=>{const started=performance.now();let sequence=0;const frame=()=>{document.body.style.background=sequence++%2?'rgb(239,240,240)':'rgb(240,240,240)';if(performance.now()-started<350)requestAnimationFrame(frame);else requestAnimationFrame(()=>setTimeout(resolve,0))};requestAnimationFrame(frame)}))}
`;
  const policies = modes.map(mode => `test.describe(${JSON.stringify(mode)},()=>{test.use({trace:${JSON.stringify(mode)}});test('policy',async({page},info)=>{await page.goto(${JSON.stringify(baseURL)});await page.getByRole('textbox').fill('retry '+info.retry);await expect(page.getByRole('textbox')).toHaveValue('retry '+info.retry);await paint(page);await info.attach('attempt',{body:'attempt-'+info.retry});if(info.retry<2)throw Error('intentional policy retry '+info.retry);});});`).join('\n');
  await writeFile(join(directory,'policy.spec.ts'),prefix+policies);
  await writeFile(join(directory,'owners.spec.ts'),prefix+`
test.use({trace:'on'});
const shared=test.extend({sharedPage:[async({browser},use)=>{const context=await browser.newContext();const page=await context.newPage();try{await use(page)}finally{await context.close()}},{scope:'worker'}]});
for(const title of ['first owner','second owner'])shared(title,async({page,sharedPage,browser,request},info)=>{
 await test.step(title+' outer',async()=>{await page.goto(${JSON.stringify(baseURL)});await test.step('inner',async()=>{await page.getByRole('textbox').fill(title);await expect(page.getByRole('textbox')).toHaveValue(title)});});
 await paint(page);
 await sharedPage.goto(${JSON.stringify(baseURL)});await sharedPage.getByRole('textbox').fill(title+' shared');
 const manual=await browser.newContext();const manualPage=await manual.newPage();await manualPage.goto(${JSON.stringify(baseURL)});await manualPage.getByRole('textbox').fill(title+' manual');await manual.close();
 const response=await request.get(${JSON.stringify(baseURL)});expect(await response.text()).toContain('API trace sentinel');
 await info.attach('owner',{body:title});
});
`);
  await writeFile(join(directory,'controls.spec.ts'),prefix+`
import {mkdirSync} from 'node:fs';
test.describe('timeout control',()=>{test.use({trace:'on-first-retry'});test('timeout retry',async({page},info)=>{
 await page.goto(${JSON.stringify(baseURL)});
 if(info.retry===0){info.setTimeout(500);await page.evaluate(()=>new Promise(()=>{}));}
 await page.getByRole('textbox').fill('timeout recovered');await paint(page);await info.attach('owner',{body:'timeout retry'});
});});
test.describe('disabled resources',()=>{test.use({trace:{mode:'on',screenshots:false,snapshots:false,sources:false,attachments:false}});test('option suppression',async({page},info)=>{
 await page.goto(${JSON.stringify(baseURL)});await page.getByRole('textbox').fill('options');await info.attach('suppressed',{body:'must not enter archive'});
});});
test.describe('export control',()=>{test.use({trace:{mode:'on',screenshots:false,snapshots:false}});test.fail('export failure',async({page},info)=>{
 await page.goto(${JSON.stringify(baseURL)});mkdirSync(info.outputPath('trace.zip'));throw Error('original export failure sentinel');
});});
`);
  await writeFile(join(directory,'skip.spec.ts'),prefix+`
test.use({trace:'on'});let context,page;
test.beforeAll(async({browser})=>{context=await browser.newContext();page=await context.newPage();await page.goto(${JSON.stringify(baseURL)});});
test('before skip',async({},info)=>{await page.getByRole('textbox').fill('before skip');await paint(page);await info.attach('owner',{body:'before skip'});});
test.skip('trailing skipped',()=>{throw Error('skipped body must not execute')});
test.afterAll(async()=>{await page.getByRole('textbox').fill('after skipped');await paint(page);await test.info().attach('owner',{body:'trailing skipped'});await context.close();});
`);
  const reportFile = join(directory,'report.json');
  await writeFile(join(directory,'config.cjs'),'module.exports='+JSON.stringify({workers:1,retries:2,timeout:15000,testMatch:'*.spec.ts',outputDir:join(directory,'results'),reporter:[['json',{outputFile:reportFile}]]}));
  const child = spawn(process.execPath,[join(root,'packages/flashwright-test/cli.cjs'),'test','--runner=independent','--config',join(directory,'config.cjs')],{cwd:directory,stdio:['ignore','pipe','pipe']});
  const stdout=[],stderr=[];
  child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));
  const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
  const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))});
  clearTimeout(timer);
  await writeFile(join(directory,'stdout.txt'),Buffer.concat(stdout));await writeFile(join(directory,'stderr.txt'),Buffer.concat(stderr));
  assert.deepEqual(outcome,{code:0,signal:null},Buffer.concat(stderr).toString());
  const report=JSON.parse(await readFile(reportFile,'utf8'));
  assert.deepEqual(report.workerErrors,[]);
  assert.ok(report.workers.every(worker=>worker.exitCode===0&&!worker.signal&&!worker.forcedTermination));
  assert.equal(report.results.length,32);
  const verified=[];
  for(const result of report.results){
    const identity = JSON.parse(result.id);
    result.title = identity.slice(1).join(' › ');
    if(identity.at(-1)==='export failure'){
      assert.equal(result.status,'failed');assert.equal(result.expectedStatus,'failed');
      assert.match(result.errors[0].message,/original export failure sentinel/);
      assert.ok(result.attachments.some(a=>a.name==='trace-error'));
      assert.ok(!result.attachments.some(a=>a.name==='trace'));
      continue;
    }
    assert.ok(!result.attachments.some(a=>a.name==='trace-error'),JSON.stringify(result));
    if(identity.at(-1)==='option suppression'){
      const archive=result.attachments.find(a=>a.name==='trace');assert.ok(archive);
      const zip=new utils.ZipFile(archive.path);
      try{
        const names=await zip.entries();assert.ok(!names.some(name=>name.startsWith('resources/')));
        const events=(await Promise.all(names.filter(name=>name.endsWith('.trace')).map(async name=>(await zip.read(name)).toString('utf8').trim().split('\n').map(JSON.parse)))).flat();
        assert.ok(!events.some(event=>event.type==='frame-snapshot'||event.type==='screencast-frame'||event.attachments?.length));
      }finally{zip.close()}
      continue;
    }
    const isPolicy=result.title.endsWith('policy');
    const isSkipSuite=identity[0].endsWith('/skip.spec.ts');
    if(identity.at(-1)==='trailing skipped')assert.equal(result.status,'skipped');
    const isTimeout=identity.at(-1)==='timeout retry';
    if(isTimeout)assert.equal(result.status,result.retry===0?'timedOut':'passed');
    const mode=isPolicy ? identity.at(-2) : isTimeout?'on-first-retry':'on';
    assert.ok(mode, result.title);
    const capture=!!independentTraceOptions(mode,result.retry);
    const kept=capture&&shouldRetain(mode,result.retry,result.status!==result.expectedStatus);
    const traces=result.attachments.filter(a=>a.name==='trace');
    assert.equal(traces.length,kept?1:0,`${result.title} retry ${result.retry}`);
    if(!kept)continue;
    const zip=new utils.ZipFile(traces[0].path);
    try{
      const names=await zip.entries(),files=new Map(await Promise.all(names.map(async name=>[name,await zip.read(name)])));
      const loader=new iso.TraceLoader();
      await loader.load({entryNames:async()=>names,readText:async name=>files.get(name)?.toString('utf8'),hasEntry:async name=>files.has(name),isLive:()=>false});
      const model=new iso.TraceModel(result.title,loader.contextEntries);
      assert.ok(model.actions.some(action=>action.apiName==='locator.fill'||action.title?.includes('fill')),`missing fill ${result.title}`);
      const native=names.filter(name=>/^\d+-trace\.trace$/.test(name)).flatMap(name=>files.get(name).toString('utf8').trim().split('\n').map(JSON.parse));
      assert.ok(native.some(event=>event.type==='frame-snapshot'),`missing snapshot ${result.title}`);
      assert.ok(native.some(event=>event.type==='screencast-frame'),`missing filmstrip ${result.title}`);
      assert.ok(names.some(name=>name.startsWith('resources/src@')),`missing sources ${result.title}`);
      const journal=files.get('test.trace').toString('utf8').trim().split('\n').map(JSON.parse);
      const attachments=journal.flatMap(event=>event.attachments??[]);
      const attachment=attachments.find(a=>a.name===(isPolicy?'attempt':'owner'));
      assert.ok(attachment?.sha1,`missing attachment ${result.title}`);
      assert.equal(files.get('resources/'+attachment.sha1).toString('utf8'),isPolicy?'attempt-'+result.retry:result.title.split(' › ').at(-1));
      if(!isPolicy&&!isTimeout&&!isSkipSuite){
        const outer=model.actions.find(action=>action.title?.endsWith(' outer'));
        const inner=model.actions.find(action=>action.title==='inner');
        assert.equal(inner?.parentId,outer?.stepId);
        assert.ok(model.actions.some(action=>action.parentId===inner.stepId&&action.title?.includes('fill')));
        assert.ok(names.filter(name=>/^\d+-trace\.trace$/.test(name)).length>=4,'fixture/manual/worker/request captures');
      }
      if(result.status==='failed'){
        assert.ok(attachments.some(a=>a.name==='error-context'&&a.sha1));
        assert.ok(journal.some(event=>event.type==='error'&&event.stack?.[0]?.file.endsWith('policy.spec.ts')));
      }
      verified.push({title:result.title,retry:result.retry,actions:model.actions.length,archive:traces[0].path});
    }finally{zip.close()}
  }
  await writeFile(join(directory,'verified.json'),JSON.stringify({status:'passed',runtime:process.versions.bun?'bun':'node',attempts:report.results.length,archives:verified},null,2));
  console.log(JSON.stringify({status:'passed',directory,attempts:report.results.length,archives:verified.length}));
}finally{await new Promise(resolve=>server.close(resolve))}
