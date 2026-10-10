//! Downloads belong to contexts; browser events settle their original file owners.

use super::*;
use flashwright_browser::connection::Event;
use serde_json::value::RawValue;
use std::path::PathBuf;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAXIMUM_CONTEXT_DOWNLOADS: usize = 1024;
const MAXIMUM_ENGINE_DOWNLOADS: usize = 8192;
const MAXIMUM_DOWNLOAD_METADATA_BYTES: usize = 64 * 1024;
const CONTEXT_METADATA_BYTES: usize = 16 * 1024 * 1024;
const ENGINE_METADATA_BYTES: usize = 64 * 1024 * 1024;
const DENIED_MESSAGE: &str =
    "Pass { acceptDownloads: true } when you are creating your browser context.";

pub(crate) struct DownloadBudget {
    slots: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    file_jobs: Arc<Semaphore>,
}

impl Default for DownloadBudget {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(MAXIMUM_ENGINE_DOWNLOADS)),
            bytes: Arc::new(Semaphore::new(ENGINE_METADATA_BYTES)),
            file_jobs: Arc::new(Semaphore::new(64)),
        }
    }
}

pub(crate) struct Downloads {
    directory: PathBuf,
    accepted: bool,
    entries: Mutex<HashMap<String, Arc<Download>>>,
    slots: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    engine_budget: Arc<DownloadBudget>,
    closed: watch::Sender<Option<ErrorRecord>>,
    closing: std::sync::atomic::AtomicBool,
}

struct Download {
    page_identifier: String,
    path: PathBuf,
    outcome: watch::Sender<DownloadOutcome>,
    deleted: std::sync::atomic::AtomicBool,
    file_access: Arc<tokio::sync::Mutex<()>>,
    _credits: Vec<OwnedSemaphorePermit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DownloadOutcome {
    Pending,
    Completed,
    Failed(String),
}

impl Downloads {
    pub(crate) fn new(
        directory: PathBuf,
        accepted: bool,
        engine_budget: Arc<DownloadBudget>,
    ) -> Self {
        Self {
            directory,
            accepted,
            entries: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(MAXIMUM_CONTEXT_DOWNLOADS)),
            bytes: Arc::new(Semaphore::new(CONTEXT_METADATA_BYTES)),
            engine_budget,
            closed: watch::channel(None).0,
            closing: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(crate) fn retire(&self, error: ErrorRecord) {
        self.begin_close();
        self.closed.send_if_modified(|closed| {
            if closed.is_some() {
                return false;
            }
            *closed = Some(error);
            true
        });
    }

    fn check(&self, method: &str) -> Result<(), ErrorRecord> {
        if let Some(mut error) = self.closed.borrow().clone() {
            error.method = method.into();
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn begin_close(&self) {
        self.closing.store(true, Ordering::Release);
    }

    pub(crate) async fn cancel_active(&self, browser: &Chromium, context: &str) {
        let identifiers: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, download)| *download.outcome.borrow() == DownloadOutcome::Pending)
            .map(|(identifier, _)| identifier.clone())
            .collect();
        for identifier in identifiers {
            let _ = browser
                .connection
                .call(
                    "Browser.cancelDownload",
                    json!({
                        "guid": identifier, "browserContextId": context,
                    }),
                    None,
                )
                .await;
        }
    }

    fn admit(
        &self,
        identifier: &str,
        page_identifier: &str,
        metadata_bytes: usize,
    ) -> Result<(), ErrorRecord> {
        self.check("download")?;
        if metadata_bytes > MAXIMUM_DOWNLOAD_METADATA_BYTES {
            return Err(resource_limit());
        }
        let mut entries = self.entries.lock().unwrap();
        if entries.contains_key(identifier) {
            return Err(ErrorRecord::new(
                ErrorCode::Protocol,
                "download",
                "browser reused a retained download identifier",
            ));
        }
        let mut credits = Vec::with_capacity(4);
        for (budget, amount) in [
            (&self.slots, 1),
            (&self.engine_budget.slots, 1),
            (&self.bytes, metadata_bytes),
            (&self.engine_budget.bytes, metadata_bytes),
        ] {
            credits.push(
                budget
                    .clone()
                    .try_acquire_many_owned(amount as u32)
                    .map_err(|_| resource_limit())?,
            );
        }
        entries.insert(
            identifier.into(),
            Arc::new(Download {
                page_identifier: page_identifier.into(),
                path: self.directory.join(identifier),
                outcome: watch::channel(DownloadOutcome::Pending).0,
                deleted: std::sync::atomic::AtomicBool::new(false),
                file_access: Arc::new(tokio::sync::Mutex::new(())),
                _credits: credits,
            }),
        );
        Ok(())
    }

    fn get(&self, identifier: &str, method: &str) -> Result<Arc<Download>, ErrorRecord> {
        self.check(method)?;
        if self.closing.load(Ordering::Acquire) {
            return Err(closed(method));
        }
        self.entries
            .lock()
            .unwrap()
            .get(identifier)
            .cloned()
            .filter(|download| !download.deleted.load(Ordering::Acquire))
            .ok_or_else(|| closed(method))
    }

    async fn completion(
        &self,
        download: &Download,
        method: &str,
    ) -> Result<Option<String>, ErrorRecord> {
        if !self.accepted {
            return Ok(Some(DENIED_MESSAGE.into()));
        }
        let mut completion = download.outcome.subscribe();
        let mut retirement = self.closed.subscribe();
        loop {
            if download.deleted.load(Ordering::Acquire) {
                return Err(closed(method));
            }
            match completion.borrow().clone() {
                DownloadOutcome::Pending => {}
                DownloadOutcome::Completed => return Ok(None),
                DownloadOutcome::Failed(message) => return Ok(Some(message)),
            }
            self.check(method)?;
            tokio::select! {
                result = completion.changed() => result.map_err(|_| closed(method))?,
                result = retirement.changed() => result.map_err(|_| closed(method))?,
            }
        }
    }

    /// Accepted file copies own their locks until completion, even if their callers leave.
    pub(crate) async fn remove_files(&self) -> Result<(), ErrorRecord> {
        let entries: Vec<_> = self.entries.lock().unwrap().values().cloned().collect();
        let mut access = Vec::with_capacity(entries.len());
        for download in &entries {
            access.push(download.file_access.clone().lock_owned().await);
        }
        match tokio::fs::remove_dir_all(&self.directory).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(file_error("context.close", error)),
        }
        self.entries.lock().unwrap().clear();
        Ok(())
    }

