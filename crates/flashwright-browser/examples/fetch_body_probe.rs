//! Real Chromium verification for typed body output, independent of the public routing API.

use flashwright_browser::{
    Chromium, LaunchOptions,
    connection::fetch_body::{ContinueRequest, FetchBodyCommand, FetchHeader, FulfillRequest},
};
use flashwright_protocol::{ErrorCode, ErrorRecord, InputAttachment};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--browser-guardian")
    {
        flashwright_browser::supervision::run_guardian(&arguments[1..])?;
        return Ok(());
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let requests = Arc::new(AtomicUsize::new(0));
    let observed_requests = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let observed_requests = observed_requests.clone();
            tokio::spawn(async move {
                serve(stream, &observed_requests).await.unwrap();
            });
        }
    });
    let browser = Chromium::launch(
        LaunchOptions {
            executable_path: std::env::var_os("FLASHWRIGHT_BROWSER_PATH")
                .ok_or("FLASHWRIGHT_BROWSER_PATH is required")?
                .into(),
            headless: true,
        },
        None,
    )
    .await
    .map_err(browser_failure)?;
    let result = probe(&browser, &origin, &requests).await;
    let closed = browser.close().await;
    server.abort();
    closed.map_err(browser_failure)?;
    println!(
        "{}",
        json!({"status": "passed", "browserVersion": browser.version, "cases": result?})
    );
    Ok(())
}

async fn probe(
    browser: &Chromium,
    origin: &str,
    requests: &AtomicUsize,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let connection = &browser.connection;
    let context = connection
        .call("Target.createBrowserContext", json!({}), None)
        .await
        .map_err(browser_failure)?;
    let target = connection
        .call(
            "Target.createTarget",
            json!({"url": "about:blank", "browserContextId": context["browserContextId"]}),
            None,
        )
        .await
        .map_err(browser_failure)?;
    let attached = connection
        .call(
            "Target.attachToTarget",
            json!({"targetId": target["targetId"], "flatten": true}),
            None,
        )
        .await
        .map_err(browser_failure)?;
    let session = attached["sessionId"].as_str().ok_or("missing session")?;
    let (sender, mut events) = tokio::sync::mpsc::channel(16);
    let event_session = session.to_owned();
    connection
        .observe_events(move |event| {
            if event.session_identifier.as_deref() == Some(&event_session)
                && matches!(
                    event.method.as_str(),
                    "Page.loadEventFired" | "Fetch.requestPaused"
                )
            {
                sender.try_send(event).map_err(|_| {
                    ErrorRecord::new(
                        ErrorCode::ResourceLimit,
                        "fetch-body-probe",
                        "probe event queue unavailable",
                    )
                })?;
            }
            Ok(())
        })
        .map_err(browser_failure)?;
    connection
        .call("Network.enable", json!({}), Some(session))
        .await
        .map_err(browser_failure)?;
    connection
        .call("Page.enable", json!({}), Some(session))
        .await
        .map_err(browser_failure)?;
    connection
        .call("Page.navigate", json!({"url": origin}), Some(session))
        .await
        .map_err(browser_failure)?;
    loop {
        let event = events.recv().await.ok_or("event owner closed")?;
        if event.session_identifier.as_deref() == Some(session)
            && event.method == "Page.loadEventFired"
        {
            break;
        }
    }
    connection
        .call(
            "Fetch.enable",
            json!({"patterns": [{"urlPattern": format!("{origin}/payload/*")}] }),
            Some(session),
        )
        .await
        .map_err(browser_failure)?;
    let mut results = Vec::new();
    for length in [0, 65537, 9 * 1024 * 1024, 32 * 1024 * 1024] {
        for fulfill in [false, true] {
            let before = requests.load(Ordering::SeqCst);
            let path = if fulfill { "fulfill" } else { "continue" };
            let expression = if fulfill {
                format!(
                    "fetch('/payload/fulfill?length={length}').then(response => response.arrayBuffer()).then(buffer => {{ const bytes = new Uint8Array(buffer); if (bytes.length !== {length}) throw new Error('wrong body length'); for (let index = 0; index < bytes.length; index++) if (bytes[index] !== index % 256) throw new Error('wrong body byte at ' + index); return {{bytes: bytes.length, exact: true}}; }})"
                )
            } else {
                format!(
                    "fetch('/payload/continue?length={length}', {{method: 'POST', body: 'original'}}).then(response => response.json())"
                )
            };
            let mut evaluation = connection
                .start_command(
                    "Runtime.evaluate",
                    json!({"expression": expression, "awaitPromise": true, "returnByValue": true}),
                    Some(session),
                )
                .map_err(browser_failure)?;
            let pause = loop {
                let event = events.recv().await.ok_or("event owner closed")?;
                if event.session_identifier.as_deref() == Some(session)
                    && event.method == "Fetch.requestPaused"
                {
                    let parameters: Value = serde_json::from_str(
                        event
                            .parameters
                            .as_ref()
                            .ok_or("missing pause parameters")?
                            .get(),
                    )?;
                    assert!(
                        parameters["request"]["url"]
                            .as_str()
                            .unwrap()
                            .contains(&format!("/payload/{path}?"))
                    );
                    break parameters;
                }
            };
            let request_identifier = pause["requestId"]
                .as_str()
                .ok_or("missing pause identity")?
                .to_owned();
            let parameters = if fulfill {
                FetchBodyCommand::Fulfill(FulfillRequest {
                    request_identifier,
                    response_code: 200,
                    response_phrase: None,
                    response_headers: vec![
                        FetchHeader {
                            name: "Content-Type".into(),
                            value: "application/octet-stream".into(),
                        },
                        FetchHeader {
                            name: "Content-Length".into(),
                            value: length.to_string(),
                        },
                    ],
                })
            } else {
                FetchBodyCommand::Continue(ContinueRequest {
                    request_identifier,
                    url: None,
                    method: None,
                    headers: None,
                })
            };
            let slots = Arc::new(Semaphore::new(1));
            let input = Arc::new(InputAttachment {
                bytes: Arc::new((0..length).map(|index| (index % 256) as u8).collect()),
                reservation: slots.clone().try_acquire_owned()?,
            });
            connection
                .start_fetch_body(parameters, input, session)
                .map_err(browser_failure)?
                .response()
                .await
                .map_err(browser_failure)?;
            let response = evaluation.response().await.map_err(browser_failure)?;
            assert!(response.get("exceptionDetails").is_none(), "{response}");
            assert_eq!(
                response["result"]["value"],
                json!({"bytes": length, "exact": true})
            );
            assert_eq!(
                requests.load(Ordering::SeqCst) - before,
                usize::from(!fulfill)
            );
            assert_eq!(slots.available_permits(), 1);
            results.push(json!({"operation": path, "bytes": length, "exact": true, "serverRequests": usize::from(!fulfill), "inputLeaseReleased": true}));
        }
    }
    Ok(results)
}

