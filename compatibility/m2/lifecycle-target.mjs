/** Own a CDP target outside the reference driver's context map. Its normal focus
 * emulation keeps pages visible and prevents Chromium from actually freezing.
 * This target is only for lifecycle fault injection, never a performance sample. */
export async function createLifecycleTarget(browser) {
  const control = await browser.newBrowserCDPSession();
  const { browserContextId } = await control.send('Target.createBrowserContext', { disposeOnDetach: true });
  const pending = new Map();
  let identifier = 0;
  let sessionId;
  const receive = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const completion = pending.get(message.id);
    if (!completion) return;
    pending.delete(message.id);
    if (message.error) completion.reject(new Error(JSON.stringify(message.error)));
    else completion.resolve(message.result);
  };
  control.on('Target.receivedMessageFromTarget', receive);

  async function send(method, parameters = {}) {
    const requestId = ++identifier;
    let completion;
    const result = new Promise((resolve, reject) => { completion = { resolve, reject }; });
    pending.set(requestId, completion);
    control.send('Target.sendMessageToTarget', {
      sessionId, message: JSON.stringify({ id: requestId, method, params: parameters }),
    }).catch(error => {
      if (pending.delete(requestId)) completion.reject(error);
    });
    return result;
  }

  async function close() {
    try { await control.send('Target.disposeBrowserContext', { browserContextId }); }
    finally {
      control.off('Target.receivedMessageFromTarget', receive);
      for (const completion of pending.values()) completion.reject(new Error('Lifecycle target closed'));
      pending.clear();
      await control.detach();
    }
  }

  try {
    const { targetId } = await control.send('Target.createTarget', { url: 'about:blank', browserContextId });
    ({ sessionId } = await control.send('Target.attachToTarget', { targetId, flatten: false }));
    await send('Runtime.runIfWaitingForDebugger');
    return { send, close };
  } catch (error) {
    await close();
    throw error;
  }
}
