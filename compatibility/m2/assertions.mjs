import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium as referenceChromium } from 'playwright';
import { expect as referenceExpect } from 'flashwright-upstream-runner/test';
import { chromium as flashwrightChromium } from 'flashwright';
import { expect as flashwrightExpect } from '@flashwright/test';

const fixture = `<!doctype html><meta charset="utf-8"><title>  Assertion   fixture </title>
<h1 id="heading"> Hello  <span>world</span> </h1><p class="item">Alpha</p><p class="item">Beta</p><p class="item">Gamma</p>
<input id="input" value="before"><input id="readonly" readonly value="read only"><fieldset disabled><button id="disabled">Disabled</button></fieldset>
<input id="checked" type="checkbox" checked><input id="unchecked" type="checkbox"><input id="mixed" type="checkbox">
<div id="hidden" hidden>Hidden text</div><div id="empty">  </div><div id="host"></div><div id="pending" hidden>pending</div>
<div id="replacement">original</div><div id="unicode"></div><iframe name="child" src="/child"></iframe>
<script>document.querySelector('#mixed').indeterminate=true;document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<span>Shadow value</span>';</script>`;
const fontBytes = await readFile('compatibility/m2/fixtures/zero-advance.ttf');
const pendingFonts = new Map();
const server = createServer((request, response) => {
 const acceptFont = pendingFonts.get(request.url);
 if (acceptFont) { pendingFonts.delete(request.url); acceptFont(response); return; }
 response.setHeader('content-type','text/html; charset=utf-8');
 response.end(request.url === '/child' ? '<p>Child value</p>' : request.url === '/successor' ? '<h1>Successor</h1>' : fixture);
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const baseURL = 'http://127.0.0.1:' + server.address().port;
const outcomes = {};
async function run(name, chromium, expect) {
 const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH ?? referenceChromium.executablePath() });
 const context = await browser.newContext({ baseURL }); const page = await context.newPage();
 const result = {};
 async function fails(label, operation) { await assert.rejects(operation(), error => { assert.ok(error.message.length > 20); result[label] = true; return true; }); }
 try {
  await page.goto('/');
  await expect(page.locator('#heading')).toHaveText('Hello world');
  await expect(page.locator('#heading')).toHaveText(/Hello\s+world/);
  await expect(page.locator('#heading')).toHaveText('hello world', { ignoreCase:true });
  await expect(page.locator('#heading')).toContainText('world');
  await expect(page.locator('.item')).toHaveText(['Alpha',/Beta/,'Gamma']);
  await expect(page.locator('.item')).toContainText(['Al','ma']);
  await expect(page.locator('.item')).toHaveCount(3);
  await expect(page.locator('.item')).not.toHaveCount(2);
  await expect(page.locator('#missing')).toHaveText([]);
  await expect(page.locator('#missing')).toHaveCount(0);
  await expect(page.locator('#missing')).not.toHaveText(['value']);
  await expect(page.locator('#missing')).toBeHidden();
  await expect(page.locator('#missing')).not.toBeVisible();
  await expect(page.locator('#missing')).not.toBeAttached();
  await expect(page.locator('#hidden')).toBeVisible({ visible:false });
  await expect(page.locator('#input')).toBeAttached();
  await expect(page.locator('#input')).toBeEditable();
  await expect(page.locator('#readonly')).toBeEditable({ editable:false });
  await expect(page.locator('#empty')).toBeEmpty();
  await expect(page.locator('#disabled')).toBeEnabled({ enabled:false });
  await expect(page.locator('#disabled')).toBeDisabled();
  await expect(page.locator('#input')).toBeEnabled();
  await expect(page.locator('#checked')).toBeChecked();
  await expect(page.locator('#unchecked')).toBeChecked({ checked:false });
  await expect(page.locator('#unchecked')).not.toBeChecked();
  await expect(page.locator('#mixed')).toBeChecked({ indeterminate:true });
  await expect(page.locator('#input')).toHaveValue('before');
  await expect(page.locator('#input')).toHaveValue(/BEFORE/i);
  await expect(page.locator('#input')).toHaveAttribute('id','input');
  await expect(page.locator('#checked')).toHaveAttribute('checked');
  await expect(page.locator('#checked')).toHaveAttribute('checked', { timeout:500 });
  await expect(page).toHaveTitle('Assertion fixture');
  await expect(page).toHaveURL('/');
  await expect(page).toHaveURL(/127\.0\.0\.1/);
  await expect(page.getByText('Shadow value')).toHaveText('Shadow value');
  await expect(page.frame('child').locator('p')).toHaveText('Child value');
  await page.locator('#input').focus(); await expect(page.locator('#input')).toBeFocused();
  await page.evaluate(() => { document.querySelector('#unicode').textContent='\uD800\0\uDC00'; });
  await expect(page.locator('#unicode')).toHaveText('\uD800\0\uDC00');
  console.log(`${name}: immediate, array, state and missing-element assertions passed`);
  await fails('strict', () => expect(page.locator('.item')).toBeVisible());
  await fails('invalid-selector', () => expect(page.locator('css=[')).toHaveText('value'));
  const short = expect.configure({ timeout:80 });
  await fails('negated-missing-hidden', () => short(page.locator('#missing')).not.toBeHidden());
  await fails('negated-missing-enabled', () => short(page.locator('#missing')).not.toBeEnabled());
  await fails('negated-missing-text', () => short(page.locator('#missing')).not.toHaveText('value'));
  await fails('negated-empty-array', () => short(page.locator('#missing')).not.toHaveText([]));
  await fails('wrong-value', () => short(page.locator('#input')).toHaveValue('wrong'));
  await fails('wrong-count', () => short(page.locator('.item')).toHaveCount(2));
  await fails('negative-count', () => short(page.locator('.item')).toHaveCount(-1));
  await fails('checked-wrong-element', () => short(page.locator('#heading')).toBeChecked());
  await fails('indeterminate-and-checked', () => short(page.locator('#mixed')).toBeChecked({ checked:false, indeterminate:true }));
  await page.evaluate(() => { setTimeout(() => { document.querySelector('#pending').hidden=false; },40); });
  await expect(page.locator('#pending')).toBeVisible();
  await page.evaluate(() => { setTimeout(() => { document.querySelector('#input').value='property changed'; },40); });
  await expect(page.locator('#input')).toHaveValue('property changed');
  await page.evaluate(() => { setTimeout(() => { document.querySelector('#replacement').outerHTML='<p id="replacement">successor element</p>'; },40); });
  await expect(page.locator('#replacement')).toHaveText('successor element');
  await page.evaluate(() => { setTimeout(() => { const host=document.createElement('div'); document.body.append(host); host.attachShadow({mode:'open'}).innerHTML='<p>Late shadow</p>'; },40); });
  await expect(page.getByText('Late shadow')).toBeVisible();
  await page.evaluate(() => { document.querySelector('#pending').style.opacity='0'; });
  await expect(page.locator('#pending')).toBeVisible();
  await page.evaluate(() => {
    const style=document.createElement('style');
    style.textContent='@keyframes assertionHide { to { transform:scale(0) } } #animated-target { animation:assertionHide 100ms linear forwards paused }';
    const target=document.createElement('p');target.id='animated-target';target.textContent='Animated';
    document.head.append(style);document.body.append(target);
  });
  await expect(page.locator('#animated-target')).toBeVisible();
  await page.evaluate(() => { document.querySelector('#animated-target').getAnimations()[0].play(); });
  await expect(page.locator('#animated-target')).toBeHidden();
  result['css-animation']=true;
  const fontPath='/condition-font-'+name+'.ttf';
  const fontRequested=new Promise(resolve => pendingFonts.set(fontPath,resolve));
  await page.evaluate(url => {
    const target=document.createElement('span');target.id='font-target';target.textContent='A';
    target.style.cssText='display:inline-block;font:20px AssertionFont,monospace';document.body.append(target);
    globalThis.fixtureFont=new FontFace('AssertionFont',`url(${url})`,{display:'swap'});
    document.fonts.add(fixtureFont);globalThis.fixtureFontLoad=fixtureFont.load().then(()=>true,()=>false);
  },baseURL+fontPath);
  const fontResponse=await fontRequested;
  await expect(page.locator('#font-target')).toBeVisible();
  const hiddenAfterFont=expect(page.locator('#font-target')).toBeHidden();
  fontResponse.writeHead(200,{'content-type':'font/ttf'});fontResponse.end(fontBytes);
  await hiddenAfterFont;
  assert.equal(await page.evaluate(()=>fixtureFontLoad),true);
  assert.equal(await page.evaluate(()=>document.querySelector('#font-target').getBoundingClientRect().width),0);
  result['font-loading']=true;
  await page.evaluate(() => {
    document.querySelector('#unicode').textContent='a'.repeat(9000)+'z';
    const list=document.createElement('section'); list.id='large-list';
    for(let index=0;index<120;index++) { const item=document.createElement('p'); item.textContent='q'.repeat(5000); list.append(item); }
    document.body.append(list);
  });
  await expect(page.locator('#unicode')).toHaveText('a'.repeat(9000)+'z');
  await expect(page.locator('#large-list p')).toHaveText(Array(120).fill(/^q{5000}$/));
  if(name==='flashwright') {
    await assert.rejects(short(page.locator('#unicode')).toHaveText('a'.repeat(9000)+'x'), error => {
      assert.match(error.message,/diagnostic was truncated/);
      assert.equal(error.matcherResult.actual, 'a'.repeat(4096) + '… [diagnostic truncated]');
      return true;
    });
    const expected=Array(120).fill(/^q{5000}$/); expected[119]=/wrong/;
    await assert.rejects(short(page.locator('#large-list p')).toHaveText(expected), error => {
      assert.match(error.message,/diagnostic was truncated/); assert.equal(error.matcherResult.actual.length,100);
      assert.ok(JSON.stringify(error.matcherResult.actual).length<20000); return true;
    });
  }
  const successor = expect(page.getByRole('heading')).toHaveText('Successor');
  await page.goto('/successor'); await successor;
  result.complete=true; outcomes[name]=result;
  console.log(`${name}: retry, failure and successor-document assertions passed`);
 } finally { await browser.close(); }
}
try {
 await run('reference',referenceChromium,referenceExpect); await run('flashwright',flashwrightChromium,flashwrightExpect);
 assert.deepEqual(outcomes.flashwright,outcomes.reference);
 await mkdir('compatibility/evidence',{recursive:true});
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const destination=`compatibility/evidence/assertions-${process.platform}-${process.arch}-${process.versions.node}.json`;
 await writeFile(destination,JSON.stringify({reference:'1.60.0',node:process.version,platform:process.platform,architecture:process.arch,fixtureSha256:hash(await readFile(new URL(import.meta.url))),driverSha256:hash(await readFile(process.env.FLASHWRIGHT_DRIVER_PATH)),outcomes,scope:'Experimental retrying assertions; no performance claim.'},null,2)+'\n');
 console.log(`Assertion differential evidence: ${destination}`);
} finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
