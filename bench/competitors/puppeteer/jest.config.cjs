module.exports = {
  preset: 'jest-puppeteer',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Plain CommonJS tests: no Babel transform.
  transform: {},
  testTimeout: 30000,
};
