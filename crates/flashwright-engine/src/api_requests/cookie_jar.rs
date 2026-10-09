//! Independently retained standalone request cookies, following Playwright 1.60's cookie store.

use super::budget::{MAXIMUM_METADATA_BYTES, PairedBudget, PairedReservation};
use super::options::Cookie;
use flashwright_protocol::{ErrorCode, ErrorRecord};
use std::mem::size_of;

const MAXIMUM_COOKIES: usize = 4096;
const MAXIMUM_EXPIRES_SECONDS: f64 = 253_402_300_799.0;

/// Parts of an already normalized WHATWG HTTP(S) URL; the scheme has no trailing colon.
#[derive(Clone, Copy)]
pub(super) struct CookieUrl<'url> {
    pub(super) scheme: &'url str,
    pub(super) hostname: &'url str,
    pub(super) pathname: &'url str,
}

// Fields drop in declaration order, so owned allocations disappear before their credits.
#[derive(Debug)]
struct Credits {
    _original: PairedReservation,
    _excess: Option<PairedReservation>,
}

struct RetainedCookie {
    cookie: Cookie,
    _strings: Credits,
}

struct CookieGroup {
    name: String,
    cookies: RetainedVector<RetainedCookie>,
    _name: Credits,
}

struct RetainedVector<Value> {
    values: Vec<Value>,
    capacity: Option<Credits>,
}

impl<Value> RetainedVector<Value> {
    fn new() -> Self {
        Self {
            values: Vec::new(),
            capacity: None,
        }
    }

    /// Grow with both allocations charged; failed admission preserves the original contents.
    fn admit_one(&mut self, budget: &PairedBudget, method: &str) -> Result<(), ErrorRecord> {
        if self.values.len() < self.values.capacity() {
            return Ok(());
        }
        let requested = self
            .values
            .len()
            .saturating_mul(2)
            .clamp(1, MAXIMUM_COOKIES);
        if requested <= self.values.len() {
            return Err(resource(method, "API cookie jar exceeds 4096 entries"));
        }
        let original = budget.reserve(requested * size_of::<Value>(), method)?;
        let mut replacement = Vec::new();
        replacement
            .try_reserve_exact(requested)
            .map_err(|_| allocation_failure(method))?;
        let excess = reserve_excess(
            budget,
            replacement.capacity() * size_of::<Value>(),
            requested * size_of::<Value>(),
            method,
        )?;
        replacement.append(&mut self.values);
        let previous_values = std::mem::replace(&mut self.values, replacement);
        let previous_capacity = self.capacity.replace(Credits {
            _original: original,
            _excess: excess,
        });
        drop(previous_values);
        drop(previous_capacity);
        Ok(())
    }
}

pub(super) struct CookieJar {
    groups: RetainedVector<CookieGroup>,
    budget: PairedBudget,
}

/// An outbound Cookie header keeps its metadata credits independently of the jar's lifetime.
pub(super) struct CookieHeader {
    value: String,
    _strings: Credits,
}

impl CookieHeader {
    pub(super) fn as_str(&self) -> &str {
        &self.value
    }
}

impl CookieJar {
    /// Visit expiry attributes using the same grammar as the eventual mutation.
    pub(super) fn visit_dates(
        header: &str,
        now_milliseconds: f64,
        visitor: &mut impl FnMut(&str) -> Option<f64>,
    ) {
        let _ = ParsedCookie::parse(header, now_milliseconds, visitor);
    }

    /// Initial strings are charged independently, even if context configuration also retains them.
    pub(super) fn new(
        initial: Vec<Cookie>,
        budget: PairedBudget,
        now_milliseconds: f64,
        method: &str,
    ) -> Result<Self, ErrorRecord> {
        if initial.len() > MAXIMUM_COOKIES {
            return Err(resource(method, "API cookie jar exceeds 4096 cookies"));
        }
        let mut jar = Self {
            groups: RetainedVector::new(),
            budget,
        };
        for cookie in initial {
            let original = jar
                .budget
                .reserve(cookie_string_capacity(&cookie), method)?;
            jar.insert(
                RetainedCookie {
                    cookie,
                    _strings: Credits {
                        _original: original,
                        _excess: None,
                    },
                },
                now_milliseconds,
                method,
            )?;
        }
        Ok(jar)
    }

