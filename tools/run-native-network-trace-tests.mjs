import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const require = createRequire(join(root,'package.json'));
const { chromium } = require(join(root,'packages/flashwright-core/dist/commonjs/index.js'));
const { convertNetworkTraceEntry } = require(join(root,'packages/flashwright-core/dist/commonjs/trace-network-entry.js'));
const { identifyBrowser } = await import(join(root,'tools/browser-identity.mjs'));
const output = resolve(process.argv[2]); await mkdir(output,{recursive:true});
const hash = value => createHash('sha256').update(value).digest('hex');
const idle = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));
const checks=[]; const requests=[]; const bytes=Buffer.from([0,255,128,13,10,0,42]);
const server=createServer(async(request,response)=>{
 const body=Buffer.concat(await Array.fromAsync(request)); requests.push({url:request.url,method:request.method,body:body.toString('base64')});
 if(request.url==='/never')return;
 if(request.url==='/redirect'){response.writeHead(302,{location:'/binary'});response.end();return;}
 if(request.url==='/empty'){response.writeHead(200,{'content-type':'text/plain'});response.end();return;}
 if(request.url==='/binary'||request.url==='/echo'){response.writeHead(200,{'content-type':'application/octet-stream'});response.end(request.url==='/echo'?body:bytes);return;}
 if(request.url==='/missing'){response.writeHead(404,{'content-type':'text/plain'});response.end('original missing body');return;}
 if(request.url==='/sheet.css'){response.writeHead(200,{'content-type':'text/css'});response.end('body{color:rgb(1,2,3)}');return;}
 response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><link rel="stylesheet" href="/sheet.css"><body>original network fixture</body>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const report={status:'running',scope:'Private native network collection, resource transfer and pure HAR conversion; no trace ZIP or public snapshot activation claim',checks,requests};
try{
 report.browser=await identifyBrowser(process.env.FLASHWRIGHT_BROWSER_PATH);
 browser=await chromium.launch({executablePath:process.env.FLASHWRIGHT_BROWSER_PATH});
 const context=await browser.newContext();const page=await context.newPage();const client=context.client;
 const identity={context:context.identifier,recording:'native-network-probe'};
 const command=(suffix,extra={})=>client.request(`context.trace.${suffix}`,{...identity,...extra},5000);
 await command('recording.start',{network:true});await command('chunk.start',{chunk:'first'});
 const resources=new Map();
 async function drain(){
  for(let attempts=0;attempts<1000;attempts++){
   const batch=await command('network.pull');
   for(const resource of batch.resources){
    const data=await client.requestBinary('context.trace.network.take',{...identity,token:resource.token},5000,resource.byteLength);
    assert.equal(data.length,resource.byteLength);assert.ok(!resources.has(resource.token));
    resources.set(resource.token,{...resource,data,alias:hash(data)});
    await command('network.ingested',{token:resource.token});
   }
   if(!batch.pending&&!batch.resources.length)return;
   await idle(5);
  }throw new Error('original resources did not settle');
 }
 async function entries(chunk){
  const entries=[];
  for(let index=0;index<100;index++){
   for(let attempts=0;;attempts++){
    const entry=await command('network.entry',{chunk,index});
    if(entry.done)return entries;
    if(entry.ready){entries.push(entry);break;}
    assert.ok(attempts<1000);await drain();await idle(5);
   }
  }throw new Error('entry count exceeded probe bound');
 }
 await page.goto(origin);
 await page.evaluate(async values=>{
  const bytes=new Uint8Array(values);const echo=await fetch('/echo',{method:'POST',body:bytes});if((await echo.arrayBuffer()).byteLength!==bytes.length)throw new Error('echo changed');
  for(const path of ['/redirect','/empty','/missing'])await(await fetch(path)).arrayBuffer();
 },[...bytes]);
 await page.route('**/explicit',route=>route.continue({url:origin+'/echo',method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-override':'accepted'},postData:'overridden=1'}));
 await page.route('**/fallback',route=>route.fallback({headers:{'x-fallback':'accepted'}}));
 await page.route('**/fulfilled',route=>route.fulfill({body:bytes,contentType:'application/octet-stream'}));
 await page.route('**/aborted',route=>route.abort());
 await page.evaluate(async()=>{for(const path of ['/explicit','/fallback','/fulfilled','/aborted'])try{await(await fetch(path,{method:'POST',headers:{'content-type':'application/octet-stream'},body:new Uint8Array([0,255,128])})).arrayBuffer()}catch{}});
 await drain();await command('chunk.seal',{chunk:'first'});const first=await entries('first');
 const final=url=>first.filter(entry=>entry.metadata.request.url===origin+url).at(-1);
 assert.deepEqual(resources.get(final('/echo').metadata.requestPostData.token).data,bytes);
 assert.deepEqual(resources.get(final('/echo').body.token).data,bytes);
 assert.deepEqual(resources.get(final('/binary').body.token).data,bytes);
 assert.equal(final('/redirect').body.kind,'unavailable');assert.equal(final('/redirect').metadata.redirectURL,origin+'/binary');
 assert.equal(resources.get(final('/empty').body.token).byteLength,0);
 assert.equal(resources.get(final('/missing').body.token).data.toString(),'original missing body');checks.push('original binary request/response, empty, 404 and redirect outcomes');
 assert.equal(final('/explicit').metadata.routing.continued,true);assert.equal(final('/explicit').metadata.request.url,origin+'/explicit');
 assert.equal(final('/explicit').metadata.effectiveRequest.url,origin+'/echo');assert.deepEqual(resources.get(final('/explicit').metadata.requestPostData.token).data,Buffer.from([0,255,128]));
 assert.equal(final('/fallback').metadata.routing.continued,undefined);assert.equal(final('/fulfilled').metadata.routing.fulfilled,true);assert.equal(final('/aborted').metadata.routing.aborted,true);checks.push('accepted routing flags distinguish explicit continue, fallback, fulfill and abort');
 const converted=first.map(entry=>convertNetworkTraceEntry(entry.metadata,entry.body,{pageReference:entry.metadata.page,monotonicTime:entry.metadata.nativeTime,cookieWallTime:entry.metadata.responseHeadersWallTime,resolveResource:token=>{const resource=resources.get(token);assert.ok(resource);return{alias:resource.alias,byteLength:resource.byteLength,...(resource.formEncoded?{formParameters:[...new URLSearchParams(resource.data.toString())].map(([name,value])=>({name,value}))}:{})}}}));
 const explicit=converted.find(entry=>entry.request.url===origin+'/explicit');assert.equal(explicit.request.method,'POST');assert.ok(explicit.request.headers.some(header=>header.name==='x-override'&&header.value==='accepted'));checks.push('native metadata converts into pinned HAR schema with accepted request headers');
 await page.unrouteAll();await page.evaluate(async()=>{await(await fetch('/binary?gap')).arrayBuffer()});await drain();
 assert.deepEqual(await entries('first'),first);await command('chunk.start',{chunk:'second'});await command('chunk.seal',{chunk:'second'});const second=await entries('second');assert.ok(second.length>first.length);checks.push('sealed prefix stays immutable while recording continues through the chunk gap');
 await page.evaluate(()=>{globalThis.pendingNetwork=new AbortController();void fetch('/never',{signal:pendingNetwork.signal}).catch(()=>{});});await idle(20);
 await command('recording.retire');for(let count=0;(await command('recording.status')).networkPending;count++){assert.ok(count<1000);await idle(5)}await command('recording.stop');assert.equal(await page.evaluate(()=>42),42);checks.push('unfinished HTTP request does not block recording retirement or harm the page');
 await page.evaluate(()=>pendingNetwork.abort());
 report.entries=first;report.secondEntries=second;report.har=converted;report.resources=[...resources.values()].map(({data,...metadata})=>({...metadata,sha256:hash(data)}));
 await context.close();report.status='passed';
}catch(error){report.status='failed';report.error={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks,error:report.error},null,2));}
