//! Canonical transitions update only their immutable occurrence; extra-info keeps its ingress owner.

use super::*;
use crate::network_observer::{NetworkIngress, NetworkObserver};
use crate::network_request::RequestState;
use crate::network_state::HeaderKind;

struct Terminal {
    occurrence: Occurrence,
    identifier: String,
    unavailable: Option<BodyUnavailable>,
}

pub(super) struct RecordingObserver<'recording> {
    recording: &'recording mut NetworkRecording,
    page: &'recording str,
    terminals: Vec<Terminal>,
}

fn kind_number(kind: HeaderKind) -> u8 {
    match kind {
        HeaderKind::Request => 0,
        HeaderKind::Response => 1,
    }
}

fn bounded_clone(value: &Value) -> Result<Value, JournalError> {
    if crate::network_state::encoded_bytes(value) > 256 * 1024 {
        return Err(JournalError::ResourceLimit(
            "network metadata field exceeds 256 KiB",
        ));
    }
    Ok(value.clone())
}

fn javascript_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn header_array(value: &Value, raw: bool) -> Result<Value, JournalError> {
    bounded_clone(value)?;
    if value.is_array() {
        return Ok(value.clone());
    }
    let Some(headers) = value.as_object() else {
        return Ok(json!([]));
    };
    if headers.len() > 2048 {
        return Err(JournalError::ResourceLimit(
            "network metadata exceeds 2048 headers",
        ));
    }
    let mut result = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        let value = value
            .as_str()
            .ok_or(JournalError::Protocol("network header is not a string"))?;
        let values: Vec<_> = if raw {
            value
                .split('\n')
                .map(|line| line.trim_matches(javascript_whitespace))
                .collect()
        } else {
            vec![value]
        };
        for line in values {
            if result.len() == 2048 {
                return Err(JournalError::ResourceLimit(
                    "network metadata exceeds 2048 headers",
                ));
            }
            result.push(json!({"name":name,"value":line}));
        }
    }
    Ok(Value::Array(result))
}

impl<'recording> RecordingObserver<'recording> {
    pub(super) fn new(recording: &'recording mut NetworkRecording, page: &'recording str) -> Self {
        Self {
            recording,
            page,
            terminals: Vec::new(),
        }
    }

    fn occurrence(&self, identity: &str) -> Occurrence {
        Occurrence {
            page: self.page.into(),
            identity: identity.into(),
        }
    }

    fn run(&mut self, work: impl FnOnce(&mut Self) -> Result<(), JournalError>) {
        if self.recording.journal.failure().is_some() {
            return;
        }
        if let Err(error) = work(self) {
            self.recording.fail(error)
        }
    }

    fn update(
        &mut self,
        identity: &str,
        change: impl FnOnce(&mut Value),
    ) -> Result<(), JournalError> {
        let occurrence = self.occurrence(identity);
        if !self.recording.journal.contains(&occurrence) {
            return Ok(());
        }
        self.recording.journal.update(&occurrence, change)
    }

    fn readiness(&mut self, request: &RequestState) -> Result<(), JournalError> {
        let request_headers = request
            .raw_request_headers
            .as_ref()
            .map(|headers| header_array(headers, true))
            .transpose()?;
        let response_headers = request
            .raw_response_headers
            .as_ref()
            .map(|headers| header_array(headers, true))
            .transpose()?;
        let effective_headers = request
            .interception_headers
            .then(|| header_array(&request.metadata()["headers"], false))
            .transpose()?;
        self.update(request.identity(), |metadata| {
            metadata["requestHeadersReady"] = json!(request.request_headers_ready);
            metadata["responseHeadersReady"] = json!(request.response_headers_ready);
            if metadata["routeDecided"] != true
                && let Some(headers) = effective_headers.or(request_headers)
            {
                metadata["requestHeaders"] = headers;
            }
            if let Some(headers) = response_headers {
                metadata["responseHeaders"] = headers;
            }
            metadata["interceptionHeaders"] = json!(request.interception_headers);
        })
    }

    /// A redirect's successor sets redirectURL before this whole event group appends its predecessor.
    pub(super) fn finish(mut self) -> Vec<BodyJob> {
        let mut jobs = Vec::new();
        for terminal in std::mem::take(&mut self.terminals) {
            self.run(|observer| {
                let Some(work) = observer
                    .recording
                    .journal
                    .complete(&terminal.occurrence, true)?
                else {
                    unreachable!()
                };
                if let Some(reason) = terminal.unavailable {
                    observer.recording.journal.finish_body(
                        &terminal.occurrence,
                        work,
                        BodyOutcome::Unavailable { reason },
                    )?;
                } else {
                    let guard = observer
                        .recording
                        .owners
                        .admit(&terminal.occurrence, &terminal.identifier)?;
                    jobs.push(BodyJob {
                        occurrence: terminal.occurrence,
                        identifier: terminal.identifier,
                        work,
                        guard,
                    });
                }
                Ok(())
            });
        }
        jobs
    }

