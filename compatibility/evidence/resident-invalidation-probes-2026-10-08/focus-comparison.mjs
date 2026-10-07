import { chromium } from 'playwright';
const browser = await chromium.launch({executablePath:process.env.FLASHWRIGHT_BROWSER_PATH});
const control = await browser.newBrowserCDPSession();
const {browserContextId} = await control.send('Target.createBrowserContext',{disposeOnDetach:true});
const {targetId}=await control.send('Target.createTarget',{url:'about:blank',browserContextId});
const {sessionId}=await control.send('Target.attachToTarget',{targetId,flatten:false});
let identifier=0;const pending=new Map();
control.on('Target.receivedMessageFromTarget',event=>{
 if(event.sessionId!==sessionId)return;const message=JSON.parse(event.message);const result=pending.get(message.id);if(!result)return;
 pending.delete(message.id);if(message.error)result.reject(new Error(JSON.stringify(message.error)));else result.resolve(message.result);
});
async function send(method,params={}) {
 const id=++identifier;const result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
 await control.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})});return result;
}
async function evaluate(expression){return (await send('Runtime.evaluate',{expression,returnByValue:true})).result.value;}
try {
 await send('Runtime.runIfWaitingForDebugger');
 await evaluate(`globalThis.state={freeze:0,resume:0,ticks:0};document.addEventListener('freeze',()=>state.freeze++);document.addEventListener('resume',()=>state.resume++);setInterval(()=>state.ticks++,10);`);
 await send('Emulation.setFocusEmulationEnabled',{enabled:true});
 await send('Page.setWebLifecycleState',{state:'frozen'});
 await new Promise(resolve=>setTimeout(resolve,200));
 console.log('focusEmulated',await evaluate('({...state,visibility:document.visibilityState})'));
 await send('Page.setWebLifecycleState',{state:'active'});
 await send('Emulation.setFocusEmulationEnabled',{enabled:false});
 console.log('before',await evaluate('({...state,visibility:document.visibilityState})'));
 await send('Page.setWebLifecycleState',{state:'frozen'});
 await new Promise(resolve=>setTimeout(resolve,100));
 console.log('frozen',await evaluate('({...state,visibility:document.visibilityState})'));
 await new Promise(resolve=>setTimeout(resolve,200));
 console.log('frozen2',await evaluate('({...state,visibility:document.visibilityState})'));
 await send('Page.setWebLifecycleState',{state:'active'});
 await new Promise(resolve=>setTimeout(resolve,100));
 console.log('resumed',await evaluate('({...state,visibility:document.visibilityState})'));
}finally {await control.send('Target.disposeBrowserContext',{browserContextId});await browser.close();}
