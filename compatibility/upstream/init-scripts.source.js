async function evaluationScript(platform, fun, arg, addSourceUrl = true) {
  if (typeof fun === "function") {
    const source8 = fun.toString();
    const argString = Object.is(arg, void 0) ? "undefined" : JSON.stringify(arg);
    return `(${source8})(${argString})`;
  }
  if (arg !== void 0)
    throw new Error("Cannot evaluate a string with arguments");
  if (isString(fun))
    return fun;
  if (fun.content !== void 0)
    return fun.content;
  if (fun.path !== void 0) {
    let source8 = await platform.fs().promises.readFile(fun.path, "utf8");
    if (addSourceUrl)
      source8 = addSourceUrlToScript(source8, fun.path);
    return source8;
  }
  throw new Error("Either path or content property must be present");
}

function addSourceUrlToScript(source8, path59) {
  return `${source8}
//# sourceURL=${path59.replace(/\n/g, "")}`;
}