    fn terminal(
        &mut self,
        event: &NetworkEvent<'_>,
        request: &RequestState,
        retired: bool,
    ) -> Result<(), JournalError> {
        let occurrence = self.occurrence(request.identity());
        if !self.recording.journal.contains(&occurrence) {
            return Ok(());
        }
        self.readiness(request)?;
        let kind = if retired {
            "retired"
        } else if request.failure.is_some() {
            "failed"
        } else {
            "finished"
        };
        let mut terminal = json!({"kind":kind});
        for key in ["timestamp", "encodedDataLength"] {
            if let Some(value) = event.parameters.get(key) {
                terminal[key] = value.clone();
            }
        }
        if request.redirecting {
            terminal
                .as_object_mut()
                .unwrap()
                .remove("encodedDataLength");
        }
        if let Some(error) = &request.failure {
            terminal["errorText"] = json!(error);
        }
        self.update(request.identity(), |metadata| {
            metadata["terminal"] = terminal
        })?;
        let unavailable = if retired {
            Some(BodyUnavailable::OriginalRequestReplaced)
        } else if request.failure.is_some() {
            Some(BodyUnavailable::RequestFailed)
        } else if request
            .response
            .as_ref()
            .and_then(|response| response["status"].as_f64())
            .is_some_and(|status| (300.0..400.0).contains(&status))
        {
            Some(BodyUnavailable::Redirect)
        } else if request.response.is_none() {
            Some(BodyUnavailable::BrowserResourceMissing)
        } else {
            None
        };
        self.terminals.push(Terminal {
            occurrence,
            identifier: request.original_metadata()["identifier"]
                .as_str()
                .unwrap_or_default()
                .into(),
            unavailable,
        });
        Ok(())
    }
}

