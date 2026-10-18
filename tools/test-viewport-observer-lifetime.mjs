import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const registry=await readFile('packages/resident-runtime/condition-registry.js','utf8');
const locator=await readFile('packages/resident-runtime/locator-runtime.js','utf8');
const observers=[],frames=new Map(),listeners=new Map();let nextFrame=0;
class Observer {
 constructor(callback){this.callback=callback;this.live=true;this.disconnects=0;observers.push(this)}
 observe(element){this.element=element}
 disconnect(){this.live=false;this.element=undefined;this.disconnects++}
}
const context={document:{},performance,Date,setTimeout,clearTimeout,queueMicrotask,MessageChannel,
 addEventListener:(name,callback)=>{const set=listeners.get(name)??new Set();set.add(callback);listeners.set(name,set)},removeEventListener:(name,callback)=>listeners.get(name)?.delete(callback),
 MutationObserver:class{observe(){}disconnect(){}},IntersectionObserver:Observer,
 requestAnimationFrame:callback=>{const id=++nextFrame;frames.set(id,callback);return id},cancelAnimationFrame:id=>frames.delete(id)};
const createRuntime=vm.runInNewContext(`${registry}\n${locator}\ncreateLocatorRuntime`,context);
const element={};const runtime=createRuntime({parseSelector:()=>({parts:[]}),querySelector:()=>element},{encode:v=>v});
const request=JSON.stringify({selector:'#target',expectedNumber:0.5}),units=Array.from(request,c=>c.charCodeAt(0));
const start=(token,deadline=null)=>runtime.waitForAssertion(units,deadline,'to.be.in.viewport',false,token);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let pending=start('cancel');assert.equal(observers.at(-1).element,element);
assert.equal(runtime.cancelAssertion('cancel').status,'cancelled');assert.equal(observers.at(-1).live,false,'disconnect precedes cancellation acknowledgement');
assert.equal((await pending).status,'cancelled');assert.equal(frames.size,0);
const old=observers.at(-1);pending=start('next');const successor=observers.at(-1);old.callback([{intersectionRatio:1}]);assert(successor.live);runtime.cancelAssertion('next');await pending;assert(!successor.live);
pending=start('deadline',Date.now()+25);assert.equal((await pending).status,'expired');assert(!observers.at(-1).live);assert.equal(frames.size,0);
pending=start('success');observers.at(-1).callback([{intersectionRatio:0.5}]);assert.equal((await pending).status,'matched');assert(!observers.at(-1).live);assert.equal(frames.size,0);
pending=start('pagehide');for(const callback of [...listeners.get('pagehide')])callback();assert.equal((await pending).status,'cancelled');assert(!observers.at(-1).live);assert.equal(frames.size,0);
pending=start('replaced');runtime.documentReplaced();assert.equal((await pending).status,'cancelled');assert(!observers.at(-1).live);assert.equal(frames.size,0);
await tick();assert(observers.every(o=>!o.live&&o.disconnects===1));
console.log('Viewport observer cancellation, deadline, match, pagehide, document replacement and late callback ownership passed.');
