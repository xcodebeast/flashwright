import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
const {PNG}=createRequire(import.meta.url)('/workspace/node_modules/playwright-core/lib/utilsBundle.js');
const server=createServer((request,response)=>{response.setHeader('content-type','text/html');response.end(request.url==='/remote'?'<style>html,body{margin:0;background:yellow}</style>':'<style>body{margin:0;background:red}</style>');});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const profile=await mkdtemp('/tmp/flashwright-chromium-barrier-');
const policy=JSON.parse(await readFile('crates/flashwright-browser/src/chromium-launch-policy.json','utf8'));
const child=spawn(process.env.FLASHWRIGHT_BROWSER_PATH,policy.headless.map(value=>value.replace('__FLASHWRIGHT_PROFILE__',profile)),{stdio:['ignore','ignore','ignore','pipe','pipe']});
const exited=once(child,'exit');let incoming=Buffer.alloc(0);let identifier=0;const pending=new Map();const observers=new Set();
child.stdio[4].on('data',chunk=>{incoming=Buffer.concat([incoming,chunk]);let offset;while((offset=incoming.indexOf(0))!==-1){const value=JSON.parse(incoming.subarray(0,offset));incoming=incoming.subarray(offset+1);const owner=pending.get(value.id);if(owner){pending.delete(value.id);if(value.error)owner.reject(new Error(JSON.stringify(value.error)));else owner.resolve(value.result);}else for(const observe of [...observers])observe(value);}});
function send(method,params={},sessionId){const id=++identifier;const result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));child.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');return result;}
function event(method,sessionId){return new Promise(resolve=>{const observe=value=>{if(value.method===method&&value.sessionId===sessionId){observers.delete(observe);resolve(value.params);}};observers.add(observe);});}
const records=[];
try{
 await send('Browser.getVersion');
 for(let iteration=0;iteration<3;iteration++)for(const mode of ['none','attach','evaluate','enable','layout','frames']){
  const {browserContextId}=await send('Target.createBrowserContext',{disposeOnDetach:true});
  const {targetId}=await send('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Page.enable',{},sessionId);await send('Runtime.enable',{},sessionId);
  await send('Emulation.setFocusEmulationEnabled',{enabled:true},sessionId);
  const {windowId}=await send('Browser.getWindowForTarget',{},sessionId);await send('Browser.setWindowBounds',{windowId,bounds:{width:320,height:240}},sessionId);
  await send('Emulation.setDeviceMetricsOverride',{width:320,height:240,deviceScaleFactor:1,mobile:false,screenWidth:320,screenHeight:240,screenOrientation:{angle:0,type:'landscapePrimary'}},sessionId);
  const loaded=event('Page.loadEventFired',sessionId);await send('Page.navigate',{url:origin},sessionId);await loaded;
  const remote=origin.replace('127.0.0.1','localhost')+'/remote';
  await send('Runtime.evaluate',{expression:`(async()=>{const frame=document.createElement('iframe');frame.style.cssText='position:absolute;left:120px;top:100px;width:100px;height:60px;border:0';const loaded=new Promise(resolve=>frame.onload=resolve);frame.src=${JSON.stringify(remote)};document.body.append(frame);await loaded;return true;})()`,awaitPromise:true,returnByValue:true},sessionId);
  if(mode!=='none'){
   const {targetInfos}=await send('Target.getTargets');const target=targetInfos.find(target=>target.type==='iframe'&&target.url===remote);
   if(!target)throw new Error('No remote target');
   const {sessionId:remoteSession}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
   if(mode==='evaluate')await send('Runtime.evaluate',{expression:'0',returnByValue:true},remoteSession);
   if(mode==='enable')await send('Page.enable',{},remoteSession);
   if(mode==='layout')await send('Page.getLayoutMetrics',{},remoteSession);
   if(mode==='frames')await send('Runtime.evaluate',{expression:'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',awaitPromise:true,returnByValue:true},remoteSession);
  }
  await send('Page.getLayoutMetrics',{},sessionId);
  const result=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:320,height:240,scale:1},captureBeyondViewport:false},sessionId);
  const image=PNG.sync.read(Buffer.from(result.data,'base64'));const offset=(120*image.width+150)*4;
  records.push({iteration,mode,pixel:[...image.data.subarray(offset,offset+4)]});console.log(records.at(-1));
  await send('Target.disposeBrowserContext',{browserContextId});
 }
}finally{await writeFile('/output/report.json',JSON.stringify(records,null,2)+'\n');await send('Browser.close').catch(()=>{});await exited;await rm(profile,{recursive:true,force:true});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