    /// Apply one bounded Set-Cookie field. Date parsing is deliberately supplied by the caller:
    /// it must return JavaScript Date milliseconds, or None for an invalid Date.
    pub(super) fn apply_set_cookie(
        &mut self,
        header: &str,
        response_url: CookieUrl<'_>,
        now_milliseconds: f64,
        parse_date: &mut impl FnMut(&str) -> Option<f64>,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        if header.len() > MAXIMUM_METADATA_BYTES {
            return Err(resource(method, "Set-Cookie field exceeds 256 KiB"));
        }
        let Some(parsed) = ParsedCookie::parse(header, now_milliseconds, parse_date) else {
            return Ok(());
        };
        let retained = parsed.retain(response_url, &self.budget, method)?;
        if !domain_matches(response_url.hostname, &retained.cookie.domain) {
            return Ok(());
        }
        self.insert(retained, now_milliseconds, method)
    }

    /// Prune expiry and borrow storage-state cookies without cloning retained strings.
    pub(super) fn all_cookies(&mut self, now_milliseconds: f64) -> impl Iterator<Item = &Cookie> {
        self.prune(now_milliseconds, true);
        self.groups
            .values
            .iter()
            .flat_map(|group| group.cookies.values.iter().map(|retained| &retained.cookie))
    }

    /// Retain exactly the name/value header in the pinned store's name-group insertion order.
    pub(super) fn cookie_header(
        &mut self,
        url: CookieUrl<'_>,
        now_milliseconds: f64,
        method: &str,
    ) -> Result<Option<CookieHeader>, ErrorRecord> {
        self.prune(now_milliseconds, true);
        let matching = || {
            self.groups.values.iter().flat_map(|group| {
                group.cookies.values.iter().filter_map(|retained| {
                    cookie_matches(&retained.cookie, url).then_some(&retained.cookie)
                })
            })
        };
        let mut length = 0usize;
        let mut count = 0usize;
        for cookie in matching() {
            length = length
                .checked_add(cookie.name.len())
                .and_then(|length| length.checked_add(cookie.value.len()))
                .and_then(|length| length.checked_add(1 + usize::from(count != 0) * 2))
                .ok_or_else(|| allocation_failure(method))?;
            count += 1;
        }
        if count == 0 {
            return Ok(None);
        }
        let original = self.budget.reserve(length, method)?;
        let mut value = allocate_string(length, method)?;
        let excess = reserve_excess(&self.budget, value.capacity(), length, method)?;
        for (index, cookie) in matching().enumerate() {
            if index != 0 {
                value.push_str("; ");
            }
            value.push_str(&cookie.name);
            value.push('=');
            value.push_str(&cookie.value);
        }
        Ok(Some(CookieHeader {
            value,
            _strings: Credits {
                _original: original,
                _excess: excess,
            },
        }))
    }