    /// A failed page allocation cannot leave an unpublished artifact in a live context.
    pub(crate) async fn discard_page(
        &self,
        browser: &Chromium,
        context: &str,
        page: &str,
    ) -> Result<(), ErrorRecord> {
        let entries: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, download)| download.page_identifier == page)
            .map(|(identifier, download)| (identifier.clone(), download.clone()))
            .collect();
        for (identifier, download) in entries {
            if *download.outcome.borrow() == DownloadOutcome::Pending {
                let result = timeout(Duration::from_millis(500), async {
                    browser
                        .connection
                        .call(
                            "Browser.cancelDownload",
                            json!({ "guid": identifier, "browserContextId": context }),
                            None,
                        )
                        .await?;
                    self.completion(&download, "download.discard").await?;
                    Ok::<_, ErrorRecord>(())
                })
                .await;
                if !matches!(result, Ok(Ok(()))) {
                    let cleanup = operation::close_for_cleanup(
                        browser,
                        "browserClosedAfterDownloadDiscardFailure",
                    )
                    .await;
                    let mut error = file_error(
                        "download.discard",
                        "unpublished download cancellation could not be confirmed",
                    );
                    error.cleanup = Some(cleanup.into());
                    return Err(error);
                }
            }
            let _access = download.file_access.lock().await;
            let _ = tokio::fs::remove_file(&download.path).await;
            download.deleted.store(true, Ordering::Release);
            self.entries.lock().unwrap().remove(&identifier);
        }
        Ok(())
    }
}

fn resource_limit() -> ErrorRecord {
    ErrorRecord::new(
        ErrorCode::ResourceLimit,
        "download",
        "download identity or metadata admission limit exceeded",
    )
}

fn file_error(method: &str, error: impl std::fmt::Display) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, method, error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadStarted<'event> {
    frame_id: &'event str,
    guid: &'event str,
    #[serde(borrow)]
    url: &'event RawValue,
    #[serde(borrow)]
    suggested_filename: &'event RawValue,
}

