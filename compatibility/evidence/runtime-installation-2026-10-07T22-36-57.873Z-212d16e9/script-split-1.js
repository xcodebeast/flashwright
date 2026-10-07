(() => { const started = performance.now(); const exports = {}; /** Shared Node/renderer value codec. Strings carry UTF-16 units, never lossy UTF-8 conversions. */
function createValueCodec() {
  const failures = new WeakMap();
  function codecFailure(code, message) {
    const error = new Error(message);
    error.name = code;
    failures.set(error, code);
    return error;
  }
  /** Only this codec's own failures may claim a capability, limit or protocol error category. */
  function describeError(error, classifyCodecFailure = true) {
    let message;
    try {
      const stack = error == null ? undefined : error.stack;
      message = typeof stack === 'string' ? stack : String(error);
    } catch {
      message = 'JavaScript threw a value whose description could not be read';
    }
    return {
      code: classifyCodecFailure && failures.get(error) || 'EvaluationError',
      messageUnits: stringUnits(message.slice(0, 8192)),
      messageTruncated: message.length > 8192,
    };
  }
  function stringUnits(value) {
    return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
  }
  function fromUnits(units) {
    let value = '';
    for (let index = 0; index < units.length; index += 8192) value += String.fromCharCode(...units.slice(index, index + 8192));
    return value;
  }
  function encode(value) {
    const visited = new Map();
    let nodes = 0;
    function visit(value, depth) {
      if (++nodes > 100000 || depth > 48) throw codecFailure('ResourceLimitError', 'evaluation value exceeds depth or node limits');
      if (value === undefined) return { kind: 'undefined' };
      if (value === null) return { kind: 'null' };
      if (typeof value === 'string') {
        nodes += value.length;
        if (nodes > 100000) throw codecFailure('ResourceLimitError', 'evaluation string exceeds node limit');
        return { kind: 'string', units: stringUnits(value) };
      }
      if (typeof value === 'boolean') return { kind: 'boolean', value };
      if (typeof value === 'number') {
        if (Object.is(value, -0)) return { kind: 'special', value: '-0' };
        if (!Number.isFinite(value)) return { kind: 'special', value: String(value) };
        return { kind: 'number', value };
      }
      if (typeof value === 'bigint') return { kind: 'bigint', value: String(value) };
      if (typeof value !== 'object') throw codecFailure('UnsupportedFeatureError', `evaluation value of type ${typeof value}`);
      if (visited.has(value)) return { kind: 'reference', identifier: visited.get(value) };
      const identifier = visited.size + 1;
      visited.set(value, identifier);
      if (Array.isArray(value)) return { kind: 'array', identifier, items: Array.from(value, item => visit(item, depth + 1)) };
      if (value instanceof Date) return { kind: 'date', identifier, value: value.toISOString() };
      if (value instanceof RegExp) return { kind: 'regexp', identifier, source: stringUnits(value.source), flags: value.flags };
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw codecFailure('UnsupportedFeatureError', `evaluation object ${Object.prototype.toString.call(value)}`);
      return { kind: 'object', identifier, entries: Object.keys(value).map(key => [stringUnits(key), visit(value[key], depth + 1)]) };
    }
    return visit(value, 0);
  }
  function decode(value) {
    const references = new Map();
    let nodes = 0;
    function visit(value, depth) {
      if (++nodes > 100000 || depth > 48) throw codecFailure('ResourceLimitError', 'evaluation value exceeds depth or node limits');
      if (!value || typeof value !== 'object') throw codecFailure('ProtocolError', 'malformed evaluation value');
      switch (value.kind) {
        case 'undefined': return undefined;
        case 'null': return null;
        case 'string': return fromUnits(value.units);
        case 'boolean': case 'number': return value.value;
        case 'special': {
          if (value.value === '-0') return -0;
          if (value.value === 'NaN') return NaN;
          if (value.value === 'Infinity') return Infinity;
          if (value.value === '-Infinity') return -Infinity;
          throw codecFailure('ProtocolError', 'unknown special number');
        }
        case 'bigint': return BigInt(value.value);
        case 'reference': {
          if (!references.has(value.identifier)) throw codecFailure('ProtocolError', 'unknown evaluation reference');
          return references.get(value.identifier);
        }
        case 'date': { const result = new Date(value.value); references.set(value.identifier, result); return result; }
        case 'regexp': { const result = new RegExp(fromUnits(value.source), value.flags); references.set(value.identifier, result); return result; }
        case 'array': {
          const result = []; references.set(value.identifier, result);
          for (const item of value.items) result.push(visit(item, depth + 1));
          return result;
        }
        case 'object': {
          const result = {}; references.set(value.identifier, result);
          for (const [key, item] of value.entries) Object.defineProperty(result, fromUnits(key), { value: visit(item, depth + 1), enumerable: true, configurable: true, writable: true });
          return result;
        }
        default: throw codecFailure('ProtocolError', 'unknown evaluation value kind');
      }
    }
    return visit(value, 0);
  }
  return { encode, decode, describeError };
}
exports.createValueCodec = createValueCodec;
; // Document-owned conditions. The engine keeps this path behind its experiment switch.
function createConditionRegistry({ instrumentation = false, observeMutations = true } = {}) {
  const conditions = new Map();
  const roots = new Set();
  const discoveryQueue = [];
  const maximumConditions = 128;
  const maximumRoots = 512;
  const maximumDiscoveryQueue = 128;
  const maximumDiscoveryVisits = 100000;
  const discoveryVisitsPerTask = 512;
  const mutationVisitsPerBatch = 512;
  const fallbackMilliseconds = 100;
  const events = ['input', 'change', 'focusin', 'focusout', 'resize', 'scroll', 'hashchange', 'popstate', 'visibilitychange', 'transitionrun', 'transitionend', 'animationstart', 'animationend'];
  const counters = { predicateEvaluations: 0, discoveryPasses: 0, discoveryVisits: 0, mutationBatches: 0, mutationRecordsVisited: 0, addedNodesVisited: 0, fallbackChecks: 0, animationFrameChecks: 0, timerFallbackChecks: 0, discoveryOverflows: 0 };
  let observer;
  let generation = 0;
  let flushQueued = false;
  let animationFrame;
  let fallbackTimer;
  let deadlineTimer;
  let discoveryTimer;
  let discoveryStarted = false;
  let discoveryVisits = 0;

  function count(name, amount = 1) {
    if (instrumentation) counters[name] += amount;
  }

  function observeRoot(root) {
    if (!observer || roots.has(root)) return;
    if (roots.size >= maximumRoots) { count('discoveryOverflows'); return; }
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    roots.add(root);
  }

  /** Discover open roots once per pending group, then only in inserted subtrees.
   * Missing roots at either bound remain covered by full predicate fallback checks. */
  function enqueueDiscovery(root) {
    if (!observer || !root.isConnected || !conditions.size) return;
    if (discoveryQueue.length >= maximumDiscoveryQueue) { count('discoveryOverflows'); return; }
    discoveryQueue.push({ root, walker: document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT), first: true });
    if (discoveryTimer === undefined) discoveryTimer = setTimeout(discover, 0);
  }

  function discover() {
    discoveryTimer = undefined;
    let remaining = discoveryVisitsPerTask;
    while (discoveryQueue.length && remaining-- > 0 && conditions.size) {
      if (discoveryVisits >= maximumDiscoveryVisits) {
        count('discoveryOverflows');
        discoveryQueue.length = 0;
        break;
      }
      const item = discoveryQueue[0];
      if (!item.root.isConnected) { discoveryQueue.shift(); continue; }
      const node = item.first ? item.root : item.walker.nextNode();
      item.first = false;
      if (!node) { discoveryQueue.shift(); continue; }
      discoveryVisits++;
      count('discoveryVisits');
      if (node.shadowRoot) {
        observeRoot(node.shadowRoot);
        enqueueDiscovery(node.shadowRoot);
      }
    }
    if (discoveryQueue.length && discoveryTimer === undefined) discoveryTimer = setTimeout(discover, 0);
  }

  function pruneRoots() {
    if (!observer || ![...roots].some(root => root !== document && !root.isConnected)) return;
    observer.disconnect();
    for (const root of [...roots]) {
      roots.delete(root);
      if (root === document || root.isConnected) observeRoot(root);
    }
  }

  function begin() {
    generation++;
    if (observeMutations) {
      observer = new MutationObserver(records => {
        count('mutationBatches');
        if (discoveryStarted) {
          let remainingRecords = mutationVisitsPerBatch;
          let remainingNodes = mutationVisitsPerBatch;
          for (const record of records) {
            if (remainingRecords-- <= 0 || remainingNodes <= 0) { count('discoveryOverflows'); break; }
            count('mutationRecordsVisited');
            if (record.type === 'childList') {
              for (const node of record.addedNodes) {
                if (remainingNodes-- <= 0) { count('discoveryOverflows'); break; }
                count('addedNodesVisited');
                if (node.nodeType === Node.ELEMENT_NODE) enqueueDiscovery(node);
              }
            }
          }
        }
        invalidate();
      });
      observeRoot(document);
    }
    for (const event of events) globalThis.addEventListener(event, invalidate, true);
    globalThis.addEventListener('pagehide', dispose);
    document.fonts?.addEventListener('loadingdone', invalidate);
    document.fonts?.addEventListener('loadingerror', invalidate);
  }

  function stop() {
    generation++;
    observer?.disconnect();
    observer = undefined;
    roots.clear();
    discoveryQueue.length = 0;
    for (const event of events) globalThis.removeEventListener(event, invalidate, true);
    globalThis.removeEventListener('pagehide', dispose);
    document.fonts?.removeEventListener('loadingdone', invalidate);
    document.fonts?.removeEventListener('loadingerror', invalidate);
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    clearTimeout(fallbackTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(discoveryTimer);
    animationFrame = fallbackTimer = deadlineTimer = discoveryTimer = undefined;
    flushQueued = discoveryStarted = false;
    discoveryVisits = 0;
  }

  function finish(condition, result) {
    if (conditions.get(condition.token) !== condition) return;
    conditions.delete(condition.token);
    condition.check = undefined;
    condition.resolve(result);
    if (!conditions.size) stop();
    else scheduleDeadline();
  }

  function scheduleDeadline() {
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    const nearest = Math.min(...[...conditions.values()].map(condition => condition.deadline));
    if (!Number.isFinite(nearest)) return;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      const now = performance.now();
      for (const condition of conditions.values()) {
        if (condition.deadline <= now) finish(condition, { status: 'expired', observation: condition.observation });
      }
      scheduleDeadline();
    }, Math.max(0, Math.min(nearest - performance.now(), 2147483647)));
  }

  /** Frame callbacks catch property/CSS/animation changes; the timer covers stalled
   * frame scheduling. Neither path assumes that a prior assertion result stays true. */
  function scheduleFallback() {
    if (!conditions.size) return;
    if (animationFrame === undefined) {
      animationFrame = requestAnimationFrame(() => {
        animationFrame = undefined;
        count('fallbackChecks');
        count('animationFrameChecks');
        invalidate();
        scheduleFallback();
      });
    }
    if (fallbackTimer === undefined) {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined;
        count('fallbackChecks');
        count('timerFallbackChecks');
        invalidate();
        scheduleFallback();
      }, fallbackMilliseconds);
    }
    if (!discoveryStarted) {
      discoveryStarted = true;
      if (observer) { count('discoveryPasses'); enqueueDiscovery(document); }
    }
  }

  function queueFlush() {
    if (flushQueued || !conditions.size) return;
    flushQueued = true;
    const queuedGeneration = generation;
    queueMicrotask(() => {
      if (queuedGeneration !== generation) return;
      flushQueued = false;
      pruneRoots();
      for (const condition of conditions.values()) {
        if (condition.dirty && !condition.running) void evaluate(condition);
      }
    });
  }

  function invalidate() {
    for (const condition of conditions.values()) condition.dirty = true;
    queueFlush();
  }

  async function evaluate(condition) {
    if (conditions.get(condition.token) !== condition) return;
    if (performance.now() >= condition.deadline) {
      finish(condition, { status: 'expired', observation: condition.observation });
      return;
    }
    condition.running = true;
    condition.dirty = false;
    try {
      count('predicateEvaluations');
      const observation = await condition.check();
      if (conditions.get(condition.token) !== condition) return;
      if (observation.status !== 'observation') { finish(condition, observation); return; }
      if (typeof observation.matches !== 'boolean') throw new Error('Condition omitted boolean predicate outcome');
      condition.observation = observation;
      // A full check that finishes after its deadline cannot become a late success.
      if (performance.now() >= condition.deadline) finish(condition, { status: 'expired', observation });
      else if (observation.matches !== condition.isNot) finish(condition, { status: 'matched', observation });
      else scheduleFallback();
    } catch (error) {
      finish(condition, { status: 'error', message: String(error?.stack ?? error).slice(0, 16384) });
    } finally {
      condition.running = false;
      if (conditions.get(condition.token) === condition && condition.dirty) queueFlush();
    }
  }

  /** Subscribe before checking, without retaining a locator's element or truth value. */
  function wait({ token, timeoutMilliseconds = null, isNot = false, check }) {
    if (typeof token !== 'string' || !token || typeof check !== 'function' || typeof isNot !== 'boolean') throw new Error('Invalid condition registration');
    if (timeoutMilliseconds !== null && (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0)) throw new Error('Invalid condition timeout');
    if (conditions.has(token)) throw new Error('Condition token is already registered');
    if (conditions.size >= maximumConditions) return Promise.resolve({ status: 'limit', message: 'Document condition limit exceeded' });
    const deadline = timeoutMilliseconds === null ? Infinity : performance.now() + timeoutMilliseconds;
    if (!conditions.size) begin();
    return new Promise(resolve => {
      const condition = { token, deadline, isNot, check, resolve, observation: null, dirty: true, running: false };
      conditions.set(token, condition);
      scheduleDeadline();
      void evaluate(condition);
    });
  }

  function cancel(token) {
    const condition = conditions.get(token);
    if (!condition) return null;
    const result = { status: 'cancelled', observation: condition.observation };
    finish(condition, result);
    return result;
  }

  function dispose() {
    for (const token of conditions.keys()) cancel(token);
  }

  function inspect() {
    if (!instrumentation) throw new Error('Condition instrumentation is disabled');
    return {
      ...counters, activeConditions: conditions.size, observedRoots: roots.size,
      queuedDiscovery: discoveryQueue.length, animationFrameScheduled: animationFrame !== undefined,
      fallbackTimerScheduled: fallbackTimer !== undefined, deadlineTimerScheduled: deadlineTimer !== undefined,
      discoveryTimerScheduled: discoveryTimer !== undefined,
    };
  }

  return { wait, cancel, dispose, inspect };
}
; /* The browser boundary for locator operations. This file executes only in an isolated realm. */
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
        if (length < value.length) { truncated = true; return value.slice(0, length) + '… [diagnostic truncated]'; }
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
;; const declared = performance.now(); globalThis.probeRuntime = createLocatorRuntime(globalThis.probeInjected, exports.createValueCodec()); return { declarations: declared-started, wrapper: performance.now()-declared }; })()