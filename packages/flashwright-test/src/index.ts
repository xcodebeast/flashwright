import * as upstream from 'flashwright-upstream-runner/test';
import { chromium, failure, type Browser, type BrowserContext, type Page, type LaunchOptions, type BrowserContextOptions, type ViewportSize } from 'flashwright';
import type { PlaywrightTestOptions, PlaywrightWorkerOptions, ExpectMatcherState } from 'flashwright-upstream-runner/test';
import { matchers } from './matchers.js';

export type { TestInfo, WorkerInfo, TestType, Fixtures, FullConfig, FullProject, PlaywrightTestConfig, ExpectMatcherState, MatcherReturnType } from 'flashwright-upstream-runner/test';
export type { Browser, BrowserContext, Page, Locator } from 'flashwright';
export { errors } from 'flashwright';
export { defineConfig, devices } from 'flashwright-upstream-runner/test';

function unsupportedOptions(options: object): void {
  for (const [name, value] of Object.entries(options)) if (value !== undefined) throw failure('UnsupportedFeatureError', `test.use.${name}`, 'option is not implemented by the Flashwright development runner');
}
function unsupportedMatcher(name: string) {
  return async function(this: ExpectMatcherState, _actual: unknown, ..._arguments: unknown[]): Promise<never> { throw failure('UnsupportedFeatureError', `expect.${name}`, 'browser matcher is not implemented by Flashwright'); };
}
export const expect = upstream.expect.extend({}).extend({
  ...matchers,
  toBeInViewport: unsupportedMatcher('toBeInViewport'), toBeOK: unsupportedMatcher('toBeOK'),
  toHaveClass: unsupportedMatcher('toHaveClass'), toContainClass: unsupportedMatcher('toContainClass'),
  toHaveCSS: unsupportedMatcher('toHaveCSS'), toHaveId: unsupportedMatcher('toHaveId'),
  toHaveJSProperty: unsupportedMatcher('toHaveJSProperty'), toHaveRole: unsupportedMatcher('toHaveRole'),
  toHaveValues: unsupportedMatcher('toHaveValues'), toHaveScreenshot: unsupportedMatcher('toHaveScreenshot'),
  toMatchAriaSnapshot: unsupportedMatcher('toMatchAriaSnapshot'),
  toHaveAccessibleName: unsupportedMatcher('toHaveAccessibleName'),
  toHaveAccessibleDescription: unsupportedMatcher('toHaveAccessibleDescription'),
  toHaveAccessibleErrorMessage: unsupportedMatcher('toHaveAccessibleErrorMessage'),
});

type WorkerFixtures = Omit<PlaywrightWorkerOptions, 'launchOptions'> & { browser: Browser; launchOptions: LaunchOptions; _validateWorkerOptions: void };
type TestFixtures = Partial<Omit<PlaywrightTestOptions, 'contextOptions' | 'viewport' | 'actionTimeout' | 'navigationTimeout'>> & {
  page: Page; context: BrowserContext; contextOptions: BrowserContextOptions; viewport: ViewportSize | null;
  actionTimeout: number; navigationTimeout: number; _validateContextOptions: void;
};

