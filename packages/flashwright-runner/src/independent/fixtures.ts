import { chromium, request, failure, type Browser, type BrowserContext, type Page, type APIRequestContext, type LaunchOptions, type BrowserContextOptions, type ViewportSize } from '@flashwright/core';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import type { Fixtures } from 'flashwright-upstream-runner/test';
import { currentIndependentInfo } from './output.js';
import type { IndependentTracePolicy } from './tracing.js';

export interface NativeWorkerFixtures {
  browser: Browser; browserName: 'chromium'; defaultBrowserType: 'chromium';
  launchOptions: LaunchOptions; headless: boolean;
  screenshot: 'off'; video: 'off';
  _validateOptions: void;
}
export interface NativeTestFixtures {
  trace: IndependentTracePolicy;
  context: BrowserContext; page: Page; request: APIRequestContext;
  contextOptions: BrowserContextOptions; baseURL: string | undefined;
  viewport: ViewportSize | null; storageState: BrowserContextOptions['storageState'];
  actionTimeout: number; navigationTimeout: number;
  screen: BrowserContextOptions['screen'];
  userAgent: BrowserContextOptions['userAgent'];
  deviceScaleFactor: BrowserContextOptions['deviceScaleFactor'];
  isMobile: BrowserContextOptions['isMobile'];
  hasTouch: BrowserContextOptions['hasTouch'];
  ignoreHTTPSErrors: BrowserContextOptions['ignoreHTTPSErrors'];
  javaScriptEnabled: BrowserContextOptions['javaScriptEnabled'];
  acceptDownloads: BrowserContextOptions['acceptDownloads'];
  colorScheme: BrowserContextOptions['colorScheme'];
  reducedMotion: BrowserContextOptions['reducedMotion'];
  forcedColors: BrowserContextOptions['forcedColors'];
  contrast: BrowserContextOptions['contrast'];
  _contextDefaults: void;
}

export const nativeFixtures: Fixtures<NativeTestFixtures, NativeWorkerFixtures> = {
  defaultBrowserType: ['chromium', { scope: 'worker', option: true }],
  browserName: [async ({ defaultBrowserType }, use) => use(defaultBrowserType), { scope: 'worker', option: true }],
  launchOptions: [{}, { scope: 'worker', option: true }],
  headless: [async ({ launchOptions }, use) => use(launchOptions.headless ?? true), { scope: 'worker', option: true }],
  trace: ['off', { option: true }],
  screenshot: ['off', { scope: 'worker', option: true }],
  video: ['off', { scope: 'worker', option: true }],
  _validateOptions: [async ({ browserName, defaultBrowserType, screenshot, video }, use) => {
    if (browserName !== 'chromium' || defaultBrowserType !== 'chromium') throw failure('UnsupportedFeatureError', 'independent.use.browserName', 'only Chromium is implemented');
    for (const [name, value] of Object.entries({ screenshot, video })) if (value !== 'off') throw failure('UnsupportedFeatureError', `independent.use.${name}`, 'automatic artifacts are not integrated with the independent runner; use the default runner for this policy');
    await use();
  }, { scope: 'worker', auto: true }],
  browser: [async ({ _validateOptions, launchOptions, headless }, use) => {
    void _validateOptions;
    const browser = await chromium.launch({ ...launchOptions, headless });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
  contextOptions: [{}, { option: true }],
  baseURL: [async ({ contextOptions }, use) => use(contextOptions.baseURL ?? process.env.PLAYWRIGHT_TEST_BASE_URL), { option: true }],
  viewport: [async ({ contextOptions }, use) => use(contextOptions.viewport === undefined ? { width: 1280, height: 720 } : contextOptions.viewport), { option: true }],
  storageState: [async ({ contextOptions }, use) => use(contextOptions.storageState), { option: true }],
  screen: [async ({ contextOptions }, use) => use(contextOptions.screen), { option: true }],
  userAgent: [async ({ contextOptions }, use) => use(contextOptions.userAgent), { option: true }],
  deviceScaleFactor: [async ({ contextOptions }, use) => use(contextOptions.deviceScaleFactor), { option: true }],
  isMobile: [async ({ contextOptions }, use) => use(contextOptions.isMobile), { option: true }],
  hasTouch: [async ({ contextOptions }, use) => use(contextOptions.hasTouch), { option: true }],
  ignoreHTTPSErrors: [async ({ contextOptions }, use) => use(contextOptions.ignoreHTTPSErrors), { option: true }],
  javaScriptEnabled: [async ({ contextOptions }, use) => use(contextOptions.javaScriptEnabled), { option: true }],
  acceptDownloads: [async ({ contextOptions }, use) => use(contextOptions.acceptDownloads), { option: true }],
  colorScheme: [async ({ contextOptions }, use) => use(contextOptions.colorScheme), { option: true }],
  reducedMotion: [async ({ contextOptions }, use) => use(contextOptions.reducedMotion), { option: true }],
  forcedColors: [async ({ contextOptions }, use) => use(contextOptions.forcedColors), { option: true }],
  contrast: [async ({ contextOptions }, use) => use(contextOptions.contrast), { option: true }],
  actionTimeout: [0, { option: true }], navigationTimeout: [0, { option: true }],
  _contextDefaults: [async ({ contextOptions, baseURL, viewport, storageState, screen, userAgent, deviceScaleFactor, isMobile, hasTouch, ignoreHTTPSErrors, javaScriptEnabled, acceptDownloads, colorScheme, reducedMotion, forcedColors, contrast, actionTimeout, navigationTimeout }, use) => {
    const inherited = { screen, userAgent, deviceScaleFactor, isMobile, hasTouch, ignoreHTTPSErrors, javaScriptEnabled, acceptDownloads, colorScheme, reducedMotion, forcedColors, contrast };
    const forwarded = Object.fromEntries(Object.entries(inherited).filter(([, value]) => value !== undefined));
    const restore = runnerIntegration.installContextDefaults(1, {
      contextOptions: { ...contextOptions, ...forwarded, viewport, ...(baseURL === undefined ? {} : { baseURL }), ...(storageState === undefined ? {} : { storageState }) },
      actionTimeout, navigationTimeout,
    });
    try { await use(); } finally { restore(); }
  }, { auto: 'all-hooks-included' as unknown as boolean }],
  context: async ({ _contextDefaults, browser }, use) => {
    void _contextDefaults;
    const context = await browser.newContext();
    try { await use(context); }
    finally {
      try {
      const info = currentIndependentInfo();
      if (info.status !== 'passed' && info.status !== 'skipped' && context.pages().length) {
        try {
          const snapshot = await context.pages()[0]!.locator('body').ariaSnapshot({ timeout: 2000 });
          await info.attach('page-snapshot', { body: snapshot.slice(0, 32768), contentType: 'text/yaml' });
        } catch (error) {
          await info.attach('page-snapshot-error', { body: String(error).slice(0, 4096), contentType: 'text/plain' });
        }
      }
      } finally { await context.close(); }
    }
  },
  page: async ({ context }, use) => { await use(await context.newPage()); },
  request: async ({ _contextDefaults }, use) => {
    void _contextDefaults;
    const context = await request.newContext();
    try { await use(context); } finally { await context.dispose(); }
  },
};
