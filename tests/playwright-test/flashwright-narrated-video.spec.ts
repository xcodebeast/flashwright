/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { test, expect } from './playwright-test-fixtures';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test.skip(!hasFfmpeg, 'needs ffmpeg');
test.slow();

// A voice that writes down what it says and answers with a second of silence.
const voiceConfig = (extra = '') => `
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  process.env.FLASHWRIGHT_VOICE_CACHE = path.join(__dirname, 'voice-cache');
  module.exports = {
    narratedVideo: {
      voice: async text => {
        fs.appendFileSync(path.join(__dirname, 'spoken.txt'), text + '\\n');
        return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1', '-f', 'wav', '-']);
      },
      ${extra}
    },
  };
`;

function probe(file: string) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_chapters', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
  return {
    codecs: info.streams.map((s: any) => s.codec_name).filter((c: string) => c !== 'bin_data'),
    size: `${info.streams[0].width}x${info.streams[0].height}`,
    duration: +info.format.duration,
    chapters: info.chapters.map((c: any) => c.tags.title),
  };
}

function colorAt(file: string, seconds: number) {
  const pixel = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'crop=2:2:960:400', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const [r, g, b] = pixel;
  return r > g + 60 && r > b + 60 ? 'red' : g > r + 60 && g > b + 60 ? 'green' : b > r + 60 && b > g + 60 ? 'blue' : `other(${r},${g},${b})`;
}

function cues(vtt: string) {
  return fs.readFileSync(vtt, 'utf8').split('\n\n').slice(1).map(block => {
    const [times, ...text] = block.trim().split('\n');
    const seconds = (time: string) => time.split(':').reduce((sum, part) => sum * 60 + parseFloat(part), 0);
    const [start, end] = times.split(' --> ').map(seconds);
    return { start, end, text: text.join(' ') };
  }).filter(cue => cue.text);
}

const passing = (title: string) => `
  test('${title}', async ({ page, narrate }) => {
    await page.setContent('<button>Go</button>');
    await narrate('This is ${title}.');
    await page.getByRole('button', { name: 'Go' }).click();
  });
`;

test('--video makes one video of the tests in their order, and a clip of each', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      ${passing('first')}
      ${passing('second')}
      test('third fails', async ({ page, narrate }) => {
        await page.setContent('<div>Hello</div>');
        await narrate('This one fails.');
        await expect(page.getByText('Goodbye')).toBeVisible({ timeout: 300 });
      });
      test('no page', async () => {});
    `,
  }, { 'video': true, 'workers': 2, 'fully-parallel': true });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(3);
  expect(result.failed).toBe(1);
  expect(result.output).toMatch(/Video: test-results.video\.mp4 \(\d+ s, 3 tests\)/);

  const video = test.info().outputPath('test-results', 'video.mp4');
  const info = probe(video);
  expect(info.codecs).toEqual(['h264', 'aac', 'mov_text']);
  expect(info.size).toBe('1920x1080');
  expect(info.chapters).toEqual(['first', 'second', 'third fails']);
  for (const clip of ['a-first', 'a-second', 'a-third-fails'])
    expect(probe(test.info().outputPath('test-results', clip, 'video.mp4')).codecs).toEqual(['h264', 'aac', 'mov_text']);
  expect(cues(video.replace('.mp4', '.vtt')).map(cue => cue.text)).toEqual(['This is first.', 'This is second.', 'This one fails.']);

  const spoken = fs.readFileSync(test.info().outputPath('spoken.txt'), 'utf8');
  expect(spoken).toContain('This is first.');
  expect(spoken).toContain('The test failed.');
  expect(spoken).toContain('2 tests passed, 1 failed.');
  // What the video was made from is gone.
  expect(fs.existsSync(test.info().outputPath('test-results', '.video-recordings'))).toBe(false);
  expect(fs.existsSync(test.info().outputPath('test-results', '.video-work'))).toBe(false);
});

test('the video shows the state each sentence talks about', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('colors', async ({ page, narrate }) => {
        await page.setContent(\`
          <style>html, body { height: 100%; margin: 0 }</style>
          <body style="background: rgb(220, 20, 20)"><button id=green onclick="document.body.style.background = 'rgb(20, 200, 20)'">a</button>
          <button id=blue onclick="document.body.style.background = 'rgb(20, 20, 220)'">b</button></body>\`);
        await narrate('It starts red.');
        await page.locator('#green').click();
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 200, 20)');
        await narrate('Now it is green.');
        await page.locator('#blue').click();
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 20, 220)');
        await narrate('Now it is blue.');
      });
    `,
  }, { video: true });
  expect(result.exitCode).toBe(0);
  const video = test.info().outputPath('test-results', 'video.mp4');
  const sentences = cues(video.replace('.mp4', '.vtt'));
  expect(sentences.map(cue => cue.text)).toEqual(['It starts red.', 'Now it is green.', 'Now it is blue.']);
  const colors = sentences.map(cue => colorAt(video, (cue.start + cue.end) / 2));
  expect(colors).toEqual(['red', 'green', 'blue']);
});

