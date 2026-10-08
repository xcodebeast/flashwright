/** User execution and codec work have distinct failure boundaries, independent of error text. */
async function runEvaluation(codec, source, isFunction, encodedArgument, handles = [], primitiveHandles = [], receiverIndex = null, returnHandle = false) {
  let argument;
  try {
    handles = handles.map((value, index) => primitiveHandles[index] ? codec.decode(value) : value);
    argument = codec.decode(encodedArgument, handles);
  } catch (error) {
    return { outcome: 'exception', stage: 'argumentDecoding', error: codec.describeError(error) };
  }
  let value;
  try {
    const operation = (0, eval)(source);
    value = await (isFunction ? receiverIndex === null ? operation(argument) : operation(handles[receiverIndex], argument) : operation);
  } catch (error) {
    return { outcome: 'exception', stage: 'execution', error: codec.describeError(error, false) };
  }
  if (returnHandle) return { outcome: 'success', value };
  try {
    return { outcome: 'success', value: codec.encode(value) };
  } catch (error) {
    return { outcome: 'exception', stage: 'resultSerialization', error: codec.describeError(error) };
  }
}
exports.runEvaluation = runEvaluation;

/** Only the outer result object is inspected by CDP; user properties/getters stay untouched. */
async function runHandleEvaluation(codec, source, isFunction, argument, handles, primitiveHandles, receiverIndex) {
  const result = await runEvaluation(codec, source, isFunction, argument, handles, primitiveHandles, receiverIndex, true);
  if (result.outcome === 'exception') return { outcome: 'exception', failure: JSON.stringify(result) };
  return result;
}
exports.runHandleEvaluation = runHandleEvaluation;
