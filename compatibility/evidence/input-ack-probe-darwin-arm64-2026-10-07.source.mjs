import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: chromium.executablePath() });
const samples = [];
try {
 const page = await browser.newPage();
 await page.evaluate(() => {
  document.body.innerHTML = '<button style="position:absolute;left:0;top:0;width:100px;height:100px">Target</button>';
  window.frameCount = 0;
  function frame() { frameCount++; requestAnimationFrame(frame); } requestAnimationFrame(frame);
  window.events = [];
  for (const type of ['pointerdown','pointerup','click']) document.addEventListener(type, event => events.push({ type, trusted: event.isTrusted, frame: frameCount }));
 });
 const session = await page.context().newCDPSession(page);
 const commands = [
  { type:'mouseMoved', x:40, y:40, button:'none', buttons:0, modifiers:0, force:0 },
  { type:'mousePressed', x:40, y:40, button:'left', buttons:1, modifiers:0, clickCount:1, force:0.5 },
  { type:'mouseReleased', x:40, y:40, button:'left', buttons:0, modifiers:0, clickCount:1 },
 ];
 for (let iteration = 0; iteration < 24; iteration++) {
  for (const mode of iteration % 2 ? ['concurrentReplies','serialReplies'] : ['serialReplies','concurrentReplies']) {
   const before = await page.evaluate(() => { events=[]; return frameCount; });
   const started = performance.now();
   const acknowledgements = [];
   const dispatch = parameters => session.send('Input.dispatchMouseEvent', parameters).then(() => { acknowledgements.push({ event:parameters.type, milliseconds:performance.now()-started }); });
   if (mode==='serialReplies') for (const command of commands) await dispatch(command);
   else await Promise.all(commands.map(dispatch));
   const elapsedMilliseconds = performance.now()-started;
   const observation = await page.evaluate(() => ({ frameCount, events }));
   assert.deepEqual(observation.events.map(event=>[event.type,event.trusted]), [['pointerdown',true],['pointerup',true],['click',true]]);
   samples.push({ iteration, warmup:iteration<4, mode, elapsedMilliseconds, acknowledgements, elapsedFrames:observation.frameCount-before, events:observation.events });
  }
 }
 const median = values => { const ordered=values.sort((left,right)=>left-right); return (ordered[Math.floor((ordered.length-1)/2)]+ordered[Math.ceil((ordered.length-1)/2)])/2; };
 const medians = Object.fromEntries(['serialReplies','concurrentReplies'].map(mode=>[mode,median(samples.filter(sample=>sample.mode===mode&&!sample.warmup).map(sample=>sample.elapsedMilliseconds))]));
 const result = { scope:'Causal input-dispatch probe using the pinned reference CDP connection. One launch, alternating acknowledgement strategies, no actionability phase. Functional diagnosis only; not a Flashwright speed claim.', playwright:'1.60.0', browserVersion:browser.version(), browserPath:chromium.executablePath(), sourceSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), medians, samples };
 await writeFile('compatibility/evidence/input-ack-probe-darwin-arm64-2026-10-07.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(medians));
} finally { await browser.close(); }
