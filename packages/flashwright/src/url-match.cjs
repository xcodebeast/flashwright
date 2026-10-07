// Adapted from Playwright 1.60.0, copyright Microsoft Corporation, Apache-2.0.
// Provenance and modifications: compatibility/upstream/url-match-provenance.json.
const escapedChars = new Set(["$", "^", "+", ".", "*", "(", ")", "|", "\\", "?", "{", "}", "[", "]"]);
function globToRegexPattern(glob) {
  const tokens = ["^"];
  let inGroup = false;
  for (let index = 0; index < glob.length; ++index) {
    const character = glob[index];
    if (character === "\\" && index + 1 < glob.length) {
      const escapedCharacter = glob[++index];
      tokens.push(escapedChars.has(escapedCharacter) ? "\\" + escapedCharacter : escapedCharacter);
      continue;
    }
    if (character === "*") {
      const characterBefore = glob[index - 1];
      let starCount = 1;
      while (glob[index + 1] === "*") {
        starCount++;
        index++;
      }
      if (starCount > 1) {
        const characterAfter = glob[index + 1];
        if (characterAfter === "/") {
          if (characterBefore === "/")
            tokens.push("((.+/)|)");
          else
            tokens.push("(.*/)");
          ++index;
        } else {
          tokens.push("(.*)");
        }
      } else {
        tokens.push("([^/]*)");
      }
      continue;
    }
    switch (character) {
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
        tokens.push("\\" + character);
        break;
      default:
        tokens.push(escapedChars.has(character) ? "\\" + character : character);
    }
  }
  if (inGroup)
    throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '{'`);
  tokens.push("$");
  return tokens.join("");
}

function resolveGlobBase(baseURL, match) {
  if (!match.startsWith("*")) {
    let mapToken = function(original, replacement) {
      if (original.length === 0)
        return "";
      tokenMap.set(replacement, original);
      return replacement;
    };
    const tokenMap = /* @__PURE__ */ new Map();
    match = match.replaceAll(/\\\\\?/g, "?");
    if (match.startsWith("about:") || match.startsWith("data:") || match.startsWith("chrome:") || match.startsWith("edge:") || match.startsWith("file:"))
      return match;
    const relativePath = match.split("/").map((token, index) => {
      if (token === "." || token === ".." || token === "")
        return token;
      if (index === 0 && token.endsWith(":")) {
        if (token.indexOf("*") !== -1 || token.indexOf("{") !== -1)
          return mapToken(token, "http:");
        return token;
      }
      const questionIndex = token.indexOf("?");
      if (questionIndex === -1)
        return mapToken(token, `$_${index}_$`);
      const newPrefix = mapToken(token.substring(0, questionIndex), `$_${index}_$`);
      const newSuffix = mapToken(token.substring(questionIndex), `?$_${index}_$`);
      return newPrefix + newSuffix;
    }).join("/");
    const result = resolveBaseURL(baseURL, relativePath);
    let resolved = result.resolved;
    for (const [token, original] of tokenMap) {
      const normalize = result.caseInsensitivePart?.includes(token);
      resolved = resolved.replace(token, normalize ? original.toLowerCase() : original);
    }
    match = resolved;
  }
  return match;
}

function resolveBaseURL(baseURL, givenURL) {
  try {
    const url = new URL(givenURL, baseURL);
    const resolved = url.toString();
    const caseInsensitivePrefix = url.origin;
    return { resolved, caseInsensitivePart: caseInsensitivePrefix };
  } catch (error) {
    return { resolved: givenURL };
  }
}

exports.globToRegexPattern = globToRegexPattern;
exports.resolveGlobBase = resolveGlobBase;
