/** Record the driver's default assertion path and explicit diagnostic switches. */
export function readEngineConfiguration(environment = process.env) {
  return {
    residentAssertions: environment.FLASHWRIGHT_RESIDENT_ASSERTIONS !== '0',
    conditionInstrumentation: environment.FLASHWRIGHT_CONDITION_INSTRUMENTATION === '1',
  };
}
