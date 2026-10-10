//! Complete HTTP attempts share the original operation deadline and request-context owner.

use super::cookie_jar::CookieUrl;
use super::exchange::{self, Failure, Header};
use super::options::{CredentialSend, HttpCredentials};
use super::registry::RequestContext;
use super::trace::{self, TraceCapture};
use super::unix_milliseconds;
use crate::{Engine, Operation};
use bytes::Bytes;
use flashwright_protocol::attachment::encode_base64;
use flashwright_protocol::{ErrorCode, ErrorRecord, InputAttachment};
use http::{HeaderName, HeaderValue, Method, Request};
use http_body_util::Full;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use url::Url;

const METHOD: &str = "apiRequest.fetch";
const MAXIMUM_REQUEST_METADATA: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FetchOptions {
    context: String,
    url: String,
    method: String,
    #[serde(default)]
    headers: Vec<Header>,
    #[serde(default = "default_redirects")]
    max_redirects: u32,
    #[serde(default)]
    max_retries: u32,
    #[serde(default)]
    fail_on_status_code: bool,
    #[serde(default, rename = "ignoreHTTPSErrors")]
    ignore_https_errors: bool,
    has_body: bool,
    #[serde(default)]
    trace: Option<TraceCapture>,
}

fn default_redirects() -> u32 {
    20
}

struct InputBytes(Arc<InputAttachment>);
impl AsRef<[u8]> for InputBytes {
    fn as_ref(&self) -> &[u8] {
        self.0.bytes.as_slice()
    }
}

struct RequestHeaders {
    values: Vec<Header>,
    // Jar-generated headers survive an original request's authentication/reset retries.
    _cookie_copy: Option<super::budget::PairedReservation>,
}

struct InitialRequest<'value> {
    url: Url,
    method: Method,
    response_identifier: &'value str,
}