test('a sentence shows the page it is given, and the camera follows actions to other pages', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      const color = (value: string) => \`<style>html, body { height: 100%; margin: 0 }</style><body style="background: \${value}"><button>go</button></body>\`;
      test('two pages', async ({ page, context, narrate }) => {
        await page.setContent(color('rgb(220, 20, 20)'));
        await narrate('The first page.');
        const other = await context.newPage();
        await other.setContent(color('rgb(20, 20, 220)'));
        await narrate('The second page.', other);
        await narrate('The first page again.', page);
        await other.getByRole('button').click();
        await narrate('After a click on the second page.');
      });
    `,
  }, { video: true });
  expect(result.exitCode).toBe(0);
  const video = test.info().outputPath('test-results', 'video.mp4');
  const colors = cues(video.replace('.mp4', '.vtt')).map(cue => colorAt(video, (cue.start + cue.end) / 2));
  expect(colors).toEqual(['red', 'blue', 'red', 'blue']);
});

test('a failed assertion is recorded as failed, and soft ones too', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('fails', async ({ page }) => {
        await page.setContent('<div>Hello</div>');
        await expect(page.getByText('Hello')).toBeVisible();
        await expect.soft(page.getByText('Soft')).toBeVisible({ timeout: 300 });
        await expect(page.getByText('Goodbye')).toBeVisible({ timeout: 300 });
      });
    `,
  }, { video: true }, { FLASHWRIGHT_KEEP_VIDEO_WORK: '1' });
  expect(result.exitCode).toBe(1);
  const root = test.info().outputPath('test-results', '.video-recordings');
  const recording = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root)[0], 'recording.json'), 'utf8'));
  const assertions = recording.steps.filter((step: any) => step.category === 'expect').map((step: any) => [step.subtitle, !!step.failed]);
  expect(assertions).toEqual([
    [`getByText('Hello')`, false],
    [`getByText('Soft')`, true],
    [`getByText('Goodbye')`, true],
  ]);
  const { narratedVideo } = require('../../packages/playwright/lib/runner/index.js');
  expect(narratedVideo.describeAssertion({ title: 'Expect "toBeEnabled"', subtitle: `getByRole('button', { name: 'Checkout' })`, failed: true })).toBe('Expected \u201cCheckout\u201d to be enabled');
  expect(narratedVideo.describeAssertion({ title: 'Expect "toBeEnabled"', subtitle: `getByRole('button', { name: 'Checkout' })` })).toBe('\u201cCheckout\u201d is enabled');
});

test('closing another context does not stop the recording', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('two contexts', async ({ page, browser, narrate }) => {
        await page.setContent('<style>html, body { height: 100%; margin: 0 }</style><body style="background: rgb(220, 20, 20)"><button onclick="document.body.style.background = \\'rgb(20, 200, 20)\\'">go</button></body>');
        const visitor = await browser.newContext();
        const visitorPage = await visitor.newPage();
        await visitorPage.setContent('<style>html, body { height: 100%; margin: 0 }</style><body style="background: rgb(20, 20, 220)"></body>');
        await narrate('The visitor.', visitorPage);
        await visitor.close();
        await narrate('Back to the first page.', page);
        await page.getByRole('button').click();
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 200, 20)');
        await narrate('It changed after the visitor left.');
      });
    `,
  }, { video: true });
  expect(result.exitCode).toBe(0);
  const video = test.info().outputPath('test-results', 'video.mp4');
  const colors = cues(video.replace('.mp4', '.vtt')).map(cue => colorAt(video, (cue.start + cue.end) / 2));
  expect(colors).toEqual(['blue', 'red', 'green']);
});

