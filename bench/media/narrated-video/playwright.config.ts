import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'checklist.spec.ts',
  workers: 1,
  reporter: 'list',
  use: {
    viewport: { width: 1280, height: 720 },
    launchOptions: process.env.FLASHWRIGHT_EXAMPLE_CHROMIUM
      ? { executablePath: process.env.FLASHWRIGHT_EXAMPLE_CHROMIUM }
      : {},
  },
});
