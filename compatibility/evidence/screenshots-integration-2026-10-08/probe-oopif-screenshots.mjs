import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium as reference } from 'playwright';
import { chromium as candidate } from 'flashwright';
const require=createRequire(import.meta.url);
const {PNG}=require('/workspace/node_modules/playwright-core/lib/utilsBundle.js');
const server=createServer((request,response)=>{response.setHeader('content-type','text/html');response.end(request.url==='/remote'?'<style>html,body{margin:0;background:yellow}</style>':'<style>body{margin:0;background:red}</style>');});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const records=[];
try {
 for(const [name,chromium] of [['reference',reference],['candidate',candidate]]) {
  const browser=await chromium.launch({executablePath:process.env.FLASHWRIGHT_BROWSER_PATH});
  try {
   for(let iteration=0;iteration<3;iteration++){
    const page=await browser.newPage({viewport:{width:320,height:240}});await page.goto(origin);
    await page.evaluate(async url=>{const frame=document.createElement('iframe');frame.style.cssText='position:absolute;left:120px;top:100px;width:100px;height:60px;border:0';const loaded=new Promise(resolve=>frame.onload=resolve);frame.src=url;document.body.append(frame);await loaded;},origin.replace('127.0.0.1','localhost')+'/remote');
    for(const delay of [0,0,50,500]) {
     if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
     const bytes=await page.screenshot({caret:'initial'});const decoded=PNG.sync.read(bytes);const offset=(120*decoded.width+150)*4;
     records.push({name,iteration,delay,pixel:[...decoded.data.subarray(offset,offset+4)]});
     console.log(records.at(-1));
    }
    await page.close();
   }
  } finally {await browser.close();}
 }
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile('/output/report.json',JSON.stringify(records,null,2)+'\n');}
