module.exports = {
  launch: {
    executablePath: process.env.CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1280, height: 720 },
  },
  // A new incognito context, and so empty localStorage, for every test file.
  browserContext: 'incognito',
};
