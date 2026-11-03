export const config = {
  runner: 'local',
  specs: ['./tests/**/*.spec.js'],
  maxInstances: Number(process.env.WORKERS),
  capabilities: [{
    browserName: 'chrome',
    'goog:chromeOptions': {
      binary: process.env.CHROME_PATH,
      args: ['--headless=new', '--window-size=1280,720'],
    },
    'wdio:chromedriverOptions': { binary: process.env.CHROMEDRIVER_PATH },
    // WebdriverIO opens a WebDriver BiDi connection by default; WDIO_CLASSIC=1 measures without.
    ...(process.env.WDIO_CLASSIC === '1' && { 'wdio:enforceWebDriverClassic': true }),
  }],
  logLevel: 'error',
  bail: 0,
  waitforTimeout: 5000,
  connectionRetryCount: 0,
  framework: 'mocha',
  reporters: ['dot'],
  mochaOpts: { ui: 'bdd', timeout: 30000 },
};
