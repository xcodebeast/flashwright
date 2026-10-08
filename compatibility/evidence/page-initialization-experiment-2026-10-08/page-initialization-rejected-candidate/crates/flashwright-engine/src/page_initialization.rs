//! Independent page initialization shares one deadline and completes before publication.

use super::{Operation, Viewport, invalid};
use flashwright_browser::Connection;
use flashwright_protocol::ErrorRecord;
use serde_json::{Value, json};

/// Register the page's event owner before calling this. Every domain, viewport and
/// frame-tree reply is required; cancellation withdraws all outstanding commands.
pub(crate) async fn initialize_page_session(
    connection: &Connection,
    headless: bool,
    viewport: Option<&Viewport>,
    session: &str,
    operation: &Operation,
) -> Result<Value, ErrorRecord> {
    let configure = async {
        if let Some(viewport) = viewport {
            configure_viewport(connection, headless, viewport, session).await?;
        }
        Ok::<(), ErrorRecord>(())
    };
    let (_, _, _, _, _, _, _, frame_tree) = operation
        .wait(async {
            tokio::try_join!(
                connection.call("Page.enable", json!({}), Some(session)),
                connection.call(
                    "Page.setLifecycleEventsEnabled",
                    json!({ "enabled": true }),
                    Some(session)
                ),
                connection.call("Network.enable", json!({}), Some(session)),
                connection.call("Runtime.enable", json!({}), Some(session)),
                connection.call("Log.enable", json!({}), Some(session)),
                // Preserve reference focus/visibility while other pages are active.
                connection.call(
                    "Emulation.setFocusEmulationEnabled",
                    json!({ "enabled": true }),
                    Some(session)
                ),
                configure,
                connection.call("Page.getFrameTree", json!({}), Some(session)),
            )
        })
        .await?;
    Ok(frame_tree)
}