    fn insert(
        &mut self,
        retained: RetainedCookie,
        now_milliseconds: f64,
        method: &str,
    ) -> Result<(), ErrorRecord> {
        let existing_group = self
            .groups
            .values
            .iter()
            .position(|group| group.name == retained.cookie.name);
        let existing_cookie = existing_group.and_then(|group_index| {
            self.groups.values[group_index]
                .cookies
                .values
                .iter()
                .position(|other| {
                    other.cookie.domain == retained.cookie.domain
                        && other.cookie.path == retained.cookie.path
                })
        });
        let incoming_expired = expired(&retained.cookie, now_milliseconds);
        let live_count = self
            .groups
            .values
            .iter()
            .flat_map(|group| &group.cookies.values)
            .filter(|retained| !expired(&retained.cookie, now_milliseconds))
            .count();
        let replaces_live_cookie =
            existing_group
                .zip(existing_cookie)
                .is_some_and(|(group_index, cookie_index)| {
                    !expired(
                        &self.groups.values[group_index].cookies.values[cookie_index].cookie,
                        now_milliseconds,
                    )
                });
        if !incoming_expired && live_count - usize::from(replaces_live_cookie) >= MAXIMUM_COOKIES {
            return Err(resource(method, "API cookie jar exceeds 4096 cookies"));
        }

        // Complete admission before removing a cookie, including the name-group backing memory.
        let group_index = match existing_group {
            Some(index) => index,
            None => {
                self.groups.admit_one(&self.budget, method)?;
                let original = self.budget.reserve(retained.cookie.name.len(), method)?;
                let mut name = allocate_string(retained.cookie.name.len(), method)?;
                let excess = reserve_excess(
                    &self.budget,
                    name.capacity(),
                    retained.cookie.name.len(),
                    method,
                )?;
                name.push_str(&retained.cookie.name);
                let mut cookies = RetainedVector::new();
                if !incoming_expired {
                    cookies.admit_one(&self.budget, method)?;
                }
                self.groups.values.push(CookieGroup {
                    name,
                    cookies,
                    _name: Credits {
                        _original: original,
                        _excess: excess,
                    },
                });
                self.groups.values.len() - 1
            }
        };
        let group = &mut self.groups.values[group_index];
        if !incoming_expired && existing_cookie.is_none() {
            // Expired entries can supply a slot without replacing the group's backing allocation.
            // The incoming strings are already admitted, and no live cookie is removed here.
            if group.cookies.values.len() == group.cookies.values.capacity() {
                group
                    .cookies
                    .values
                    .retain(|retained| !expired(&retained.cookie, now_milliseconds));
            }
            group.cookies.admit_one(&self.budget, method)?;
        }
        if let Some(index) = existing_cookie {
            drop(group.cookies.values.remove(index));
        }
        if !incoming_expired {
            group.cookies.values.push(retained);
        }
        self.prune(now_milliseconds, false);
        Ok(())
    }

    fn prune(&mut self, now_milliseconds: f64, remove_empty_groups: bool) {
        for group in &mut self.groups.values {
            group
                .cookies
                .values
                .retain(|retained| !expired(&retained.cookie, now_milliseconds));
        }
        if remove_empty_groups {
            self.groups
                .values
                .retain(|group| !group.cookies.values.is_empty());
        }
    }
}

struct ParsedCookie<'header> {
    name: &'header str,
    value: &'header str,
    domain: &'header str,
    path: &'header str,
    expires: f64,
    http_only: bool,
    secure: bool,
    same_site: &'static str,
}

impl<'header> ParsedCookie<'header> {
    fn parse(
        header: &'header str,
        now_milliseconds: f64,
        parse_date: &mut impl FnMut(&str) -> Option<f64>,
    ) -> Option<Self> {
        let mut pairs = header
            .split(';')
            .filter(|pair| !javascript_trim(pair).is_empty());
        let (name, value) = cookie_pair(pairs.next()?);
        let mut parsed = Self {
            name,
            value,
            domain: "",
            path: "",
            expires: -1.0,
            http_only: false,
            secure: false,
            same_site: "Lax",
        };
        for pair in pairs {
            let (attribute, value) = cookie_pair(pair);
            if attribute.eq_ignore_ascii_case("expires") {
                if let Some(milliseconds) = parse_date(value).filter(|value| value.is_finite()) {
                    parsed.expires = if milliseconds <= 0.0 {
                        0.0
                    } else {
                        (milliseconds / 1000.0).min(MAXIMUM_EXPIRES_SECONDS)
                    };
                }
            } else if attribute.eq_ignore_ascii_case("max-age") {
                if let Some(seconds) = javascript_parse_integer(value) {
                    parsed.expires = if seconds <= 0.0 {
                        0.0
                    } else {
                        (now_milliseconds / 1000.0 + seconds).min(MAXIMUM_EXPIRES_SECONDS)
                    };
                }
            } else if attribute.eq_ignore_ascii_case("domain") {
                parsed.domain = value;
            } else if attribute.eq_ignore_ascii_case("path") {
                parsed.path = value;
            } else if attribute.eq_ignore_ascii_case("secure") {
                parsed.secure = true;
            } else if attribute.eq_ignore_ascii_case("httponly") {
                parsed.http_only = true;
            } else if attribute.eq_ignore_ascii_case("samesite") {
                if value.eq_ignore_ascii_case("none") {
                    parsed.same_site = "None";
                } else if value.eq_ignore_ascii_case("lax") {
                    parsed.same_site = "Lax";
                } else if value.eq_ignore_ascii_case("strict") {
                    parsed.same_site = "Strict";
                }
            }
        }
        Some(parsed)
    }

