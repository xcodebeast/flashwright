import assert from 'node:assert/strict';

export const viewportHTML = `<!doctype html><link rel="icon" href="data:,"><style id="sheet">
#css-only{transform:translateY(2000px)}
body{margin:0} .box{width:100px;height:100px} #visible{position:absolute;left:10px;top:10px}
#clipping{position:absolute;left:140px;top:10px;width:100px;height:50px;overflow:hidden}
#hidden{position:absolute;left:260px;top:10px;visibility:hidden;opacity:0}
#outside{position:absolute;left:10px;top:3000px}
#css-only{position:absolute;left:380px;top:10px}
</style><div id="visible" class="box">visible</div><div id="clipping"><div id="half" class="box">half</div></div><div id="hidden" class="box">hidden</div><div id="outside" class="box">outside</div><div id="css-only" class="box">css</div>`;

export async function viewportCases(page, expect, check, baseURL, implementation) {
 const short=expect.configure({timeout:160});
 const rejects=async callback=>{let error;try{await callback()}catch(e){error=e}assert(error instanceof Error);return error};
 await check('positive intersection, exact thresholds and finite out-of-range ratios',async()=>{
  for(const ratio of [undefined,0,0.5,1,-1])await expect(page.locator('#visible')).toBeInViewport({ratio});
  await expect(page.locator('#visible')).not.toBeInViewport({ratio:2});
  await expect(page.locator('#half')).toBeInViewport({ratio:0.5});
  await expect(page.locator('#half')).not.toBeInViewport({ratio:0.51});
 });
 await check('intersection does not require visibility and never scrolls to target',async()=>{
  await expect(page.locator('#hidden')).toBeInViewport({ratio:1});
  await expect(page.locator('#outside')).not.toBeInViewport({ratio:0});
  assert.equal(await page.evaluate(()=>scrollY),0);
 });
 await check('missing negation succeeds; positive absence and strict selectors fail',async()=>{
  await expect(page.locator('#missing')).not.toBeInViewport();
  await expect(page.frameLocator('#missing-frame').locator('#target')).not.toBeInViewport();
  await rejects(()=>short(page.locator('#missing')).toBeInViewport());
  const strict=await rejects(()=>short(page.locator('.box')).toBeInViewport());assert.match(strict.message,/strict mode violation/);
 });
 await check('timeout retains the observed viewport ratio',async()=>{
  const error=await rejects(()=>short(page.locator('#half')).toBeInViewport({ratio:0.9}));
  assert.match(error.message,/viewport ratio 0\.5/);
 });
 await check('stylesheet-only changes wake viewport retry without DOM mutation',async()=>{
  await page.evaluate(()=>setTimeout(()=>document.querySelector('#sheet').sheet.cssRules[0].style.transform='none',70));
  await expect(page.locator('#css-only')).toBeInViewport({timeout:2500,ratio:1});
 });
 await check('replacement and disappearance re-resolve the original locator',async()=>{
  await page.evaluate(()=>setTimeout(()=>{const old=document.querySelector('#outside');const next=document.createElement('div');next.id='outside';next.style.cssText='position:absolute;left:10px;top:130px;width:100px;height:100px';old.replaceWith(next)},70));
  await expect(page.locator('#outside')).toBeInViewport({timeout:2500});
  await page.evaluate(()=>setTimeout(()=>document.querySelector('#outside').remove(),70));
  await expect(page.locator('#outside')).not.toBeInViewport({timeout:2500});
 });
 await check('same-site and cross-site child locators use native intersection',async()=>{
  for(const host of ['127.0.0.1','localhost']){
   const child=new URL('/child?viewport=1',baseURL);child.hostname=host;
   await page.evaluate(url=>{document.querySelector('iframe')?.remove();const frame=document.createElement('iframe');frame.src=url;frame.style.cssText='position:absolute;left:10px;top:250px;width:250px;height:150px';document.body.append(frame)},child.href);
   const frame=page.frameLocator('iframe');await expect(frame.locator('#child')).toBeInViewport({ratio:1,timeout:5000});
   await expect(frame.locator('#far')).not.toBeInViewport();
  }
 });
 await check('changing iframe selector revalidates ancestry before viewport success',async()=>{
  await page.evaluate(()=>{
   document.querySelectorAll('iframe').forEach(frame=>frame.remove());
   for(const [id,top] of [['old',2000],['next',0]]){const frame=document.createElement('iframe');frame.id=id;frame.className=id==='old'?'selected':'';frame.style.cssText='position:absolute;left:10px;top:250px;width:250px;height:150px';frame.srcdoc='<div id="target" style="position:absolute;top:'+top+'px;width:50px;height:50px">target</div>';document.body.append(frame)}
  });
  for(const id of ['old','next'])await expect(page.frameLocator('#'+id).locator('#target')).toHaveText('target');
  await page.evaluate(()=>setTimeout(()=>{document.querySelector('#old').className='';document.querySelector('#next').className='selected'},70));
  await expect(page.frameLocator('iframe.selected').locator('#target')).toBeInViewport({timeout:2000});
 });
 await check('late viewport match in a deselected live iframe cannot succeed',async()=>{
  await page.evaluate(()=>{
   const old=document.querySelector('#old'),next=document.querySelector('#next');old.className='selected';next.className='';next.contentDocument.querySelector('#target').style.top='2000px';
   setTimeout(()=>{old.className='';next.className='selected';old.contentDocument.querySelector('#target').style.top='0px'},70);
  });
  await rejects(()=>expect(page.frameLocator('iframe.selected').locator('#target')).toBeInViewport({timeout:350}));
 });
 await check('navigation keeps the public assertion pending for the successor document',async()=>{
  const pending=expect(page.locator('#successor')).toBeInViewport({timeout:3000});
  await page.goto(baseURL+'/successor');await pending;
 });
 await check('document.open replacement retires old observations and resumes against new elements',async()=>{
  const pending=expect(page.locator('#opened')).toBeInViewport({timeout:2500});
  await page.evaluate(()=>{document.open();document.write('<div id="opened">replacement</div>');document.close()});await pending;
 });
 await check('page closure retires an unbounded viewport assertion',async()=>{
  const child=await page.context().newPage();await child.goto(baseURL);
  const pending=rejects(()=>expect(child.locator('#never')).toBeInViewport({timeout:0}));
  await new Promise(resolve=>setTimeout(resolve,40));await child.close();await pending;
 });
 if(implementation==='flashwright')await check('invalid ratios and unsupported options reject explicitly',async()=>{
  for(const ratio of [NaN,Infinity,'0.5',null])await assert.rejects(expect(page.locator('#opened')).toBeInViewport({ratio}),e=>e.name==='InvalidArgumentError');
  await assert.rejects(expect(page.locator('#opened')).toBeInViewport({extra:true}),e=>e.name==='UnsupportedFeatureError');
 });
}

