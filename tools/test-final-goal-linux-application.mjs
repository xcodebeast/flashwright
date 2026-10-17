import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFinalGoalEvidence } from './verify-final-goal.mjs';
import { finalGoalHash } from '../benchmarks/final-goal-contract.mjs';
import { reconstructFinalGoalLinuxResourceEvidence } from './final-goal-linux-evidence.mjs';
import { test } from 'node:test';
import { applicationCorpusDirectory, loadApplicationCorpus, applicationGeneratedSources, applicationTestIdentities } from '../benchmarks/application-corpus.mjs';
import { applicationConfiguration } from '../benchmarks/application-suite-contract.mjs';
import { reconstructFinalGoalLinuxApplication, decodeLinuxApplicationJson, linuxApplicationEvidenceLimits } from './final-goal-linux-application.mjs';
import { syntheticDispatch } from './fixtures/linux-application-dispatch.mjs';
const fixture = JSON.parse(await readFile(new URL('../compatibility/evidence/fixtures/linux-cgroup-originals-synthetic.json', import.meta.url)));
const corpus = await loadApplicationCorpus(applicationCorpusDirectory('todomvc'));
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));

function bundle({ failed = false, dispatch = false, change = () => {}, changeDispatch = () => {} } = {}) {
  const originals = Object.fromEntries(Object.entries(fixture.originals).map(([name, raw]) => [name, JSON.parse(raw)]));
  const directory = '/synthetic/missing/application', project = directory + '/project';
  const browser = { executablePath:'/synthetic/chrome',sha256:'a'.repeat(64) };
  const configuration = applicationConfiguration(project, browser, 1);
  const generated = applicationGeneratedSources(corpus, project + '/adapter.mjs');
  const sourceBytes = Object.fromEntries([['adapter.mjs', Buffer.from('/* captured adapter, source admission separate */')],
    ['runner.config.mjs', Buffer.from('/* captured configuration, source admission separate */')], ...generated.map(s=>[s.record.path,Buffer.from(s.contents)])]);
  const prepared = {schemaVersion:1,application:'todomvc',engine:'flashwright',workers:1,workspaceDirectory:'/synthetic',directory,project,browser,
    driverPath:'/synthetic/driver',configuration,corpusManifestSha256:corpus.manifestSha256,generatedSources:generated.map(s=>s.record),
    generatedHashes:Object.fromEntries(Object.entries(sourceBytes).map(([name,bytes])=>[name,hash(bytes)])),
    ownerCommand:['/synthetic/bun','/synthetic/owner.mjs',directory],runnerCommand:['/synthetic/bun','/synthetic/runner.mjs','test','--config',project+'/runner.config.mjs']};
  const specs=applicationTestIdentities(corpus).map((identity,index)=>({id:'test-'+index,...identity,ok:!(failed&&index===0),tests:[{expectedStatus:'passed',status:failed&&index===0?'unexpected':'expected',results:[{status:failed&&index===0?'failed':'passed',retry:0,parallelIndex:0,workerIndex:0,duration:1,errors:failed&&index===0?[{message:'original failure'}]:[]}]}]}));
  const reporter={errors:[],config:{version:corpus.manifest.tests.reference,configFile:project+'/runner.config.mjs',rootDir:project+'/tests',workers:1,
    forbidOnly:true,fullyParallel:false,maxFailures:0,shard:null,globalSetup:null,globalTeardown:null,reporter:configuration.reporter,
    projects:[{testDir:project+'/tests',outputDir:project+'/results',retries:0,repeatEach:1,timeout:30000}]},suites:[{title:'',specs}],
    stats:{expected:specs.length-(failed?1:0),unexpected:failed?1:0,skipped:0,flaky:0,duration:30}};
  const requestCounts={};for(const policy of Object.values(corpus.manifest.httpExpectations))for(const [path,count] of Object.entries(policy))requestCounts[path]=Math.max(count,requestCounts[path]??0);
  const events=['fixture-start-requested','fixture-listening','runner-spawn-requested','runner-closed','runner-streams-retained',...(failed?[]:['reporter-output-readable']),'fixture-close-requested','fixture-closed','owner-report-write-requested'];
  const owner={application:'todomvc',engine:'flashwright',workers:1,serviceClosed:true,status:failed?'failed':'completed-owner',failures:failed?['original failed outcome']:[],runnerCommand:prepared.runnerCommand,
    runnerExit:{code:failed?1:0,signal:null},clock:{captureIdentity:originals.capture.captureIdentity,domain:'linux-clock-monotonic',originNanoseconds:'200',implementation:'clock_gettime(CLOCK_MONOTONIC)'},
    events:events.map((name,index)=>({name,nanoseconds:String(250+index*10)})),requests:Object.entries(requestCounts).flatMap(([path,count])=>Array.from({length:count},()=>({method:'GET',path,status:200})))};
  change({prepared,owner,reporter,sourceBytes,originals});
  const files=new Map();
  function retain(path,originalPath,bytes) {files.set(path,bytes);return {path,originalPath,bytes:bytes.length,sha256:hash(bytes)};}
  const preparedReceipt=retain('inputs/prepared.json',directory+'/prepared.json',encode(prepared));
  const generatedReceipts=Object.entries(sourceBytes).map(([name,bytes],index)=>retain('inputs/source-'+index,project+'/'+name,bytes));
  const selected=[preparedReceipt,...generatedReceipts].map(({originalPath,bytes,sha256})=>({path:originalPath,resolvedPath:originalPath,bytes,sha256}));
  const executables={runtime:{path:'/synthetic/bun',resolvedPath:'/synthetic/bun'},browser:{path:browser.executablePath,sha256:browser.sha256},driver:{path:prepared.driverPath}};
  for(const name of ['before','after']) {
    originals[name].workloadCommand=prepared.ownerCommand;
    originals[name].inputs={executables,files:[{path:'/synthetic/bun',resolvedPath:'/synthetic/bun'},{path:'/synthetic/owner.mjs',resolvedPath:'/synthetic/owner.mjs',bytes:1,sha256:'a'.repeat(64)},{path:'/synthetic/runner.mjs',resolvedPath:'/synthetic/runner.mjs',bytes:1,sha256:'b'.repeat(64)},...selected]};
  }
  originals.capture.workloadCommand=prepared.ownerCommand;
  originals.capture.wrapperCommand.splice(-2,2,...prepared.ownerCommand);
  originals.capture.collectorCommand.splice(-2,2,...prepared.ownerCommand);
  originals.native.commandBytes=originals.capture.wrapperCommand;
  originals.native.originalWait.exitCode=failed?1:0;originals.native.originalWait.status=failed?256:0;
  originals.capture.native.originalWrapperWait=structuredClone(originals.native.originalWait);
  originals.capture.workloadClock={schemaVersion:1,type:'monotonic',implementation:'clock_gettime(CLOCK_MONOTONIC)',identity:originals.capture.captureIdentity,originNanoseconds:'200',resolutionSeconds:1e-9};
  let dispatchReport = {};
  if (dispatch) {
    for (const [index, event] of owner.events.entries()) event.nanoseconds = String(index < 3 ? 230 + index * 10 : 600 + (index - 3) * 10);
    dispatchReport = syntheticDispatch({ prepared, preparedSha256: preparedReceipt.sha256, owner, reporter, before: originals.before,
      resources: { captureIdentity: originals.capture.captureIdentity } });
    originals.after.inputs = structuredClone(originals.before.inputs);
    changeDispatch(dispatchReport);
  }
  const outputs=[['owner-report.json',encode(owner)],['project/report.json',encode(reporter)],['runner-stdout.txt',Buffer.from('retained output')],['runner-stderr.txt',Buffer.alloc(0)],['dispatch-report.json',encode(dispatchReport)]]
    .map(([name,bytes],index)=>retain('outputs/'+index,directory+'/'+name,bytes));
  originals.capture.requestedOutputs=outputs.map(r=>r.originalPath);
  originals.capture.capturedOutputs=outputs.map(({originalPath,bytes,sha256})=>({path:originalPath,resolvedPath:originalPath,bytes,sha256}));
  const resourceManifest={schemaVersion:1,accountingClass:fixture.header.accountingClass,files:{}};
  for(const name of ['before','after','native']) {
    const bytes=encode(originals[name]);const receipt={path:'originals/'+name+'.json',bytes:bytes.length,sha256:hash(bytes)};
    resourceManifest.files[name]=receipt;files.set(receipt.path,bytes);
    const key=name==='native'?'nativeReceipt':name;originals.capture[key]={...originals.capture[key],bytes:receipt.bytes,sha256:receipt.sha256};
  }
  const raw=encode(originals.capture);resourceManifest.files.capture={path:'originals/capture.json',bytes:raw.length,sha256:hash(raw)};files.set('originals/capture.json',raw);
  const outputManifest={schemaVersion:1,accountingClass:fixture.header.accountingClass,captureSha256:hash(raw),outputs};
  const manifest={schemaVersion:1,accountingClass:fixture.header.accountingClass,captureSha256:hash(raw),prepared:preparedReceipt,generated:generatedReceipts,
    ...(dispatch ? { dispatch: { observerOriginalPath: '/synthetic/observer.cjs' } } : {})};
  const reads=[];
  const args={resourceManifest,outputManifest,manifest,corpus,application:'todomvc',engine:'flashwright',workers:1,readBytes:async (receipt,limits)=>{
    assert(!receipt.path.startsWith('/'),'Historical paths must remain inert');reads.push(receipt.path);
    const bytes=files.get(receipt.path);assert(bytes);assert.equal(bytes.length,limits.expectedSize);assert(bytes.length<=limits.maximumFileBytes);return bytes;
  }};
  return {args,files,reads};
}

