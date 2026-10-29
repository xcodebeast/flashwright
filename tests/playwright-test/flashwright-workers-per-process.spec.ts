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

// Flashwright: the workersPerProcess option runs several workers in one worker process.

import { test, expect } from './playwright-test-fixtures';

import type { JSONReport, JSONReportTestResult } from '@playwright/test/reporter';

function resultsByTitle(report: JSONReport): Map<string, JSONReportTestResult> {
  const results = new Map<string, JSONReportTestResult>();
  const visit = (suite: JSONReport['suites'][number]) => {
    for (const spec of suite.specs) {
      for (const test of spec.tests)
        results.set(spec.title, test.results[0]);
    }
    suite.suites?.forEach(visit);
  };
  report.suites.forEach(visit);
  return results;
}

// Prints each API call with the test and the step it was reported in.
const apiCallReporter = `
  export default class {
    onStepBegin(test, result, step) {
      if (step.category === 'pw:api')
        console.log('%%api ' + test.title + ' > ' + step.parent?.title + ' > ' + step.title);
    }
  }
`;

// Each test waits for the other to start: they run at the same time, in one process.
const together = `
  globalThis.started = (globalThis.started ?? 0) + 1;
  await expect.poll(() => globalThis.started).toBe(2);
`;

test('should run tests of several workers at the same time in one process', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { workers: 2, workersPerProcess: 2, fullyParallel: true, use: { trace: 'on' }, reporter: './reporter.ts' };`,
    'reporter.ts': apiCallReporter,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      for (const name of ['one', 'two']) {
        test(name, async ({ page }, testInfo) => {
          ${together}
          await test.step('step of ' + name, async () => {
            await page.route('**/*', async route => {
              console.log('route of ' + name);
              await route.fulfill({ contentType: 'text/html', body: '<p>' + name + '</p>' });
            });
            await page.goto('http://localhost/' + name);
            await expect(page.locator('p')).toHaveText(name);
          });
          console.log('output of ' + name);
          console.log('%%worker ' + process.pid + ' ' + testInfo.workerIndex + ' ' + testInfo.parallelIndex);
        });
      }
    `,
  });
  expect(result.exitCode).toBe(0);
  expect(result.report.stats.expected).toBe(2);
  const results = resultsByTitle(result.report);
  const stdout = (name: string) => results.get(name)!.stdout.map(chunk => 'text' in chunk ? chunk.text : '').join('');
  const workers = ['one', 'two'].map(name => stdout(name).match(/%%worker (.*)/)![1].split(' '));
  expect(workers[0][0]).toBe(workers[1][0]);
  expect(workers[0][1]).not.toBe(workers[1][1]);
  expect(workers[0][2]).not.toBe(workers[1][2]);
  // What each test does is reported for that test, including what its route handler prints.
  const apiCalls = result.outputLines.filter(line => line.startsWith('api '));
  for (const [name, other] of [['one', 'two'], ['two', 'one']]) {
    expect(apiCalls).toContain(`api ${name} > step of ${name} > Navigate`);
    expect(apiCalls.filter(line => line.startsWith(`api ${name} > `)).join('\n')).not.toContain(other);
    expect(stdout(name)).toContain('route of ' + name);
    expect(stdout(name)).toContain('output of ' + name);
    expect(stdout(name)).not.toContain(other);
    expect(results.get(name)!.attachments.map(attachment => attachment.name)).toEqual(['trace']);
  }
});

test('should not fail the other worker of the process on an unhandled error', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { workers: 2, workersPerProcess: 2, fullyParallel: true };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('throws', async ({ page }) => {
        ${together}
        setTimeout(() => { throw new Error('thrown from a timer'); }, 0);
        await page.waitForTimeout(1000);
      });
      test('passes', async ({ page }) => {
        ${together}
        await page.setContent('<p>passes</p>');
        await page.waitForTimeout(300);
        await expect(page.locator('p')).toHaveText('passes');
      });
    `,
  });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(1);
  expect(result.failed).toBe(1);
  expect(resultsByTitle(result.report).get('throws')!.errors[0].message).toContain('thrown from a timer');
});

test('should keep each worker\'s action timeout when the other worker\'s test ends', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { workers: 2, workersPerProcess: 2, fullyParallel: true, use: { actionTimeout: 1234 } };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('ends first', async ({ page }) => {
        ${together}
      });
      test('ends last', async ({ browser }) => {
        ${together}
        // The other test and its fixtures are done.
        await new Promise(f => setTimeout(f, 500));
        const context = await browser.newContext();
        const page = await context.newPage();
        const error = await page.click('button').catch(e => e);
        expect(error.message).toContain('Timeout 1234ms exceeded');
        await context.close();
      });
    `,
  });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
});

test('should take workersPerProcess from the command line', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      for (const name of ['one', 'two']) {
        test(name, async ({}, testInfo) => {
          ${together}
          console.log('%%' + process.pid);
        });
      }
    `,
  }, { 'workers': 2, 'workers-per-process': 2, 'fully-parallel': true });
  expect(result.exitCode).toBe(0);
  expect(new Set(result.outputLines).size).toBe(1);
});

test('should validate workersPerProcess', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { workersPerProcess: 0 };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('pass', () => {});
    `,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('config.workersPerProcess must be a positive integer');
});
