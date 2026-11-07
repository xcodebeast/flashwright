/**
 * Detect Electron renderer / nwjs process, which is node, but we should
 * treat as a browser.
 */

module.exports = require('./node.js');
