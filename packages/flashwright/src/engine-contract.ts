export const requiredCapabilities = [
  'browser.launch', 'browser.close', 'browser.newContext', 'context.newPage', 'context.close',
  'page.close', 'page.evaluate', 'page.event.pageerror', 'page.screenshot', 'page.goto', 'page.waitForLoadState', 'response.body',
  'page.console.subscribe', 'context.console.subscribe',
  'locator.run', 'assertion.run', 'keyboard.press',
  'page.evaluateHandle', 'frame.evaluate', 'frame.evaluateHandle', 'handle.evaluate', 'handle.evaluateHandle',
  'handle.jsonValue', 'handle.getProperty', 'handle.getProperties', 'handle.dispose', 'handle.discard',
  'context.cookies', 'context.addCookies', 'context.clearCookies', 'context.storageState',
];

export const engineHandshake = {
  packageVersion: '0.0.0', protocolVersion: 5, capabilityInventoryVersion: 1,
  limits: { controlFrameBytes: 8 * 1024 * 1024, pendingOperations: 1024, queuedMessages: 128, valueDepth: 64, valueNodes: 100000, binaryAttachmentBytes: 32 * 1024 * 1024, pendingAttachments: 2 },
};
