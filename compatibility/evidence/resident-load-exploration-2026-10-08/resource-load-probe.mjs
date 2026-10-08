import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
const mode=process.argv[2];let chromium,expect;
if(mode==='playwright')({chromium,expect}=await import('@playwright/test'));
else {({chromium}=await import('flashwright'));({expect}=await import('@flashwright/test'));}
const counts={documents:0,backend:0};
const document=`<!doctype html><link rel="icon" href="data:,"><div id="noise"></div>${'<p class="probe">before</p>'.repeat(4000)}<script>
window.begin=()=>{ window.observations={tasks:0,mutations:0,gaps:[],readyAt:0};let previous=performance.now();
 const tasks=new Promise(resolve=>{function tick(){const now=performance.now();observations.gaps.push(now-previous);previous=now;observations.tasks++;
 for(let index=0;index<32;index++){document.querySelector('#noise').dataset.sequence=String(observations.mutations++);}
 if(observations.tasks<80)setTimeout(tick,16);else resolve();}setTimeout(tick,16);});
 const backend=fetch('/ready').then(response=>response.text()).then(value=>{if(value!=='ready')throw Error(value);});
 Promise.all([tasks,backend]).then(()=>{for(const target of [...document.querySelectorAll('.probe')].slice(-128))target.textContent='after';observations.readyAt=performance.now();});
};</script>`;
const server=createServer((request,response)=>{if(request.url==='/ready'){counts.backend++;setTimeout(()=>response.end('ready'),2000);}else{counts.documents++;response.end(document);}});
server.listen(0,'127.0.0.1');await once(server,'listening');let browser;const started=performance.now();
try {
 browser=await chromium.launch({executablePath:process.env.FLASHWRIGHT_BROWSER_PATH});const context=await browser.newContext({viewport:{width:1280,height:720}});const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
 await expect(page.locator('.probe').nth(3999)).toHaveText('before');const operationStarted=performance.now();await page.evaluate(()=>window.begin());
 await Promise.all(Array.from({length:128},(_,index)=>expect(page.locator('.probe').nth(3872+index)).toHaveText('after',{timeout:10000})));
 const operationMilliseconds=performance.now()-operationStarted;
 const observations=await page.evaluate(()=>({...window.observations,observedAt:performance.now(),values:[...document.querySelectorAll('.probe')].slice(-128).map(element=>element.textContent)}));
 assert.equal(observations.tasks,80);assert.equal(observations.mutations,2560);assert.deepEqual(observations.values,Array(128).fill('after'));assert.deepEqual(counts,{documents:1,backend:1});
 let metrics=null;
 if(mode==='on') {
  const request=JSON.stringify({selector:'css=.probe >> nth=3999',expectedText:[{string:'after',normalizeWhiteSpace:true}]});
  metrics=(await browser.client.request('assertion.run',{page:page.identifier,frame:page.mainFrame().snapshot.identifier,expression:'to.have.text',isNot:false,request:Array.from(request,value=>value.charCodeAt(0))},5000)).conditionMetrics;
 }
 await browser.close();browser=null;
 console.log(JSON.stringify({mode,operationMilliseconds,completeMilliseconds:performance.now()-started,counts,observations,metrics},null,2));
}finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
