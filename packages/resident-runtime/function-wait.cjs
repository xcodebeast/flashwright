/** Capture the pinned injected scheduler once, when this document first requests a predicate wait. */
function createFunctionWaitFactory() {
  const builtins = globalThis.__pwClock ? globalThis.__pwClock.builtins : {
    setTimeout: globalThis.setTimeout?.bind(globalThis),
    clearTimeout: globalThis.clearTimeout?.bind(globalThis),
    setInterval: globalThis.setInterval?.bind(globalThis),
    clearInterval: globalThis.clearInterval?.bind(globalThis),
    requestAnimationFrame: globalThis.requestAnimationFrame?.bind(globalThis),
    cancelAnimationFrame: globalThis.cancelAnimationFrame?.bind(globalThis),
    requestIdleCallback: globalThis.requestIdleCallback?.bind(globalThis),
    cancelIdleCallback: globalThis.cancelIdleCallback?.bind(globalThis),
    performance: globalThis.performance,
    Intl: globalThis.Intl,
    Date: globalThis.Date,
    AbortSignal: globalThis.AbortSignal,
  };
  return (...arguments_) => createFunctionWaiter(builtins, ...arguments_);
}
exports.createFunctionWaitFactory = createFunctionWaitFactory;

/** Scheduling getters are caller code too; describe their failures within the existing codec bound. */
function failedFunctionWaiter(codec, error) {
  const result = Promise.resolve({ outcome: 'exception', failure: JSON.stringify({
    outcome: 'exception', stage: 'scheduling', error: codec.describeError(error, false),
  }) });
  return { result, start() {}, abort() {} };
}
exports.failedFunctionWaiter = failedFunctionWaiter;

/** A private controller owns one predicate attempt and its exact scheduled callback. */
function createFunctionWaiter(builtins, codec, source, isFunction, encodedArgument, handles, primitiveHandles, polling) {
  const PromiseConstructor = Promise;
  let argument;
  let decodedFailure;
  try {
    const decodedHandles = handles.map((value, index) => primitiveHandles[index] ? codec.decode(value) : value);
    argument = codec.decode(encodedArgument, decodedHandles);
  } catch (error) {
    decodedFailure = { outcome: 'exception', stage: 'argumentDecoding', error: codec.describeError(error) };
  }
  let finish;
  const result = new PromiseConstructor(resolve => { finish = resolve; });
  let started = false;
  let terminal = false;
  let scheduled = null;
  let hasScheduledCallback = false;
  let cachedFunction;

  const clearScheduled = () => {
    if (hasScheduledCallback) {
      const identifier = scheduled;
      hasScheduledCallback = false;
      scheduled = null;
      if (polling === null) builtins.cancelAnimationFrame(identifier);
      else builtins.clearTimeout(identifier);
    }
  };
  const complete = outcome => {
    if (terminal) return;
    terminal = true;
    // A caller-provided scheduler cannot prevent the original outcome from settling.
    try { clearScheduled(); } catch {}
    source = undefined;
    argument = undefined;
    cachedFunction = undefined;
    finish(outcome);
  };
  const fail = failure => complete({ outcome: 'exception', failure: JSON.stringify(failure) });
  const abort = () => fail({ outcome: 'exception', stage: 'polling', error: {
    code: 'TimeoutError', messageUnits: Array.from('predicate polling was cancelled or expired', character => character.charCodeAt(0)), messageTruncated: false,
  } });
  const next = () => {
    hasScheduledCallback = false;
    scheduled = null;
    if (terminal) return;
    try {
      let value = cachedFunction ?? globalThis.eval(source);
      if (isFunction) {
        cachedFunction = value;
        value = value(argument);
      }
      if (value) {
        // The pinned implementation tests Promise truthiness before assimilating its value.
        PromiseConstructor.resolve(value).then(
          value => complete({ outcome: 'success', value }),
          error => fail({ outcome: 'exception', stage: 'execution', error: codec.describeError(error, false) }),
        );
        return;
      }
      scheduled = polling === null ? builtins.requestAnimationFrame(next) : builtins.setTimeout(next, polling);
      hasScheduledCallback = true;
    } catch (error) {
      fail({ outcome: 'exception', stage: 'execution', error: codec.describeError(error, false) });
    }
  };
  return {
    result,
    start() {
      if (started || terminal) return;
      started = true;
      if (decodedFailure) fail(decodedFailure);
      else next();
    },
    abort,
  };
}
