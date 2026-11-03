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

import { test, expect, stripAnsi } from './playwright-test-fixtures';

const suite = {
  'a.spec.ts': `
    import { test, expect } from '@playwright/test';
    test('passes', async () => {
      console.log('noise from a passing test');
    });
    test('fails', async () => {
      console.log('before the failure');
      expect(1 + 1).toBe(3);
    });
    test('flaky', async ({}, testInfo) => {
      expect(testInfo.retry).toBe(1);
    });
    test.skip('skipped', async () => {});
  `,
};

function readSummary() {
  return JSON.parse(fs.readFileSync(test.info().outputPath('test-results', 'summary.json'), 'utf8'));
}

test('a detected agent gets failures only and a summary file', async ({ runInlineTest }) => {
  const result = await runInlineTest(suite, { retries: 1, workers: 1 }, { CLAUDECODE: '1' });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.flaky).toBe(1);
  expect(result.output).toContain('Running 4 tests using 1 worker');
  expect(result.output).not.toContain('noise from a passing test');
  expect(result.output).not.toContain('passes');
  expect(result.output).not.toContain('───');
  expect(result.output).toContain('  ✘ a.spec.ts:6:9 › fails');
  expect(result.output).toContain('    Test output (1 line):\n    | before the failure');
  // The last attempt only.
  expect(result.output.match(/Received: 2/g)).toHaveLength(1);
  expect(stripAnsi(result.output)).toContain('  1 failed\n    a.spec.ts:6:9 › fails\n  1 flaky\n    a.spec.ts:10:9 › flaky\n  1 skipped\n  1 passed');
  expect(result.output).toContain('  Rerun the failures: npx playwright test --last-failed');
  expect(result.output).toContain('  Summary: test-results/summary.json');

  const summary = readSummary();
  expect(summary).toEqual({
    version: 1,
    outcome: 'failed',
    status: 'failed',
    durationMs: expect.any(Number),
    counts: { total: 4, passed: 1, failed: 1, flaky: 1, skipped: 1, interrupted: 0, didNotRun: 0 },
    failures: [{
      title: 'fails',
      project: '',
      location: 'a.spec.ts:6:9',
      status: 'failed',
      attempts: 2,
      errors: [{ message: 'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 3\nReceived: 2', location: 'a.spec.ts:8:21' }],
      attachments: [{ name: 'error-context', contentType: 'text/markdown', path: 'test-results/a-fails-retry1/error-context.md' }],
      rerun: 'npx playwright test a.spec.ts:6',
    }],
    flaky: [{
      title: 'flaky',
      project: '',
      location: 'a.spec.ts:10:9',
      errors: [{ message: expect.stringContaining('Expected: 1\nReceived: 0'), location: 'a.spec.ts:11:30' }],
    }],
    errors: [],
    rerun: 'npx playwright test --last-failed',
  });
});

test('each coding agent variable turns agent mode on, and 0 or false does not', async ({ runInlineTest }) => {
  const files = { 'a.spec.ts': suite['a.spec.ts'].replace(/test\('(fails|flaky)'/g, 'test.skip(\'$1\'') };
  for (const name of ['AI_AGENT', 'CLAUDECODE', 'CODEX_CI', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'COPILOT_CLI', 'CURSOR_AGENT', 'GEMINI_CLI']) {
    const result = await runInlineTest(files, { workers: 1 }, { [name]: '1' });
    expect(result.exitCode, name).toBe(0);
    expect(result.output, name).not.toContain('noise from a passing test');
  }
  for (const value of ['0', 'false']) {
    const result = await runInlineTest(files, { workers: 1 }, { AI_AGENT: value });
    expect(result.output, value).toContain('noise from a passing test');
  }
});

test('the environment variable overrides the config, which overrides detection', async ({ runInlineTest }) => {
  const files = (agentMode: boolean) => ({
    'playwright.config.ts': `export default { agentMode: ${agentMode} };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('passes', async () => {
        console.log('noise from a passing test');
      });
    `,
  });
  const human = await runInlineTest(files(false), {}, { CLAUDECODE: '1' });
  expect(human.output).toContain('noise from a passing test');
  expect(human.output).toContain('✓');

  const agent = await runInlineTest(files(true), {});
  expect(agent.output).not.toContain('noise from a passing test');
  expect(agent.output).toContain('Summary: test-results/summary.json');

  const forcedOff = await runInlineTest(files(true), {}, { FLASHWRIGHT_AGENT_MODE: '0' });
  expect(forcedOff.output).toContain('noise from a passing test');

  const forcedOn = await runInlineTest(files(false), {}, { FLASHWRIGHT_AGENT_MODE: '1' });
  expect(forcedOn.output).not.toContain('noise from a passing test');
});

test('a reporter on the command line is kept, and file reporters stay', async ({ runInlineTest }) => {
  const files = {
    'playwright.config.ts': `export default { reporter: [['line'], ['dot'], ['junit', { outputFile: 'junit.xml' }]] };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('passes', async () => {});
    `,
  };
  const agent = await runInlineTest(files, {}, { CLAUDECODE: '1' });
  expect(agent.exitCode).toBe(0);
  expect(agent.output).toContain('Summary: test-results/summary.json');
  // line and dot become a single agent reporter.
  expect(agent.output.match(/Running 1 test/g)).toHaveLength(1);
  expect(fs.existsSync(test.info().outputPath('junit.xml'))).toBe(true);

  const dot = await runInlineTest(files, { reporter: 'dot' }, { CLAUDECODE: '1' });
  expect(dot.output).toContain('·');
  expect(dot.output).not.toContain('Summary:');
});

test('the summary says when no tests ran or an error happened outside tests', async ({ runInlineTest }) => {
  const none = await runInlineTest({
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('passes', async () => {});
    `,
  }, { grep: 'nothing-matches' }, { CLAUDECODE: '1' });
  expect(none.exitCode).toBe(1);
  expect(readSummary()).toMatchObject({ outcome: 'no-tests', counts: { total: 0 }, errors: [{ message: 'Error: No tests found' }] });

  const broken = await runInlineTest({
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('passes', async () => {});
    `,
    'b.spec.ts': `
      import { test } from '@playwright/test';
      throw new Error('broken file');
    `,
  }, {}, { CLAUDECODE: '1' });
  expect(broken.exitCode).toBe(1);
  const summary = readSummary();
  expect(summary.outcome).toBe('error');
  expect(summary.errors[0].message).toContain('broken file');
});

test('summary.json is written where the outputFile option says', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `export default { reporter: [['agent', { outputFile: 'out/agent.json' }]] };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('passes', async () => {});
    `,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('Summary: out/agent.json');
  expect(JSON.parse(fs.readFileSync(test.info().outputPath('out', 'agent.json'), 'utf8'))).toMatchObject({ outcome: 'passed', counts: { total: 1, passed: 1 } });
});
