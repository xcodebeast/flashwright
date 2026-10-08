// Document-owned conditions. The engine keeps this path behind its experiment switch.
function createConditionRegistry({ instrumentation = false, observeMutations = true, runSynchronousBatch = callback => callback() } = {}) {
  const conditions = new Map();
  const dirtyConditions = new Set();
  const roots = new Set();
  const discoveryQueue = [];
  const maximumConditions = 128;
  const maximumRoots = 512;
  const maximumDiscoveryQueue = 128;
  const maximumDiscoveryVisits = 100000;
  const discoveryVisitsPerTask = 512;
  const mutationVisitsPerBatch = 512;
  const fallbackMilliseconds = 100;
  const fastFallbackWindowMilliseconds = 100;
  const pendingFallbackIntervalMilliseconds = 32;
  const maximumChecksPerTask = 32;
  const maximumCheckMillisecondsPerTask = 4;
  const events = ['input', 'change', 'focusin', 'focusout', 'resize', 'scroll', 'hashchange', 'popstate', 'visibilitychange', 'transitionrun', 'transitionend', 'animationstart', 'animationend'];
  const counters = { predicateEvaluations: 0, discoveryPasses: 0, discoveryVisits: 0, mutationBatches: 0, mutationRecordsVisited: 0, addedNodesVisited: 0, fallbackChecks: 0, animationFrameChecks: 0, timerFallbackChecks: 0, fallbackConditionInvalidations: 0, fallbackConditionsDeferred: 0, fallbackSchedulingPasses: 0, animationFrameRequests: 0, fallbackTimerRequests: 0, discoveryOverflows: 0, flushTasks: 0, maximumChecksBeforeYield: 0 };
  let observer;
  let generation = 0;
  let flushQueued = false;
  let flushChannel;
  let flushTaskQueued = false;
  let checksBeforeYield = 0;
  let flushStartedAt;
  let animationFrame;
  let fallbackTimer;
  let fallbackTimerDeadline;
  let fallbackSchedulingQueued = false;
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
    dirtyConditions.clear();
    discoveryQueue.length = 0;
    if (flushChannel) {
      flushChannel.port1.onmessage = null;
      flushChannel.port1.close();
      flushChannel.port2.close();
      flushChannel = undefined;
    }
    flushTaskQueued = false;
    checksBeforeYield = 0;
    flushStartedAt = undefined;
    for (const event of events) globalThis.removeEventListener(event, invalidate, true);
    globalThis.removeEventListener('pagehide', dispose);
    document.fonts?.removeEventListener('loadingdone', invalidate);
    document.fonts?.removeEventListener('loadingerror', invalidate);
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    clearTimeout(fallbackTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(discoveryTimer);
    animationFrame = fallbackTimer = fallbackTimerDeadline = deadlineTimer = discoveryTimer = undefined;
    fallbackSchedulingQueued = false;
    flushQueued = discoveryStarted = false;
    discoveryVisits = 0;
  }

  function finish(condition, result) {
    if (conditions.get(condition.token) !== condition) return;
    conditions.delete(condition.token);
    dirtyConditions.delete(condition);
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

  /** Plan once after concurrent checks settle, rather than scan every condition
   * for every result. Retired callbacks cannot alter a successor group's timers. */
  function queueFallbackScheduling() {
    if (fallbackSchedulingQueued || !conditions.size) return;
    fallbackSchedulingQueued = true;
    const queuedGeneration = generation;
    queueMicrotask(() => {
      if (queuedGeneration !== generation) return;
      fallbackSchedulingQueued = false;
      scheduleFallback();
    });
  }

  /** Short waits use frames with a stalled-frame timer. Long waits use the next
   * due predicate's timer directly, so deferred work does not keep requesting
   * render frames. Events still invalidate immediately; deadlines are independent. */
  function scheduleFallback() {
    if (!conditions.size) return;
    count('fallbackSchedulingPasses');
    const now = performance.now();
    let needsFrames = false;
    let nextDeadline = Infinity;
    for (const condition of conditions.values()) {
      if (condition.running || condition.dirty) continue;
      if (now - condition.registeredAt < fastFallbackWindowMilliseconds) needsFrames = true;
      else nextDeadline = Math.min(nextDeadline, condition.lastCheckStartedAt + pendingFallbackIntervalMilliseconds);
    }
    const queuedGeneration = generation;
    if (needsFrames && animationFrame === undefined) {
      count('animationFrameRequests');
      animationFrame = requestAnimationFrame(() => {
        if (queuedGeneration !== generation) return;
        animationFrame = undefined;
        count('fallbackChecks');
        count('animationFrameChecks');
        invalidateFallback();
        queueFallbackScheduling();
      });
    } else if (!needsFrames && animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    // Allow one batch's check-start spread to become due together. Scheduling at
    // the earliest individual timestamp fragments shared work into tiny timers.
    // Events still check immediately; this window only delays paced fallback.
    if (needsFrames) nextDeadline = fallbackTimerDeadline ?? now + fallbackMilliseconds;
    else if (Number.isFinite(nextDeadline)) nextDeadline = Math.max(now, nextDeadline + maximumCheckMillisecondsPerTask);
    if (!Number.isFinite(nextDeadline)) {
      clearTimeout(fallbackTimer);
      fallbackTimer = fallbackTimerDeadline = undefined;
    } else if (fallbackTimer === undefined || fallbackTimerDeadline !== nextDeadline) {
      clearTimeout(fallbackTimer);
      fallbackTimerDeadline = nextDeadline;
      count('fallbackTimerRequests');
      fallbackTimer = setTimeout(() => {
        if (queuedGeneration !== generation) return;
        fallbackTimer = fallbackTimerDeadline = undefined;
        count('fallbackChecks');
        count('timerFallbackChecks');
        invalidateFallback(true);
        queueFallbackScheduling();
      }, Math.max(0, Math.min(nextDeadline - now, 2147483647)));
    }
    if (!discoveryStarted) {
      discoveryStarted = true;
      if (observer) { count('discoveryPasses'); enqueueDiscovery(document); }
    }
  }

  function hasFlushBudget() {
    // Even a slow root-pruning pass must leave room for one predicate to progress.
    return checksBeforeYield === 0 || checksBeforeYield < maximumChecksPerTask &&
      (flushStartedAt === undefined || performance.now() - flushStartedAt < maximumCheckMillisecondsPerTask);
  }

  /** The task boundary also resets the budget when a check or an observer queues
   * another microtask. Otherwise repeated small flushes could starve the app too.
   * MessageChannel avoids the nested-timer clamp during a long pending group. */
  function scheduleFlushTask() {
    if (flushTaskQueued) return;
    if (!flushChannel) {
      const queuedGeneration = generation;
      flushChannel = new MessageChannel();
      flushChannel.port1.onmessage = () => {
        if (queuedGeneration !== generation) return;
        flushTaskQueued = false;
        checksBeforeYield = 0;
        flushStartedAt = undefined;
        count('flushTasks');
        flush();
      };
    }
    flushTaskQueued = true;
    flushChannel.port2.postMessage(null);
  }

  function flush() {
    if (!dirtyConditions.size) return;
    if (flushStartedAt === undefined) flushStartedAt = performance.now();
    scheduleFlushTask();
    pruneRoots();
    function flushChecks(canShareSelectorQueries) {
      while (dirtyConditions.size && hasFlushBudget()) {
        const condition = dirtyConditions.values().next().value;
        if (condition.canShareSelectorQueries !== canShareSelectorQueries) break;
        dirtyConditions.delete(condition);
        checksBeforeYield++;
        if (instrumentation) counters.maximumChecksBeforeYield = Math.max(counters.maximumChecksBeforeYield, checksBeforeYield);
        void evaluate(condition);
      }
    }
    while (dirtyConditions.size && hasFlushBudget()) {
      if (dirtyConditions.values().next().value.canShareSelectorQueries) runSynchronousBatch(() => flushChecks(true));
      else flushChecks(false);
    }
  }

  function queueFlush() {
    if (flushQueued || !dirtyConditions.size) return;
    if (!hasFlushBudget()) { scheduleFlushTask(); return; }
    flushQueued = true;
    const queuedGeneration = generation;
    queueMicrotask(() => {
      if (queuedGeneration !== generation) return;
      flushQueued = false;
      flush();
    });
  }

  function invalidate() {
    for (const condition of conditions.values()) {
      condition.dirty = true;
      if (!condition.running) dirtyConditions.add(condition);
    }
    queueFlush();
  }

  /** Frames pace individual long waits. A due timer checks the pending group
   * together so registration/check offsets do not perpetuate separate timers. */
  function invalidateFallback(coalescePendingChecks = false) {
    const now = performance.now();
    for (const condition of conditions.values()) {
      if (!coalescePendingChecks && now - condition.registeredAt >= fastFallbackWindowMilliseconds &&
          now - condition.lastCheckStartedAt < pendingFallbackIntervalMilliseconds) {
        count('fallbackConditionsDeferred');
        continue;
      }
      count('fallbackConditionInvalidations');
      condition.dirty = true;
      if (!condition.running) dirtyConditions.add(condition);
    }
    queueFlush();
  }

  async function evaluate(condition) {
    if (conditions.get(condition.token) !== condition) return;
    const now = performance.now();
    if (now >= condition.deadline) {
      finish(condition, { status: 'expired', observation: condition.observation });
      return;
    }
    condition.running = true;
    condition.dirty = false;
    condition.lastCheckStartedAt = now;
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
    } catch (error) {
      finish(condition, { status: 'error', message: String(error?.stack ?? error).slice(0, 16384) });
    } finally {
      condition.running = false;
      if (conditions.get(condition.token) === condition) {
        if (condition.dirty) {
          dirtyConditions.add(condition);
          queueFlush();
        }
        queueFallbackScheduling();
      }
    }
  }

  /** Subscribe before checking, without retaining a locator's element or truth value. */
  function wait({ token, timeoutMilliseconds = null, isNot = false, check, canShareSelectorQueries = false }) {
    if (typeof token !== 'string' || !token || typeof check !== 'function' || typeof isNot !== 'boolean' || typeof canShareSelectorQueries !== 'boolean') throw new Error('Invalid condition registration');
    if (timeoutMilliseconds !== null && (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0)) throw new Error('Invalid condition timeout');
    if (conditions.has(token)) throw new Error('Condition token is already registered');
    if (conditions.size >= maximumConditions) return Promise.resolve({ status: 'limit', message: 'Document condition limit exceeded' });
    const registeredAt = performance.now();
    const deadline = timeoutMilliseconds === null ? Infinity : registeredAt + timeoutMilliseconds;
    if (!conditions.size) begin();
    return new Promise(resolve => {
      const condition = { token, deadline, registeredAt, lastCheckStartedAt: registeredAt, isNot, check, canShareSelectorQueries, resolve, observation: null, dirty: true, running: false };
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
      queuedConditions: dirtyConditions.size, flushMicrotaskScheduled: flushQueued,
      flushTaskScheduled: flushTaskQueued, flushChannelOpen: flushChannel !== undefined,
      queuedDiscovery: discoveryQueue.length, animationFrameScheduled: animationFrame !== undefined,
      fallbackTimerScheduled: fallbackTimer !== undefined, deadlineTimerScheduled: deadlineTimer !== undefined,
      fallbackSchedulingQueued,
      discoveryTimerScheduled: discoveryTimer !== undefined,
    };
  }

  return { wait, cancel, dispose, inspect };
}
