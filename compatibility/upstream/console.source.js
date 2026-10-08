function renderPreview(object) {
  if (object.type === "undefined")
    return "undefined";
  if ("value" in object)
    return String(object.value);
  if (object.unserializableValue)
    return String(object.unserializableValue);
  if (object.description === "Object" && object.preview) {
    const tokens = [];
    for (const { name, value: value2 } of object.preview.properties)
      tokens.push(`${name}: ${value2}`);
    return `{${tokens.join(", ")}}`;
  }
  if (object.subtype === "array" && object.preview)
    return sparseArrayToString(object.preview.properties);
  return object.description;
}

function sparseArrayToString(entries) {
  const arrayEntries = [];
  for (const { name, value: value2 } of entries) {
    const index = +name;
    if (isNaN(index) || index < 0)
      continue;
    arrayEntries.push({ index, value: value2 });
  }
  arrayEntries.sort((a, b) => a.index - b.index);
  let lastIndex = -1;
  const tokens = [];
  for (const { index, value: value2 } of arrayEntries) {
    const emptyItems = index - lastIndex - 1;
    if (emptyItems === 1)
      tokens.push(`empty`);
    else if (emptyItems > 1)
      tokens.push(`empty x ${emptyItems}`);
    tokens.push(String(value2));
    lastIndex = index;
  }
  return "[" + tokens.join(", ") + "]";
}

function stackTraceToLocation(stackTrace) {
  return stackTrace && stackTrace.callFrames.length ? {
    url: stackTrace.callFrames[0].url,
    lineNumber: stackTrace.callFrames[0].lineNumber,
    columnNumber: stackTrace.callFrames[0].columnNumber
  } : { url: "", lineNumber: 0, columnNumber: 0 };
}