impl Engine {
    pub(crate) async fn api_fetch(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<Value, ErrorRecord> {
        let options: FetchOptions =
            serde_json::from_value(parameters).map_err(|error| invalid(error.to_string()))?;
        let context = self.api_requests.context(&options.context, METHOD)?;
        if options
            .trace
            .as_ref()
            .is_some_and(|capture| !capture.valid())
        {
            return Err(invalid("invalid API trace attempt identity"));
        }
        let mut metadata_bytes = options
            .url
            .capacity()
            .saturating_add(options.method.capacity())
            .saturating_add(
                options
                    .headers
                    .capacity()
                    .saturating_mul(size_of::<Header>()),
            );
        for header in &options.headers {
            metadata_bytes = metadata_bytes
                .saturating_add(header.name.capacity())
                .saturating_add(header.value.capacity());
        }
        if options.headers.len() > 4096 || metadata_bytes > MAXIMUM_REQUEST_METADATA {
            return Err(resource("API request options exceed 1 MiB or 4096 headers"));
        }
        let context_metadata_bytes = context.options.retained_bytes();
        // Owned options, merged headers, URLs and their simultaneous replacements.
        let _metadata = context.budget.metadata.reserve(
            metadata_bytes
                .saturating_add(context_metadata_bytes)
                .saturating_mul(4)
                .saturating_add(64 * 1024),
            METHOD,
        )?;
        let original_url = parse_url(&options.url)?;
        let original_method = Method::from_bytes(options.method.as_bytes())
            .map_err(|_| invalid("invalid HTTP method"))?;
        let body = match (options.has_body, operation.shared_input_attachment()) {
            (false, Some(_)) => return Err(invalid("binary input requires hasBody")),
            (_, Some(attachment)) => Bytes::from_owner(InputBytes(attachment)),
            (_, None) => Bytes::new(),
        };
        let mut headers = vec![
            Header {
                name: "user-agent".into(),
                value: context
                    .options
                    .user_agent
                    .clone()
                    .unwrap_or_else(|| "Flashwright/0.0.0".into()),
            },
            Header {
                name: "accept".into(),
                value: "*/*".into(),
            },
            Header {
                name: "accept-encoding".into(),
                value: "gzip,deflate,br".into(),
            },
        ];
        for header in context
            .options
            .extra_http_headers
            .iter()
            .chain(&options.headers)
        {
            set_header(&mut headers, &header.name, header.value.clone());
        }
        if let Some(credentials) = credentials(&context, &original_url)
            .filter(|credentials| credentials.send == CredentialSend::Always)
        {
            authorize(&mut headers, &credentials.username, &credentials.password);
        }
        if options.has_body {
            set_header(&mut headers, "content-length", body.len().to_string());
        }
        let mut headers = RequestHeaders {
            values: headers,
            _cookie_copy: None,
        };
        let response_identifier = self.identifier("api-response");
        operation
            .wait(context.while_alive(METHOD, async {
                let mut attempt = 0u32;
                loop {
                    let result = request_chain(
                        self,
                        &context,
                        &options,
                        InitialRequest {
                            url: original_url.clone(),
                            method: original_method.clone(),
                            response_identifier: &response_identifier,
                        },
                        &mut headers,
                        body.clone(),
                        operation,
                    )
                    .await;
                    match result {
                        Ok((url, metadata, body)) => {
                            operation.check()?;
                            if options.fail_on_status_code && !(200..400).contains(&metadata.status)
                            {
                                return Err(status_error(
                                    metadata.status,
                                    &metadata.status_text,
                                    &body.bytes,
                                ));
                            }
                            return context.retain_response(
                                response_identifier,
                                url,
                                metadata,
                                body,
                                options
                                    .trace
                                    .as_ref()
                                    .map(|capture| capture.generation.as_str()),
                            );
                        }
                        Err(failure)
                            if failure.connection_reset && attempt < options.max_retries =>
                        {
                            // Node's timer uses one millisecond after its signed-32-bit delay overflows.
                            let delay = Duration::from_millis(if attempt < 24 {
                                250u64 << attempt
                            } else {
                                1
                            });
                            attempt += 1;
                            tokio::time::sleep(delay).await;
                        }
                        Err(failure) => return Err(failure.error),
                    }
                }
            }))
            .await
    }
}

async fn request_chain(
    engine: &Engine,
    context: &Arc<RequestContext>,
    options: &FetchOptions,
    initial_request: InitialRequest<'_>,
    original_headers: &mut RequestHeaders,
    mut body: Bytes,
    operation: &Operation,
) -> Result<
    (
        String,
        exchange::ResponseMetadata,
        Arc<super::budget::RetainedBody>,
    ),
    Failure,
> {
    let InitialRequest {
        mut url,
        mut method,
        response_identifier,
    } = initial_request;
    let mut redirects = 0u32;
    let mut redirect_headers: Option<RequestHeaders> = None;
    loop {
        operation.check()?;
        context.check(METHOD)?;
        let headers = redirect_headers.as_mut().unwrap_or(&mut *original_headers);
        let cookie = if header(&headers.values, "cookie").is_none() {
            context
                .cookies
                .lock()
                .expect("API cookies lock")
                .cookie_header(cookie_url(&url), unix_milliseconds(), METHOD)?
        } else {
            None
        };
        if let Some(cookie) = &cookie {
            let reservation = context.budget.metadata.reserve(
                cookie
                    .as_str()
                    .len()
                    .saturating_mul(4)
                    .saturating_add(
                        headers
                            .values
                            .capacity()
                            .saturating_mul(size_of::<Header>())
                            .saturating_mul(2),
                    )
                    .saturating_add(1024),
                METHOD,
            )?;
            set_header(&mut headers.values, "cookie", cookie.as_str().to_owned());
            headers._cookie_copy = Some(reservation);
        }
        let head_bytes = headers
            .values
            .iter()
            .fold(url.as_str().len(), |total, field| {
                total
                    .saturating_add(field.name.len())
                    .saturating_add(field.value.len())
                    .saturating_add(512)
            });
        let _head_workspace = context
            .budget
            .metadata
            .reserve(head_bytes.saturating_mul(4).saturating_add(4096), METHOD)?;
        let mut outgoing = headers.values.clone();
        if header(&outgoing, "authorization").is_none()
            && (!url.username().is_empty() || url.password().is_some())
        {
            let username = percent_encoding::percent_decode_str(url.username())
                .decode_utf8()
                .map_err(|_| invalid("invalid URL username encoding"))?;
            let password = percent_encoding::percent_decode_str(url.password().unwrap_or(""))
                .decode_utf8()
                .map_err(|_| invalid("invalid URL password encoding"))?;
            authorize(&mut outgoing, &username, &password);
        }
        let request = build_request(&url, method.clone(), &outgoing, body.clone())?;
        let attempt = options
            .trace
            .as_ref()
            .map(|_| engine.identifier("api-attempt"));
        let request_method = options.trace.as_ref().map(|_| method.to_string());
        let request_body_size = body.len();
        let started_wall_time = super::unix_milliseconds();
        let started = Instant::now();
        let exchange = exchange::start(
            context.client(options.ignore_https_errors),
            request,
            &context.budget,
            || operation.check(),
        )
        .await;
        let exchange = match exchange {
            Ok(exchange) => exchange,
            Err(error) => {
                if let (Some(capture), Some(attempt)) = (&options.trace, &attempt) {
                    trace::record_failed_attempt(
                        engine,
                        context,
                        capture,
                        trace::FailedAttempt {
                            identifier: attempt,
                            url: url.as_str(),
                            method: request_method.as_deref().unwrap_or(method.as_str()),
                            request_headers: &outgoing,
                            request_body_size,
                            started_wall_time,
                        },
                    )
                    .await;
                }
                return Err(error);
            }
        };
        engine
            .apply_api_cookies(
                context,
                &exchange.metadata.headers,
                cookie_url(&url),
                operation,
            )
            .await?;
        if matches!(exchange.metadata.status, 301 | 302 | 303 | 307 | 308)
            && options.max_redirects != 0
        {
            if redirects == options.max_redirects {
                if let (Some(capture), Some(attempt)) = (&options.trace, &attempt) {
                    trace::record_attempt(
                        engine,
                        context,
                        capture,
                        trace::WireAttempt {
                            identifier: attempt,
                            url: url.as_str(),
                            method: request_method.as_deref().unwrap_or(method.as_str()),
                            request_headers: &outgoing,
                            request_body_size,
                            response: &exchange.metadata,
                            response_body_size: None,
                            response_identifier: None,
                            started_wall_time,
                            started,
                        },
                    )
                    .await;
                }
                return Err(request_error("Max redirect count exceeded").into());
            }
            if let Some(location) = exchange
                .metadata
                .first("location")
                .filter(|location| !location.is_empty())
            {
                let location_bytes = location
                    .chars()
                    .map(|character| character as u8)
                    .collect::<Vec<_>>();
                let location = String::from_utf8_lossy(&location_bytes);
                let next = url
                    .join(&location)
                    .map_err(|_| request_error("invalid redirect URL"))?;
                require_http(&next)?;
                // Redirects own a child option set; only mutations on the original
                // request survive the outer connection-reset retry.
                let mut next_headers = headers.values.clone();
                if ((exchange.metadata.status == 301 || exchange.metadata.status == 302)
                    && method == Method::POST)
                    || (exchange.metadata.status == 303
                        && method != Method::GET
                        && method != Method::HEAD)
                {
                    method = Method::GET;
                    body = Bytes::new();
                    for name in [
                        "content-encoding",
                        "content-language",
                        "content-length",
                        "content-location",
                        "content-type",
                    ] {
                        remove_header(&mut next_headers, name);
                    }
                }
                remove_header(&mut next_headers, "cookie");
                if url.origin() != next.origin() {
                    remove_header(&mut next_headers, "authorization");
                }
                if next_headers.iter().any(|field| field.name == "host") {
                    set_header(&mut next_headers, "host", authority(&next));
                }
                redirect_headers = Some(RequestHeaders {
                    values: next_headers,
                    _cookie_copy: None,
                });
                redirects += 1;
                if let (Some(capture), Some(attempt)) = (&options.trace, &attempt) {
                    trace::record_attempt(
                        engine,
                        context,
                        capture,
                        trace::WireAttempt {
                            identifier: attempt,
                            url: url.as_str(),
                            method: request_method.as_deref().unwrap_or(method.as_str()),
                            request_headers: &outgoing,
                            request_body_size,
                            response: &exchange.metadata,
                            response_body_size: None,
                            response_identifier: None,
                            started_wall_time,
                            started,
                        },
                    )
                    .await;
                }
                url = next;
                drop(exchange);
                continue;
            }
        }
        if exchange.metadata.status == 401
            && header(&headers.values, "authorization").is_none_or(str::is_empty)
            && exchange
                .metadata
                .first("www-authenticate")
                .is_some_and(|value| value.trim().starts_with("Basic"))
            && let Some(credentials) = credentials(context, &url)
        {
            if let (Some(capture), Some(attempt)) = (&options.trace, &attempt) {
                trace::record_attempt(
                    engine,
                    context,
                    capture,
                    trace::WireAttempt {
                        identifier: attempt,
                        url: url.as_str(),
                        method: request_method.as_deref().unwrap_or(method.as_str()),
                        request_headers: &outgoing,
                        request_body_size,
                        response: &exchange.metadata,
                        response_body_size: None,
                        response_identifier: None,
                        started_wall_time,
                        started,
                    },
                )
                .await;
            }
            authorize(
                &mut headers.values,
                &credentials.username,
                &credentials.password,
            );
            drop(exchange);
            continue;
        }
        let finished = exchange.finish(&context.budget, || operation.check()).await;
        let (metadata, body) = match finished {
            Ok(finished) => finished,
            Err(error) => {
                if let (Some(capture), Some(attempt)) = (&options.trace, &attempt) {
                    trace::record_failed_attempt(
                        engine,
                        context,
                        capture,
                        trace::FailedAttempt {
                            identifier: attempt,
                            url: url.as_str(),
                            method: request_method.as_deref().unwrap_or(method.as_str()),
                            request_headers: &outgoing,
                            request_body_size,
                            started_wall_time,
                        },
                    )
                    .await;
                }
                return Err(error);
            }
        };
        if let (Some(capture), Some(attempt)) = (&options.trace, &attempt) {
            trace::record_attempt(
                engine,
                context,
                capture,
                trace::WireAttempt {
                    identifier: attempt,
                    url: url.as_str(),
                    method: request_method.as_deref().unwrap_or(method.as_str()),
                    request_headers: &outgoing,
                    request_body_size,
                    response: &metadata,
                    response_body_size: Some(body.bytes.len()),
                    response_identifier: Some(response_identifier),
                    started_wall_time,
                    started,
                },
            )
            .await;
        }
        return Ok((url.to_string(), metadata, body));
    }
}

fn build_request(
    url: &Url,
    method: Method,
    headers: &[Header],
    body: Bytes,
) -> Result<Request<Full<Bytes>>, ErrorRecord> {
    let mut destination = url.clone();
    destination.set_fragment(None);
    let _ = destination.set_username("");
    let _ = destination.set_password(None);
    let mut request = Request::builder()
        .method(method)
        .uri(destination.as_str())
        .body(Full::new(body))
        .map_err(|error| invalid(error.to_string()))?;
    for field in headers {
        let name = HeaderName::from_bytes(field.name.as_bytes())
            .map_err(|_| invalid("invalid HTTP header name"))?;
        let bytes = field
            .value
            .chars()
            .map(|character| {
                u8::try_from(character as u32)
                    .map_err(|_| invalid("HTTP header values must be Latin-1"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let value =
            HeaderValue::from_bytes(&bytes).map_err(|_| invalid("invalid HTTP header value"))?;
        request.headers_mut().insert(name, value);
    }
    Ok(request)
}

fn parse_url(value: &str) -> Result<Url, ErrorRecord> {
    let url = Url::parse(value).map_err(|error| invalid(error.to_string()))?;
    require_http(&url)?;
    Ok(url)
}
fn require_http(url: &Url) -> Result<(), ErrorRecord> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid("API request URL must use HTTP or HTTPS"));
    }
    Ok(())
}
fn cookie_url(url: &Url) -> CookieUrl<'_> {
    CookieUrl {
        scheme: url.scheme(),
        hostname: url.host_str().unwrap_or(""),
        pathname: url.path(),
    }
}
fn credentials<'context>(
    context: &'context RequestContext,
    url: &Url,
) -> Option<&'context HttpCredentials> {
    context
        .options
        .http_credentials
        .as_ref()
        .filter(|credentials| {
            credentials.origin.as_ref().is_none_or(|origin| {
                origin.eq_ignore_ascii_case(&url.origin().ascii_serialization())
            })
        })
}
fn authority(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or("")),
        None => url.host_str().unwrap_or("").to_owned(),
    }
}
fn header<'headers>(headers: &'headers [Header], name: &str) -> Option<&'headers str> {
    headers
        .iter()
        .find(|field| field.name.eq_ignore_ascii_case(name))
        .map(|field| field.value.as_str())
}
fn set_header(headers: &mut Vec<Header>, name: &str, value: String) {
    if let Some(field) = headers
        .iter_mut()
        .find(|field| field.name.eq_ignore_ascii_case(name))
    {
        field.value = value;
    } else {
        headers.push(Header {
            name: name.to_owned(),
            value,
        });
    }
}
fn remove_header(headers: &mut Vec<Header>, name: &str) {
    headers.retain(|field| !field.name.eq_ignore_ascii_case(name));
}
fn authorize(headers: &mut Vec<Header>, username: &str, password: &str) {
    set_header(
        headers,
        "authorization",
        format!(
            "Basic {}",
            encode_base64(format!("{username}:{password}").as_bytes())
        ),
    );
}
fn invalid(message: impl Into<String>) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::InvalidArgument, METHOD, message)
}
fn resource(message: impl Into<String>) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::ResourceLimit, METHOD, message)
}
fn request_error(message: impl Into<String>) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Request, METHOD, message)
}