test('--demo has no test names or results, and leaves out tests that failed', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      ${passing('first')}
      test('broken', async ({ page }) => {
        await page.setContent('<div>Hello</div>');
        await expect(page.getByText('Goodbye')).toBeVisible({ timeout: 300 });
      });
      test('with steps', async ({ page }) => {
        await page.setContent('<div>Hello</div>');
        await test.step('a step title', async () => {});
      });
    `,
  }, { demo: true, workers: 1 });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Left out of the demo because it failed: broken');
  expect(result.output).toMatch(/Video: test-results.video\.mp4 \(\d+ s, 2 tests\)/);
  const spoken = fs.readFileSync(test.info().outputPath('spoken.txt'), 'utf8');
  expect(spoken).toBe('This is first.\n');
  expect(probe(test.info().outputPath('test-results', 'video.mp4')).chapters).toEqual(['a step title']);

  const allFail = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('broken', async ({ page }) => {
        await page.setContent('<div>Hello</div>');
        expect(1).toBe(2);
      });
    `,
  }, { demo: true });
  expect(allFail.output).toContain('No video: every test failed.');
});

test('the voice, captions and camera can be turned off', async ({ runInlineTest }) => {
  const files = {
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      ${passing('only')}
    `,
  };
  const video = test.info().outputPath('test-results', 'video.mp4');
  const noVoice = await runInlineTest(files, { 'video': true, 'no-video-voice': true });
  expect(noVoice.exitCode).toBe(0);
  expect(fs.existsSync(test.info().outputPath('spoken.txt'))).toBe(false);
  // Still time to read the sentence, and silence for the audio track.
  const sentence = cues(video.replace('.mp4', '.vtt'))[0];
  expect(sentence.end - sentence.start).toBeGreaterThan(1);
  expect(probe(video).codecs).toEqual(['h264', 'aac', 'mov_text']);

  const noCaptions = await runInlineTest(files, { 'video': true, 'no-video-captions': true, 'no-video-zoom': true });
  expect(noCaptions.exitCode).toBe(0);
  expect(fs.readFileSync(test.info().outputPath('spoken.txt'), 'utf8')).toContain('This is only.');
  // The subtitle track stays: players keep it off unless asked for it.
  expect(probe(video).codecs).toEqual(['h264', 'aac', 'mov_text']);
});

test('the config can turn it on and set its options', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(`mode: 'demo', zoom: false, captions: false,`),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      ${passing('first')}
    `,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('Video: test-results');
  const invalid = await runInlineTest({
    'playwright.config.js': `module.exports = { narratedVideo: { mode: 'sometimes' } };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async () => {});
    `,
  });
  expect(invalid.exitCode).toBe(1);
  expect(invalid.output).toContain('config.narratedVideo.mode must be one of "off", "on", "demo"');
});

test('only the last attempt of a test is in the video', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('flaky', async ({ page, narrate }, testInfo) => {
        await page.setContent('<div>Hello</div>');
        await narrate('Attempt ' + testInfo.retry);
        expect(testInfo.retry).toBe(1);
      });
    `,
  }, { video: true, retries: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.flaky).toBe(1);
  expect(cues(test.info().outputPath('test-results', 'video.vtt')).map(cue => cue.text)).toEqual(['Attempt 1']);
});

test('narrate does nothing in other runs, and the video does not change the tests', async ({ runInlineTest }) => {
  const files = {
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('a', async ({ page, narrate }) => {
        await page.setContent('<div>Hello</div>');
        await narrate('A sentence.');
        expect(await page.evaluate(() => document.body.textContent)).toBe('Hello');
      });
      test('needs a sentence', async ({ narrate }) => {
        await expect(narrate(' ')).rejects.toThrow('narrate() needs a sentence to say.');
      });
    `,
  };
  const normal = await runInlineTest(files);
  expect(normal.exitCode).toBe(0);
  expect(normal.passed).toBe(2);
  expect(fs.existsSync(test.info().outputPath('test-results', 'video.mp4'))).toBe(false);
  expect(fs.existsSync(test.info().outputPath('test-results', '.video-recordings'))).toBe(false);
});