/// Check the upload incrementally; the server never retains another complete request body.
async fn serve(mut stream: TcpStream, requests: &AtomicUsize) -> std::io::Result<()> {
    let mut received = Vec::new();
    let mut buffer = [0; 65536];
    let header_end = loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            return Ok(());
        }
        received.extend_from_slice(&buffer[..count]);
        if let Some(position) = received.windows(4).position(|part| part == b"\r\n\r\n") {
            break position + 4;
        }
        assert!(
            received.len() < 65536,
            "request headers exceeded probe limit"
        );
    };
    let headers = String::from_utf8_lossy(&received[..header_end]);
    let upload = headers.starts_with("POST /payload/continue?");
    assert!(
        !headers.contains("/payload/fulfill?"),
        "fulfilled request reached HTTP server"
    );
    let length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut checked = 0;
    let mut exact = true;
    for byte in &received[header_end..] {
        exact &= *byte == (checked % 256) as u8;
        checked += 1;
    }
    while checked < length {
        let count = stream.read(&mut buffer).await?;
        assert_ne!(count, 0, "upload closed early");
        for byte in &buffer[..count] {
            exact &= *byte == (checked % 256) as u8;
            checked += 1;
        }
    }
    assert_eq!(checked, length);
    let body = if upload {
        requests.fetch_add(1, Ordering::SeqCst);
        json!({"bytes": checked, "exact": exact}).to_string()
    } else {
        "<!doctype html><title>Fetch body probe</title>".into()
    };
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", if upload { "application/json" } else { "text/html" }, body.len(), body).as_bytes()).await?;
    stream.shutdown().await
}

fn browser_failure(error: ErrorRecord) -> std::io::Error {
    std::io::Error::other(format!("{}: {}", error.method, error.message))
}
