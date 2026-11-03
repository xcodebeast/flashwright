const { defineConfig } = require('cypress');

module.exports = defineConfig({
  video: false,
  screenshotOnRunFailure: false,
  retries: 0,
  viewportWidth: 1280,
  viewportHeight: 720,
  // type() waits 10 ms after each keystroke by default; 0 types as fast as Cypress can.
  keystrokeDelay: 0,
  reporter: 'dot',
  e2e: {
    specPattern: 'tests/**/*.cy.js',
    supportFile: false,
    expose: { APP_URL: process.env.APP_URL },
  },
});
