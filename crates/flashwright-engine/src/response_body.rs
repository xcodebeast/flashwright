//! Response payload ownership survives completion waits and attachment admission.

use super::*;
use flashwright_browser::Connection;
use std::future::Future;

impl Engine {
    pub(crate) async fn response_body(
        &self,
        parameters: Value,
        operation: &Operation,
    ) -> Result<BinaryAttachment, ErrorRecord> {
        let method = "response.body";
        validate_keys(method, &parameters, &["page", "request", "requestIdentity"])?;
        let page = self.page(identifier(&parameters, "page", method)?, method)?;
        let context = self.context(&page.context_identifier, method)?;
        let browser = self.browser(&context.browser_identifier, method)?;
        let request_identifier = identifier(&parameters, "request", method)?;
        let occurrence_identity = identifier(&parameters, "requestIdentity", method)?;
        read_body_for_occurrence(
            &page,
            &browser.connection,
            request_identifier,
            occurrence_identity,
            self.attachment_slots.clone(),
            self.maximum_attachment_bytes,
            operation,
        )
        .await
    }
}

/// Validate the original occurrence at every asynchronous handoff before publishing bytes.
pub(crate) async fn read_body_for_occurrence(
    page: &Page,
    connection: &Connection,
    request_identifier: &str,
    occurrence_identity: &str,
    attachment_slots: Arc<tokio::sync::Semaphore>,
    maximum_attachment_bytes: usize,
    operation: &Operation,
) -> Result<BinaryAttachment, ErrorRecord> {
    let method = "response.body";
    let mut changes = page.state.changed.subscribe();
    loop {
        {
            check_original_source(page, request_identifier, occurrence_identity)?;
            let state = page.state.state.lock().unwrap();
            let request =
                state.request_for_occurrence(request_identifier, occurrence_identity, method)?;
            if let Some(error) = &request.failure {
                return Err(ErrorRecord::new(ErrorCode::Navigation, method, error));
            }
            if request.finished {
                break;
            }
        }
        operation
            .wait(async { changes.changed().await.map_err(|_| closed(method)) })
            .await?;
    }
    let reservation = operation
        .wait(while_original_request(
            page,
            request_identifier,
            occurrence_identity,
            async {
                attachment_slots
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| closed(method))
            },
        ))
        .await?;
    let source = check_original_source(page, request_identifier, occurrence_identity)?;
    let payload = operation
        .wait(while_original_request(
            page,
            request_identifier,
            occurrence_identity,
            connection.response_body(
                &source.identifier,
                &source.session,
                maximum_attachment_bytes,
            ),
        ))
        .await
        .map_err(|mut error| {
            error.method = method.into();
            error
        })?;
    operation.check()?;
    check_original_source(page, request_identifier, occurrence_identity)?;
    Ok(BinaryAttachment::from_payload(payload, reservation))
}

fn check_original_source(
    page: &Page,
    identifier: &str,
    identity: &str,
) -> Result<crate::network_request::RequestSource, ErrorRecord> {
    let state = page.state.state.lock().unwrap();
    let request = state.request_for_occurrence(identifier, identity, "response.body")?;
    let source = request.response_source();
    if !state.requests.owns_response(request) {
        return Err(invalid(
            "response.body",
            "original response identifier was replaced in its renderer",
        ));
    }
    if !request.awaiting_response_renderer
        && !page
            .state
            .renderer_sessions
            .lock()
            .unwrap()
            .get(&source.session)
            .is_some_and(|renderer| !renderer.is_retired() && !renderer.is_destroyed())
    {
        return Err(closed("response.body"));
    }
    Ok(source)
}

