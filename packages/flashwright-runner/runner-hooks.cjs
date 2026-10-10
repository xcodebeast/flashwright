'use strict';

/** The owned worker calls this one adapter before any trace writes or user fixtures. */
let onTraceStart;
module.exports = Object.freeze({
  get onTraceStart() { return onTraceStart; },
  installTraceStart(callback) {
    if (onTraceStart || typeof callback !== 'function')
      throw new Error('Invalid or duplicate Flashwright runner trace adapter');
    onTraceStart = (information, policy) => {
      const handled = callback(information, policy);
      if (typeof handled !== 'boolean') {
        // An accidental promise must never resume upstream live allocation after final stop.
        if (require('node:util').types.isPromise(handled)) void handled.catch(() => {});
        throw new Error('Flashwright trace startup must decide ownership synchronously');
      }
      return handled;
    };
  },
});
