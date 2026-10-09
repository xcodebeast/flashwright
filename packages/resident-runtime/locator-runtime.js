/* The browser boundary for locator operations. This file executes only in an isolated realm. */
function createLocatorRuntime(injected, codec, { conditionInstrumentation = false, selectorBatchCache = true } = {}) {
  const succeeded = value => ({ status: 'success', value: codec.encode(value) });
  const retry = reason => ({ status: 'retry', reason: codec.encode(String(reason)) });
  const pointerAttempts = new Map();
  const completedPointers = new Map();
  const elementActions = new Map();
  let selectorPrefixes;
  const conditions = createConditionRegistry({ instrumentation: conditionInstrumentation,
    runSynchronousBatch: selectorBatchCache ? runReadOnlyAssertionBatch : undefined });
  // Optimization eligibility is separate from API support: additions stay uncached until reviewed.
  const readOnlyAssertions = new Set(['to.have.text', 'to.have.text.array', 'to.contain.text.array', 'to.have.count',
    'to.be.visible', 'to.be.hidden', 'to.be.enabled', 'to.be.disabled', 'to.be.checked', 'to.be.attached', 'to.be.detached',
    'to.be.editable', 'to.be.readonly', 'to.be.empty', 'to.be.focused', 'to.have.value', 'to.have.url', 'to.have.title',
    'to.have.attribute', 'to.have.attribute.value']);
  const readOnlySelectorEngines = new Set(['css', 'xpath', 'xpath:light', 'role', 'text', 'text:light', 'id', 'id:light',
    'data-testid', 'data-testid:light', 'data-test-id', 'data-test-id:light', 'data-test', 'data-test:light', 'nth', 'visible',
    'internal:has', 'internal:has-not', 'internal:and', 'internal:or', 'internal:chain', 'internal:label', 'internal:text',
    'internal:has-text', 'internal:has-not-text', 'internal:attr', 'internal:testid', 'internal:role', 'internal:describe', 'aria-ref']);
  const decodeRequest = units => JSON.parse(units.map(unit => String.fromCharCode(unit)).join(''));
  const expired = deadline => deadline !== null && Date.now() >= deadline;

  /** Supported assertions only read the isolated DOM. Share the pinned evaluator's
   * selector work until this synchronous stack returns, never across await or a
   * browser task. Full predicates still run independently with their own reads. */
  function runReadOnlyAssertionBatch(callback) {
    const previousPrefixes = selectorPrefixes;
    selectorPrefixes = new Map();
    injected._evaluator.begin();
    try { callback(); }
    finally {
      injected._evaluator.end();
      selectorPrefixes.clear();
      selectorPrefixes = previousPrefixes;
    }
  }

  function inspectAssertionConditions() {
    return { ...conditions.inspect(), cachedSelectorPrefixes: selectorPrefixes?.size ?? 0, selectorBatchActive: selectorPrefixes !== undefined };
  }

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

  /** Captured actions never query a replacement, and cancellation owns every pending frame callback. */
  function cancelElementAction(token) {
    const attempt = elementActions.get(token);
    if (!attempt) return false;
    elementActions.delete(token);
    attempt.cancelStability?.();
    return true;
  }

  async function prepareElementAction(element, action, force, deadline, token) {
    if (expired(deadline)) return { status: 'expired' };
    if (elementActions.size >= 16) return { status: 'resourceLimit' };
    const attempt = { element, deadline };
    elementActions.set(token, attempt);
    try {
      if (action === 'scrollIntoViewIfNeeded') {
        const stable = await checkStability(attempt);
        if (stable === 'error:notconnected') return { status: 'detached' };
        if (['error:expired', 'error:cancelled'].includes(stable)) return { status: 'expired' };
        if (stable !== 'done') return actionResult(stable);
        return expired(deadline) ? { status: 'expired' } : { status: 'ready' };
      }
      if (action !== 'selectText') throw new Error('Unknown captured element action');
      if (!force) {
        const result = await injected.checkElementStates(element, ['visible']);
        if (result === 'error:notconnected') return { status: 'detached' };
        if (result) return actionResult(result);
      }
      if (expired(deadline)) return { status: 'expired' };
      const selected = injected.selectText(element);
      return selected === 'error:notconnected' ? { status: 'detached' } : actionResult(selected);
    } finally { cancelElementAction(token); }
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

  function prepareAssertion(units, expression, isNot, prepareSelectorPrefix = false) {
    const options = { ...decodeRequest(units), expression, isNot };
    const selector = options.selector === null ? null : injected.parseSelector(options.selector);
    let prefix;
    if (prepareSelectorPrefix && selector?.capture === undefined && selector?.parts.length > 1 && selector.parts.at(-1).name === 'nth') {
      const parts = selector.parts.slice(0, -1);
      prefix = { selector: { parts }, key: JSON.stringify(parts.map(part => [part.name, part.source])), index: Number(selector.parts.at(-1).body) };
      if (readOnlyAssertions.has(expression)) prefix.documentCss = indexedDocumentCss(parts, prefix.index);
    }
    return { options, selector, prefix };
  }

  function isReadOnlySelector(selector) {
    return selector === null || selector.parts.every(part => readOnlySelectorEngines.has(part.name) &&
      (!part.body?.parsed || isReadOnlySelector(part.body.parsed)));
  }

  /** The pinned CSS engine appends shadow matches after document matches for one
   * plain compound. An in-range positive index needs neither a copied match array
   * nor shadow discovery. Other selector forms retain the complete resolver. */
  function indexedDocumentCss(parts, index) {
    if (!Number.isSafeInteger(index) || index < 0 || parts.length !== 1 || parts[0].name !== 'css') return undefined;
    const selectors = parts[0].body;
    if (!Array.isArray(selectors) || selectors.length !== 1 || selectors[0].simples.length !== 1) return undefined;
    const simple = selectors[0].simples[0].selector;
    return simple.functions.length === 0 && simple.css ? simple.css : undefined;
  }

  function queryAssertionPrefix(prefix) {
    let candidates = selectorPrefixes?.get(prefix.key);
    if (!candidates) {
      candidates = {};
      selectorPrefixes?.set(prefix.key, candidates);
    }
    if (!candidates.completeMatches && prefix.documentCss) {
      candidates.documentMatches ??= document.querySelectorAll(prefix.documentCss);
      if (prefix.index < candidates.documentMatches.length) return [candidates.documentMatches[prefix.index]];
    }
    candidates.completeMatches ??= injected.querySelectorAll(prefix.selector, document);
    // Preserve the pinned nth engine's special -1 and native slice behavior.
    const index = prefix.index === -1 ? candidates.completeMatches.length - 1 : prefix.index;
    return candidates.completeMatches.slice(index, index + 1);
  }

  async function observeAssertion({ options, selector, prefix }) {
    const expression = options.expression;
    let elements = [];
    let element;
    if (selector !== null) {
      const multiple = expression === 'to.have.count' || expression.endsWith('.array');
      if (prefix && (selectorPrefixes || prefix.documentCss)) {
        elements = queryAssertionPrefix(prefix);
        element = elements[0];
      } else if (multiple) elements = injected.querySelectorAll(selector, document);
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
    const descriptor = prepareAssertion(units, expression, isNot, selectorBatchCache);
    const result = await conditions.wait({
      token, isNot, timeoutMilliseconds: deadline === null ? null : Math.max(0, deadline - Date.now()),
      canShareSelectorQueries: readOnlyAssertions.has(expression) && isReadOnlySelector(descriptor.selector),
      check: () => safely(() => observeAssertion(descriptor)),
    });
    if (conditionInstrumentation && result.observation) result.observation.conditionMetrics = inspectAssertionConditions();
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

  /** Keep the selected node in its private allocation group until native adoption completes. */
  function resolveElement(selectorUnits, strict, state, deadline) {
    try {
      let value = false;
      if (!expired(deadline)) {
        const selector = codec.decode({ kind: 'string', units: selectorUnits });
        const element = injected.querySelector(injected.parseSelector(selector), document, strict);
        const visible = !!element && injected.elementState(element, 'visible').matches;
        const matches = state === 'attached' ? !!element : state === 'detached' ? !element : state === 'visible' ? visible : !visible;
        if (matches) value = state === 'hidden' || state === 'detached' ? null : element;
      }
      return { outcome: 'success', value };
    } catch (error) {
      return { outcome: 'exception', failure: JSON.stringify({ outcome: 'exception', stage: 'execution', error: codec.describeError(error, false) }) };
    }
  }

  /** Label retargeting preserves captured nodes, including detached file inputs. */
  function resolveFileInput(node, multiple, connected, deadline) {
    try {
      if (expired(deadline)) return { outcome: 'success', value: false };
      const element = injected.retarget(node, 'follow-label');
      if (!element || (connected && !element.isConnected)) return { outcome: 'success', value: false };
      const status = validateFileInput(element, multiple, connected, deadline);
      return { outcome: 'success', value: status === 'ready' ? element : status };
    } catch (error) {
      return { outcome: 'exception', failure: JSON.stringify({ outcome: 'exception', stage: 'execution', error: codec.describeError(error, false) }) };
    }
  }

  /** Validation is repeated in the final renderer task before any file or event mutation. */
  function validateFileInput(element, multiple, connected, deadline) {
    if (expired(deadline)) return 'expired';
    if (connected && !element.isConnected) return 'detached';
    if (element.nodeName !== 'INPUT') throw injected.createStacklessError('Node is not an HTMLInputElement');
    if (element.type !== 'file') throw injected.createStacklessError('Not an input[type=file] element');
    if (element.webkitdirectory) return 'directory';
    if (multiple && !element.multiple) throw injected.createStacklessError('Non-multiple file input can only accept single file');
    return 'ready';
  }

  /** Private staging holds at most one mutable file buffer; completed Files own their bytes. */
  function createFileUpload() { return { files: [], pending: undefined }; }
  function beginUploadFile(upload, name, mimeType, length) {
    if (upload.pending) throw new Error('Upload already has a pending file');
    upload.pending = { name: codec.decode({ kind: 'string', units: name }), mimeType: codec.decode({ kind: 'string', units: mimeType }), bytes: new Uint8Array(length), offset: 0 };
  }
  function appendUploadFile(upload, encoded) {
    const pending = upload.pending;
    const chunk = atob(encoded);
    if (!pending || pending.offset + chunk.length > pending.bytes.length) throw new Error('Invalid upload chunk');
    for (let index = 0; index < chunk.length; index++) pending.bytes[pending.offset + index] = chunk.charCodeAt(index);
    pending.offset += chunk.length;
  }
  function finishUploadFile(upload) {
    const pending = upload.pending;
    if (!pending || pending.offset !== pending.bytes.length) throw new Error('Incomplete upload file');
    upload.files.push(new File([pending.bytes], pending.name, { type: pending.mimeType }));
    upload.pending = undefined;
  }
  function assignFileUpload(element, upload, connected, deadline) {
    const status = validateFileInput(element, upload.files.length > 1, connected, deadline);
    if (status !== 'ready') return status;
    const transfer = new DataTransfer();
    for (const file of upload.files) transfer.items.add(file);
    element.files = transfer.files;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return 'success';
  }

  async function mutationReadiness(element, request) {
    if (!element || element.ownerDocument !== document || !element.isConnected) return 'error:notconnected';
    if (request.force) return undefined;
    const states = request.action === 'fill' ? ['visible', 'enabled', 'editable'] : ['visible', 'enabled'];
    return injected.checkElementStates(element, states);
  }

  /** Capture can await browser work; recheck this retained node immediately before mutation. */
  async function mutateElement(element, request, deadline) {
    if (expired(deadline)) return { status: 'expired' };
    const readiness = await mutationReadiness(element, request);
    if (readiness) return actionResult(readiness);
    if (element.ownerDocument !== document || !element.isConnected) return retry('error:notconnected');
    if (expired(deadline)) return { status: 'expired' };
    if (request.action === 'fill') {
      const result = injected.fill(element, request.value);
      if (result === 'needsinput') return { status: 'needsinput', textUnits: codec.encode(request.value).units };
      return actionResult(result);
    }
    const result = injected.selectOptions(element, request.values);
    return Array.isArray(result) ? succeeded(result) : actionResult(result);
  }

  /** The action owns this selector result; later snapshot work cannot resolve a replacement. */
  async function resolveMutationElement(units, deadline) {
    try {
      if (expired(deadline)) return { outcome: 'success', value: false };
      const request = decodeRequest(units);
      const element = injected.querySelector(injected.parseSelector(request.selector), document, true);
      const readiness = await mutationReadiness(element, request);
      return { outcome: 'success', value: readiness || expired(deadline) ? false : element };
    } catch (error) {
      return { outcome: 'exception', failure: JSON.stringify({ outcome: 'exception', stage: 'execution', error: codec.describeError(error, false) }) };
    }
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
    resolveElement,
    resolveMutationElement,
    mutateCapturedElement: (element, units, deadline) => safely(() => mutateElement(element, decodeRequest(units), deadline)),
    resolveFileInput, validateFileInput, createFileUpload, beginUploadFile, appendUploadFile, finishUploadFile, assignFileUpload,
    resolveLocatorElement: (units, deadline) => resolveElement(codec.encode(decodeRequest(units).selector).units, true, 'attached', deadline),
    prepareElementAction: (element, action, force, deadline, token) => safely(() => prepareElementAction(element, action, force, deadline, token)),
    cancelElementAction,
    assertion: (units, deadline, expression, isNot) => safely(() => assertion(units, deadline, expression, isNot)),
    waitForAssertion: (units, deadline, expression, isNot, token) => safely(() => waitForAssertion(units, deadline, expression, isNot, token)),
    cancelAssertion(token) {
      const result = conditions.cancel(token);
      if (conditionInstrumentation && result?.observation) result.observation.conditionMetrics = inspectAssertionConditions();
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