impl Engine {
    pub(crate) async fn initialize_downloads(
        &self,
        identifier: &str,
        operation: &Operation,
    ) -> Result<(), ErrorRecord> {
        let method = "browser.newContext";
        let context = self.context(identifier, method)?;
        let downloads = context
            .state
            .downloads
            .get()
            .expect("new context owns downloads");
        let browser = self.browser(&context.browser_identifier, method)?;
        // Chromium creates this directory on the first download, inside its guardian-owned lifetime.
        let directory = downloads.directory.to_str().ok_or_else(|| {
            ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                method,
                "Chromium download paths require UTF-8",
            )
        })?;
        operation
            .wait(context.state.while_alive(
                method,
                browser.connection.call(
                    "Browser.setDownloadBehavior",
                    json!({
                        "behavior": if downloads.accepted { "allowAndName" } else { "deny" },
                        "browserContextId": context.protocol_identifier,
                        "downloadPath": directory,
                        "eventsEnabled": true,
                    }),
                    None,
                ),
            ))
            .await?;
        Ok(())
    }

    pub(crate) fn download_event(
        &self,
        browser_identifier: &str,
        event: &Event,
    ) -> Result<(), ErrorRecord> {
        let Some(raw) = &event.parameters else {
            return Err(file_error(
                "download",
                "browser omitted download event parameters",
            ));
        };
        if event.method == "Browser.downloadWillBegin" {
            let metadata: DownloadStarted<'_> =
                serde_json::from_str(raw.get()).map_err(|error| file_error("download", error))?;
            if metadata.guid.is_empty()
                || metadata.guid.len() > 128
                || !metadata
                    .guid
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || !metadata.url.get().starts_with('"')
                || !metadata.suggested_filename.get().starts_with('"')
            {
                return Err(file_error("download", "invalid browser download metadata"));
            }
            let candidates: Vec<_> = {
                let registry = self.registry.lock().unwrap();
                registry
                    .pages
                    .iter()
                    .filter_map(|(identifier, page)| {
                        let context = registry.contexts.get(&page.context_identifier)?;
                        if context.browser_identifier != browser_identifier
                            || page.state.purpose != PagePurpose::Public
                        {
                            return None;
                        }
                        Some((identifier.clone(), page.clone(), context.clone()))
                    })
                    .collect()
            };
            let owner = candidates.into_iter().find(|(_, page, _)| {
                let state = page.state.state.lock().unwrap();
                state.frames.contains_key(metadata.frame_id) && state.failure.is_none()
            });
            if let Some((identifier, page, context)) = owner {
                let downloads =
                    context.state.downloads.get().ok_or_else(|| {
                        file_error("download", "context download ownership missing")
                    })?;
                if downloads.closing.load(Ordering::Acquire) {
                    return Ok(());
                }
                downloads.admit(metadata.guid, &identifier, raw.get().len())?;
                self.page_diagnostic(
                    &identifier,
                    &page,
                    "download",
                    json!({
                        "context": page.context_identifier,
                        "download": metadata.guid,
                        "downloadJson": raw.get(),
                    }),
                );
            }
        } else {
            let progress: Value =
                serde_json::from_str(raw.get()).map_err(|error| file_error("download", error))?;
            let identifier = string_field(&progress, "guid")?;
            let result = match progress["state"].as_str() {
                Some("completed") => Some(DownloadOutcome::Completed),
                Some("canceled") => Some(DownloadOutcome::Failed("canceled".to_owned())),
                Some("inProgress") => None,
                _ => {
                    return Err(file_error(
                        "download",
                        "invalid browser download progress state",
                    ));
                }
            };
            if let Some(result) = result {
                let registry = self.registry.lock().unwrap();
                for context in registry
                    .contexts
                    .values()
                    .filter(|context| context.browser_identifier == browser_identifier)
                {
                    let Some(downloads) = context.state.downloads.get() else {
                        continue;
                    };
                    let entries = downloads.entries.lock().unwrap();
                    if let Some(download) = entries.get(&identifier) {
                        download.outcome.send_if_modified(|outcome| {
                            if *outcome != DownloadOutcome::Pending {
                                return false;
                            }
                            *outcome = result.clone();
                            true
                        });
                        break;
                    }
                }
            }
        }
        Ok(())
    }

    /// Claim original download ownership in driver wire order before asynchronous work can reorder.
    pub fn prepare_download_operation(
        self: &Arc<Self>,
        method: &str,
        parameters: &Value,
        operation: &Operation,
    ) -> Option<Result<PreparedDownload, ErrorRecord>> {
        if !matches!(
            method,
            "download.path"
                | "download.failure"
                | "download.saveAs"
                | "download.cancel"
                | "download.delete"
        ) {
            return None;
        }
        Some((|| {
            operation.check()?;
            validate_keys(
                method,
                parameters,
                if method == "download.saveAs" {
                    &["context", "download", "path"]
                } else {
                    &["context", "download"]
                },
            )?;
            let destination = if method == "download.saveAs" {
                let path = PathBuf::from(identifier(parameters, "path", method)?);
                if !path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0) {
                    return Err(ErrorRecord::new(
                        ErrorCode::InvalidArgument,
                        method,
                        "download destination must be an absolute path without NUL",
                    ));
                }
                if path.as_os_str().as_encoded_bytes().len() > 4096 {
                    return Err(ErrorRecord::new(
                        ErrorCode::ResourceLimit,
                        method,
                        "download destination exceeds 4096 bytes",
                    ));
                }
                Some(path)
            } else {
                None
            };
            let context = self.context(identifier(parameters, "context", method)?, method)?;
            let download_identifier = identifier(parameters, "download", method)?;
            let downloads = context
                .state
                .downloads
                .get()
                .ok_or_else(|| closed(method))?
                .clone();
            let download = downloads.get(download_identifier, method)?;
            Ok(PreparedDownload {
                engine: self.clone(),
                method: method.into(),
                context,
                downloads,
                download,
                download_identifier: download_identifier.into(),
                destination,
            })
        })())
    }
}

