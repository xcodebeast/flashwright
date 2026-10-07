/** Mirror the driver's internal experiment switches in retained verification evidence. */
export function readEngineConfiguration(environment = process.env) {
  return {
    residentAssertions: environment.FLASHWRIGHT_RESIDENT_ASSERTIONS === '1',
    conditionInstrumentation: environment.FLASHWRIGHT_CONDITION_INSTRUMENTATION === '1',
  };
}
