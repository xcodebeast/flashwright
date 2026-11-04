import { passedTests, playwrightFiles } from '../playwright-port.mjs';

export default {
  label: 'Flashwright',
  package: 'flashwright-test',
  kind: 'test framework',
  files: playwrightFiles,
  // The warm session is off, as in CI: every run starts from nothing. Agent mode is off too, so a
  // benchmark started by a coding agent keeps the same reporter as Playwright.
  command: ({ workers, node }) => ({ command: node, args: ['node_modules/@playwright/test/cli.js', 'test', `--workers=${workers}`], env: { FLASHWRIGHT_SESSION: '0', FLASHWRIGHT_AGENT_MODE: '0' } }),
  passed: passedTests,
};
