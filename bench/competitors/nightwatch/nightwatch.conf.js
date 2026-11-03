const workers = Number(process.env.WORKERS);

module.exports = {
  src_folders: ['tests'],
  output_folder: false,
  usage_analytics: { enabled: false },
  disable_output_boxes: true,
  detailed_output: false,
  test_workers: workers > 1 ? { enabled: true, workers } : false,
  webdriver: {
    start_process: true,
    server_path: process.env.CHROMEDRIVER_PATH,
    log_path: false,
  },
  test_settings: {
    default: {
      screenshots: { enabled: false },
      desiredCapabilities: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          binary: process.env.CHROME_PATH,
          args: ['--headless=new', '--window-size=1280,720'],
        },
      },
      globals: { waitForConditionTimeout: 5000 },
    },
  },
};
