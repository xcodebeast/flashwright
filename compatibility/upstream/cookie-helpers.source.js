function filterCookies(cookies, urls) {
  const parsedURLs = urls.map((s) => new URL(s));
  return cookies.filter((c) => {
    if (!parsedURLs.length)
      return true;
    for (const parsedURL of parsedURLs) {
      let domain = c.domain;
      if (!domain.startsWith("."))
        domain = "." + domain;
      if (!("." + parsedURL.hostname).endsWith(domain))
        continue;
      if (!parsedURL.pathname.startsWith(c.path))
        continue;
      if (parsedURL.protocol !== "https:" && !isLocalHostname(parsedURL.hostname) && c.secure)
        continue;
      return true;
    }
    return false;
  });
}
function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function rewriteCookies(cookies) {
  return cookies.map((c) => {
    assert(c.url || c.domain && c.path, "Cookie should have a url or a domain/path pair");
    assert(!(c.url && c.domain), "Cookie should have either url or domain");
    assert(!(c.url && c.path), "Cookie should have either url or path");
    assert(!(c.expires && c.expires < 0 && c.expires !== -1), "Cookie should have a valid expires, only -1 or a positive number for the unix timestamp in seconds is allowed");
    assert(!(c.expires && c.expires > 0 && c.expires > kMaxCookieExpiresDateInSeconds), "Cookie should have a valid expires, only -1 or a positive number for the unix timestamp in seconds is allowed");
    const copy = { ...c };
    if (copy.url) {
      assert(copy.url !== "about:blank", `Blank page can not have cookie "${c.name}"`);
      assert(!copy.url.startsWith("data:"), `Data URL page can not have cookie "${c.name}"`);
      const url2 = new URL(copy.url);
      copy.domain = url2.hostname;
      copy.path = url2.pathname.substring(0, url2.pathname.lastIndexOf("/") + 1);
      copy.secure = url2.protocol === "https:";
    }
    return copy;
  });
}
