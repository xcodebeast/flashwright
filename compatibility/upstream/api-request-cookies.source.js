// packages/playwright-core/src/server/cookieStore.ts
function parseRawCookie(header) {
  const pairs = header.split(";").filter((s) => s.trim().length > 0).map((p) => {
    let key = "";
    let value3 = "";
    const separatorPos = p.indexOf("=");
    if (separatorPos === -1) {
      key = p.trim();
    } else {
      key = p.slice(0, separatorPos).trim();
      value3 = p.slice(separatorPos + 1).trim();
    }
    return [key, value3];
  });
  if (!pairs.length)
    return null;
  const [name, value2] = pairs[0];
  const cookie = {
    name,
    value: value2
  };
  for (let i = 1; i < pairs.length; i++) {
    const [name2, value3] = pairs[i];
    switch (name2.toLowerCase()) {
      case "expires":
        const expiresMs = +new Date(value3);
        if (isFinite(expiresMs)) {
          if (expiresMs <= 0)
            cookie.expires = 0;
          else
            cookie.expires = Math.min(expiresMs / 1e3, kMaxCookieExpiresDateInSeconds);
        }
        break;
      case "max-age":
        const maxAgeSec = parseInt(value3, 10);
        if (isFinite(maxAgeSec)) {
          if (maxAgeSec <= 0)
            cookie.expires = 0;
          else
            cookie.expires = Math.min(Date.now() / 1e3 + maxAgeSec, kMaxCookieExpiresDateInSeconds);
        }
        break;
      case "domain":
        cookie.domain = value3.toLocaleLowerCase() || "";
        if (cookie.domain && !cookie.domain.startsWith(".") && cookie.domain.includes("."))
          cookie.domain = "." + cookie.domain;
        break;
      case "path":
        cookie.path = value3 || "";
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite":
        switch (value3.toLowerCase()) {
          case "none":
            cookie.sameSite = "None";
            break;
          case "lax":
            cookie.sameSite = "Lax";
            break;
          case "strict":
            cookie.sameSite = "Strict";
            break;
        }
        break;
    }
  }
  return cookie;
}
function domainMatches(value2, domain) {
  if (value2 === domain)
    return true;
  if (!domain.startsWith("."))
    return false;
  value2 = "." + value2;
  return value2.endsWith(domain);
}
function pathMatches(value2, path59) {
  if (value2 === path59)
    return true;
  if (!value2.endsWith("/"))
    value2 = value2 + "/";
  if (!path59.endsWith("/"))
    path59 = path59 + "/";
  return value2.startsWith(path59);
}
var Cookie, CookieStore;
var init_cookieStore = __esm({
  "packages/playwright-core/src/server/cookieStore.ts"() {
    "use strict";
    init_network2();
    Cookie = class {
      constructor(data) {
        this._raw = data;
      }
      _name() {
        return this._raw.name;
      }
      // https://datatracker.ietf.org/doc/html/rfc6265#section-5.4
      matches(url2) {
        if (this._raw.secure && (url2.protocol !== "https:" && !isLocalHostname(url2.hostname)))
          return false;
        if (!domainMatches(url2.hostname, this._raw.domain))
          return false;
        if (!pathMatches(url2.pathname, this._raw.path))
          return false;
        return true;
      }
      _equals(other) {
        return this._raw.name === other._raw.name && this._raw.domain === other._raw.domain && this._raw.path === other._raw.path;
      }
      _networkCookie() {
        return this._raw;
      }
      _updateExpiresFrom(other) {
        this._raw.expires = other._raw.expires;
      }
      _expired() {
        if (this._raw.expires === -1)
          return false;
        return this._raw.expires * 1e3 < Date.now();
      }
    };
    CookieStore = class _CookieStore {
      constructor() {
        this._nameToCookies = /* @__PURE__ */ new Map();
      }
      addCookies(cookies) {
        for (const cookie of cookies)
          this._addCookie(new Cookie(cookie));
      }
      cookies(url2) {
        const result2 = [];
        for (const cookie of this._cookiesIterator()) {
          if (cookie.matches(url2))
            result2.push(cookie._networkCookie());
        }
        return result2;
      }
      allCookies() {
        const result2 = [];
        for (const cookie of this._cookiesIterator())
          result2.push(cookie._networkCookie());
        return result2;
      }
      _addCookie(cookie) {
        let set = this._nameToCookies.get(cookie._name());
        if (!set) {
          set = /* @__PURE__ */ new Set();
          this._nameToCookies.set(cookie._name(), set);
        }
        for (const other of set) {
          if (other._equals(cookie))
            set.delete(other);
        }
        set.add(cookie);
        _CookieStore.pruneExpired(set);
      }
      *_cookiesIterator() {
        for (const [name, cookies] of this._nameToCookies) {
          _CookieStore.pruneExpired(cookies);
          for (const cookie of cookies)
            yield cookie;
          if (cookies.size === 0)
            this._nameToCookies.delete(name);
        }
      }
      static pruneExpired(cookies) {
        for (const cookie of cookies) {
          if (cookie._expired())
            cookies.delete(cookie);
        }
      }
    };
  }
});


function parseCookie2(header) {
  const raw = parseRawCookie(header);
  if (!raw)
    return null;
  const cookie = {
    domain: "",
    path: "",
    expires: -1,
    httpOnly: false,
    secure: false,
    // From https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite
    // The cookie-sending behavior if SameSite is not specified is SameSite=Lax.
    sameSite: "Lax",
    ...raw
  };
  return cookie;
}

      _parseSetCookieHeader(responseUrl, setCookie) {
        if (!setCookie)
          return [];
        const url2 = new URL(responseUrl);
        const defaultPath = "/" + url2.pathname.substr(1).split("/").slice(0, -1).join("/");
        const cookies = [];
        for (const header of setCookie) {
          const cookie = parseCookie2(header);
          if (!cookie)
            continue;
          if (!cookie.domain)
            cookie.domain = url2.hostname;
          else
            assert(cookie.domain.startsWith(".") || !cookie.domain.includes("."));
          if (!domainMatches(url2.hostname, cookie.domain))
            continue;
          if (!cookie.path || !cookie.path.startsWith("/"))
            cookie.path = defaultPath;
          cookies.push(cookie);
        }
        return cookies;
      }
      async _updateRequestCookieHeader(progress2, url2, headers) {
        if (getHeader(headers, "cookie") !== void 0)
          return;
        const contextCookies = await this.cookies(progress2, url2);
        const cookies = contextCookies.filter((c) => new Cookie(c).matches(url2));
        if (cookies.length) {
          const valueArray = cookies.map((c) => `${c.name}=${c.value}`);
          setHeader(headers, "cookie", valueArray.join("; "));
        }
      }

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}