export async function responseCases(request, expect, check, baseURL) {
 const context=await request.newContext();
 const failure=async callback=>{try{await callback()}catch(error){assert(error instanceof Error);return error}throw Error('Expected assertion failure')};
 try {
  await check('immutable status boundaries and negation',async()=>{
   for(const status of [200,204,299,300,404,503]){
    const response=await context.get(`${baseURL}/api?status=${status}&type=text/plain`);
    await (status<300?expect(response).toBeOK():expect(response).not.toBeOK());
    await failure(()=>status<300?expect(response).not.toBeOK():expect(response).toBeOK());
   }
  });
  await check('textual diagnostics include bounded text across supported MIME classes',async()=>{
   for(const type of ['text/plain','application/json','application/problem+json','application/xml','image/svg+xml','application/javascript','application/graphql','application/x-www-form-urlencoded']){
    const response=await context.get(`${baseURL}/api?status=500&type=${encodeURIComponent(type)}`);
    const error=await failure(()=>expect(response).toBeOK());assert.match(error.message,/body-marker/);assert(!error.message.includes('end-marker'));
   }
  });
  await check('binary and absent content types do not read disposed bodies for diagnostics',async()=>{
   for(const type of ['application/octet-stream','absent']){
    const response=await context.get(`${baseURL}/api?status=500&type=${type}`);await response.dispose();
    const error=await failure(()=>expect(response).toBeOK());assert(!error.message.includes('body-marker'));assert(!error.message.includes('disposed'));
   }
  });
  await check('passing assertions do not read disposed textual bodies; failing reads propagate',async()=>{
   const good=await context.get(`${baseURL}/api?status=200&type=text/plain`);await good.dispose();await expect(good).toBeOK();
   const bad=await context.get(`${baseURL}/api?status=500&type=text/plain`);await bad.dispose();await expect(bad).not.toBeOK();
   const error=await failure(()=>expect(bad).toBeOK());assert.match(error.message,/disposed|closed/i);
  });
  await check('foreign response-shaped values are rejected',async()=>{
   await failure(()=>expect({ok:()=>true,headers:()=>({}),text:async()=>''}).toBeOK());
  });
 } finally { await context.dispose(); }
 await check('response metadata survives context closure without reading the body',async()=>{
  const owner=await request.newContext();const response=await owner.get(`${baseURL}/api?status=200&type=text/plain`);await owner.dispose();await expect(response).toBeOK();
 });
}