test('a video replaces the video option and works with a trace that has screenshots', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': `
      const config = (() => { ${voiceConfig().replace('module.exports =', 'return')} })();
      module.exports = { ...config, use: { video: 'on', trace: 'on' } };
    `,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      ${passing('first')}
    `,
  }, { video: true });
  expect(result.exitCode).toBe(0);
  const dir = test.info().outputPath('test-results', 'a-first');
  expect(fs.readdirSync(dir).sort()).toEqual(['trace.zip', 'video.mp4']);
});

test('it says when ffmpeg is missing, before running the tests', async ({ runInlineTest }) => {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'no-ffmpeg-'));
  fs.symlinkSync(process.execPath, path.join(emptyPath, process.platform === 'win32' ? 'node.exe' : 'node'));
  const result = await runInlineTest({
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async () => { console.log('the test ran'); });
    `,
  }, { video: true }, { PATH: emptyPath });
  fs.rmSync(emptyPath, { recursive: true, force: true });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('--video needs ffmpeg.');
  expect(result.output).not.toContain('the test ran');
});

test('the system voice reads the narration', async ({ runInlineTest }) => {
  test.skip(process.platform !== 'linux', 'a stand-in for espeak-ng');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-espeak-'));
  fs.writeFileSync(path.join(bin, 'espeak-ng'), `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -f) cat "$2" >> "${bin}/said.txt"; echo >> "${bin}/said.txt"; shift 2;;
    -w) out="$2"; shift 2;;
    *) shift;;
  esac
done
ffmpeg -hide_banner -loglevel error -y -f lavfi -i anullsrc=r=22050:cl=mono -t 0.5 "$out"
`, { mode: 0o755 });
  const unique = `Said by the system ${Date.now()} ${test.info().workerIndex}.`;
  const result = await runInlineTest({
    'playwright.config.js': `module.exports = { narratedVideo: { voice: 'system' } };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async ({ page, narrate }) => {
        await page.setContent('<div>Hello</div>');
        await narrate('${unique}');
      });
    `,
  }, { video: true }, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const said = fs.readFileSync(path.join(bin, 'said.txt'), 'utf8');
  fs.rmSync(bin, { recursive: true, force: true });
  expect(result.exitCode).toBe(0);
  expect(said).toContain(unique);
  expect(probe(test.info().outputPath('test-results', 'video.mp4')).codecs).toEqual(['h264', 'aac', 'mov_text']);
});

test('the voice of this system speaks', async ({ runInlineTest }) => {
  test.skip(process.platform === 'linux' && spawnSync('espeak-ng', ['--version']).status !== 0 && spawnSync('espeak', ['--version']).status !== 0, 'no system voice here');
  const result = await runInlineTest({
    'playwright.config.js': `
      process.env.FLASHWRIGHT_VOICE_CACHE = require('path').join(__dirname, 'voice-cache');
      module.exports = { narratedVideo: { voice: 'system' } };
    `,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async ({ page, narrate }) => {
        await page.setContent('<div>Hello</div>');
        await narrate('This sentence is read aloud by the voice of the operating system.');
      });
    `,
  }, { video: true, reporter: 'line' });
  expect(result.exitCode).toBe(0);
  expect(result.output).not.toContain('the voice failed');
  const video = test.info().outputPath('test-results', 'video.mp4');
  expect(probe(video).codecs).toEqual(['h264', 'aac', 'mov_text']);
  const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-i', video, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const loudest = +stderr.match(/max_volume: (-?[\d.]+) dB/)![1];
  expect(loudest).toBeGreaterThan(-40);
});

