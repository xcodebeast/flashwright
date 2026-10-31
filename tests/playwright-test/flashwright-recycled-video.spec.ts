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

import fs from 'fs';
import path from 'path';

import { test, expect } from './playwright-test-fixtures';
import { VideoPlayer } from '../library/videoPlayer';

type Color = 'red' | 'blue';

function isColor(pixels: Buffer, color: Color) {
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const matches = color === 'red' ? r > 200 && g < 60 && b < 60 : b > 200 && r < 60 && g < 60;
    if (!matches)
      return false;
  }
  return true;
}

test('tests that record video in a recycled context each get their own page in their video', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { video: 'on', viewport: { width: 320, height: 240 } } };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      for (const [name, color] of [['red', 'rgb(255, 0, 0)'], ['blue', 'rgb(0, 0, 255)']]) {
        test(name, async ({ page }) => {
          await page.setContent('<style>body { margin: 0; background: ' + color + '; }</style>');
          await page.waitForTimeout(500);
        });
      }
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
  for (const [name, other] of [['red', 'blue'], ['blue', 'red']] as [Color, Color][]) {
    const dir = test.info().outputPath('test-results', `a-${name}`);
    const file = fs.readdirSync(dir).find(file => file.endsWith('.webm'));
    const player = new VideoPlayer(path.join(dir, file!));
    // The video ends with the test's page, not with what the context does after the test.
    expect(isColor(player.seekLastFrame().data, name)).toBe(true);
    expect(player.findFrame(pixels => isColor(pixels, other))).toBeUndefined();
  }
});

test('a recycled context keeps the video of a failed test only with retain-on-failure', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { video: 'retain-on-failure' } };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('pass', async ({ page }) => {
        await page.setContent('<div>PASS</div>');
      });
      test('fail', async ({ page }) => {
        await page.setContent('<div>FAIL</div>');
        expect(1).toBe(2);
      });
      test('pass again', async ({ page }) => {
        await page.setContent('<div>PASS</div>');
      });
    `,
  }, { workers: 1 });
  expect(result.passed).toBe(2);
  expect(result.failed).toBe(1);
  const videos = (name: string) => {
    const dir = test.info().outputPath('test-results', name);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.webm')) : [];
  };
  expect(videos('a-pass')).toEqual([]);
  expect(videos('a-fail')).toEqual(['video.webm']);
  expect(videos('a-pass-again')).toEqual([]);
});

test('a recycled context saves the video of every page a test opens', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { use: { video: 'on' } };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('first', async ({ page }) => {
        await page.setContent('<div>FIRST</div>');
      });
      test('popup', async ({ page }) => {
        await page.setContent('<a target=_blank href="about:blank">open</a>');
        const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('a')]);
        await popup.setContent('<div>POPUP</div>');
        await popup.close();
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
  const videos = (name: string) => fs.readdirSync(test.info().outputPath('test-results', name)).filter(file => file.endsWith('.webm')).sort();
  expect(videos('a-first')).toEqual(['video.webm']);
  expect(videos('a-popup')).toEqual(['video-1.webm', 'video.webm']);
});
