/** Record the driver's default assertion path and explicit diagnostic switches. */
export function readEngineConfiguration(environment = process.env) {
  return {
    residentAssertions: environment.FLASHWRIGHT_RESIDENT_ASSERTIONS !== '0',
    conditionInstrumentation: environment.FLASHWRIGHT_CONDITION_INSTRUMENTATION === '1',
    ...(environment.FLASHWRIGHT_FRAME_ASSERTION_LEASES === '0' ? { frameAssertionLeases: false } : {}),
    // Keep historical default records comparable while distinguishing opt-in runs.
    ...(environment.FLASHWRIGHT_EXPERIMENT_POINTER_READINESS === '1' ? { pointerReadiness: true } : {}),
  };
}