test('retained application sources, outcomes and original owner timeline reconstruct without historical filesystem access',async()=>{
 const {args}=bundle();const result=await reconstructFinalGoalLinuxApplication(args);
 assert.equal(result.tests.length,24);assert.equal(result.passed,true);assert.equal(result.completeCorpusExecuted,true);
 assert.equal(result.resourceAdmission,false);assert.equal(result.performanceAccepted,false);assert.equal(result.callbackDispatchVerified,false);
 assert.equal(result.nativeCleanObservedTeardown,false);
});
test('a fully reported failed workload retains its failed outcome and original diagnostics',async()=>{
 const result=await reconstructFinalGoalLinuxApplication(bundle({failed:true}).args);
 assert.equal(result.passed,false);assert.equal(result.tests[0].attempts[0].errors[0].message,'original failure');
 assert.equal(result.performanceAccepted,false);
});
test('optional retained dispatch joins all application attempts without claiming native ownership', async () => {
 const result = await reconstructFinalGoalLinuxApplication(bundle({ dispatch: true }).args);
 assert.equal(result.dispatch.tests, 24); assert.equal(result.dispatch.dispatchJournalVerified, true);
 assert.equal(result.dispatch.freshFixtureJsContexts, 24); assert.equal(result.dispatch.nativeContextOwnershipVerified, false);
 assert.equal(result.callbackDispatchVerified, false); assert.equal(result.performanceAccepted, false);
});
test('failed application outcomes cannot opt into passing-only dispatch verification', async () => {
 await assert.rejects(() => reconstructFinalGoalLinuxApplication(bundle({ dispatch: true, failed: true }).args), /passing corpora only/);
});
test('captured but incomplete dispatch journal cannot pass application integration', async () => {
 const b = bundle({ dispatch: true, changeDispatch: raw => { raw.journals[0].text = raw.journals[0].text.split('\n').slice(0, -2).join('\n') + '\n'; } });
 await assert.rejects(() => reconstructFinalGoalLinuxApplication(b.args));
});
test('oversized dispatch declaration rejects before any retained reads', async () => {
 const b = bundle({ dispatch: true }); b.args.outputManifest.outputs[4].bytes = 4 * 1024 ** 2 + 1;
 await assert.rejects(() => reconstructFinalGoalLinuxApplication(b.args), /Dispatch report byte limit/); assert.deepEqual(b.reads, []);
});
for(const [name,change] of [
 ['wrong engine',d=>d.prepared.engine='playwright'],['wrong workers',d=>d.prepared.workers=4],
 ['different corpus',d=>d.prepared.corpusManifestSha256='0'.repeat(64)],['wrong project',d=>d.prepared.project='/elsewhere'],
 ['altered test source',d=>{const name=Object.keys(d.sourceBytes).find(n=>n.endsWith('.spec.ts'));d.sourceBytes[name]=Buffer.from('changed');}],
 ['changed source declaration',d=>d.prepared.generatedSources[0].generatedSha256='0'.repeat(64)],
 ['wrong owner identity',d=>d.owner.clock.captureIdentity='b'.repeat(32)],['wrong clock origin',d=>d.owner.clock.originNanoseconds='201'],
 ['outside original interval',d=>d.owner.events[0].nanoseconds='1'],['reversed owner phases',d=>d.owner.events.reverse()],
 ['owner service still open',d=>d.owner.serviceClosed=false],['runner command substituted',d=>d.owner.runnerCommand=['not-the-runner']],
 ['missing reported test',d=>d.reporter.suites[0].specs.pop()],['source identity relabelled',d=>d.reporter.suites[0].specs[0].title='substitute'],
 ['invented pass count',d=>d.reporter.stats.expected++],['missing application work',d=>d.owner.requests=[]],
 ['skipped attempt',d=>d.reporter.suites[0].specs[0].tests[0].results[0].status='skipped'],
 ['unreported retry',d=>d.reporter.suites[0].specs[0].tests[0].results[0].retry=1],
 ['worker escapes policy',d=>d.reporter.suites[0].specs[0].tests[0].results[0].parallelIndex=1],
 ['owner outcome promotion',d=>d.owner.runnerExit.code=1],
]) test('rejects captured application mismatch: '+name,async()=>{
 await assert.rejects(()=>reconstructFinalGoalLinuxApplication(bundle({change}).args));
});
for(const [name,change] of [
 ['capture substitution',a=>a.manifest.captureSha256='b'.repeat(64)],
 ['oversized output inventory',a=>a.outputManifest.outputs=Array(257).fill(a.outputManifest.outputs[0])],
 ['malformed output declaration',a=>a.outputManifest.outputs[0].bytes=-1],
 ['unknown original resource file',a=>a.resourceManifest.files.extra=a.resourceManifest.files.native],
 ['absolute retained path',a=>a.manifest.prepared.path='/private/prepared.json'],
 ['path traversal',a=>a.manifest.prepared.path='../prepared.json'],
 ['output path alias',a=>a.manifest.prepared.path=a.outputManifest.outputs[0].path],
 ['input duplicate',a=>a.manifest.generated.push(a.manifest.generated[0])],
 ['file size limit',a=>a.manifest.prepared.bytes=linuxApplicationEvidenceLimits.maximumFileBytes+1],
 ['too many sources',a=>a.manifest.generated=Array(64).fill(a.manifest.generated[0])],
 ['aggregate size limit',a=>{a.manifest.generated=Array.from({length:5},(_,i)=>({...a.manifest.generated[0],path:'large/'+i,originalPath:'/large/'+i,bytes:linuxApplicationEvidenceLimits.maximumFileBytes}));}],
]) test('malformed application inventory rejects before reads: '+name,async()=>{
 const b=bundle();change(b.args);await assert.rejects(()=>reconstructFinalGoalLinuxApplication(b.args));assert.deepEqual(b.reads,[]);
});
test('altered retained payload fails the byte binding',async()=>{
 const b=bundle();const receipt=b.args.manifest.generated[0];b.files.set(receipt.path,Buffer.alloc(receipt.bytes,120));
 await assert.rejects(()=>reconstructFinalGoalLinuxApplication(b.args),/bytes changed/);
});
for(const raw of ['{"a":1,"a":2}','{"x":{"a":1,"\\u0061":2}}','{"n":1e999}','['.repeat(129)+'0'+']'.repeat(129)])
 test('strict application JSON rejects '+raw.slice(0,45),()=>assert.throws(()=>decodeLinuxApplicationJson(Buffer.from(raw))));
