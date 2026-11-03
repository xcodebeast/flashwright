import { passedTests, playwrightFiles } from '../playwright-port.mjs';

export default {
  label: 'Playwright',
  package: '@playwright/test',
  kind: 'test framework',
  files: playwrightFiles,
  command: ({ workers, node }) => ({ command: node, args: ['node_modules/@playwright/test/cli.js', 'test', `--workers=${workers}`], env: {} }),
  passed: passedTests,
};
