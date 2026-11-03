import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: Number(process.env.WORKERS),
  retries: 0,
  reporter: 'dot',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: { executablePath: process.env.CHROME_PATH },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