/// Retiring an occurrence ends queued or dispatched reads without waiting for unrelated capacity.
async fn while_original_request<T>(
    page: &Page,
    request_identifier: &str,
    occurrence_identity: &str,
    future: impl Future<Output = Result<T, ErrorRecord>>,
) -> Result<T, ErrorRecord> {
    let method = "response.body";
    let mut changes = page.state.changed.subscribe();
    tokio::pin!(future);
    loop {
        check_original_source(page, request_identifier, occurrence_identity)?;
        tokio::select! {
            result = &mut future => {
                check_original_source(page, request_identifier, occurrence_identity)?;
                return result;
            }
            changed = changes.changed() => changed.map_err(|_| closed(method))?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{Future, poll_fn};
    use std::task::Poll;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
    use tokio::sync::{Semaphore, watch};
    use tokio::time::{Duration, timeout};

    struct Peer {
        reader: BufReader<ReadHalf<DuplexStream>>,
        writer: WriteHalf<DuplexStream>,
    }

    impl Peer {
        /// Observe actual serialized CDP commands from the body operation.
        async fn command(&mut self) -> Value {
            let mut bytes = Vec::new();
            timeout(
                Duration::from_secs(2),
                self.reader.read_until(0, &mut bytes),
            )
            .await
            .unwrap()
            .unwrap();
            serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap()
        }

        /// Complete a dispatched body lookup after the test changes native ownership.
        async fn reply(&mut self, command: &Value) {
            let mut bytes = serde_json::to_vec(&json!({"id":command["id"], "result":{"body":"successor bytes", "base64Encoded":false}})).unwrap();
            bytes.push(0);
            self.writer.write_all(&bytes).await.unwrap();
        }

        /// A rejected owner must not leave a delayed browser request queued behind admission.
        async fn assert_no_command(&mut self) {
            let mut bytes = Vec::new();
            assert!(
                timeout(
                    Duration::from_millis(20),
                    self.reader.read_until(0, &mut bytes)
                )
                .await
                .is_err()
            );
        }
    }

    struct Fixture {
        page: Page,
        connection: Connection,
        peer: Peer,
        slots: Arc<Semaphore>,
        cancellation: watch::Sender<bool>,
        operation: Operation,
        original_identity: String,
    }

    impl Fixture {
        /// Create one original request and a controlled browser peer without a Chromium process.
        fn new(finished: bool) -> Self {
            let (host, peer) = tokio::io::duplex(4096);
            let (reader, writer) = tokio::io::split(host);
            let connection = Connection::new(reader, writer);
            let (reader, writer) = tokio::io::split(peer);
            let page = Page {
                context_identifier: "context".into(),
                target_identifier: "target".into(),
                session_identifier: "session".into(),
                state: Arc::new(PageState::default()),
            };
            page.state
                .renderer_sessions
                .lock()
                .unwrap()
                .register_root("target", "session")
                .unwrap()
                .mark_ready();
            let (cancellation, receiver) = watch::channel(false);
            let mut fixture = Self {
                page,
                connection,
                peer: Peer {
                    reader: BufReader::new(reader),
                    writer,
                },
                slots: Arc::new(Semaphore::new(1)),
                cancellation,
                operation: Operation::new("response.body".into(), None, receiver),
                original_identity: String::new(),
            };
            fixture.replace_request(finished);
            fixture.original_identity = fixture
                .page
                .state
                .state
                .lock()
                .unwrap()
                .requests
                .get("7:sessionshared")
                .unwrap()
                .metadata()["identity"]
                .as_str()
                .unwrap()
                .to_owned();
            fixture
        }

        /// Reuse the protocol identifier while emitting a distinct native occurrence.
        fn replace_request(&self, finished: bool) {
            let mut state = self.page.state.state.lock().unwrap();
            state.observe_in_session("session", "Network.requestWillBeSent", &json!({"requestId":"shared", "type":"Fetch", "request":{"url":"https://example.test/resource", "method":"GET"}}));
            if finished {
                state.observe_in_session(
                    "session",
                    "Network.loadingFinished",
                    &json!({"requestId":"shared"}),
                );
            }
            self.page.state.changed.send_replace(state.sequence);
        }
    }

    #[tokio::test]
    async fn original_child_retirement_cancels_completion_admission_and_held_body_reply() {
        for stage in 0..3 {
            let mut fixture = Fixture::new(true);
            let (root, child) = {
                let mut sessions = fixture.page.state.renderer_sessions.lock().unwrap();
                let root = sessions.get("session").unwrap();
                let child = sessions
                    .register_child(&root, "child-frame", "child")
                    .unwrap();
                child.mark_ready();
                (root, child)
            };
            let identity = {
                let mut state = fixture.page.state.state.lock().unwrap();
                state.observe_in_session("child","Network.requestWillBeSent",&json!({"requestId":"remote", "type":"Fetch","request":{"url":"https://remote.test/","method":"GET"}}));
                if stage > 0 {
                    state.observe_in_session(
                        "child",
                        "Network.loadingFinished",
                        &json!({"requestId":"remote"}),
                    );
                }
                state
                    .requests
                    .get("5:childremote")
                    .unwrap()
                    .identity()
                    .to_owned()
            };
            let occupied = if stage == 1 {
                Some(fixture.slots.clone().acquire_owned().await.unwrap())
            } else {
                None
            };
            let body = read_body_for_occurrence(
                &fixture.page,
                &fixture.connection,
                "5:childremote",
                &identity,
                fixture.slots.clone(),
                1024,
                &fixture.operation,
            );
            tokio::pin!(body);
            poll_fn(|context| {
                assert!(body.as_mut().poll(context).is_pending());
                Poll::Ready(())
            })
            .await;
            let command = if stage == 2 {
                let command = fixture.peer.command().await;
                assert_eq!(command["sessionId"], "child");
                assert_eq!(command["params"]["requestId"], "remote");
                Some(command)
            } else {
                None
            };
            fixture
                .page
                .state
                .renderer_sessions
                .lock()
                .unwrap()
                .retire(&child);
            fixture.page.state.changed.send_replace(100);
            assert_eq!(
                timeout(Duration::from_secs(1), body)
                    .await
                    .unwrap()
                    .err()
                    .unwrap()
                    .code,
                ErrorCode::TargetClosed
            );
            assert!(!root.is_retired());
            drop(occupied);
            assert_eq!(fixture.slots.available_permits(), 1);
            if let Some(command) = command {
                fixture.peer.reply(&command).await;
            }
            fixture.peer.assert_no_command().await;
        }
    }

    #[tokio::test]
    async fn transferred_navigation_body_uses_child_session_with_original_public_reference() {
        let mut fixture = Fixture::new(true);
        {
            let mut sessions = fixture.page.state.renderer_sessions.lock().unwrap();
            let root = sessions.get("session").unwrap();
            sessions
                .register_child(&root, "child-frame", "child")
                .unwrap()
                .mark_ready();
        }
        let identity = {
            let mut state = fixture.page.state.state.lock().unwrap();
            state.observe_in_session("session","Network.requestWillBeSent",&json!({"requestId":"NAV","loaderId":"NAV","frameId":"child-frame", "type":"Document","request":{"url":"https://remote.test/","method":"GET"}}));
            let identity = state
                .requests
                .get("7:sessionNAV")
                .unwrap()
                .identity()
                .to_owned();
            state
                .requests
                .committed_navigation("child-frame", "NAV", "child")
                .unwrap();
            state.observe_in_session(
                "child",
                "Network.loadingFinished",
                &json!({"requestId":"NAV"}),
            );
            identity
        };
        let body = read_body_for_occurrence(
            &fixture.page,
            &fixture.connection,
            "7:sessionNAV",
            &identity,
            fixture.slots.clone(),
            1024,
            &fixture.operation,
        );
        tokio::pin!(body);
        poll_fn(|context| {
            assert!(body.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        let command = fixture.peer.command().await;
        assert_eq!(command["sessionId"], "child");
        assert_eq!(command["params"]["requestId"], "NAV");
        fixture.peer.reply(&command).await;
        assert_eq!(body.await.unwrap().bytes.as_slice(), b"successor bytes");
    }

    #[tokio::test]
    async fn replacement_while_waiting_for_completion_cannot_read_successor_bytes() {
        let mut fixture = Fixture::new(false);
        let body = read_body_for_occurrence(
            &fixture.page,
            &fixture.connection,
            "7:sessionshared",
            &fixture.original_identity,
            fixture.slots.clone(),
            1024,
            &fixture.operation,
        );
        tokio::pin!(body);
        poll_fn(|context| {
            assert!(body.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        fixture.replace_request(true);
        assert_eq!(body.await.err().unwrap().code, ErrorCode::Protocol);
        assert_eq!(fixture.slots.available_permits(), 1);
        fixture.peer.assert_no_command().await;
    }

    #[tokio::test]
    async fn replacement_while_queued_for_output_rechecks_before_browser_dispatch() {
        let mut fixture = Fixture::new(true);
        let occupied = fixture.slots.clone().acquire_owned().await.unwrap();
        let body = read_body_for_occurrence(
            &fixture.page,
            &fixture.connection,
            "7:sessionshared",
            &fixture.original_identity,
            fixture.slots.clone(),
            1024,
            &fixture.operation,
        );
        tokio::pin!(body);
        poll_fn(|context| {
            assert!(body.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        fixture.replace_request(true);
        assert_eq!(
            timeout(Duration::from_secs(1), body)
                .await
                .unwrap()
                .err()
                .unwrap()
                .code,
            ErrorCode::Protocol
        );
        drop(occupied);
        assert_eq!(fixture.slots.available_permits(), 1);
        fixture.peer.assert_no_command().await;
    }

    #[tokio::test]
    async fn replacement_during_browser_reply_discards_bytes_and_releases_output_slot() {
        let mut fixture = Fixture::new(true);
        let body = read_body_for_occurrence(
            &fixture.page,
            &fixture.connection,
            "7:sessionshared",
            &fixture.original_identity,
            fixture.slots.clone(),
            1024,
            &fixture.operation,
        );
        tokio::pin!(body);
        poll_fn(|context| {
            assert!(body.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        let command = fixture.peer.command().await;
        assert_eq!(command["method"], "Network.getResponseBody");
        assert_eq!(command["params"]["requestId"], "shared");
        fixture.replace_request(true);
        assert_eq!(
            timeout(Duration::from_secs(1), body)
                .await
                .unwrap()
                .err()
                .unwrap()
                .code,
            ErrorCode::Protocol
        );
        assert_eq!(fixture.slots.available_permits(), 1);
        fixture.peer.reply(&command).await;
        fixture.peer.assert_no_command().await;

        let successor_identity = fixture
            .page
            .state
            .state
            .lock()
            .unwrap()
            .requests
            .get("7:sessionshared")
            .unwrap()
            .metadata()["identity"]
            .as_str()
            .unwrap()
            .to_owned();
        let successor = read_body_for_occurrence(
            &fixture.page,
            &fixture.connection,
            "7:sessionshared",
            &successor_identity,
            fixture.slots.clone(),
            1024,
            &fixture.operation,
        );
        tokio::pin!(successor);
        poll_fn(|context| {
            assert!(successor.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        let successor_command = fixture.peer.command().await;
        assert_ne!(command["id"], successor_command["id"]);
        fixture.peer.reply(&successor_command).await;
        let attachment = successor.await.unwrap();
        assert_eq!(attachment.bytes.as_slice(), b"successor bytes");
        assert_eq!(fixture.slots.available_permits(), 0);
        drop(attachment);
        assert_eq!(fixture.slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancellation_during_output_admission_sends_no_late_body_command() {
        let mut fixture = Fixture::new(true);
        let occupied = fixture.slots.clone().acquire_owned().await.unwrap();
        let body = read_body_for_occurrence(
            &fixture.page,
            &fixture.connection,
            "7:sessionshared",
            &fixture.original_identity,
            fixture.slots.clone(),
            1024,
            &fixture.operation,
        );
        tokio::pin!(body);
        poll_fn(|context| {
            assert!(body.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        fixture.cancellation.send(true).unwrap();
        assert_eq!(body.await.err().unwrap().code, ErrorCode::Cancelled);
        drop(occupied);
        assert_eq!(fixture.slots.available_permits(), 1);
        fixture.peer.assert_no_command().await;
    }
}
