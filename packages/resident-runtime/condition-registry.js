// Document-owned conditions. The engine keeps this path behind its experiment switch.
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