    fn retain(
        self,
        response_url: CookieUrl<'_>,
        budget: &PairedBudget,
        method: &str,
    ) -> Result<RetainedCookie, ErrorRecord> {
        let path = if self.path.starts_with('/') {
            self.path
        } else {
            default_path(response_url.pathname)
        };
        let domain_capacity = if self.domain.is_empty() {
            response_url.hostname.len()
        } else {
            self.domain.len().saturating_mul(3).saturating_add(1)
        };
        let requested = self
            .name
            .len()
            .saturating_add(self.value.len())
            .saturating_add(domain_capacity)
            .saturating_add(path.len())
            .saturating_add(self.same_site.len());
        let original = budget.reserve(requested, method)?;
        let mut domain = allocate_string(domain_capacity, method)?;
        if self.domain.is_empty() {
            domain.push_str(response_url.hostname);
        } else {
            // Rust's Unicode lowercase may allocate a temporary in addition to the final domain.
            let lowercase_credit = budget.reserve(self.domain.len().saturating_mul(6), method)?;
            let lowered = self.domain.to_lowercase();
            if !lowered.starts_with('.') && lowered.contains('.') {
                domain.push('.');
            }
            domain.push_str(&lowered);
            drop(lowered);
            drop(lowercase_credit);
        }
        let cookie = Cookie {
            name: copy_string(self.name, method)?,
            value: copy_string(self.value, method)?,
            domain,
            path: copy_string(path, method)?,
            url: None,
            expires: Some(self.expires),
            http_only: Some(self.http_only),
            secure: Some(self.secure),
            same_site: Some(copy_string(self.same_site, method)?),
            partition_key: None,
            has_cross_site_ancestor: None,
        };
        let excess = reserve_excess(budget, cookie_string_capacity(&cookie), requested, method)?;
        Ok(RetainedCookie {
            cookie,
            _strings: Credits {
                _original: original,
                _excess: excess,
            },
        })
    }
}

fn cookie_matches(cookie: &Cookie, url: CookieUrl<'_>) -> bool {
    (!cookie.secure.unwrap_or(false)
        || url.scheme == "https"
        || url.hostname == "localhost"
        || url.hostname.ends_with(".localhost"))
        && domain_matches(url.hostname, &cookie.domain)
        && path_matches(url.pathname, &cookie.path)
}

