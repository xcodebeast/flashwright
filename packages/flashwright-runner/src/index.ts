import { upstreamRequire, runnerHooks } from './upstream-runtime.js';
import type * as PinnedRunner from 'flashwright-upstream-runner/test';
import { runnerIntegration } from '@flashwright/core/runner-integration';
import { chromium, failure, type Browser, type BrowserContext, type Page, type LaunchOptions, type BrowserContextOptions, type ViewportSize } from '@flashwright/core';
import type { PlaywrightTestOptions, PlaywrightWorkerOptions, ExpectMatcherState } from 'flashwright-upstream-runner/test';
import { matchers } from './matchers.js';
import { screenshotPolicy } from './screenshot-policy.js';
import { validateTracePolicy } from './trace-policy.js';
import type { ScreenshotScopes } from './screenshot-recorder.js';
import { RunnerArtifactCoordinator } from './runner-artifact-coordinator.js';
import { discardDisabledRunnerTrace } from './runner-trace-off.js';

const upstream: typeof PinnedRunner = upstreamRequire('./test.js');
const artifacts = new RunnerArtifactCoordinator();

// The pinned runner's transformed files need its map registry, even when Bun
// exposes structured call sites independently of Error.prepareStackTrace.
const { sourceMapSupport } = upstreamRequire('playwright-core/lib/utilsBundle') as { sourceMapSupport: { mapSourcePosition: Parameters<typeof runnerIntegration.installSourcePositionMapper>[1] } };
runnerIntegration.installSourcePositionMapper(1, position => sourceMapSupport.mapSourcePosition(position));
runnerHooks.installTraceStart((testInfo, policy) => {
  try { validateTracePolicy(policy); }
  catch (error) { artifacts.start(testInfo, { error }); throw error; }
  return artifacts.start(testInfo);
});

export type { TestInfo, WorkerInfo, TestType, Fixtures, FullConfig, FullProject, PlaywrightTestConfig, ExpectMatcherState, MatcherReturnType } from 'flashwright-upstream-runner/test';
export type { Browser, BrowserContext, Page, Locator, Dialog } from '@flashwright/core';
export { errors } from '@flashwright/core';
export const defineConfig = upstream.defineConfig;
export { devices } from '@flashwright/core';

function unsupportedOptions(options: object): void {
  for (const [name, value] of Object.entries(options)) if (value !== undefined) throw failure('UnsupportedFeatureError', `test.use.${name}`, 'option is not implemented by the Flashwright development runner');
}
function unsupportedMatcher(name: string) {
  return async function(this: ExpectMatcherState, _actual: unknown, ..._arguments: unknown[]): Promise<never> { throw failure('UnsupportedFeatureError', `expect.${name}`, 'browser matcher is not implemented by Flashwright'); };
}
export const expect = upstream.expect.extend({}).extend({
  ...matchers,
  toBeInViewport: unsupportedMatcher('toBeInViewport'), toBeOK: unsupportedMatcher('toBeOK'),
  toHaveJSProperty: unsupportedMatcher('toHaveJSProperty'),
  toHaveScreenshot: unsupportedMatcher('toHaveScreenshot'),
  toMatchAriaSnapshot: unsupportedMatcher('toMatchAriaSnapshot'),
});

type WorkerFixtures = Omit<PlaywrightWorkerOptions, 'launchOptions'> & { browser: Browser; launchOptions: LaunchOptions; _workerArtifacts: void; _validateWorkerOptions: void; _screenshotScopes: ScreenshotScopes | undefined };
type TestFixtures = Partial<Omit<PlaywrightTestOptions, 'contextOptions' | 'viewport' | 'actionTimeout' | 'navigationTimeout'>> & {
  page: Page; context: BrowserContext; contextOptions: BrowserContextOptions; viewport: ViewportSize | null;
  actionTimeout: number; navigationTimeout: number; _validateContextOptions: void;
  _combinedContextOptions: BrowserContextOptions; _setupRunnerContextDefaults: void; _setupRunnerScreenshots: void; _testArtifacts: void;
};

