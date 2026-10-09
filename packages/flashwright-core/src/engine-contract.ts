export const requiredCapabilities = [
  'browser.launch', 'browser.close', 'browser.newContext', 'browser.newContext.deviceEmulation', 'context.newPage', 'context.close',
  'browser.newContext.ignoreHTTPSErrors', 'browser.newContext.javaScriptEnabled',
  'page.addInitScript', 'context.addInitScript', 'initScript.dispose', 'network.request.references', 'network.routing',
  'page.close', 'page.evaluate', 'page.event.pageerror', 'page.screenshot', 'page.goto', 'page.reload', 'page.goBack', 'page.goForward', 'page.waitForLoadState', 'response.body', 'response.body.occurrence', 'request.postData.bytes', 'network.headers',
  'page.navigation.capture', 'page.navigation.next', 'page.navigation.complete',
  'page.fileChooser.subscribe', 'page.console.subscribe', 'context.console.subscribe',
  'context.trace.start', 'context.trace.pull', 'context.trace.stop',
  'context.trace.filmstrip.clock',
  'context.trace.filmstrip.activity',
  'context.trace.filmstrip.pull',
  'context.trace.filmstrip.start',
  'context.trace.filmstrip.seal',
  'context.trace.filmstrip.dispose',
  'context.trace.filmstrip.take',
  'locator.run', 'assertion.run', 'keyboard.press', 'keyboard.type',
  'frame.waitForSelector',
  'frame.setInputFiles', 'elementHandle.setInputFiles',
  'elementHandle.selectText', 'elementHandle.scrollIntoViewIfNeeded',
  'page.evaluateHandle', 'frame.evaluate', 'frame.evaluateHandle', 'handle.evaluate', 'handle.evaluateHandle',
  'handle.jsonValue', 'handle.getProperty', 'handle.getProperties', 'handle.dispose', 'handle.discard',
  'context.cookies', 'context.addCookies', 'context.clearCookies', 'context.storageState',
];

export const engineHandshake = {
  packageVersion: '0.0.0', protocolVersion: 6, capabilityInventoryVersion: 1,
  limits: { controlFrameBytes: 8 * 1024 * 1024, pendingOperations: 1024, queuedMessages: 128, valueDepth: 64, valueNodes: 100000, binaryAttachmentBytes: 32 * 1024 * 1024, pendingAttachments: 2 },
};