/// Window bounds need the window identity; device metrics can be configured while
/// that browser-side lookup is pending. Both finish before a page becomes public.
async fn configure_viewport(
    connection: &Connection,
    headless: bool,
    viewport: &Viewport,
    session: &str,
) -> Result<(), ErrorRecord> {
    let insets = if headless {
        (0, 0)
    } else {
        match std::env::consts::OS {
            "macos" => (2, 80),
            "linux" => (8, 85),
            _ => (24, 88),
        }
    };
    let width = viewport.width.checked_add(insets.0).ok_or_else(|| {
        invalid(
            "context.newPage",
            "window width overflows its supported range",
        )
    })?;
    let height = viewport.height.checked_add(insets.1).ok_or_else(|| {
        invalid(
            "context.newPage",
            "window height overflows its supported range",
        )
    })?;
    let bounds = async {
        let window = connection
            .call("Browser.getWindowForTarget", json!({}), Some(session))
            .await;
        let window = match window {
            Ok(window) => window["windowId"]
                .as_i64()
                .ok_or_else(|| invalid("context.newPage", "Chromium omitted window identity"))?,
            Err(error) if error.browser_error_code.is_some() => return Ok(()),
            Err(error) => return Err(error),
        };
        connection
            .call(
                "Browser.setWindowBounds",
                json!({ "windowId": window, "bounds": { "width": width, "height": height } }),
                Some(session),
            )
            .await?;
        Ok::<(), ErrorRecord>(())
    };
    let metrics = connection.call(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": viewport.width, "height": viewport.height,
            "screenWidth": viewport.width, "screenHeight": viewport.height,
            "deviceScaleFactor": 1, "mobile": false,
            "screenOrientation": { "angle": 0, "type": "landscapePrimary" },
        }),
        Some(session),
    );
    tokio::try_join!(bounds, metrics)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flashwright_protocol::ErrorCode;
    use std::{collections::BTreeMap, future::Future, pin::Pin};
    use tokio::io::{
        AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf, duplex, split,
    };
    use tokio::sync::watch;
    use tokio::time::{Duration, timeout};

    fn connection_pair() -> (
        Connection,
        BufReader<ReadHalf<DuplexStream>>,
        WriteHalf<DuplexStream>,
    ) {
        let (host, peer) = duplex(65536);
        let (reader, writer) = split(host);
        let connection = Connection::new(reader, writer);
        let (reader, writer) = split(peer);
        (connection, BufReader::new(reader), writer)
    }

    async fn read_command(reader: &mut BufReader<ReadHalf<DuplexStream>>) -> Value {
        let mut bytes = Vec::new();
        timeout(Duration::from_secs(2), reader.read_until(0, &mut bytes))
            .await
            .expect("initialization waited for an unrelated reply")
            .unwrap();
        assert_eq!(bytes.pop(), Some(0));
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn initial_commands(
        mut initialization: Pin<&mut impl Future<Output = Result<Value, ErrorRecord>>>,
        reader: &mut BufReader<ReadHalf<DuplexStream>>,
        count: usize,
    ) -> BTreeMap<String, Value> {
        let mut commands = BTreeMap::new();
        for _ in 0..count {
            let command = tokio::select! {
                result = initialization.as_mut() => panic!("page initialized without its replies: {result:?}"),
                command = read_command(reader) => command,
            };
            assert_eq!(command["sessionId"], "owned-page");
            assert!(
                commands
                    .insert(command["method"].as_str().unwrap().to_owned(), command)
                    .is_none()
            );
        }
        commands
    }

    async fn reply(writer: &mut WriteHalf<DuplexStream>, command: &Value, result: Value) {
        let mut bytes = serde_json::to_vec(
            &json!({ "id": command["id"], "sessionId": command["sessionId"], "result": result }),
        )
        .unwrap();
        bytes.push(0);
        writer.write_all(&bytes).await.unwrap();
    }

    async fn synchronize_replies(
        connection: &Connection,
        reader: &mut BufReader<ReadHalf<DuplexStream>>,
        writer: &mut WriteHalf<DuplexStream>,
    ) {
        let mut barrier = connection
            .start_command("barrier", json!({}), None)
            .unwrap();
        let command = read_command(reader).await;
        assert_eq!(
            command["method"], "barrier",
            "cancelled initialization dispatched late work"
        );
        reply(writer, &command, json!({})).await;
        barrier.response().await.unwrap();
    }

    #[tokio::test]
    async fn independent_domains_overlap_but_every_configuration_reply_is_required() {
        let (connection, mut reader, mut writer) = connection_pair();
        let (_cancellation, receiver) = watch::channel(false);
        let operation = Operation::new("context.newPage".into(), None, receiver);
        let viewport = Viewport {
            width: 1280,
            height: 720,
        };
        let initialization =
            initialize_page_session(&connection, true, Some(&viewport), "owned-page", &operation);
        tokio::pin!(initialization);
        let commands = initial_commands(initialization.as_mut(), &mut reader, 9).await;
        assert_eq!(
            commands.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "Browser.getWindowForTarget",
                "Emulation.setDeviceMetricsOverride",
                "Emulation.setFocusEmulationEnabled",
                "Log.enable",
                "Network.enable",
                "Page.enable",
                "Page.getFrameTree",
                "Page.setLifecycleEventsEnabled",
                "Runtime.enable",
            ]
        );
        let tree =
            json!({ "frameTree": { "frame": { "id": "initial-frame", "url": "about:blank" } } });
        for (method, command) in commands.iter().rev() {
            if method == "Emulation.setDeviceMetricsOverride" {
                continue;
            }
            let result = match method.as_str() {
                "Page.getFrameTree" => tree.clone(),
                "Browser.getWindowForTarget" => json!({ "windowId": 17 }),
                _ => json!({}),
            };
            reply(&mut writer, command, result).await;
        }
        let bounds = initial_commands(initialization.as_mut(), &mut reader, 1).await;
        let bounds = &bounds["Browser.setWindowBounds"];
        assert_eq!(
            bounds["params"],
            json!({ "windowId": 17, "bounds": { "width": 1280, "height": 720 } })
        );
        reply(&mut writer, bounds, json!({})).await;
        synchronize_replies(&connection, &mut reader, &mut writer).await;
        tokio::select! {
            biased;
            result = initialization.as_mut() => panic!("missing viewport acknowledgement was ignored: {result:?}"),
            _ = std::future::ready(()) => {},
        }
        reply(
            &mut writer,
            &commands["Emulation.setDeviceMetricsOverride"],
            json!({}),
        )
        .await;
        assert_eq!(initialization.await.unwrap(), tree);
    }

    #[tokio::test]
    async fn cancelled_window_lookup_cannot_dispatch_configuration_after_recovery() {
        let (connection, mut reader, mut writer) = connection_pair();
        let (cancellation, receiver) = watch::channel(false);
        let operation = Operation::new("context.newPage".into(), None, receiver);
        let viewport = Viewport {
            width: 1280,
            height: 720,
        };
        let initialization =
            initialize_page_session(&connection, true, Some(&viewport), "owned-page", &operation);
        tokio::pin!(initialization);
        let commands = initial_commands(initialization.as_mut(), &mut reader, 9).await;
        cancellation.send_replace(true);
        assert_eq!(initialization.await.unwrap_err().code, ErrorCode::Cancelled);
        for command in commands.values() {
            reply(&mut writer, command, json!({ "windowId": 17 })).await;
        }
        synchronize_replies(&connection, &mut reader, &mut writer).await;
    }

    #[tokio::test]
    async fn domain_failure_preserves_its_cause_and_releases_other_initialization_calls() {
        let (connection, mut reader, mut writer) = connection_pair();
        let (_cancellation, receiver) = watch::channel(false);
        let operation = Operation::new("context.newPage".into(), None, receiver);
        let initialization =
            initialize_page_session(&connection, true, None, "owned-page", &operation);
        tokio::pin!(initialization);
        let commands = initial_commands(initialization.as_mut(), &mut reader, 7).await;
        let command = &commands["Runtime.enable"];
        let mut bytes = serde_json::to_vec(&json!({ "id": command["id"], "sessionId": "owned-page", "error": { "code": -32000, "message": "renderer rejected initialization" } })).unwrap();
        bytes.push(0);
        writer.write_all(&bytes).await.unwrap();
        let error = initialization.await.unwrap_err();
        assert_eq!(error.browser_error_code, Some(-32000));
        assert_eq!(error.method.as_ref(), "chromium");
        assert!(error.message.contains("renderer rejected initialization"));
        for (method, command) in &commands {
            if method != "Runtime.enable" {
                reply(&mut writer, command, json!({})).await;
            }
        }
        synchronize_replies(&connection, &mut reader, &mut writer).await;
    }
}
