function getExceptionMessage(exceptionDetails) {
  if (exceptionDetails.exception)
    return exceptionDetails.exception.description || String(exceptionDetails.exception.value);
  let message = exceptionDetails.text;
  if (exceptionDetails.stackTrace) {
    for (const callframe of exceptionDetails.stackTrace.callFrames) {
      const location2 = callframe.url + ":" + callframe.lineNumber + ":" + callframe.columnNumber;
      const functionName = callframe.functionName || "<anonymous>";
      message += `
    at ${functionName} (${location2})`;
    }
  }
  return message;
}

function exceptionToError(exceptionDetails) {
  const messageWithStack = getExceptionMessage(exceptionDetails);
  const lines = messageWithStack.split("\n");
  const firstStackTraceLine = lines.findIndex((line) => line.startsWith("    at"));
  let messageWithName = "";
  let stack = "";
  if (firstStackTraceLine === -1) {
    messageWithName = messageWithStack;
  } else {
    messageWithName = lines.slice(0, firstStackTraceLine).join("\n");
    stack = messageWithStack;
  }
  const { name, message } = splitErrorMessage(messageWithName);
  const err = new Error(message);
  err.stack = stack;
  const nameOverride = exceptionDetails.exception?.preview?.properties.find((o) => o.name === "name");
  err.name = nameOverride ? nameOverride.value ?? "Error" : name;
  return err;
}

function splitErrorMessage(message) {
  const separationIdx = message.indexOf(":");
  return {
    name: separationIdx !== -1 ? message.slice(0, separationIdx) : "",
    message: separationIdx !== -1 && separationIdx + 2 <= message.length ? message.substring(separationIdx + 2) : message
  };
}
