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

import { test, expect } from './playwright-test-fixtures';

const passing = `
  import { test } from '@playwright/test';
  test('a', async () => {});
`;

test('doctor reports a healthy project', async ({ runCLICommand }) => {
  const result = await runCLICommand({
    'playwright.config.ts': `export default { projects: [{ name: 'chromium' }] };`,
    'a.spec.ts': passing,
  }, 'doctor');
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('✓ Node.js v');
  expect(result.stdout).toMatch(/✓ Flashwright \d+\.\d+\.\d+/);
  expect(result.stdout).toContain('✓ Config: playwright.config.ts, 1 project');
  expect(result.stdout).toContain('✓ Project chromium: 1 test file');
  expect(result.stdout).toMatch(/✓ Chrome Headless Shell [\d.]+ \(used by chromium\)/);
  expect(result.stdout).toContain('· Agent mode: off (no coding agent detected)');
  expect(result.stdout).toContain('No problems found.');
});

test('doctor reports what would stop a run', async ({ startCLICommand }) => {
  const child = await startCLICommand({
    'playwright.config.ts': `export default { projects: [
      { name: 'empty', testDir: 'nothing-here' },
      { name: 'custom', use: { launchOptions: { executablePath: '/does/not/exist' } } },
      { name: 'headed', use: { headless: false } },
    ] };`,
    'a.spec.ts': passing,
  }, 'doctor', [], {}, { DISPLAY: undefined, WAYLAND_DISPLAY: undefined, AI_AGENT: 'some-agent' });
  const { exitCode } = await child.exited;
  expect(exitCode).toBe(1);
  expect(child.output).toContain('! Project empty: no test files');
  expect(child.output).toContain('✗ Browser at /does/not/exist does not exist (used by custom)');
  if (process.platform === 'linux')
    expect(child.output).toContain('✗ No display for headed projects: Project headed');
  expect(child.output).toContain('· Agent mode: on (AI_AGENT is set)');
  expect(child.output).toMatch(/\d problems?, 1 warning\./);
});

test('doctor reports a config that does not load', async ({ runCLICommand }) => {
  const result = await runCLICommand({
    'playwright.config.ts': `throw new Error('broken config');`,
  }, 'doctor', ['--json']);
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.ok).toBe(false);
  expect(report.checks).toContainEqual({ level: 'error', title: 'Config does not load', details: expect.arrayContaining([expect.stringContaining('broken config')]) });
});

test('doctor finds a second copy of Playwright', async ({ runCLICommand }) => {
  const result = await runCLICommand({
    'playwright.config.ts': `export default {};`,
    'a.spec.ts': passing,
    'node_modules/@playwright/test/package.json': JSON.stringify({ name: '@playwright/test', version: '1.50.0' }),
    'node_modules/playwright/package.json': JSON.stringify({ name: 'playwright', version: '1.50.0' }),
  }, 'doctor');
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain(`✗ The project's @playwright/test is another copy of Playwright (1.50.0)`);
});
