/** User execution and codec work have distinct failure boundaries, independent of error text. */
async function runEvaluation(codec, source, isFunction, encodedArgument) {
  let argument;
  try {
    argument = codec.decode(encodedArgument);
  } catch (error) {
    return { outcome: 'exception', stage: 'argumentDecoding', error: codec.describeError(error) };
  }
  let value;
  try {
    const operation = (0, eval)(source);
    value = await (isFunction ? operation(argument) : operation);
  } catch (error) {
    return { outcome: 'exception', stage: 'execution', error: codec.describeError(error, false) };
  }
  try {
    return { outcome: 'success', value: codec.encode(value) };
  } catch (error) {
    return { outcome: 'exception', stage: 'resultSerialization', error: codec.describeError(error) };
  }
}
exports.runEvaluation = runEvaluation;