test('strict application JSON preserves strings, arrays and separate object namespaces',()=>{
 const value={a:'{[\"escaped\"]}',items:[{a:1},{a:2}],nested:{a:{a:3}},flag:true,n:null};
 assert.deepEqual(decodeLinuxApplicationJson(encode(value)),value);
 assert.throws(()=>decodeLinuxApplicationJson(Buffer.from([0xff])));
});


test('draft campaign integrates captured application outcomes without opening final admission', async () => {
  const b = bundle({ dispatch: true });
  const configuration = JSON.parse(await readFile(new URL('../benchmarks/configurations/final-goal-linux.json', import.meta.url)));
  const temporaryRoot = fileURLToPath(new URL('../workbench/final-goal-linux-application-tests/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'draft-'));
  try {
    const save = async (path, value) => {
      const bytes = encode(value); await writeFile(join(directory, path), bytes);
      return { path, sha256: hash(bytes) };
    };
    for (const [path, bytes] of b.files) {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), bytes);
    }
    const resources = await reconstructFinalGoalLinuxResourceEvidence(b.args.resourceManifest, b.args.readBytes);
    const report = { tests: [] }; // Final normalized callback/clock report is still unadmitted.
    const evidence = [];
    for (const [kind, path, value] of [['report', 'report.json', report], ['resources', 'resources.json', resources],
      ['linux-cgroup-originals', 'originals.json', b.args.resourceManifest], ['linux-captured-outputs', 'outputs.json', b.args.outputManifest],
      ['linux-application-workload', 'application.json', b.args.manifest]]) evidence.push({ kind, ...await save(path, value) });
    const campaign = { schemaVersion: 1, configuration: await save('configuration.json', configuration),
      declaration: await save('declaration.json', { schemaVersion: 1, status: 'draft', configurationSha256: finalGoalHash(configuration),
        accountingClass: configuration.accountingClass, resourceContext: { accountingClass: configuration.accountingClass } }), scenarios: [] };
    for (const scenario of configuration.scenarios) {
      const result = { id: scenario.id, cells: configuration.cells.map((cell, index) => scenario.id === 'application-todomvc' && index === 0
        ? { id: cell.id, status: 'noncomparable', reason: 'Synthetic workload fixture; final admission absent', attempts: [{ runs: { flashwright: { report, resources, evidence } } }] }
        : { id: cell.id, status: 'unmeasured', attempts: [] }) };
      campaign.scenarios.push({ ...await save(scenario.id + '.json', result), scenarioId: scenario.id });
    }
    await save('campaign.json', campaign);
    const result = await verifyFinalGoalEvidence(directory);
    assert.equal(result.analysis.goalAccepted, false);
    assert.equal(result.linuxApplicationOutcomes.length, 1);
    assert.equal(result.linuxApplicationOutcomes[0].tests.length, 24);
    assert.equal(result.linuxApplicationOutcomes[0].callbackDispatchVerified, false);
    assert.equal(result.linuxApplicationOutcomes[0].dispatch.dispatchJournalVerified, true);
    await writeFile(join(directory, b.args.manifest.generated[0].path), Buffer.from('substituted input'));
    await assert.rejects(() => verifyFinalGoalEvidence(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('selected input receipt substitution rejects before any application input payload read', async () => {
  const b = bundle(); b.args.manifest.generated[0].sha256 = 'f'.repeat(64);
  await assert.rejects(() => reconstructFinalGoalLinuxApplication(b.args), /differs from original capture/);
  assert(b.reads.every(path => !path.startsWith('inputs/')));
});

test('a missing generated input cannot masquerade as a complete source inventory', async () => {
  const b = bundle(); b.args.manifest.generated.pop();
  await assert.rejects(() => reconstructFinalGoalLinuxApplication(b.args), /Incomplete generated source inventory/);
  assert(!b.reads.some(path => path.startsWith('inputs/source-')));
});
