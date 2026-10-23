// Renders a side-by-side replay of two recorded test runs: each line of `npx playwright test`
// output appears at the time it arrived in the real run, next to a stopwatch.
//
// Record runs first (the median run of each engine is replayed):
//   BENCH_TIMELINE=workbench/race-timeline node bench/run.mjs todomvc 1 7 stock,fork
// Then render:
//   node bench/media/race.mjs workbench/race-timeline docs/media/race
// Writes <out>.mp4 and <out>.gif. Needs ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '../../packages/playwright-core/index.mjs';

const [timelineDir = 'workbench/race-timeline', out = 'docs/media/race'] = process.argv.slice(2);
const fps = 30;
const holdMs = 2500;

function medianRun(engine) {
  const runs = readdirSync(timelineDir).filter(f => f.startsWith(engine + '-')).map(f => JSON.parse(readFileSync(join(timelineDir, f), 'utf8')));
  runs.sort((a, b) => a.elapsed - b.elapsed);
  return runs[Math.floor(runs.length / 2)];
}

// "  ✓   3 tests/a/b.spec.ts:7:3 › Suite › title (101ms)" -> { title: 'Suite › title', ms: 101 }
function parse(run) {
  const tests = [];
  for (const { t, line } of run.lines) {
    const match = /^\s+✓\s+\d+\s+\S+ › (.+) \((\d+)ms\)$/.exec(line);
    if (match)
      tests.push({ t, title: match[1], ms: Number(match[2]) });
  }
  return { elapsed: Math.round(run.elapsed), tests, count: tests.length };
}

const playwright = parse(medianRun('stock'));
const flashwright = parse(medianRun('fork'));
const totalMs = Math.max(playwright.elapsed, flashwright.elapsed) + holdMs;
const speedup = (playwright.elapsed / flashwright.elapsed).toFixed(1);

const html = `<!doctype html><html><head><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1280px; height: 720px; background: #0b0f17; color: #c9d1d9; font: 15px/1.45 "DejaVu Sans Mono", monospace; overflow: hidden; }
  header { height: 70px; display: flex; align-items: center; justify-content: center; font: 600 22px "DejaVu Sans", sans-serif; color: #e6edf3; }
  header span { color: #8b949e; font-weight: 400; margin-left: 10px; font-size: 18px; }
  main { display: flex; gap: 24px; padding: 0 28px; height: 590px; }
  .pane { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
  .bar { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; background: #161b22; border-bottom: 1px solid #30363d; }
  .name { font: 700 20px "DejaVu Sans", sans-serif; }
  .name small { font-weight: 400; color: #8b949e; font-size: 14px; margin-left: 6px; }
  .clock { font: 700 28px "DejaVu Sans Mono", monospace; color: #e6edf3; min-width: 120px; text-align: right; }
  .done .clock { color: #3fb950; }
  .body { padding: 14px 18px; flex: 1; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; }
  .cmd { color: #8b949e; position: absolute; }
  .line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .line .ok { color: #3fb950; } .line .ms { color: #8b949e; }
  .summary { margin-top: 8px; font-weight: 700; color: #3fb950; min-height: 22px; }
  footer { height: 60px; display: flex; align-items: center; justify-content: center; color: #8b949e; font: 15px "DejaVu Sans", sans-serif; }
  .banner { position: absolute; left: 0; right: 0; top: 300px; text-align: center; opacity: 0; transition: none; }
  .banner div { display: inline-block; background: #3fb950; color: #0b0f17; font: 800 44px "DejaVu Sans", sans-serif; padding: 14px 34px; border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
</style></head><body>
<header>Playwright's TodoMVC example suite<span>24 tests · 1 worker · same machine · real runs, played back in real time</span></header>
<main>
  <section class="pane" id="playwright"><div class="bar"><div class="name">Playwright <small>1.64.1</small></div><div class="clock">0.00 s</div></div><div class="body"><div class="lines"></div><div class="summary"></div></div></section>
  <section class="pane" id="flashwright"><div class="bar"><div class="name">Flashwright <small>defaults</small></div><div class="clock">0.00 s</div></div><div class="body"><div class="lines"></div><div class="summary"></div></div></section>
</main>
<footer>$ npx playwright test &nbsp;·&nbsp; the same command, the same tests, unmodified</footer>
<div class="banner"><div>Flashwright: ${speedup}× faster</div></div>
<script>
const runs = { playwright: ${JSON.stringify(playwright)}, flashwright: ${JSON.stringify(flashwright)} };
const maxLines = 22;
const escape = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
window.render = t => {
  for (const [id, run] of Object.entries(runs)) {
    const pane = document.getElementById(id);
    const done = t >= run.elapsed;
    pane.classList.toggle('done', done);
    pane.querySelector('.clock').textContent = (Math.min(t, run.elapsed) / 1000).toFixed(2) + ' s';
    const shown = run.tests.filter(test => test.t <= t).slice(-maxLines);
    pane.querySelector('.lines').innerHTML = shown.map(test => '<div class="line"><span class="ok">✓</span> ' + escape(test.title) + ' <span class="ms">' + test.ms + 'ms</span></div>').join('');
    pane.querySelector('.summary').textContent = done ? '✓ ' + run.count + ' passed in ' + (run.elapsed / 1000).toFixed(2) + ' s' : '';
  }
  const last = Math.max(runs.playwright.elapsed, runs.flashwright.elapsed);
  document.querySelector('.banner').style.opacity = String(Math.max(0, Math.min(1, (t - last - 200) / 300)));
};
</script></body></html>`;

const framesDir = resolve('workbench/race-frames');
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(html);
const frameCount = Math.ceil(totalMs / 1000 * fps);
for (let i = 0; i < frameCount; i++) {
  await page.evaluate(t => window.render(t), i * 1000 / fps);
  writeFileSync(join(framesDir, `frame-${String(i).padStart(5, '0')}.png`), await page.screenshot());
}
await browser.close();

mkdirSync(dirname(resolve(out)), { recursive: true });
const frames = join(framesDir, 'frame-%05d.png');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', frames, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', resolve(out + '.mp4')]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', frames, '-vf', `fps=20,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none`, resolve(out + '.gif')]);
console.log(`Playwright ${playwright.elapsed} ms, Flashwright ${flashwright.elapsed} ms (${speedup}x): ${out}.mp4, ${out}.gif`);