fn domain_matches(hostname: &str, domain: &str) -> bool {
    if hostname == domain {
        return true;
    }
    let Some(domain) = domain.strip_prefix('.') else {
        return false;
    };
    hostname == domain
        || hostname
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn path_matches(pathname: &str, cookie_path: &str) -> bool {
    pathname == cookie_path
        || (!pathname.ends_with('/') && cookie_path.strip_suffix('/') == Some(pathname))
        || pathname
            .strip_prefix(cookie_path)
            .is_some_and(|suffix| cookie_path.ends_with('/') || suffix.starts_with('/'))
}

#[cfg(test)]
#[test]
fn repeated_trailing_slashes_do_not_match_a_shorter_slash_terminated_url() {
    assert!(path_matches("/a", "/a/"));
    assert!(!path_matches("/a/", "/a//"));
    assert!(!path_matches("/", "//"));
    assert!(path_matches("/a//", "/a/"));
}

fn expired(cookie: &Cookie, now_milliseconds: f64) -> bool {
    cookie
        .expires
        .is_some_and(|expires| expires != -1.0 && expires * 1000.0 < now_milliseconds)
}

fn default_path(pathname: &str) -> &str {
    match pathname.rfind('/') {
        Some(index) if index > 0 => &pathname[..index],
        _ => "/",
    }
}

fn cookie_pair(pair: &str) -> (&str, &str) {
    match pair.split_once('=') {
        Some((name, value)) => (javascript_trim(name), javascript_trim(value)),
        None => (javascript_trim(pair), ""),
    }
}

fn javascript_trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'..='\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    })
}