test('without a voice it says how to get one', async ({ runInlineTest }) => {
  test.skip(process.platform !== 'linux', 'macOS and Windows always have one');
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'no-voice-'));
  for (const tool of ['ffmpeg', 'ffprobe'])
    fs.symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), path.join(emptyBin, tool));
  fs.symlinkSync(process.execPath, path.join(emptyBin, 'node'));
  const result = await runInlineTest({
    'playwright.config.js': `module.exports = { narratedVideo: { voice: 'system' } };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async ({ page, narrate }) => {
        await page.setContent('<div>Hello</div>');
        await narrate('A sentence.');
      });
    `,
  }, { video: true }, { PATH: emptyBin });
  fs.rmSync(emptyBin, { recursive: true, force: true });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('This system has no voice, so the video only has captions. For a free, natural voice: npx playwright install-voice');
  expect(result.output).toContain('Video: test-results');
});

test('the summary of agent mode has the video', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.js': voiceConfig(),
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      ${passing('first')}
    `,
  }, { video: true }, { FLASHWRIGHT_AGENT_MODE: '1' });
  expect(result.exitCode).toBe(0);
  const summary = JSON.parse(fs.readFileSync(test.info().outputPath('test-results', 'summary.json'), 'utf8'));
  expect(summary.video).toBe(path.join('test-results', 'video.mp4'));
});

test('captions say what is typed', async () => {
  const { narratedVideo } = require('../../packages/playwright/lib/runner/index.js');
  const describe = (method: string, params: any) => narratedVideo.describeAction({ order: 0, title: '', category: 'pw:api', start: 0, method, params });
  expect(describe('fill', { selector: 'internal:role=textbox[name="Email"i]', value: 'ann@example.com' })).toBe('Type \u201cann@example.com\u201d into \u201cEmail\u201d');
  expect(describe('fill', { selector: 'internal:label="Password"i', value: 'hunter2' })).toBe('Type \u201chunter2\u201d into \u201cPassword\u201d');
  expect(describe('fill', { selector: 'internal:label="Email"i', value: '' })).toBe('Clear \u201cEmail\u201d');
  expect(describe('keyboardType', { text: 'hello' })).toBe('Type \u201chello\u201d');
});

test('types', async ({ runTSC }) => {
  const result = await runTSC({
    'playwright.config.ts': `
      import { defineConfig } from '@playwright/test';
      export default defineConfig({
        narratedVideo: { mode: 'demo', zoom: false, captions: true, voice: async text => Buffer.from(text), voiceName: 'Samantha' },
      });
      // @ts-expect-error
      defineConfig({ narratedVideo: { mode: 'sometimes' } });
      // @ts-expect-error
      defineConfig({ narratedVideo: { voice: true } });
    `,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('a', async ({ page, narrate }) => {
        await narrate('Hello.');
        await narrate('Hello.', page);
        // @ts-expect-error
        await narrate(1);
      });
    `,
  });
  expect(result.exitCode).toBe(0);
});
