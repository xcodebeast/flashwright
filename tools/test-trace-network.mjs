import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const require=createRequire(import.meta.url);
const {TraceNetworkChannel}=require('../packages/flashwright-core/dist/commonjs/trace-network.js');
const {NativeTraceRecording,NativeTraceChunk}=require('../packages/flashwright-core/dist/commonjs/trace-recording.js');
const {TraceResources}=require('../packages/flashwright-core/dist/commonjs/trace-resources.js');
const {TraceWriter}=require('../packages/flashwright-core/dist/commonjs/trace-writer.js');
const {tryAcquireTraceTransfer}=require('../packages/flashwright-core/dist/commonjs/trace-transfers.js');
const {utils}=require('playwright-core/lib/coreBundle');
const output=resolve(process.argv[2]);await mkdir(output);
const report={status:'running',checks:[]};
const identity={context:'context',recording:'recording',chunk:'first'};
const token=number=>`network-resource-${number.toString(16).padStart(16,'0')}`;
const metadata=()=>({page:'native-page',frame:'original-frame',identity:'request:1',nativeTime:5,startedWallTime:1700000000000,responseHeadersWallTime:1700000000000,originalIngress:{sequence:1,nativeTime:4},originalRequestTimestamp:1,originalRequestWallTime:1700000000,request:{url:'http://example.test/data',method:'POST',resourceType:'Fetch',headers:[]},effectiveRequest:{url:'http://example.test/data',method:'POST'},requestHeadersReady:true,responseHeadersReady:true,servedFromCache:false,routing:{},response:{status:200,statusText:'OK',headers:{'Content-Type':'application/octet-stream'},protocol:'http/1.1'},terminal:{kind:'finished',timestamp:1.1,encodedDataLength:20}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}};
class Driver {
 calls=[];data=new Map([[token(1),Buffer.from([0,255,128,0])],[token(2),Buffer.from('a=1&a=2')]]);
 resources=[{token:token(1),byteLength:4,formEncoded:false},{token:token(2),byteLength:7,formEncoded:true}];
 entries=[{metadata:{...metadata(),requestPostData:{token:token(2),byteLength:7,mimeType:'application/x-www-form-urlencoded'}},body:{kind:'resource',token:token(1),byteLength:4}}];
 pendingNetwork=false;
 async request(method,parameters){
  this.calls.push({method,parameters});
  if(method.endsWith('.pull'))return{recording:identity.recording,resources:this.resources.splice(0),pending:false};
  if(method.endsWith('.entry'))return parameters.index<this.entries.length?{ready:true,done:false,index:parameters.index,...this.entries[parameters.index]}:{done:true,count:this.entries.length};
  if(method.endsWith('.seal'))return{lastEventSequence:9};
  if(method==='context.trace.recording.status')return{recording:parameters.recording,networkPending:this.pendingNetwork};
  return null;
 }
 async requestTraceAttachment(method,parameters){this.calls.push({method,parameters});return Buffer.from(this.data.get(parameters.token));}
}
async function fixture(driver=new Driver()){
 const resources=await TraceResources.create();const writer=await TraceWriter.create(resources);const failures=[];
 const channel=new TraceNetworkChannel(driver,identity.context,identity.recording,resources,error=>failures.push(error));clearTimeout(channel.timer);
 const chunk=new NativeTraceChunk(driver,identity);chunk.clock={nativeTime:0,hostBefore:100,hostAfter:100,offset:100,uncertainty:0};
 return{driver,resources,writer,channel,chunk,failures,async dispose(){await channel.stop();await writer.dispose();await resources.dispose()}};
}
async function check(name,work){await work();report.checks.push(name)}
try{
 await check('one immutable resource ingestion serves multiple chunk archives with original frame and clock',async()=>{
  const state=await fixture();let second;
  try{
   await state.channel.exportChunk(state.chunk,state.writer,page=>`mapped-${page}`);
   const firstLines=(await readFile(join(state.writer.directory,'trace.network'),'utf8')).trim().split('\n').map(JSON.parse);
   assert.equal(firstLines.length,1);const entry=firstLines[0].snapshot;
   assert.equal(firstLines[0].type,'resource-snapshot');assert.equal(entry._frameref,'original-frame');assert.equal(entry._monotonicTime,105);assert.equal(entry.pageref,'mapped-native-page');
   assert.deepEqual(entry.request.postData.params,[{name:'a',value:'1'},{name:'a',value:'2'}]);
   second=await TraceWriter.create(state.resources);const chunk=new NativeTraceChunk(state.driver,{...identity,chunk:'second'});chunk.clock=state.chunk.clock;
   await state.channel.exportChunk(chunk,second,page=>`mapped-${page}`);assert.equal(state.driver.calls.filter(call=>call.method.endsWith('.take')).length,2);
   assert.equal(state.driver.calls.filter(call=>call.method.endsWith('.ingested')).length,2);
   const path=join(output,'network.zip');await second.finish(path,new AbortController().signal);
   const archive=new utils.ZipFile(path);try{
    assert.deepEqual(JSON.parse((await archive.read('trace.network')).toString()),firstLines[0]);
    assert.deepEqual(await archive.read(`resources/${entry.response.content._sha1}`),Buffer.from([0,255,128,0]));
    assert.equal((await archive.read(`resources/${entry.request.postData._sha1}`)).toString(),'a=1&a=2');
   }finally{archive.close()}
  }finally{await second?.dispose();await state.dispose()}
 });
 await check('pending sealed body retries its original index while ingestion finishes',async()=>{
  const driver=new Driver();const original=driver.request;let waits=0;
  driver.request=async function(method,parameters){if(method.endsWith('.entry')&&parameters.index===0&&waits++<2)return{ready:false,index:0};return original.call(this,method,parameters)};
  const state=await fixture(driver);try{await state.channel.exportChunk(state.chunk,state.writer,page=>page);assert.equal(waits,3);assert.equal(state.failures.length,0)}finally{await state.dispose()}
 });
 await check('host cancellation retains shared transfer until immutable ingestion settles and never ACKs',async()=>{
  const state=await fixture();const entered=deferred();const release=deferred();const original=state.resources.captureBytes.bind(state.resources);
  state.resources.captureBytes=async(bytes,signal)=>{entered.resolve();await release.promise;return original(bytes,signal)};
  const controller=new AbortController();const exporting=state.channel.exportChunk(state.chunk,state.writer,page=>page,controller.signal);void exporting.catch(()=>{});
  try{
   await entered.promise;assert.equal(tryAcquireTraceTransfer(state.driver,identity.context),undefined);
   controller.abort(new Error('controlled ingestion cancellation'));const stopping=state.channel.stop();
   assert.equal(tryAcquireTraceTransfer(state.driver,identity.context),undefined);assert.equal(state.driver.calls.filter(call=>call.method.endsWith('.ingested')).length,0);
   release.resolve();await assert.rejects(exporting,/controlled ingestion cancellation/);await stopping;
   assert.equal(state.driver.calls.filter(call=>call.method.endsWith('.ingested')).length,0);
   const successor=tryAcquireTraceTransfer(state.driver,identity.context);assert.equal(typeof successor,'function');successor();
  }finally{release.resolve();await state.dispose()}
 });
 await check('invalid original resource metadata fails before transferring bytes',async()=>{
  const driver=new Driver();driver.resources[0].byteLength=-1;const state=await fixture(driver);
  try{await assert.rejects(state.channel.exportChunk(state.chunk,state.writer,page=>page),/invalid original network resource metadata/);assert.equal(driver.calls.filter(call=>call.method.endsWith('.take')).length,0);assert.equal(state.failures.length,1)}finally{await state.dispose()}
 });
 await check('network retirement polls exact recording custody before stop and ignores HTTP-only waits',async()=>{
  const driver=new Driver();driver.pendingNetwork=true;const recording=new NativeTraceRecording(driver,identity.context,true);await recording.start();
  const work=recording.cleanup();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(driver.calls.filter(call=>call.method==='context.trace.recording.stop').length,0);
  driver.pendingNetwork=false;await work;
  assert.equal(driver.calls.filter(call=>call.method==='context.trace.recording.stop').length,1);
  assert.equal(driver.calls[0].parameters.network,true);
 });
 await check('network and action streams share the aggregate writer byte bound',async()=>{
  const state=await fixture();try{state.writer.bytes=64*1024*1024-1;await assert.rejects(state.writer.appendNetwork({type:'resource-snapshot'},new AbortController().signal),/stream or queued-write allowance/);assert.equal(state.writer.networkBytes,0)}finally{await state.dispose()}
 });
 report.status='passed';
}catch(error){report.status='failed';report.error={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))}
