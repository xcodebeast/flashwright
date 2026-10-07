/* The browser boundary for locator operations. This file executes only in an isolated realm. */
function createLocatorRuntime(injected, codec, { conditionInstrumentation = false } = {}) {
  const succeeded = value => ({ status: 'success', value: codec.encode(value) });
  const retry = reason => ({ status: 'retry', reason: codec.encode(String(reason)) });
  const pointerAttempts = new Map();
  const completedPointers = new Map();
  const conditions = createConditionRegistry({ instrumentation: conditionInstrumentation });
  const decodeRequest = units => JSON.parse(units.map(unit => String.fromCharCode(unit)).join(''));
  const expired = deadline => deadline !== null && Date.now() >= deadline;

  function cleanupPointer(token) {
    completedPointers.delete(token);
    const attempt = pointerAttempts.get(token);
    if (!attempt) return;
    pointerAttempts.delete(token);
    clearTimeout(attempt.completionTimer);
    clearTimeout(attempt.expiryTimer);
    attempt.cancelStability?.();
    attempt.guard?.stop();
  }

  /** Two fresh animation-frame samples, with explicit cancellation of the pending callback. */
  function checkStability(attempt) {
    return new Promise((resolve, reject) => {
      let previous;
      let animationFrame;
      const finish = result => { cancelAnimationFrame(animationFrame); attempt.cancelStability = undefined; resolve(result); };
      attempt.cancelStability = () => finish('error:cancelled');
      const sample = () => {
        try {
          if (expired(attempt.deadline)) return finish('error:expired');
          const element = injected.retarget(attempt.element, 'no-follow-label');
          if (!element || !element.isConnected) return finish('error:notconnected');
          const rectangle = element.getBoundingClientRect();
          const current = { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height };
          if (previous) return finish(Object.keys(current).every(key => current[key] === previous[key]) ? 'done' : 'error:unstable');
          previous = current;
          animationFrame = requestAnimationFrame(sample);
        } catch (error) { cancelAnimationFrame(animationFrame); attempt.cancelStability = undefined; reject(error); }
      };
      animationFrame = requestAnimationFrame(sample);
    });
  }

  async function preparePointer(units, deadline, token, settings) {
    if (expired(deadline)) return { status: 'expired' };
    const request = { selector: decodeRequest(units).selector, ...settings, checked: settings.checked ?? undefined };
    const element = injected.querySelector(injected.parseSelector(request.selector), document, true);
    if (!element) return retry('locator resolved to no elements');
    if (request.checked !== undefined) {
      const state = injected.elementState(element, 'checked');
      if (state.received === 'error:notconnected') return retry('element detached');
      if (state.matches === request.checked) return succeeded(undefined);
      if (state.isRadio && !request.checked) throw new Error('Cannot uncheck radio button. Radio buttons can only be unchecked by selecting another radio button in the same group.');
    }
    if (pointerAttempts.size >= 16) throw new Error('Too many retained pointer attempts');
    const attempt = { element, request, deadline };
    pointerAttempts.set(token, attempt);
    if (deadline !== null) attempt.expiryTimer = setTimeout(() => cleanupPointer(token), Math.max(0, Math.min(deadline - Date.now(), 2147483647)));
    if (!request.force) {
      const stable = await checkStability(attempt);
      if (stable !== 'done') { cleanupPointer(token); return retry(stable); }
      const states = request.action === 'hover' ? ['visible'] : ['visible', 'enabled'];
      const result = await injected.checkElementStates(element, states);
      if (result) { cleanupPointer(token); return actionResult(result); }
    }
    if (pointerAttempts.get(token) !== attempt || expired(deadline)) { cleanupPointer(token); return { status: 'expired' }; }
    return { status: 'ready' };
  }

  function pointerElement(token) {
    const attempt = pointerAttempts.get(token);
    return attempt && !expired(attempt.deadline) && attempt.element.isConnected ? attempt.element : null;
  }

  async function armPointer(token, point) {
    const attempt = pointerAttempts.get(token);
    if (!attempt || !pointerElement(token)) return retry('element detached or attempt expired');
    if (!attempt.request.force) {
      const states = attempt.request.action === 'hover' ? ['visible'] : ['visible', 'enabled'];
      const result = await injected.checkElementStates(attempt.element, states);
      if (result) return actionResult(result);
    }
    if (pointerAttempts.get(token) !== attempt || expired(attempt.deadline)) return { status: 'expired' };
    const guard = attempt.request.force ? { stop: () => 'done' } : injected.setupHitTargetInterceptor(attempt.element, attempt.request.action === 'hover' ? 'hover' : 'mouse', point ?? undefined, !!attempt.request.trial);
    if (typeof guard !== 'object') return retry(guard);
    const original = injected._hitTargetInterceptor;
    let releases = 0;
    const count = attempt.request.action === 'dblclick' ? 2 : attempt.request.clickCount ?? 1;
    // This pinned hook runs even when the hit guard stops immediate propagation. Complete
    // after the final native input task so provisional navigation cannot strand a guard.
    const interceptor = event => {
      original?.(event);
      if (!event.isTrusted) return;
      const finished = attempt.request.action === 'hover' ? event.type === 'mousemove' : event.type === 'pointerup' && ++releases >= count;
      if (!finished || attempt.completionTimer !== undefined) return;
      attempt.completionTimer = setTimeout(() => {
        let result;
        try { result = finishPointer(token); }
        catch (error) { result = { status: 'error', message: codec.encode(String(error && error.stack || error)) }; }
        cleanupPointer(token);
        completedPointers.set(token, result);
        if (completedPointers.size > 128) completedPointers.delete(completedPointers.keys().next().value);
      }, 0);
    };
    injected._hitTargetInterceptor = interceptor;
    attempt.guard = { stop() {
      if (injected._hitTargetInterceptor === interceptor) injected._hitTargetInterceptor = original;
      return guard.stop();
    } };
    return { status: 'ready' };
  }

  function finishPointer(token) {
    if (completedPointers.has(token)) return completedPointers.get(token);
    const attempt = pointerAttempts.get(token);
    if (!attempt) return { status: 'expired' };
    const result = attempt.guard?.stop() ?? 'done';
    attempt.guard = undefined;
    if (result !== 'done') return retry(result.hitTargetDescription ?? result);
    if (attempt.request.checked !== undefined && !attempt.request.trial) {
      const state = injected.elementState(attempt.element, 'checked');
      if (state.received === 'error:notconnected') return retry('element detached');
      if (state.matches !== attempt.request.checked) throw new Error('Clicking the checkbox did not change its state');
    }
    return succeeded(undefined);
  }

  async function safely(work) {
    try { return await work(); }
    catch (error) { return { status: 'error', message: codec.encode(String(error && error.stack || error)) }; }
  }

  function prepareAssertion(units, expression, isNot) {
    const options = { ...decodeRequest(units), expression, isNot };
    return { options, selector: options.selector === null ? null : injected.parseSelector(options.selector) };
  }

  async function observeAssertion({ options, selector }) {
    const expression = options.expression;
    let elements = [];
    let element;
    if (selector !== null) {
      const multiple = expression === 'to.have.count' || expression.endsWith('.array');
      if (multiple) elements = injected.querySelectorAll(selector, document);
      else element = injected.querySelector(selector, document, true);
    }
    const result = await injected._expectCore(element, options, elements);
    let truncated = false;
    let diagnosticUnits = 16384;
    const bound = value => {
      if (typeof value === 'string') {
        const length = Math.min(value.length, 4096, diagnosticUnits); diagnosticUnits -= length;
        // Keep the source ASCII: the pinned browser loads the combined runtime faster.
        if (length < value.length) { truncated = true; return value.slice(0, length) + '\u2026 [diagnostic truncated]'; }
        return value;
      }
      if (Array.isArray(value)) {
        if (value.length > 100) truncated = true;
        return value.slice(0, 100).map(bound);
      }
      return value;
    };
    return { status: 'observation', matches: result.matches, missingReceived: !!result.missingReceived, received: codec.encode(bound(result.received)), diagnosticTruncated: truncated };
  }

  function assertion(units, deadline, expression, isNot) {
    if (expired(deadline)) return { status: 'expired' };
    return observeAssertion(prepareAssertion(units, expression, isNot));
  }

  async function waitForAssertion(units, deadline, expression, isNot, token) {
    if (expired(deadline)) return { status: 'expired', observation: null };
    const descriptor = prepareAssertion(units, expression, isNot);
    const result = await conditions.wait({
      token, isNot, timeoutMilliseconds: deadline === null ? null : Math.max(0, deadline - Date.now()),
      check: () => safely(() => observeAssertion(descriptor)),
    });
    if (conditionInstrumentation && result.observation) result.observation.conditionMetrics = conditions.inspect();
    return result;
  }

  function readElement(element, request) {
    switch (request.action) {
      case 'textContent': return element.textContent;
      case 'innerText':
        if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') throw new Error('Node is not an HTMLElement');
        return element.innerText;
      case 'innerHTML': return element.innerHTML;
      case 'getAttribute': return element.getAttribute(request.name);
      case 'inputValue': {
        const control = injected.retarget(element, 'follow-label');
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(control?.nodeName)) throw new Error('Node is not an <input>, <textarea> or <select> element');
        return control.value;
      }
      default: return injected.elementState(element, request.state).matches;
    }
  }

  function actionResult(result) {
    if (result === 'done') return succeeded(undefined);
    return retry(typeof result === 'string' ? result : `element is not ${result.missingState}`);
  }

  async function run(request, deadline) {
    const expired = () => deadline !== null && Date.now() >= deadline;
    if (expired()) return { status: 'expired' };
    const selector = injected.parseSelector(request.selector);
    if (['count', 'allTextContents', 'allInnerTexts'].includes(request.action)) {
      const elements = injected.querySelectorAll(selector, document);
      if (request.action === 'count') return succeeded(elements.length);
      return succeeded(elements.map(element => request.action === 'allTextContents' ? element.textContent || '' : element.innerText));
    }
    const element = injected.querySelector(selector, document, true);
    if (request.action === 'waitFor') {
      const visible = !!element && injected.elementState(element, 'visible').matches;
      const matches = request.state === 'attached' ? !!element : request.state === 'detached' ? !element : request.state === 'visible' ? visible : !visible;
      return matches ? succeeded(undefined) : retry(`waiting for ${request.state}`);
    }
    if (!element) {
      if (request.action === 'isVisible') return succeeded(false);
      if (request.action === 'isHidden') return succeeded(true);
      return retry('locator resolved to no elements');
    }
    if (request.action === 'focus') return actionResult(injected.focusNode(element, false));
    if (request.action === 'blur') return actionResult(injected.blurNode(element));
    if (request.action === 'fill' || request.action === 'selectOption') {
      if (!request.force) {
        const states = request.action === 'fill' ? ['visible', 'enabled', 'editable'] : ['visible', 'enabled'];
        const result = await injected.checkElementStates(element, states);
        if (result) return actionResult(result);
      }
      if (expired()) return { status: 'expired' };
      if (request.action === 'fill') {
        const result = injected.fill(element, request.value);
        if (result === 'needsinput') return { status: 'needsinput', textUnits: codec.encode(request.value).units };
        return actionResult(result);
      }
      const result = injected.selectOptions(element, request.values);
      return Array.isArray(result) ? succeeded(result) : actionResult(result);
    }
    return succeeded(readElement(element, request));
  }

  return {
    assertion: (units, deadline, expression, isNot) => safely(() => assertion(units, deadline, expression, isNot)),
    waitForAssertion: (units, deadline, expression, isNot, token) => safely(() => waitForAssertion(units, deadline, expression, isNot, token)),
    cancelAssertion(token) {
      const result = conditions.cancel(token);
      if (conditionInstrumentation && result?.observation) result.observation.conditionMetrics = conditions.inspect();
      return result;
    },
    run: (requestUnits, deadline) => safely(() => run(decodeRequest(requestUnits), deadline)),
    prepareKeyboard: (units, deadline) => safely(() => {
      if (expired(deadline)) return { status: 'expired' };
      const element = injected.querySelector(injected.parseSelector(decodeRequest(units).selector), document, true);
      if (!element) return retry('locator resolved to no elements');
      return actionResult(injected.focusNode(element, true));
    }),
    preparePointer: (units, deadline, token, settings) => safely(() => preparePointer(units, deadline, token, settings)),
    armPointer: (token, point) => safely(() => armPointer(token, point)),
    finishPointer: token => safely(() => finishPointer(token)),
    cleanupPointer,
    pointerElement,
    scrollPointer(token, alignment) { pointerElement(token)?.scrollIntoView({ block: alignment, inline: alignment }); },
    border(token) { const element = pointerElement(token); return element ? injected.getElementBorderWidth(element) : null; },
    viewport() { return { width: innerWidth, height: innerHeight }; },
    framePoint(element, point) {
      const style = injected.describeIFrameStyle(element);
      if (style === 'transformed') return { status: 'transformed' };
      if (style === 'error:notconnected') return retry(style);
      const hit = injected.expectHitTarget(point, element);
      if (hit !== 'done') return retry(hit.hitTargetDescription);
      const rectangle = element.getBoundingClientRect();
      return { status: 'ready', point: { x: point.x - rectangle.x - style.left, y: point.y - rectangle.y - style.top } };
    },
  };
}
