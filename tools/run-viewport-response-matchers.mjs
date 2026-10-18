import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {viewportHTML,viewportCases,responseCases} from '../compatibility/m2/viewport-response-matchers.mjs';
import {runtimeMetadata} from './javascript-runtime.mjs';
import {identifyBrowser} from './browser-identity.mjs';
const require=createRequire(import.meta.url),out=resolve(process.argv[2]);await mkdir(out);
const implementation=process.argv.includes('--candidate')?'flashwright':'playwright';
const {chromium,request}=require(implementation),{expect}=require(implementation==='flashwright'?'@flashwright/test':'flashwright-upstream-runner/test');
const browserPath=process.env.FLASHWRIGHT_BROWSER_PATH;assert(browserPath);
const sourceFiles=['tools/run-viewport-response-matchers.mjs','compatibility/m2/viewport-response-matchers.mjs','packages/flashwright-runner/src/matchers.ts','packages/flashwright-runner/src/response-matcher.ts','packages/flashwright-runner/src/index.ts','packages/flashwright-core/src/runner-integration.ts','crates/flashwright-engine/src/assertions.rs','packages/resident-runtime/locator-runtime.js','packages/resident-runtime/condition-registry.js'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async p=>[p,hash(await readFile(p))])));
const report={status:'running',implementation,...runtimeMetadata,checks:[],scope:'Selected viewport and API response assertions; no JS-property or performance admission.'};
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api'){
  res.statusCode=Number(url.searchParams.get('status'));const type=url.searchParams.get('type');if(type!=='absent')res.setHeader('content-type',type);
  res.end('body-marker '+('x'.repeat(1100))+' end-marker');return;
 }
 res.setHeader('content-type','text/html; charset=utf-8');
 res.end(url.pathname==='/child'?'<link rel="icon" href="data:,"><div id="child" style="width:50px;height:50px">child</div><div id="far" style="position:absolute;top:2000px">far</div>':url.pathname==='/successor'?'<link rel="icon" href="data:,"><div id="successor">ready</div>':viewportHTML);
});
let browser;
try{
 report.sourceHashes=await hashes();report.browser=await identifyBrowser(browserPath);
 if(implementation==='flashwright')report.driverSha256=hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH));
 await new Promise(resolve=>server.listen(0,resolve));const baseURL=`http://127.0.0.1:${server.address().port}`;
 const check=async(name,callback)=>{await callback();report.checks.push(name)};
 browser=await chromium.launch({executablePath:browserPath});const context=await browser.newContext({viewport:{width:640,height:480}});const page=await context.newPage();await page.goto(baseURL);
 await viewportCases(page,expect,check,baseURL,implementation);await context.close();await browser.close();browser=undefined;
 await responseCases(request,expect,check,baseURL);
 assert.deepEqual(await hashes(),report.sourceHashes);report.status='passed';
}catch(error){report.status='failed';report.error=error.stack??String(error);process.exitCode=1}
finally{
 try{await browser?.close()}catch(error){report.cleanupError=error.stack;report.status='failed';process.exitCode=1}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