impl NetworkObserver for RecordingObserver<'_> {
    fn created(
        &mut self,
        _event: &NetworkEvent<'_>,
        _request: &RequestState,
        original: &Value,
        predecessor: Option<&str>,
        _sequence: u64,
        _received_at: Instant,
    ) {
        if let Some(predecessor) = predecessor {
            self.run(|observer| {
                observer.update(predecessor, |metadata| {
                    metadata["redirectURL"] = original["url"].clone()
                })
            });
        }
    }

    fn ready(&mut self, _event: &NetworkEvent<'_>, request: &RequestState) {
        self.run(|observer| {
            let occurrence = observer.occurrence(request.identity());
            let original = request.metadata();
            let headers = header_array(&original["headers"], false)?;
            let mime = headers.as_array().unwrap().iter().find(|header| header["name"].as_str().is_some_and(|name| name.eq_ignore_ascii_case("content-type")))
                .and_then(|header| header["value"].as_str()).unwrap_or("application/octet-stream").to_owned();
            let resource = observer.recording.resources.request(&original["postDataEntries"], mime == "application/x-www-form-urlencoded")?;
            let (timestamp, original_wall_time) = request.original_browser_timing();
            let now = Instant::now();
            let mut metadata = json!({
                "page":observer.page,"frame":original["frame"].as_str().unwrap_or_default(),"identity":request.identity(),
                "nativeTime":native_time(observer.recording.epoch,now),"startedWallTime":wall_time(),
                "originalIngress":{"sequence":request.ingress().sequence,"nativeTime":native_time(observer.recording.epoch,request.ingress().received_at)},
                "originalRequestTimestamp":timestamp,"originalRequestWallTime":original_wall_time,
                "request":{"url":original["url"],"method":original["method"],"resourceType":original["resourceType"].as_str().unwrap_or("Other"),"headers":headers},
                "effectiveRequest":{"url":request.metadata()["url"],"method":request.metadata()["method"]},
                "requestHeadersReady":request.request_headers_ready,"responseHeadersReady":request.response_headers_ready,
                "responseHeadersWallTime":wall_time(),"servedFromCache":request.served_from_cache,"routing":{},"redirectURL":""
            });
            if let Some(resource) = resource { metadata["requestPostData"] = json!({"token":resource.token,"byteLength":resource.byte_length,"mimeType":mime}); }
            observer.recording.journal.create(occurrence, &metadata)?;
            observer.readiness(request)
        });
    }

    fn routed(&mut self, _event: &NetworkEvent<'_>, request: &RequestState) {
        self.run(|observer| {
            observer.readiness(request)?;
            observer.update(request.identity(), |metadata| {
                metadata["effectiveRequest"] = json!({"url":request.metadata()["url"],"method":request.metadata()["method"]});
            })
        });
    }

    fn responded(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        self.run(|observer| {
            if !observer
                .recording
                .journal
                .contains(&observer.occurrence(request.identity()))
            {
                return Ok(());
            }
            let response = bounded_clone(if event.method == "Network.requestWillBeSent" {
                &event.parameters["redirectResponse"]
            } else {
                &event.parameters["response"]
            })?;
            observer.update(request.identity(), |metadata| {
                metadata["response"] = response;
                // An already paired raw header assignment retains its own parse-time clock.
                if metadata.get("responseExtra").is_none() {
                    metadata["responseHeadersWallTime"] = json!(wall_time());
                }
            })?;
            observer.readiness(request)
        });
    }

    fn completed(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        self.run(|observer| observer.terminal(event, request, false));
    }
    fn retired(&mut self, event: &NetworkEvent<'_>, request: &RequestState) {
        self.run(|observer| observer.terminal(event, request, true));
    }
    fn cached(&mut self, _event: &NetworkEvent<'_>, request: &RequestState) {
        self.run(|observer| {
            observer.update(request.identity(), |metadata| {
                metadata["servedFromCache"] = json!(true)
            })
        });
    }

    fn extra_info(&mut self, event: &NetworkEvent<'_>, _identifier: &str, kind: HeaderKind) {
        self.run(|observer| {
            let value = event.parameters.as_object().ok_or(JournalError::Protocol(
                "network extra-info is not an object",
            ))?;
            let bytes = crate::network_state::encoded_bytes(event.parameters);
            if bytes > 256 * 1024 {
                return Err(JournalError::ResourceLimit(
                    "network extra-info exceeds 256 KiB",
                ));
            }
            if observer.recording.extras.len() == 8192 {
                return Err(JournalError::ResourceLimit(
                    "network recording exceeds 8192 unpaired extra-info records",
                ));
            }
            let reservation = observer.recording.budget.reserve(bytes + 256)?;
            let selected = value
                .iter()
                .filter(|(key, _)| key.as_str() != "headers")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            observer.recording.extras.insert(
                (
                    observer.page.into(),
                    kind_number(kind),
                    event.ingress.sequence,
                ),
                RawExtra {
                    value: Value::Object(selected),
                    _reservation: reservation,
                },
            );
            Ok(())
        });
    }

    fn discarded_extra(
        &mut self,
        _event: &NetworkEvent<'_>,
        kind: HeaderKind,
        ingress: NetworkIngress,
    ) {
        self.recording
            .extras
            .remove(&(self.page.into(), kind_number(kind), ingress.sequence));
    }

    fn headers(
        &mut self,
        _event: &NetworkEvent<'_>,
        identity: &str,
        kind: HeaderKind,
        headers: &Value,
        ingress: NetworkIngress,
    ) {
        let extra =
            self.recording
                .extras
                .remove(&(self.page.into(), kind_number(kind), ingress.sequence));
        self.run(|observer| {
            let headers = header_array(headers, true)?;
            observer.update(identity, |metadata| {
                let (field, ready, raw) = match kind {
                    HeaderKind::Request => {
                        ("requestHeaders", "requestHeadersReady", "requestExtra")
                    }
                    HeaderKind::Response => {
                        ("responseHeaders", "responseHeadersReady", "responseExtra")
                    }
                };
                if !matches!(kind, HeaderKind::Request) || metadata["interceptionHeaders"] != true {
                    metadata[field] = headers;
                }
                metadata[ready] = json!(true);
                if let Some(extra) = extra {
                    metadata[raw] = extra.value;
                    if matches!(kind, HeaderKind::Response) {
                        metadata["responseHeadersWallTime"] = json!(wall_time());
                    }
                }
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event<'value>(
        method: &'value str,
        parameters: &'value Value,
        sequence: u64,
    ) -> NetworkEvent<'value> {
        NetworkEvent {
            session_identifier: "",
            method,
            parameters,
            ingress: NetworkIngress {
                sequence,
                received_at: Instant::now(),
            },
        }
    }

    fn request(url: &str) -> Value {
        json!({"requestId":"shared","frameId":"frame","type":"Document","timestamp":2.0,"wallTime":3.0,"request":{"url":url,"method":"GET","headers":{"X-Original":" first\nsecond "}}})
    }

    #[test]
    fn header_normalization_matches_javascript_only_for_raw_extra_info() {
        let object = json!({"X-Test":" \u{feff}first \n \u{0085}second "});
        assert_eq!(
            header_array(&object, false).unwrap(),
            json!([{"name":"X-Test","value":" \u{feff}first \n \u{0085}second "}])
        );
        assert_eq!(
            header_array(&object, true).unwrap(),
            json!([{"name":"X-Test","value":"first"},{"name":"X-Test","value":"\u{0085}second"}])
        );
    }

    #[test]
    fn redirect_group_seals_successor_url_and_original_response_before_new_body_work() {
        let mut network = NetworkRecording::new(Instant::now(), Arc::new(NetworkBudget::default()));
        let mut state = DocumentState::default();
        network.observe_group(
            "page",
            &mut state,
            event(
                "Network.requestWillBeSent",
                &request("https://example.test/first"),
                1,
            ),
        );
        let mut redirected = request("https://example.test/second");
        redirected["redirectResponse"] = json!({"url":"https://example.test/first","status":302,"statusText":"Found","headers":{"Location":"/not-the-successor"},"protocol":"http/1.1"});
        let (_, jobs) = network.observe_group(
            "page",
            &mut state,
            event("Network.requestWillBeSent", &redirected, 2),
        );
        assert!(jobs.is_empty());
        let prefix = network.seal().unwrap();
        let first = prefix.entry(0).unwrap();
        assert_eq!(
            first["metadata"]["redirectURL"],
            "https://example.test/second"
        );
        assert_eq!(
            first["metadata"]["request"]["url"],
            "https://example.test/first"
        );
        assert_eq!(first["metadata"]["response"]["protocol"], "http/1.1");
        assert_eq!(first["body"]["reason"], "redirect");
        assert!(
            first["metadata"]["terminal"]
                .get("encodedDataLength")
                .is_none()
        );
        assert_eq!(
            prefix.entry(1).unwrap()["metadata"]["request"]["url"],
            "https://example.test/second"
        );
    }

    #[test]
    fn delayed_extra_info_uses_original_ingress_and_never_mutates_a_sealed_prefix() {
        let mut network = NetworkRecording::new(Instant::now(), Arc::new(NetworkBudget::default()));
        let mut state = DocumentState::default();
        network.observe_group(
            "page",
            &mut state,
            event(
                "Network.requestWillBeSent",
                &request("https://example.test/data"),
                1,
            ),
        );
        let raw = json!({"requestId":"shared","headers":{"X-Raw":" first\nsecond "},"headersText":"HTTP/1.1 200 OK\r\nX-Raw: first\r\n\r\n","statusCode":299});
        network.observe_group(
            "page",
            &mut state,
            event("Network.responseReceivedExtraInfo", &raw, 2),
        );
        let prefix = network.seal().unwrap();
        let response = json!({"requestId":"shared","hasExtraInfo":true,"response":{"status":200,"statusText":"OK","headers":{"Content-Type":"text/plain"},"protocol":"h2"}});
        network.observe_group(
            "page",
            &mut state,
            event("Network.responseReceived", &response, 3),
        );
        let original = prefix.entry(0).unwrap();
        assert!(original["metadata"].get("response").is_none());
        assert_eq!(original["body"]["kind"], "pending");
        let (_, mut jobs) = network.observe_group(
            "page",
            &mut state,
            event(
                "Network.loadingFinished",
                &json!({"requestId":"shared","timestamp":2.25,"encodedDataLength":90}),
                4,
            ),
        );
        let job = jobs.pop().unwrap();
        assert!(jobs.is_empty());
        let current = network.seal().unwrap();
        assert_eq!(current.entry(0).unwrap(), original);
        assert_eq!(current.prefix.versions.len(), 1);
        network
            .journal
            .finish_body(
                &job.occurrence,
                job.work,
                BodyOutcome::Unavailable {
                    reason: BodyUnavailable::BrowserResourceMissing,
                },
            )
            .unwrap();
        // The request header extra is still pending, so body settlement alone cannot finalize metadata.
        assert_eq!(network.seal().unwrap().prefix.versions.len(), 1);
        network.observe_group(
            "page",
            &mut state,
            event(
                "Network.requestWillBeSentExtraInfo",
                &json!({"requestId":"shared","headers":{"X-Request":" final "}}),
                5,
            ),
        );
        let completed = network.seal().unwrap().entry(1).unwrap();
        assert_eq!(completed["metadata"]["response"]["status"], 200);
        assert_eq!(completed["metadata"]["responseExtra"]["statusCode"], 299);
        assert_eq!(
            completed["metadata"]["responseExtra"]["headersText"],
            raw["headersText"]
        );
        assert_eq!(
            completed["metadata"]["responseHeaders"],
            json!([{"name":"X-Raw","value":"first"},{"name":"X-Raw","value":"second"}])
        );
        assert_eq!(prefix.entry(0).unwrap(), original);
    }
}