/// Match Buffer UTF-8 decoding and JavaScript's UTF-16 substring boundary without
/// decoding an entire retained body just to show its first thousand code units.
fn status_error(status: u16, status_text: &str, body: &[u8]) -> ErrorRecord {
    let prefix = format!("{status} {status_text}");
    if body.is_empty() {
        return request_error(prefix);
    }
    // Every decoded UTF-16 unit consumes at most three UTF-8 bytes. This prefix
    // therefore includes the truncation decision and cannot split a kept unit.
    let decoded = String::from_utf8_lossy(&body[..body.len().min(4096)]);
    let mut preview: Vec<u16> = decoded.encode_utf16().take(1001).collect();
    if preview.len() > 1000 {
        preview.truncate(997);
        preview.extend_from_slice(&[46, 46, 46]);
    }
    let mut message: Vec<u16> = prefix
        .encode_utf16()
        .chain("\nResponse text:\n".encode_utf16())
        .collect();
    message.extend_from_slice(&preview);
    match String::from_utf16(&message) {
        Ok(message) => request_error(message),
        Err(_) => {
            let mut error = request_error(String::from_utf16_lossy(&message));
            error.message_utf16 = Some(message.into_boxed_slice());
            error
        }
    }
}

#[cfg(test)]
mod status_tests {
    use super::status_error;
    #[test]
    fn preview_truncates_at_exact_javascript_boundary_and_preserves_split_surrogate() {
        let exact = "a".repeat(1000);
        assert_eq!(
            &*status_error(500, "Failure", exact.as_bytes()).message,
            format!("500 Failure\nResponse text:\n{exact}")
        );
        assert_eq!(
            &*status_error(500, "Failure", (exact + "b").as_bytes()).message,
            format!("500 Failure\nResponse text:\n{}...", "a".repeat(997))
        );
        let split = status_error(
            500,
            "Failure",
            format!("{}😀tail", "a".repeat(996)).as_bytes(),
        );
        let units = split.message_utf16.as_ref().unwrap();
        assert_eq!(&units[units.len() - 4..], &[0xd83d, 46, 46, 46]);
    }
    #[test]
    fn preview_keeps_empty_body_distinct_and_bounds_large_multibyte_decoding() {
        assert_eq!(&*status_error(404, "Absent", b"").message, "404 Absent");
        assert_eq!(
            &*status_error(500, "Failure", "界".repeat(10000).as_bytes()).message,
            format!("500 Failure\nResponse text:\n{}...", "界".repeat(997))
        );
        assert!(
            status_error(500, "Failure", &[0xff, 0xc3, 0xa9])
                .message
                .ends_with("�é")
        );
    }
}