/// An accepted operation retains its original artifact even before its task is first polled.
pub struct PreparedDownload {
    engine: Arc<Engine>,
    method: String,
    context: Context,
    downloads: Arc<Downloads>,
    download: Arc<Download>,
    download_identifier: String,
    destination: Option<PathBuf>,
}

impl PreparedDownload {
    pub async fn finish(self, operation: &Operation) -> Result<Value, ErrorRecord> {
        operation.check()?;
        let Self {
            engine,
            method,
            context,
            downloads,
            download,
            download_identifier,
            destination,
        } = self;
        let method = method.as_str();
        let download_identifier = download_identifier.as_str();
        if method == "download.cancel" {
            if *download.outcome.borrow() != DownloadOutcome::Pending {
                return Ok(Value::Null);
            }
            let browser = engine.browser(&context.browser_identifier, method)?;
            operation
                .wait(context.state.while_alive(
                    method,
                    browser.connection.call(
                        "Browser.cancelDownload",
                        json!({
                            "guid": download_identifier, "browserContextId": context.protocol_identifier,
                        }),
                        None,
                    ),
                ))
                .await?;
            return Ok(Value::Null);
        }
        if method == "download.delete" && !downloads.accepted {
            downloads
                .entries
                .lock()
                .unwrap()
                .remove(download_identifier);
            download.deleted.store(true, Ordering::Release);
            return Ok(Value::Null);
        }
        let result = operation
            .wait(downloads.completion(&download, method))
            .await?;
        if method == "download.failure" {
            return Ok(json!(result));
        }
        if let Some(error) = result {
            return Err(ErrorRecord::new(ErrorCode::Request, method, error));
        }
        if method == "download.path" {
            return Ok(json!(download.path));
        }
        let access = operation
            .wait(context.state.while_alive(method, async {
                Ok(download.file_access.clone().lock_owned().await)
            }))
            .await?;
        let credit = operation
            .wait(context.state.while_alive(method, async {
                downloads
                    .engine_budget
                    .file_jobs
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| closed(method))
            }))
            .await?;
        let browser = engine.browser(&context.browser_identifier, method)?;
        let artifacts = operation
            .wait(context.state.while_alive(method, async {
                Ok(browser.artifact_jobs.clone().read_owned().await)
            }))
            .await?;
        let artifact_liveness = browser.retain_artifact_liveness()?;
        operation.check()?;
        let download_identifier = download_identifier.to_owned();
        let original_method = method;
        let method = method.to_owned();
        let work = operation.wait_blocking(move || {
            let _access = access;
            let _credit = credit;
            let _artifacts = artifacts;
            let _artifact_liveness = artifact_liveness;
            let _browser = browser;
            downloads.check(&method)?;
            if downloads.closing.load(Ordering::Acquire) || download.deleted.load(Ordering::Acquire)
            {
                return Err(closed(&method));
            }
            if let Some(destination) = destination {
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| {
                        ErrorRecord::new(ErrorCode::Request, &method, error.to_string())
                    })?;
                }
                std::fs::copy(&download.path, destination).map_err(|error| {
                    ErrorRecord::new(ErrorCode::Request, &method, error.to_string())
                })?;
            } else {
                let _ = std::fs::remove_file(&download.path);
                download.deleted.store(true, Ordering::Release);
                downloads
                    .entries
                    .lock()
                    .unwrap()
                    .remove(&download_identifier);
            }
            Ok(Value::Null)
        });
        operation
            .wait(context.state.while_alive(original_method, work))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn downloads() -> Downloads {
        Downloads::new(
            PathBuf::from("/unused-download-test"),
            true,
            Arc::new(DownloadBudget::default()),
        )
    }

    #[test]
    fn original_owner_retains_admission_after_registry_removal() {
        let budget = Arc::new(DownloadBudget {
            slots: Arc::new(Semaphore::new(1)),
            ..DownloadBudget::default()
        });
        let downloads =
            Downloads::new(PathBuf::from("/unused-download-test"), true, budget.clone());
        downloads.admit("first", "page", 20).unwrap();
        let retained = downloads.get("first", "test").unwrap();
        downloads.entries.lock().unwrap().remove("first");
        assert_eq!(
            downloads.admit("second", "page", 20).unwrap_err().code,
            ErrorCode::ResourceLimit
        );
        drop(retained);
        downloads.admit("second", "page", 20).unwrap();
        assert_eq!(budget.slots.available_permits(), 0);
        assert_eq!(
            downloads.slots.available_permits(),
            MAXIMUM_CONTEXT_DOWNLOADS - 1
        );
    }

    #[test]
    fn oversized_and_duplicate_metadata_do_not_consume_additional_credits() {
        let downloads = downloads();
        assert_eq!(
            downloads
                .admit("first", "page", MAXIMUM_DOWNLOAD_METADATA_BYTES + 1)
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(
            downloads.slots.available_permits(),
            MAXIMUM_CONTEXT_DOWNLOADS
        );
        downloads.admit("first", "page", 20).unwrap();
        assert_eq!(
            downloads.admit("first", "page", 20).unwrap_err().code,
            ErrorCode::Protocol
        );
        assert_eq!(
            downloads.bytes.available_permits(),
            CONTEXT_METADATA_BYTES - 20
        );
    }

    #[tokio::test]
    async fn accepted_waiter_observes_cancel_before_later_context_retirement() {
        let downloads = downloads();
        downloads.admit("first", "page", 20).unwrap();
        let download = downloads.get("first", "test").unwrap();
        let waiter = downloads.completion(&download, "download.path");
        let closing = async {
            tokio::task::yield_now().await;
            downloads.begin_close();
            assert!(downloads.get("first", "new-call").is_err());
            download
                .outcome
                .send_replace(DownloadOutcome::Failed("canceled".into()));
            downloads.retire(closed("context"));
        };
        let (result, ()) = tokio::join!(waiter, closing);
        assert_eq!(result.unwrap(), Some("canceled".into()));
        assert_eq!(
            downloads.get("first", "later-call").err().unwrap().code,
            ErrorCode::TargetClosed
        );
    }

    #[tokio::test]
    async fn retained_closing_context_routes_terminal_progress_before_disposal_reply() {
        use std::future::Future;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let (outgoing, _messages) = mpsc::channel(16);
        let (fatal, _failure) = watch::channel(false);
        let engine = Arc::new(Engine::new(
            None,
            outgoing,
            fatal,
            ResourceLimits::default(),
        ));
        let downloads = Arc::new(downloads());
        downloads.admit("original", "page", 20).unwrap();
        let download = downloads.get("original", "download.path").unwrap();
        let context_state = Arc::new(context_state::ContextState::default());
        assert!(context_state.downloads.set(downloads.clone()).is_ok());
        engine.registry.lock().unwrap().contexts.insert(
            "context".into(),
            Context {
                browser_identifier: "browser".into(),
                protocol_identifier: "native-context".into(),
                viewport: None,
                devices: devices::DeviceOptions::default(),
                settings: context_settings::ContextSettings::parse(&json!({})).unwrap(),
                state: context_state.clone(),
                published: false,
            },
        );
        let (_cancellation, receiver) = watch::channel(false);
        let operation = Operation::new("download.saveAs".into(), None, receiver);
        let admitted = ["download.path", "download.saveAs"].map(|method| {
            let parameters = if method == "download.saveAs" {
                json!({"context":"context", "download":"original", "path":"/unused-download-copy"})
            } else {
                json!({"context":"context", "download":"original"})
            };
            engine
                .prepare_download_operation(method, &parameters, &operation)
                .unwrap()
                .unwrap()
        });
        let (native, peer) = tokio::io::duplex(8192);
        let (native_input, native_output) = tokio::io::split(native);
        let connection = flashwright_browser::Connection::new(native_input, native_output);
        let observing_engine = engine.clone();
        connection
            .observe_events(move |event| observing_engine.download_event("browser", &event))
            .unwrap();
        let (peer_input, mut peer_output) = tokio::io::split(peer);
        let mut peer_input = BufReader::new(peer_input);
        let mut waiter = Box::pin(downloads.completion(&download, "download.path"));
        std::future::poll_fn(|context| {
            assert!(waiter.as_mut().poll(context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;

        context_state.closed.send_replace(Some(closed("context")));
        downloads.begin_close();
        assert_eq!(
            engine
                .context("context", "context.cookies")
                .err()
                .unwrap()
                .code,
            ErrorCode::TargetClosed
        );
        assert!(downloads.get("original", "download.path").is_err());

        let cancelling_connection = connection.clone();
        let cancellation = tokio::spawn(async move {
            cancelling_connection
                .call(
                    "Browser.cancelDownload",
                    json!({ "guid": "original", "browserContextId": "native-context" }),
                    None,
                )
                .await
        });
        let mut command = Vec::new();
        timeout(
            Duration::from_secs(1),
            peer_input.read_until(0, &mut command),
        )
        .await
        .unwrap()
        .unwrap();
        let cancellation_command: Value =
            serde_json::from_slice(&command[..command.len() - 1]).unwrap();
        assert_eq!(cancellation_command["method"], "Browser.cancelDownload");
        let mut acknowledgement =
            serde_json::to_vec(&json!({ "id": cancellation_command["id"], "result": {} })).unwrap();
        acknowledgement.push(0);
        peer_output.write_all(&acknowledgement).await.unwrap();
        cancellation.await.unwrap().unwrap();

        let disposing_connection = connection.clone();
        let disposal = tokio::spawn(async move {
            disposing_connection
                .call(
                    "Target.disposeBrowserContext",
                    json!({ "browserContextId": "native-context" }),
                    None,
                )
                .await
        });
        command.clear();
        timeout(
            Duration::from_secs(1),
            peer_input.read_until(0, &mut command),
        )
        .await
        .unwrap()
        .unwrap();
        let disposal_command: Value =
            serde_json::from_slice(&command[..command.len() - 1]).unwrap();
        assert_eq!(disposal_command["method"], "Target.disposeBrowserContext");
        let mut terminal_then_reply = serde_json::to_vec(&json!({
            "method": "Browser.downloadProgress",
            "params": { "guid": "original", "state": "canceled" },
        }))
        .unwrap();
        terminal_then_reply.push(0);
        terminal_then_reply.extend(
            serde_json::to_vec(&json!({ "id": disposal_command["id"], "result": {} })).unwrap(),
        );
        terminal_then_reply.push(0);
        peer_output.write_all(&terminal_then_reply).await.unwrap();
        disposal.await.unwrap().unwrap();

        // This exercises the routing and reply barrier primitives; close_context owns their sequence.
        engine.remove_context("context").unwrap();
        assert_eq!(waiter.await.unwrap(), Some("canceled".into()));
        for pending in admitted {
            let error = pending.finish(&operation).await.unwrap_err();
            assert_eq!(error.code, ErrorCode::Request);
            assert_eq!(error.message.as_ref(), "canceled");
        }
        assert_eq!(
            downloads.get("original", "later-call").err().unwrap().code,
            ErrorCode::TargetClosed
        );
        connection.close();
    }

    #[tokio::test]
    async fn owner_loss_settles_an_unfinished_download_without_success() {
        let downloads = downloads();
        downloads.admit("first", "page", 20).unwrap();
        let download = downloads.get("first", "test").unwrap();
        let waiter = downloads.completion(&download, "download.path");
        let closing = async {
            tokio::task::yield_now().await;
            downloads.retire(closed("context"));
        };
        let (result, ()) = tokio::join!(waiter, closing);
        assert_eq!(result.unwrap_err().code, ErrorCode::TargetClosed);
    }

    #[test]
    fn metadata_keeps_browser_strings_as_exact_json() {
        let raw = r#"{"frameId":"frame","guid":"guid","url":"https://example.test/","suggestedFilename":"lone-\ud800"}"#;
        let metadata: DownloadStarted<'_> = serde_json::from_str(raw).unwrap();
        assert_eq!(metadata.suggested_filename.get(), r#""lone-\ud800""#);
    }
}