fn javascript_parse_integer(value: &str) -> Option<f64> {
    let value = javascript_trim(value);
    let sign_length = usize::from(value.starts_with(['+', '-']));
    let digits = value.as_bytes()[sign_length..]
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits == 0 {
        return None;
    }
    value[..sign_length + digits]
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn cookie_string_capacity(cookie: &Cookie) -> usize {
    cookie
        .name
        .capacity()
        .saturating_add(cookie.value.capacity())
        .saturating_add(cookie.domain.capacity())
        .saturating_add(cookie.path.capacity())
        .saturating_add(cookie.url.as_ref().map_or(0, String::capacity))
        .saturating_add(cookie.same_site.as_ref().map_or(0, String::capacity))
        .saturating_add(cookie.partition_key.as_ref().map_or(0, String::capacity))
}

fn allocate_string(capacity: usize, method: &str) -> Result<String, ErrorRecord> {
    let mut string = String::new();
    string
        .try_reserve_exact(capacity)
        .map_err(|_| allocation_failure(method))?;
    Ok(string)
}

fn copy_string(value: &str, method: &str) -> Result<String, ErrorRecord> {
    let mut string = allocate_string(value.len(), method)?;
    string.push_str(value);
    Ok(string)
}

fn reserve_excess(
    budget: &PairedBudget,
    actual: usize,
    requested: usize,
    method: &str,
) -> Result<Option<PairedReservation>, ErrorRecord> {
    if actual > requested {
        Ok(Some(budget.reserve(actual - requested, method)?))
    } else {
        Ok(None)
    }
}

fn allocation_failure(method: &str) -> ErrorRecord {
    resource(method, "API cookie allocation failed")
}

fn resource(method: &str, message: &str) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, method, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const METHOD: &str = "apiRequest.get";

    fn url() -> CookieUrl<'static> {
        CookieUrl {
            scheme: "https",
            hostname: "www.example.test",
            pathname: "/directory/file",
        }
    }

    fn jar() -> CookieJar {
        CookieJar::new(
            vec![],
            PairedBudget::testing(64 * 1024 * 1024),
            1000.0,
            METHOD,
        )
        .unwrap()
    }

    fn apply(jar: &mut CookieJar, header: &str) {
        jar.apply_set_cookie(header, url(), 1000.0, &mut |_| None, METHOD)
            .unwrap();
    }

    fn header(jar: &mut CookieJar) -> Option<String> {
        jar.cookie_header(url(), 1000.0, METHOD)
            .unwrap()
            .map(|header| header.value.clone())
    }

    fn cookie(name: &str, value: &str, path: &str) -> Cookie {
        Cookie {
            name: name.into(),
            value: value.into(),
            domain: "www.example.test".into(),
            path: path.into(),
            url: None,
            expires: None,
            http_only: None,
            secure: None,
            same_site: None,
            partition_key: None,
            has_cross_site_ancestor: None,
        }
    }

    #[test]
    fn raw_pairs_defaults_and_ordered_duplicate_attributes_follow_reference() {
        let mut jar = jar();
        apply(
            &mut jar,
            " ; \u{feff}session = first=second ; PATH=/first; path=relative; DOMAIN=OTHER.test; Domain=EXAMPLE.TEST; Secure=no; HTTPONLY=no; SameSite=none; sameSite=garbage",
        );
        let retained = jar.all_cookies(1000.0).next().unwrap();
        assert_eq!(retained.name, "session");
        assert_eq!(retained.value, "first=second");
        assert_eq!(retained.domain, ".example.test");
        assert_eq!(retained.path, "/directory");
        assert_eq!(retained.expires, Some(-1.0));
        assert_eq!(retained.secure, Some(true));
        assert_eq!(retained.http_only, Some(true));
        assert_eq!(retained.same_site.as_deref(), Some("None"));
        apply(&mut jar, "flag");
        apply(&mut jar, "=unnamed; path=/");
        apply(&mut jar, "; ; \u{feff}");
        assert_eq!(
            header(&mut jar).as_deref(),
            Some("session=first=second; flag=; =unnamed")
        );
    }

    #[test]
    fn domain_matching_requires_host_or_dot_suffix_and_preserves_host_only_scope() {
        let mut jar = jar();
        apply(&mut jar, "host=one; path=/");
        apply(&mut jar, "parent=two; Domain=EXAMPLE.TEST; path=/");
        apply(&mut jar, "foreign=three; Domain=other.test; path=/");
        apply(&mut jar, "partial=four; Domain=ample.test; path=/");
        assert_eq!(header(&mut jar).as_deref(), Some("host=one; parent=two"));
        let subdomain = CookieUrl {
            hostname: "child.www.example.test",
            ..url()
        };
        let header = jar
            .cookie_header(subdomain, 1000.0, METHOD)
            .unwrap()
            .unwrap();
        assert_eq!(header.value, "parent=two");
        assert!(!domain_matches("notexample.test", ".example.test"));
        assert!(domain_matches("example.test", ".example.test"));
        assert!(!domain_matches("sub.localhost", "localhost"));
    }

    #[test]
    fn path_boundaries_and_localhost_secure_exception_follow_reference() {
        for (pathname, path, expected) in [
            ("/directory", "/directory", true),
            ("/directory/file", "/directory", true),
            ("/directory/file", "/directory/", true),
            ("/directory", "/directory/", true),
            ("/directory-other", "/directory", false),
            ("/directory", "/", true),
        ] {
            assert_eq!(
                path_matches(pathname, path),
                expected,
                "{pathname} / {path}"
            );
        }
        assert_eq!(default_path("/file"), "/");
        assert_eq!(default_path("/directory/"), "/directory");
        assert_eq!(default_path("/directory//file"), "/directory/");
        let mut secure = cookie("secure", "yes", "/");
        secure.secure = Some(true);
        assert!(cookie_matches(&secure, url()));
        assert!(!cookie_matches(
            &secure,
            CookieUrl {
                scheme: "http",
                ..url()
            }
        ));
        for hostname in ["localhost", "child.localhost"] {
            secure.domain = hostname.into();
            assert!(cookie_matches(
                &secure,
                CookieUrl {
                    scheme: "http",
                    hostname,
                    ..url()
                }
            ));
        }
        secure.domain = "127.0.0.1".into();
        assert!(!cookie_matches(
            &secure,
            CookieUrl {
                scheme: "http",
                hostname: "127.0.0.1",
                ..url()
            }
        ));
    }

    #[test]
    fn decimal_parse_integer_matches_javascript_prefix_and_whitespace_rules() {
        for (value, expected) in [
            ("+12tail", Some(12.0)),
            ("-12.7", Some(-12.0)),
            ("0x10", Some(0.0)),
            ("12e5", Some(12.0)),
            ("\u{feff}0012", Some(12.0)),
            ("\u{0085}12", None),
            ("+", None),
            ("NaN", None),
            ("Infinity", None),
            ("١٢", None),
            ("9007199254740993", Some(9007199254740992.0)),
        ] {
            assert_eq!(javascript_parse_integer(value), expected, "{value}");
        }
        assert_eq!(javascript_parse_integer(&"9".repeat(400)), None);
    }

    #[test]
    fn expires_and_max_age_are_applied_in_order_with_invalid_values_ignored() {
        let mut dates = |value: &str| match value {
            "valid" => Some(12_345.0),
            "ancient" => Some(-1.0),
            "future" => Some(f64::MAX),
            "invalid" => Some(f64::NAN),
            _ => None,
        };
        for (raw, expected) in [
            ("x=y; Max-Age=12tail; Expires=valid", 12.345),
            ("x=y; Expires=valid; Max-Age=12tail", 13.0),
            (
                "x=y; Expires=valid; Expires=invalid; Max-Age=invalid",
                12.345,
            ),
            ("x=y; Expires=invalid; Max-Age=invalid", -1.0),
            ("x=y; Max-Age=-0", 0.0),
            ("x=y; Max-Age=0x100", 0.0),
            ("x=y; Expires=ancient", 0.0),
            ("x=y; Expires=future", MAXIMUM_EXPIRES_SECONDS),
            ("x=y; Max-Age=99999999999999999999", MAXIMUM_EXPIRES_SECONDS),
        ] {
            let parsed = ParsedCookie::parse(raw, 1000.0, &mut dates).unwrap();
            assert_eq!(parsed.expires, expected, "{raw}");
        }
        let raw = format!("x=y; Max-Age={}", "9".repeat(400));
        assert_eq!(
            ParsedCookie::parse(&raw, 1000.0, &mut dates)
                .unwrap()
                .expires,
            -1.0
        );
    }

    #[test]
    fn name_groups_and_replacement_order_survive_empty_groups_until_iteration() {
        let mut jar = jar();
        apply(&mut jar, "first=root; path=/");
        apply(&mut jar, "second=middle; path=/");
        apply(&mut jar, "first=deep; path=/directory");
        assert_eq!(
            header(&mut jar).as_deref(),
            Some("first=root; first=deep; second=middle")
        );
        apply(&mut jar, "first=replaced; path=/");
        assert_eq!(
            header(&mut jar).as_deref(),
            Some("first=deep; first=replaced; second=middle")
        );
        apply(&mut jar, "first=deleted; path=/; Max-Age=0");
        apply(&mut jar, "first=deleted; path=/directory; Max-Age=0");
        apply(&mut jar, "first=new; path=/");
        assert_eq!(
            header(&mut jar).as_deref(),
            Some("first=new; second=middle")
        );
        apply(&mut jar, "first=deleted; path=/; Max-Age=0");
        assert_eq!(header(&mut jar).as_deref(), Some("second=middle"));
        apply(&mut jar, "first=after-read; path=/");
        assert_eq!(
            header(&mut jar).as_deref(),
            Some("second=middle; first=after-read")
        );
    }

    #[test]
    fn expiry_is_strict_and_missing_optional_expiry_remains_session_like() {
        let mut initial = cookie("initial", "value", "/");
        initial.expires = Some(1.0);
        let mut jar = CookieJar::new(
            vec![initial, cookie("missing", "expiry", "/")],
            PairedBudget::testing(1024 * 1024),
            1000.0,
            METHOD,
        )
        .unwrap();
        assert_eq!(jar.all_cookies(1000.0).count(), 2);
        assert_eq!(jar.all_cookies(1000.1).count(), 1);
        let mut session = cookie("session", "value", "/");
        session.expires = Some(-1.0);
        assert!(!expired(&session, f64::MAX));
    }

    #[test]
    fn independent_header_and_original_string_capacity_credits_survive_jar_drop() {
        let budget = PairedBudget::testing(1024 * 1024);
        let mut initial = cookie("initial", "value", "/");
        initial.value.reserve(2048);
        let initial_capacity = initial.value.capacity();
        let mut jar = CookieJar::new(vec![initial], budget.clone(), 1000.0, METHOD).unwrap();
        assert!(budget.retained() >= initial_capacity);
        let header = jar.cookie_header(url(), 1000.0, METHOD).unwrap().unwrap();
        let header_capacity = header.value.capacity();
        drop(jar);
        assert_eq!(budget.retained(), header_capacity);
        assert_eq!(header.value, "initial=value");
        drop(header);
        assert_eq!(budget.retained(), 0);
    }

    #[test]
    fn failed_replacement_and_header_admission_leave_original_cookie_intact() {
        let budget = PairedBudget::testing(1024 * 1024);
        let mut jar = CookieJar::new(
            vec![cookie("session", "original", "/")],
            budget.clone(),
            1000.0,
            METHOD,
        )
        .unwrap();
        let original_retained = budget.retained();
        let blocker = budget
            .reserve(1024 * 1024 - original_retained, METHOD)
            .unwrap();
        let error = jar
            .apply_set_cookie(
                "session=replacement; path=/",
                url(),
                1000.0,
                &mut |_| None,
                METHOD,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
        assert_eq!(jar.all_cookies(1000.0).next().unwrap().value, "original");
        assert_eq!(
            jar.cookie_header(url(), 1000.0, METHOD).err().unwrap().code,
            ErrorCode::ResourceLimit
        );
        drop(blocker);
        assert_eq!(budget.retained(), original_retained);
        apply(&mut jar, "session=replacement; path=/");
        assert_eq!(header(&mut jar).as_deref(), Some("session=replacement"));
        drop(jar);
        assert_eq!(budget.retained(), 0);
    }

    #[test]
    fn maximum_live_cookies_rejects_new_cookie_but_allows_replacement_and_expiry() {
        let budget = PairedBudget::testing(64 * 1024 * 1024);
        let initial = (0..MAXIMUM_COOKIES)
            .map(|index| cookie("session", "value", &format!("/{index}")))
            .collect();
        let mut jar = CookieJar::new(initial, budget.clone(), 1000.0, METHOD).unwrap();
        let original_retained = budget.retained();
        assert_eq!(
            jar.apply_set_cookie("other=value; path=/", url(), 1000.0, &mut |_| None, METHOD)
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(budget.retained(), original_retained);
        apply(&mut jar, "session=replaced; path=/0");
        assert_eq!(jar.all_cookies(1000.0).count(), MAXIMUM_COOKIES);
        apply(&mut jar, "session=deleted; path=/1; Max-Age=0");
        apply(&mut jar, "other=value; path=/");
        assert_eq!(jar.all_cookies(1000.0).count(), MAXIMUM_COOKIES);
        drop(jar);
        assert_eq!(budget.retained(), 0);
    }

    #[test]
    fn expired_full_group_reuses_capacity_before_admitting_a_new_path() {
        let initial = (0..MAXIMUM_COOKIES)
            .map(|index| {
                let mut cookie = cookie("session", "old", &format!("/{index}"));
                cookie.expires = Some(1.0);
                cookie
            })
            .collect();
        let mut jar = CookieJar::new(
            initial,
            PairedBudget::testing(64 * 1024 * 1024),
            1000.0,
            METHOD,
        )
        .unwrap();
        jar.apply_set_cookie("session=new; path=/", url(), 1001.0, &mut |_| None, METHOD)
            .unwrap();
        assert_eq!(jar.all_cookies(1001.0).count(), 1);
        assert_eq!(jar.all_cookies(1001.0).next().unwrap().value, "new");
    }

    #[test]
    fn oversized_set_cookie_is_rejected_before_date_callback_or_jar_mutation() {
        let mut jar = jar();
        let mut calls = 0;
        let error = jar
            .apply_set_cookie(
                &"a".repeat(MAXIMUM_METADATA_BYTES + 1),
                url(),
                1000.0,
                &mut |_| {
                    calls += 1;
                    None
                },
                METHOD,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceLimit);
        assert_eq!(calls, 0);
        assert_eq!(jar.all_cookies(1000.0).count(), 0);
    }
}