/** The version-pinned root runner provides scheduling; every browser fixture below is ours. */
export const test = upstream._baseTest.extend<TestFixtures, WorkerFixtures>({
  defaultBrowserType: ['chromium', { scope: 'worker', option: true }],
  browserName: [async ({ defaultBrowserType }, use) => use(defaultBrowserType), { scope: 'worker', option: true }],
  headless: [async ({ launchOptions }, use) => use(launchOptions.headless ?? true), { scope: 'worker', option: true }],
  channel: [undefined, { scope: 'worker', option: true }],
  launchOptions: [{}, { scope: 'worker', option: true }],
  connectOptions: [undefined, { scope: 'worker', option: true }],
  screenshot: ['off', { scope: 'worker', option: true }],
  trace: ['off', { scope: 'worker', option: true }],
  video: ['off', { scope: 'worker', option: true }],
  _validateWorkerOptions: [async ({ browserName, defaultBrowserType, channel, connectOptions, screenshot, trace, video }, use) => {
    if (browserName !== 'chromium' || defaultBrowserType !== 'chromium') throw failure('UnsupportedFeatureError', 'test.use.browserName', 'only the pinned Chromium is implemented');
    unsupportedOptions({ channel, connectOptions });
    for (const [name, value] of Object.entries({ screenshot, trace, video })) if (value !== 'off') throw failure('UnsupportedFeatureError', `test.use.${name}`, 'artifact collection is not implemented; use off');
    await use();
  }, { scope: 'worker', auto: true }],
  browser: [async ({ _validateWorkerOptions, headless, launchOptions }, use) => {
    void _validateWorkerOptions;
    const browser = await chromium.launch({ ...launchOptions, headless });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
  baseURL: [async ({}, use) => use(process.env.PLAYWRIGHT_TEST_BASE_URL), { option: true }],
  viewport: [async ({ contextOptions }, use) => use(contextOptions.viewport === undefined ? { width: 1280, height: 720 } : contextOptions.viewport), { option: true }],
  contextOptions: [{}, { option: true }], actionTimeout: [0, { option: true }], navigationTimeout: [0, { option: true }],
  acceptDownloads: [undefined, { option: true }], bypassCSP: [undefined, { option: true }], colorScheme: [undefined, { option: true }],
  clientCertificates: [undefined, { option: true }], deviceScaleFactor: [undefined, { option: true }], extraHTTPHeaders: [undefined, { option: true }],
  geolocation: [undefined, { option: true }], hasTouch: [undefined, { option: true }], httpCredentials: [undefined, { option: true }],
  ignoreHTTPSErrors: [undefined, { option: true }], isMobile: [undefined, { option: true }], javaScriptEnabled: [undefined, { option: true }],
  locale: [undefined, { option: true }], offline: [undefined, { option: true }], permissions: [undefined, { option: true }],
  proxy: [undefined, { option: true }], storageState: [undefined, { option: true }], timezoneId: [undefined, { option: true }],
  userAgent: [undefined, { option: true }], serviceWorkers: [undefined, { option: true }], testIdAttribute: ['data-testid', { option: true }],
  _validateContextOptions: [async ({ acceptDownloads, bypassCSP, colorScheme, clientCertificates, deviceScaleFactor, extraHTTPHeaders, geolocation, hasTouch, httpCredentials, ignoreHTTPSErrors, isMobile, javaScriptEnabled, locale, offline, permissions, proxy, storageState, timezoneId, userAgent, serviceWorkers, testIdAttribute }, use) => {
    unsupportedOptions({ acceptDownloads, bypassCSP, colorScheme, clientCertificates, deviceScaleFactor, extraHTTPHeaders, geolocation, hasTouch, httpCredentials, ignoreHTTPSErrors, isMobile, javaScriptEnabled, locale, offline, permissions, proxy, storageState, timezoneId, userAgent, serviceWorkers });
    if (testIdAttribute !== 'data-testid') throw failure('UnsupportedFeatureError', 'test.use.testIdAttribute', 'custom test-ID attributes are not implemented');
    await use();
  }, { auto: true }],
  context: async ({ _validateContextOptions, browser, contextOptions, viewport, baseURL, actionTimeout, navigationTimeout }, use) => {
    void _validateContextOptions;
    const context = await browser.newContext({ ...contextOptions, viewport, ...(baseURL === undefined ? {} : { baseURL }) });
    context.setDefaultTimeout(actionTimeout); context.setDefaultNavigationTimeout(navigationTimeout);
    try { await use(context); } finally { await context.close(); }
  },
  page: async ({ context }, use) => { const page = await context.newPage(); await use(page); },
});
export default test;
