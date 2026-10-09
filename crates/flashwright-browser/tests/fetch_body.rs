use flashwright_browser::{
    Connection,
    connection::fetch_body::{ContinueRequest, FetchBodyCommand, FetchHeader, FulfillRequest},
};
use flashwright_protocol::{ErrorCode, InputAttachment, attachment::MAXIMUM_ATTACHMENT_BYTES};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::io::{
    AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf,
};
use tokio::sync::Semaphore;
use tokio::time::{Duration, timeout};

struct Peer {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

impl Peer {
    async fn command(&mut self) -> Value {
        let mut bytes = Vec::new();
        timeout(
            Duration::from_secs(5),
            self.reader.read_until(0, &mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap()
    }

    async fn reply(&mut self, command: &Value) {
        self.writer
            .write_all(format!("{}\0", json!({"id": command["id"], "result": {}})).as_bytes())
            .await
            .unwrap();
    }
}

fn fixture(capacity: usize) -> (Connection, Peer) {
    let (host, peer) = tokio::io::duplex(capacity);
    let (reader, writer) = tokio::io::split(host);
    let connection = Connection::new(reader, writer);
    let (reader, writer) = tokio::io::split(peer);
    (
        connection,
        Peer {
            reader: BufReader::new(reader),
            writer,
        },
    )
}

fn attachment(bytes: Vec<u8>) -> (Arc<InputAttachment>, Arc<Semaphore>) {
    let slots = Arc::new(Semaphore::new(1));
    let reservation = slots.clone().try_acquire_owned().unwrap();
    (
        Arc::new(InputAttachment {
            bytes: Arc::new(bytes),
            reservation,
        }),
        slots,
    )
}

fn continuation() -> FetchBodyCommand {
    FetchBodyCommand::Continue(ContinueRequest {
        request_identifier: "paused".into(),
        url: None,
        method: Some("POST".into()),
        headers: None,
    })
}

fn fulfillment() -> FetchBodyCommand {
    FetchBodyCommand::Fulfill(FulfillRequest {
        request_identifier: "paused".into(),
        response_code: 200,
        response_headers: Vec::new(),
        response_phrase: None,
    })
}

#[tokio::test]
async fn typed_fetch_fields_preserve_exact_bytes_and_escaped_metadata() {
    let (connection, mut peer) = fixture(4096);
    for (bytes, expected) in [
        (vec![], ""),
        (vec![0], "AA=="),
        (vec![0, 255], "AP8="),
        (vec![0, 255, 128], "AP+A"),
    ] {
        let (input, slots) = attachment(bytes);
        let mut continued = connection
            .start_fetch_body(
                FetchBodyCommand::Continue(ContinueRequest {
                    request_identifier: "paused\"\u{0}\\é".into(),
                    url: Some("http://example.test/a?quote=\"".into()),
                    method: Some("POST".into()),
                    headers: Some(vec![FetchHeader {
                        name: "X-Value".into(),
                        value: "one\ntwo".into(),
                    }]),
                }),
                input.clone(),
                "original-session",
            )
            .unwrap();
        let command = peer.command().await;
        assert_eq!(command["method"], "Fetch.continueRequest");
        assert_eq!(command["sessionId"], "original-session");
        assert_eq!(
            command["params"],
            json!({"requestId": "paused\"\u{0}\\é", "url": "http://example.test/a?quote=\"", "method": "POST", "headers": [{"name": "X-Value", "value": "one\ntwo"}], "postData": expected})
        );
        peer.reply(&command).await;
        continued.response().await.unwrap();
        let mut fulfilled = connection
            .start_fetch_body(fulfillment(), input.clone(), "original-session")
            .unwrap();
        let command = peer.command().await;
        assert_eq!(command["method"], "Fetch.fulfillRequest");
        assert_eq!(
            command["params"],
            json!({"requestId": "paused", "responseCode": 200, "responseHeaders": [], "body": expected})
        );
        peer.reply(&command).await;
        fulfilled.response().await.unwrap();
        drop(input);
        assert_eq!(slots.available_permits(), 1);
    }
}

#[tokio::test]
async fn maximum_body_stream_is_exact_and_never_interleaves_the_next_command() {
    let (connection, mut peer) = fixture(65536);
    let (input, slots) = attachment(
        (0..MAXIMUM_ATTACHMENT_BYTES)
            .map(|index| [0, 255, 128][index % 3])
            .collect(),
    );
    let mut body = connection
        .start_fetch_body(continuation(), input.clone(), "session")
        .unwrap();
    drop(input);
    let mut successor = connection
        .start_command("barrier", json!({"after": true}), None)
        .unwrap();
    let command = peer.command().await;
    let encoded = command["params"]["postData"].as_str().unwrap();
    assert_eq!(encoded.len(), MAXIMUM_ATTACHMENT_BYTES.div_ceil(3) * 4);
    for quartet in encoded.as_bytes()[..encoded.len() - 4].as_chunks::<4>().0 {
        assert_eq!(quartet, b"AP+A");
    }
    assert_eq!(&encoded[encoded.len() - 4..], "AP8=");
    let following = peer.command().await;
    assert_eq!(following["method"], "barrier");
    assert_eq!(slots.available_permits(), 1);
    peer.reply(&following).await;
    peer.reply(&command).await;
    successor.response().await.unwrap();
    body.response().await.unwrap();
}

#[tokio::test]
async fn cancelling_a_started_body_keeps_its_lease_and_finishes_the_frame() {
    let (connection, mut peer) = fixture(64);
    let (input, slots) = attachment(vec![255; 256 * 1024]);
    let body = connection
        .start_fetch_body(fulfillment(), input.clone(), "session")
        .unwrap();
    let mut prefix = [0; 16];
    peer.reader.read_exact(&mut prefix).await.unwrap();
    assert!(!body.prevent_dispatch());
    drop(body);
    drop(input);
    assert_eq!(slots.available_permits(), 0);
    let mut successor = connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    let mut bytes = prefix.to_vec();
    timeout(
        Duration::from_secs(2),
        peer.reader.read_until(0, &mut bytes),
    )
    .await
    .unwrap()
    .unwrap();
    let command: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
    let encoded = command["params"]["body"].as_str().unwrap();
    assert_eq!(encoded.len(), (256_usize * 1024).div_ceil(3) * 4);
    assert!(
        encoded[..encoded.len() - 4]
            .bytes()
            .all(|byte| byte == b'/')
    );
    assert_eq!(&encoded[encoded.len() - 4..], "/w==");
    let following = peer.command().await;
    assert_eq!(following["method"], "barrier");
    assert_eq!(slots.available_permits(), 1);
    peer.reply(&command).await;
    peer.reply(&following).await;
    successor.response().await.unwrap();
}

#[tokio::test]
async fn queued_withdrawal_skips_the_entire_body_and_releases_its_lease() {
    let (connection, mut peer) = fixture(64);
    let _blocker = connection
        .start_command("blocked", json!({"data": "x".repeat(8192)}), None)
        .unwrap();
    let (input, slots) = attachment(vec![255; 128 * 1024]);
    let body = connection
        .start_fetch_body(continuation(), input.clone(), "session")
        .unwrap();
    assert!(body.prevent_dispatch());
    drop(body);
    drop(input);
    let _successor = connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    assert_eq!(peer.command().await["method"], "blocked");
    assert_eq!(peer.command().await["method"], "barrier");
    assert_eq!(slots.available_permits(), 1);
}

#[tokio::test]
async fn body_and_metadata_limits_leave_ordinary_admission_unchanged() {
    let (connection, mut peer) = fixture(4096);
    let (oversized, slots) = attachment(vec![0; MAXIMUM_ATTACHMENT_BYTES + 1]);
    let rejected = connection
        .start_fetch_body(fulfillment(), oversized, "session")
        .err()
        .unwrap();
    assert_eq!(rejected.code, ErrorCode::ResourceLimit);
    assert_eq!(slots.available_permits(), 1);
    let (empty, slots) = attachment(Vec::new());
    let rejected = connection
        .start_fetch_body(
            FetchBodyCommand::Continue(ContinueRequest {
                request_identifier: "paused".into(),
                url: Some("x".repeat(8 * 1024 * 1024)),
                method: None,
                headers: None,
            }),
            empty,
            "session",
        )
        .err()
        .unwrap();
    assert_eq!(rejected.code, ErrorCode::ResourceLimit);
    assert_eq!(slots.available_permits(), 1);
    let rejected = connection
        .start_command(
            "ordinary",
            json!({"data": "x".repeat(8 * 1024 * 1024)}),
            None,
        )
        .err()
        .unwrap();
    assert_eq!(rejected.code, ErrorCode::ResourceLimit);
    let _successor = connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    assert_eq!(peer.command().await["method"], "barrier");
}

#[tokio::test]
async fn queue_rejection_does_not_retain_an_input_reservation() {
    let (connection, _peer) = fixture(64);
    let _pending: Vec<_> = (0..128)
        .map(|_| connection.start_command("queued", json!({}), None).unwrap())
        .collect();
    let (input, slots) = attachment(vec![0; 1024]);
    let rejected = connection
        .start_fetch_body(fulfillment(), input, "session")
        .err()
        .unwrap();
    assert_eq!(rejected.code, ErrorCode::ResourceLimit);
    assert_eq!(slots.available_permits(), 1);
}

#[tokio::test]
async fn broken_writer_rejects_followers_and_releases_the_partial_body() {
    let (connection, mut peer) = fixture(64);
    let (input, slots) = attachment(vec![255; 256 * 1024]);
    let mut body = connection
        .start_fetch_body(fulfillment(), input, "session")
        .unwrap();
    let mut prefix = [0; 16];
    peer.reader.read_exact(&mut prefix).await.unwrap();
    let mut successor = connection
        .start_command("barrier", json!({}), None)
        .unwrap();
    drop(peer);
    assert!(
        timeout(Duration::from_secs(2), body.response())
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        timeout(Duration::from_secs(2), successor.response())
            .await
            .unwrap()
            .is_err()
    );
    assert!(connection.failure().is_some());
    timeout(Duration::from_secs(2), async {
        while slots.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn explicit_close_releases_a_blocked_body_without_writing_a_successor() {
    let (connection, mut peer) = fixture(64);
    let (input, slots) = attachment(vec![255; 256 * 1024]);
    let mut body = connection
        .start_fetch_body(continuation(), input, "session")
        .unwrap();
    let mut prefix = [0; 16];
    peer.reader.read_exact(&mut prefix).await.unwrap();
    connection.close();
    assert!(body.response().await.is_err());
    timeout(Duration::from_secs(2), async {
        while slots.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        connection
            .start_command("successor", json!({}), None)
            .is_err()
    );
}
