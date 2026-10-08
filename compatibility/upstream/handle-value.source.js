function serialize(value2, handleSerializer, visitorInfo) {
  if (value2 && typeof value2 === "object") {
    if (typeof globalThis.Window === "function" && value2 instanceof globalThis.Window)
      return "ref: <Window>";
    if (typeof globalThis.Document === "function" && value2 instanceof globalThis.Document)
      return "ref: <Document>";
    if (typeof globalThis.Node === "function" && value2 instanceof globalThis.Node)
      return "ref: <Node>";
  }
  return innerSerialize(value2, handleSerializer, visitorInfo);
}

function parseUnserializableValue(unserializableValue) {
  if (unserializableValue === "NaN")
    return NaN;
  if (unserializableValue === "Infinity")
    return Infinity;
  if (unserializableValue === "-Infinity")
    return -Infinity;
  if (unserializableValue === "-0")
    return -0;
}

function potentiallyUnserializableValue(remoteObject) {
  const value2 = remoteObject.value;
  const unserializableValue = remoteObject.unserializableValue;
  return unserializableValue ? parseUnserializableValue(unserializableValue) : value2;
}

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

function createHandle(context2, remoteObject) {
  if (remoteObject.subtype === "node") {
    assert(context2 instanceof FrameExecutionContext);
    return new ElementHandle(context2, remoteObject.objectId);
  }
  return new JSHandle(context2, remoteObject.subtype || remoteObject.type, renderPreview(remoteObject), remoteObject.objectId, potentiallyUnserializableValue(remoteObject));
}
