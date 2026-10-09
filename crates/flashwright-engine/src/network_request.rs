//! Immutable browser request observations remain separate from effective routing metadata.

use crate::network_observer::{NetworkEvent, NetworkIngress};
use serde_json::{Value, json};

struct RequestOccurrence {
    identity: String,
    metadata: Value,
    predecessor: Option<String>,
    ingress: NetworkIngress,
    timestamp: Option<f64>,
    wall_time: Option<f64>,
}

pub(crate) struct RequestState {
    occurrence: RequestOccurrence,
    pub effective_metadata: Option<Value>,
    pub(crate) awaiting_interception: bool,
    pub(crate) publicly_ready: bool,
    pub(crate) interception_headers: bool,
    pub response: Option<Value>,
    pub finished: bool,
    pub(crate) redirecting: bool,
    pub failure: Option<String>,
    pub(crate) raw_request_headers: Option<Value>,
    pub(crate) raw_response_headers: Option<Value>,
    pub(crate) request_headers_ready: bool,
    pub(crate) response_headers_ready: bool,
    pub(crate) served_from_cache: bool,
    pub(crate) retained_bytes: usize,
}

impl RequestState {
    /// Capture byte entries directly; Chromium's text field is not a lossless byte encoding.
    #[cfg(test)]
    pub(crate) fn new(identifier: &str, sequence: u64, parameters: &Value) -> Self {
        Self::from_event(
            identifier,
            sequence,
            &NetworkEvent {
                method: "Network.requestWillBeSent",
                parameters,
                ingress: NetworkIngress {
                    sequence,
                    received_at: std::time::Instant::now(),
                },
            },
            None,
        )
    }

    pub(crate) fn from_event(
        identifier: &str,
        sequence: u64,
        event: &NetworkEvent<'_>,
        predecessor: Option<String>,
    ) -> Self {
        let parameters = event.parameters;
        let identity = format!("{identifier}:{sequence}");
        let request = &parameters["request"];
        let post_data_entries: Vec<&str> = request["postDataEntries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry["bytes"].as_str())
            .filter(|bytes| !bytes.is_empty())
            .collect();
        let metadata = json!({
            "identifier": identifier,
            "identity": identity,
            "redirectedFrom": predecessor,
            "url": request["url"],
            "method": request["method"],
            "headers": request["headers"],
            "postDataEntries": if post_data_entries.is_empty() { None } else { Some(post_data_entries) },
            "resourceType": parameters["type"],
            "frame": parameters["frameId"],
            "loader": parameters["loaderId"],
            "navigation": parameters["type"] == "Document" && parameters["requestId"] == parameters["loaderId"],
        });
        let retained_bytes = crate::network_state::encoded_bytes(&metadata)
            + predecessor
                .as_ref()
                .map_or(0, crate::network_state::encoded_bytes);
        Self {
            occurrence: RequestOccurrence {
                identity,
                metadata,
                predecessor,
                ingress: event.ingress,
                timestamp: parameters["timestamp"].as_f64(),
                wall_time: parameters["wallTime"].as_f64(),
            },
            effective_metadata: None,
            awaiting_interception: false,
            publicly_ready: false,
            interception_headers: false,
            response: None,
            finished: false,
            redirecting: false,
            failure: None,
            raw_request_headers: None,
            raw_response_headers: None,
            request_headers_ready: false,
            response_headers_ready: false,
            served_from_cache: false,
            retained_bytes,
        }
    }

    /// The owner never changes when public metadata reflects continuation overrides.
    pub(crate) fn identity(&self) -> &str {
        &self.occurrence.identity
    }

    /// Later lifecycle messages reference the already published occurrence without copying its body.
    pub(crate) fn reference(&self) -> Value {
        json!({"identifier": self.occurrence.metadata["identifier"], "identity": self.identity()})
    }

    pub(crate) fn original_metadata(&self) -> &Value {
        &self.occurrence.metadata
    }
    pub(crate) fn predecessor(&self) -> Option<&str> {
        self.occurrence.predecessor.as_deref()
    }
    pub(crate) fn ingress(&self) -> NetworkIngress {
        self.occurrence.ingress
    }

    /// Browser timing survives the delayed Fetch join without mixing it with the native clock.
    pub(crate) fn original_browser_timing(&self) -> (Option<f64>, Option<f64>) {
        (self.occurrence.timestamp, self.occurrence.wall_time)
    }

    /// An unmodified request borrows its original observation without another metadata copy.
    pub(crate) fn metadata(&self) -> &Value {
        self.effective_metadata
            .as_ref()
            .unwrap_or(&self.occurrence.metadata)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_bytes_and_owner_survive_effective_metadata_changes() {
        let mut request = RequestState::new(
            "request",
            42,
            &json!({"requestId":"request", "request":{
                "url":"https://example.test/original", "method":"POST",
                "postData":"\u{0000}\u{00ff}\u{0080}\n",
                "postDataEntries":[{"bytes":"AP+ACg=="},{"bytes":""},{}]
            }}),
        );
        assert_eq!(request.metadata()["postDataEntries"], json!(["AP+ACg=="]));
        assert!(request.metadata().get("postData").is_none());
        let original = request.metadata().clone();
        let mut effective = original.clone();
        effective["url"] = json!("https://example.test/effective");
        effective["identity"] = json!("not-the-owner");
        effective["postDataEntries"] = json!(["/wCADQ=="]);
        request.effective_metadata = Some(effective);
        assert_eq!(request.identity(), "request:42");
        assert_eq!(request.occurrence.metadata, original);
        assert_eq!(request.metadata()["url"], "https://example.test/effective");
    }

    #[test]
    fn empty_or_unavailable_byte_entries_do_not_invent_a_text_body() {
        for body in [
            json!({"postData":"unavailable bytes"}),
            json!({"postDataEntries":[]}),
            json!({"postDataEntries":[{}, {"bytes":""}]}),
        ] {
            let request = RequestState::new("request", 1, &json!({"request":body}));
            assert_eq!(request.metadata()["postDataEntries"], Value::Null);
        }
    }
}
