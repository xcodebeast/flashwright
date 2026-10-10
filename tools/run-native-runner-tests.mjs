import { createHttpFixture } from './http-fixture.mjs';
import { runtimeMetadata, runtimeArtifactLabel } from './javascript-runtime.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const { server, close: closeServer } = createHttpFixture((_request,response) => { response.setHeader('content-type','text/html'); response.end('<title>Runner fixture</title><form onsubmit="event.preventDefault();document.querySelector(\'output\').textContent=\'Saved \'+document.querySelector(\'#name\').value"><label>Name<input id="name"></label></form><output role="status">Ready</output><label><input type="checkbox">Choice</label>'); });
server.listen(0,'127.0.0.1'); await once(server,'listening');
try {
 const child=spawn('python3',['tools/watchdog.py','--timeout','120','--report-directory','compatibility/evidence/resources','--',process.execPath,'packages/flashwright-test/cli.cjs','test','--config','compatibility/m2/runner/playwright.config.ts'],{stdio:'inherit',env:{...process.env,FLASHWRIGHT_TEST_BASE_URL:'http://127.0.0.1:'+server.address().port,FLASHWRIGHT_DRIVER_PATH:process.env.FLASHWRIGHT_DRIVER_PATH??resolve('target/debug/flashwright-driver'),FLASHWRIGHT_BROWSER_PATH:process.env.FLASHWRIGHT_BROWSER_PATH??chromium.executablePath()}});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 assert.equal(code,1,'Exactly the deliberate timeout fails the nested runner');
 const report=JSON.parse(await readFile('test-results/native-runner.json','utf8'));
 const specs=suites=>suites.flatMap(suite=>[...suite.specs,...specs(suite.suites??[])]);
 const all=specs(report.suites); assert.equal(all.length,12); assert.equal(report.stats.unexpected,1); assert.equal(report.stats.flaky,1);
 for(const spec of all) {
   const test=spec.tests[0];
   if(spec.title.includes('unsupported context')) { assert.equal(test.expectedStatus,'failed'); assert.ok(test.results[0].errors.some(error=>error.message.includes('test.use.locale'))); }
   else if(spec.title.includes('unsupported artifact')) { assert.equal(test.expectedStatus,'failed'); assert.ok(test.results[0].errors.some(error=>error.message.includes('test.use.video'))); }
   else for(const result of test.results) assert.ok(result.attachments.some(attachment=>attachment.name==='flashwright-context-disposed'),`Missing teardown for ${spec.title}`);
 }
 const timeout=all.find(spec=>spec.title.includes('unbounded native')).tests[0]; assert.deepEqual(timeout.results.map(result=>result.status),['timedOut','timedOut']);
 const retry=all.find(spec=>spec.title.includes('runner retries')).tests[0]; assert.deepEqual(retry.results.map(result=>result.status),['failed','passed']);
 const soft=all.find(spec=>spec.title.includes('soft native')).tests[0]; assert.equal(soft.expectedStatus,'failed'); assert.equal(soft.results[0].errors.length,1);
 const hash=value=>createHash('sha256').update(value).digest('hex');
 await mkdir('compatibility/evidence',{recursive:true});
 const destination=`compatibility/evidence/native-runner-${process.platform}-${process.arch}-${runtimeArtifactLabel}.json`;
 await writeFile(destination,JSON.stringify({...runtimeMetadata,platform:process.platform,architecture:process.arch,driverSha256:hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH ?? 'target/debug/flashwright-driver')),report,checks:['native browser fixtures','extended page objects and custom options','context isolation','storageState context-option inheritance, explicit override and file fixture','soft/configured/negated assertions','retry ownership','timeout teardown','explicit unsupported config and matcher rejection','upstream browser/request paths poisoned'],scope:'Experimental adapter; artifacts, aliases and full runner/config parity remain incomplete.'},null,2)+'\n');
 console.log(`Native runner evidence: ${destination}`);
} finally {await closeServer();}
