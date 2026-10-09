import { chromium, type BrowserContextOptions, type LaunchOptions } from 'flashwright';
import { defineConfig, test } from '@flashwright/test';

const contextOptions: BrowserContextOptions = { ignoreHTTPSErrors: true, javaScriptEnabled: false };
const launchOptions: LaunchOptions = { slowMo: 0 };
defineConfig({ use: { ...contextOptions, launchOptions, contextOptions } });
test.use(contextOptions);

async function consumer() {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext(contextOptions);
  const page = await browser.newPage({ ignoreHTTPSErrors: false, javaScriptEnabled: true });
  await page.close();
  await context.close();
  await browser.close();
}
void consumer;