/** The version-pinned root runner provides scheduling; every browser fixture below is ours. */
export const test = upstream._baseTest.extend<TestFixtures, WorkerFixtures>({
  // These zero-dependency fixtures must precede options and other automatic fixtures.
  _workerArtifacts: [async ({}, use) => {
    discardDisabledRunnerTrace();
    await artifacts.ready();
    try { await use(); } finally { await artifacts.dispose(); }
  }, { scope: 'worker', auto: true, timeout: 0 }],
  _testArtifacts: [async ({}, use, testInfo) => {
    discardDisabledRunnerTrace(testInfo);
    await artifacts.ready();
    await use();
  }, { auto: 'all-hooks-included' as unknown as boolean, timeout: 0 }],
  defaultBrowserType: ['chromium', { scope: 'worker', option: true }],
  browserName: [async ({ defaultBrowserType }, use) => use(defaultBrowserType), { scope: 'worker', option: true }],
  headless: [async ({ launchOptions }, use) => use(launchOptions.headless ?? true), { scope: 'worker', option: true }],
  channel: [undefined, { scope: 'worker', option: true }],
  launchOptions: [{}, { scope: 'worker', option: true }],
  connectOptions: [undefined, { scope: 'worker', option: true }],
  screenshot: ['off', { scope: 'worker', option: true }],
  trace: ['off', { scope: 'worker', option: true }],
  video: ['off', { scope: 'worker', option: true }],
  _validateWorkerOptions: [async ({ browserName, defaultBrowserType, channel, connectOptions, screenshot, video }, use) => {
    if (browserName !== 'chromium' || defaultBrowserType !== 'chromium') throw failure('UnsupportedFeatureError', 'test.use.browserName', 'only the pinned Chromium is implemented');
    unsupportedOptions({ channel, connectOptions });
    screenshotPolicy(screenshot);
    if (video !== 'off') throw failure('UnsupportedFeatureError', 'test.use.video', 'video collection is not implemented; use off');
    await use();
  }, { scope: 'worker', auto: true }],
  _screenshotScopes: [async ({ _validateWorkerOptions, screenshot }, use) => {
    void _validateWorkerOptions;
    const scopes = artifacts.configureScreenshots(screenshotPolicy(screenshot));
    await artifacts.ready();
    await use(scopes);
  }, { scope: 'worker', auto: true, timeout: 0 }],
  _setupRunnerScreenshots: [async ({ _screenshotScopes }, use, testInfo) => {
    if (!_screenshotScopes) { await use(); return; }
    const recorder = _screenshotScopes.start(testInfo);
    try { await use(); } finally { await _screenshotScopes.finish(recorder); }
  }, { auto: 'all-hooks-included' as unknown as boolean, timeout: 0 }],
  browser: [async ({ _validateWorkerOptions, headless, launchOptions }, use) => {
    void _validateWorkerOptions;
    const browser = await chromium.launch({ ...launchOptions, headless });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
  baseURL: [async ({}, use) => use(process.env.PLAYWRIGHT_TEST_BASE_URL), { option: true }],
  viewport: [async ({ contextOptions }, use) => use(contextOptions.viewport === undefined ? { width: 1280, height: 720 } : contextOptions.viewport), { option: true }],
  contextOptions: [{}, { option: true }], actionTimeout: [0, { option: true }], navigationTimeout: [0, { option: true }],
  acceptDownloads: [undefined, { option: true }], bypassCSP: [undefined, { option: true }], colorScheme: [undefined, { option: true }],
  clientCertificates: [undefined, { option: true }], deviceScaleFactor: [async ({ contextOptions }, use) => use(contextOptions.deviceScaleFactor), { option: true }], extraHTTPHeaders: [undefined, { option: true }],
  geolocation: [undefined, { option: true }], hasTouch: [async ({ contextOptions }, use) => use(contextOptions.hasTouch), { option: true }], httpCredentials: [undefined, { option: true }],
  ignoreHTTPSErrors: [async ({ contextOptions }, use) => use(contextOptions.ignoreHTTPSErrors), { option: true }], isMobile: [async ({ contextOptions }, use) => use(contextOptions.isMobile), { option: true }], javaScriptEnabled: [async ({ contextOptions }, use) => use(contextOptions.javaScriptEnabled), { option: true }],
  locale: [undefined, { option: true }], offline: [undefined, { option: true }], permissions: [undefined, { option: true }],
  proxy: [undefined, { option: true }], storageState: [async ({ contextOptions }, use) => use(contextOptions.storageState), { option: true }], timezoneId: [undefined, { option: true }],
  userAgent: [async ({ contextOptions }, use) => use(contextOptions.userAgent), { option: true }], serviceWorkers: [undefined, { option: true }], testIdAttribute: ['data-testid', { option: true }],
  _validateContextOptions: [async ({ acceptDownloads, bypassCSP, colorScheme, clientCertificates, extraHTTPHeaders, geolocation, httpCredentials, locale, offline, permissions, proxy, timezoneId, serviceWorkers, testIdAttribute }, use) => {
    unsupportedOptions({ acceptDownloads, bypassCSP, colorScheme, clientCertificates, extraHTTPHeaders, geolocation, httpCredentials, locale, offline, permissions, proxy, timezoneId, serviceWorkers });
    if (testIdAttribute !== 'data-testid') throw failure('UnsupportedFeatureError', 'test.use.testIdAttribute', 'custom test-ID attributes are not implemented');
    await use();
  }, { auto: true }],
  _combinedContextOptions: async ({ _validateContextOptions, contextOptions, viewport, baseURL, storageState, userAgent, deviceScaleFactor, isMobile, hasTouch, ignoreHTTPSErrors, javaScriptEnabled }, use) => {
    void _validateContextOptions;
    await use({
      ...contextOptions, viewport,
      ...(userAgent === undefined ? {} : { userAgent }),
      ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
      ...(isMobile === undefined ? {} : { isMobile }),
      ...(hasTouch === undefined ? {} : { hasTouch }),
      ...(ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors }),
      ...(javaScriptEnabled === undefined ? {} : { javaScriptEnabled }),
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(storageState === undefined ? {} : { storageState }),
    });
  },
  _setupRunnerContextDefaults: [async ({ _combinedContextOptions, actionTimeout, navigationTimeout, _setupRunnerScreenshots }, use) => {
    void _setupRunnerScreenshots;
    const restore = runnerIntegration.installContextDefaults(1, { contextOptions: _combinedContextOptions, actionTimeout, navigationTimeout });
    try { await use(); } finally { restore(); }
  // Pinned runner integration: its private all-hooks mode is absent from the public fixture type.
  }, { auto: 'all-hooks-included' as unknown as boolean }],
  context: async ({ _setupRunnerContextDefaults, browser }, use) => {
    void _setupRunnerContextDefaults;
    const context = await browser.newContext();
    try { await use(context); } finally { await context.close(); }
  },
  page: async ({ context }, use) => { const page = await context.newPage(); await use(page); },
});
export default test;
