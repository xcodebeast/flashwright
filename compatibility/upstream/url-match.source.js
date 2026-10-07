function globToRegexPattern(glob) {
  const tokens = ["^"];
  let inGroup = false;
  for (let i = 0; i < glob.length; ++i) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) {
      const char = glob[++i];
      tokens.push(escapedChars.has(char) ? "\\" + char : char);
      continue;
    }
    if (c === "*") {
      const charBefore = glob[i - 1];
      let starCount = 1;
      while (glob[i + 1] === "*") {
        starCount++;
        i++;
      }
      if (starCount > 1) {
        const charAfter = glob[i + 1];
        if (charAfter === "/") {
          if (charBefore === "/")
            tokens.push("((.+/)|)");
          else
            tokens.push("(.*/)");
          ++i;
        } else {
          tokens.push("(.*)");
        }
      } else {
        tokens.push("([^/]*)");
      }
      continue;
    }
    switch (c) {
      case "{":
        if (inGroup)
          throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: nested '{' is not supported`);
        inGroup = true;
        tokens.push("(");
        break;
      case "}":
        if (!inGroup)
          throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '}'`);
        inGroup = false;
        tokens.push(")");
        break;
      case ",":
        if (inGroup) {
          tokens.push("|");
          break;
        }
        tokens.push("\\" + c);
        break;
      default:
        tokens.push(escapedChars.has(c) ? "\\" + c : c);
    }
  }
  if (inGroup)
    throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '{'`);
  tokens.push("$");
  return tokens.join("");
}

function resolveGlobBase(baseURL, match) {
  if (!match.startsWith("*")) {
    let mapToken2 = function(original, replacement) {
      if (original.length === 0)
        return "";
      tokenMap.set(replacement, original);
      return replacement;
    };
    var mapToken = mapToken2;
    const tokenMap = /* @__PURE__ */ new Map();
    match = match.replaceAll(/\\\\\?/g, "?");
    if (match.startsWith("about:") || match.startsWith("data:") || match.startsWith("chrome:") || match.startsWith("edge:") || match.startsWith("file:"))
      return match;
    const relativePath = match.split("/").map((token, index) => {
      if (token === "." || token === ".." || token === "")
        return token;
      if (index === 0 && token.endsWith(":")) {
        if (token.indexOf("*") !== -1 || token.indexOf("{") !== -1)
          return mapToken2(token, "http:");
        return token;
      }
      const questionIndex = token.indexOf("?");
      if (questionIndex === -1)
        return mapToken2(token, `$_${index}_$`);
      const newPrefix = mapToken2(token.substring(0, questionIndex), `$_${index}_$`);
      const newSuffix = mapToken2(token.substring(questionIndex), `?$_${index}_$`);
      return newPrefix + newSuffix;
    }).join("/");
    const result2 = resolveBaseURL(baseURL, relativePath);
    let resolved = result2.resolved;
    for (const [token, original] of tokenMap) {
      const normalize = result2.caseInsensitivePart?.includes(token);
      resolved = resolved.replace(token, normalize ? original.toLowerCase() : original);
    }
    match = resolved;
  }
  return match;
}

function resolveBaseURL(baseURL, givenURL) {
  try {
    const url2 = new URL(givenURL, baseURL);
    const resolved = url2.toString();
    const caseInsensitivePrefix = url2.origin;
    return { resolved, caseInsensitivePart: caseInsensitivePrefix };
  } catch (e) {
    return { resolved: givenURL };
  }
}
