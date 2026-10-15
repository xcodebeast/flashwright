use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream as StandardUnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use command_fds::{CommandFdExt, FdMapping};
use flashwright_protocol::{ErrorCode, ErrorRecord};
use nix::unistd::Pid;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio::time::{Duration, timeout};

use crate::Connection;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchOptions {
    pub executable_path: PathBuf,
    #[serde(default = "default_headless")]
    pub headless: bool,
}

fn default_headless() -> bool {
    true
}

#[derive(Deserialize)]
struct BrowserLaunchPolicy {
    headed: Vec<String>,
    headless: Vec<String>,
}

fn launch_arguments(headless: bool) -> &'static [String] {
    static POLICY: OnceLock<BrowserLaunchPolicy> = OnceLock::new();
    let policy = POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("chromium-launch-policy.json"))
            .expect("checked-in Chromium launch policy must be valid")
    });
    if headless {
        &policy.headless
    } else {
        &policy.headed
    }
}

type ShutdownCompletion = watch::Receiver<Option<Result<(), ErrorRecord>>>;

// macOS creates pipes/socket pairs and sets CLOEXEC in separate system calls. Another
// launch must not fork in that window and inherit a launch-status or liveness writer.
#[cfg(target_os = "macos")]
static DESCRIPTOR_INHERITANCE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub struct Chromium {
    pub connection: Connection,
    pub version: String,
    pub headless: bool,
    pub artifacts_directory: PathBuf,
    pub artifact_jobs: Arc<tokio::sync::RwLock<()>>,
    child: Mutex<Option<Child>>,
    process_group: Pid,
    guardian_reap_audit: Option<crate::guardian_reap_audit::GuardianReapAudit>,
    liveness: Mutex<Option<StandardUnixStream>>,
    shutdown: Mutex<Option<ShutdownCompletion>>,
}

impl Chromium {
    /// Launch only an explicitly selected binary; no browser acquisition happens implicitly.
    pub async fn launch(
        options: LaunchOptions,
        parent_liveness: Option<&OwnedFd>,
    ) -> Result<Self, ErrorRecord> {
        if !options.executable_path.is_file() {
            return Err(ErrorRecord::new(
                ErrorCode::InvalidArgument,
                "chromium.launch",
                "executablePath must name an existing Chromium executable",
            ));
        }
        #[cfg(target_os = "macos")]
        let descriptor_inheritance_guard = DESCRIPTOR_INHERITANCE.lock().await;
        let (liveness, guardian_liveness) = StandardUnixStream::pair().map_err(launch_error)?;
        let metadata = liveness.try_clone().map_err(launch_error)?;
        metadata.set_nonblocking(true).map_err(launch_error)?;
        let mut metadata = UnixStream::from_std(metadata).map_err(launch_error)?;
        let (outgoing, browser_input) = StandardUnixStream::pair().map_err(launch_error)?;
        let (browser_output, incoming) = StandardUnixStream::pair().map_err(launch_error)?;
        outgoing.set_nonblocking(true).map_err(launch_error)?;
        incoming.set_nonblocking(true).map_err(launch_error)?;
        let outgoing = UnixStream::from_std(outgoing).map_err(launch_error)?;
        let incoming = UnixStream::from_std(incoming).map_err(launch_error)?;
        let mut command =
            std::process::Command::new(std::env::current_exe().map_err(launch_error)?);
        command
            .arg("--browser-guardian")
            .arg(&options.executable_path);
        command.args(launch_arguments(options.headless));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .process_group(0);
        let mut mappings = vec![
            FdMapping {
                parent_fd: browser_input.into(),
                child_fd: 3,
            },
            FdMapping {
                parent_fd: browser_output.into(),
                child_fd: 4,
            },
            FdMapping {
                parent_fd: guardian_liveness.into(),
                child_fd: 5,
            },
        ];
        if let Some(parent_liveness) = parent_liveness {
            mappings.push(FdMapping {
                parent_fd: parent_liveness.try_clone().map_err(launch_error)?,
                child_fd: 6,
            });
            command.env("FLASHWRIGHT_GUARDIAN_HAS_NODE_PIPE", "1");
        } else {
            command.env_remove("FLASHWRIGHT_GUARDIAN_HAS_NODE_PIPE");
        }
        command.fd_mappings(mappings).map_err(launch_error)?;
        let mut command = Command::from(command);
        command.kill_on_drop(false);
        let guardian_reap_audit = crate::guardian_reap_audit::GuardianReapAudit::from_environment();
        let child = command.spawn().map_err(launch_error)?;
        drop(command);
        #[cfg(target_os = "macos")]
        drop(descriptor_inheritance_guard);
        let process_group =
            Pid::from_raw(child.id().expect("new child has a process identifier") as i32);
        let mut browser = Self {
            connection: Connection::new(incoming, outgoing),
            version: String::new(),
            headless: options.headless,
            artifacts_directory: PathBuf::new(),
            artifact_jobs: Arc::new(tokio::sync::RwLock::new(())),
            child: Mutex::new(Some(child)),
            process_group,
            guardian_reap_audit,
            liveness: Mutex::new(Some(liveness)),
            shutdown: Mutex::new(None),
        };
        browser.artifacts_directory = crate::guardian_metadata::read_directory(&mut metadata)
            .await
            .map_err(launch_error)?;
        drop(metadata);
        let identity = browser
            .connection
            .call("Browser.getVersion", json!({}), None)
            .await?;
        browser.version = identity["product"].as_str().unwrap_or_default().to_owned();
        if browser.version != "Chrome/148.0.7778.96"
            && browser.version != "HeadlessChrome/148.0.7778.96"
        {
            return Err(ErrorRecord::new(
                ErrorCode::UnsupportedFeature,
                "chromium.launch",
                format!(
                    "unsupported browser {}; expected Chromium 148.0.7778.96",
                    browser.version
                ),
            ));
        }
        Ok(browser)
    }

    pub fn process_identifier(&self) -> u32 {
        self.process_group.as_raw() as u32
    }

    /// Physical filesystem work keeps the guardian alive even if its async waiter disappears.
    pub fn retain_artifact_liveness(&self) -> Result<OwnedFd, ErrorRecord> {
        self.liveness
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| {
                ErrorRecord::new(ErrorCode::TargetClosed, "download", "browser is closing")
            })?
            .try_clone()
            .map(OwnedFd::from)
            .map_err(launch_error)
    }

    /// All callers share cleanup completion; abandoning a wait cannot kill its independent owner.
    pub async fn close(&self) -> Result<(), ErrorRecord> {
        let mut completion = {
            let mut shutdown = self.shutdown.lock().unwrap();
            if let Some(completion) = shutdown.as_ref() {
                completion.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                let child = self.child.lock().unwrap().take();
                let liveness = self.liveness.lock().unwrap().take();
                let connection = self.connection.clone();
                let artifact_jobs = self.artifact_jobs.clone();
                let guardian_reap_audit = self.guardian_reap_audit.clone();
                tokio::spawn(async move {
                    let _artifacts = artifact_jobs.write().await;
                    let mut guardian = liveness.and_then(|stream| {
                        stream.set_nonblocking(true).ok()?;
                        UnixStream::from_std(stream).ok()
                    });
                    let graceful_shutdown = if let Some(guardian) = guardian.as_mut() {
                        matches!(
                            timeout(
                                Duration::from_secs(1),
                                guardian
                                    .write_all(&[crate::supervision::GRACEFUL_SHUTDOWN_REQUEST]),
                            )
                            .await,
                            Ok(Ok(()))
                        )
                    } else {
                        false
                    };
                    let _ = timeout(
                        Duration::from_secs(1),
                        connection.call("Browser.close", json!({}), None),
                    )
                    .await;
                    if graceful_shutdown {
                        // CDP acknowledges the request before native teardown finishes. Retain both
                        // channels until the independent guardian observes and reaps browser exit.
                        let guardian = guardian.as_mut().expect("shutdown has a guardian");
                        let _ = timeout(
                            crate::supervision::GRACEFUL_SHUTDOWN_TIMEOUT + Duration::from_secs(1),
                            async {
                                let completion = guardian.read_u8().await?;
                                if !matches!(
                                    completion,
                                    crate::supervision::BROWSER_REAPED
                                        | crate::supervision::BROWSER_TERMINATED
                                ) {
                                    return Err(std::io::Error::other(
                                        "invalid guardian completion",
                                    ));
                                }
                                Ok(())
                            },
                        )
                        .await;
                    }
                    connection.close();
                    drop(guardian);
                    let result = match child {
                        Some(mut child) => match crate::guardian_reap_audit::wait_for_guardian(
                            &mut child,
                            guardian_reap_audit.as_ref(),
                        )
                        .await
                        {
                            Ok(status) if status.success() => Ok(()),
                            result => {
                                let mut error = ErrorRecord::new(
                                    ErrorCode::Protocol,
                                    "browser.close",
                                    format!("browser guardian cleanup failed: {result:?}"),
                                );
                                error.cleanup = Some("guardianCleanupFailed".into());
                                Err(error)
                            }
                        },
                        None => Ok(()),
                    };
                    sender.send_replace(Some(result));
                });
                *shutdown = Some(receiver.clone());
                receiver
            }
        };
        completion
            .wait_for(|result| result.is_some())
            .await
            .map_err(|_| {
                ErrorRecord::new(
                    ErrorCode::Protocol,
                    "browser.close",
                    "guardian cleanup completion was lost",
                )
            })?;
        completion
            .borrow()
            .as_ref()
            .expect("completion contains a terminal result")
            .clone()
    }
}

impl Drop for Chromium {
    fn drop(&mut self) {
        if self.shutdown.get_mut().unwrap().is_none() {
            self.connection.close();
        }
        let liveness = self.liveness.get_mut().unwrap().take();
        let artifacts = self.artifact_jobs.clone();
        let guardian_reap_audit = self.guardian_reap_audit.take();
        // The guardian must outlive this value long enough to kill Chromium and remove its profile.
        if let Some(mut child) = self.child.get_mut().unwrap().take() {
            tokio::spawn(async move {
                let _artifacts = artifacts.write().await;
                drop(liveness);
                let _ = crate::guardian_reap_audit::wait_for_guardian(
                    &mut child,
                    guardian_reap_audit.as_ref(),
                )
                .await;
            });
        }
    }
}

fn launch_error(error: impl std::fmt::Display) -> ErrorRecord {
    ErrorRecord::new(ErrorCode::Protocol, "chromium.launch", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_close_keeps_protocol_open_until_guardian_reaps_browser() {
        use tokio::io::AsyncBufReadExt;

        let (liveness, peer) = StandardUnixStream::pair().unwrap();
        peer.set_nonblocking(true).unwrap();
        let mut guardian = UnixStream::from_std(peer).unwrap();
        let (protocol, browser_protocol) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(protocol);
        let mut browser_protocol = tokio::io::BufReader::new(browser_protocol);
        let browser = Arc::new(Chromium {
            connection: Connection::new(reader, writer),
            version: String::new(),
            headless: true,
            artifacts_directory: PathBuf::new(),
            artifact_jobs: Arc::new(tokio::sync::RwLock::new(())),
            child: Mutex::new(None),
            process_group: Pid::from_raw(0),
            guardian_reap_audit: None,
            liveness: Mutex::new(Some(liveness)),
            shutdown: Mutex::new(None),
        });
        let closing_browser = browser.clone();
        let closing = tokio::spawn(async move { closing_browser.close().await });
        assert_eq!(
            guardian.read_u8().await.unwrap(),
            crate::supervision::GRACEFUL_SHUTDOWN_REQUEST
        );
        let mut command = Vec::new();
        browser_protocol.read_until(0, &mut command).await.unwrap();
        command.pop();
        let command: serde_json::Value = serde_json::from_slice(&command).unwrap();
        assert_eq!(command["method"], "Browser.close");
        let reply = format!("{}\0", json!({"id": command["id"], "result": {}}));
        browser_protocol
            .get_mut()
            .write_all(reply.as_bytes())
            .await
            .unwrap();
        closing.abort();
        assert!(closing.await.unwrap_err().is_cancelled());
        drop(browser);
        let mut byte = [0];
        assert!(
            timeout(Duration::from_millis(30), browser_protocol.read(&mut byte))
                .await
                .is_err()
        );
        guardian
            .write_all(&[crate::supervision::BROWSER_REAPED])
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), browser_protocol.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert_eq!(
            timeout(Duration::from_secs(1), guardian.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn physical_artifact_lease_survives_async_waiter_abort() {
        use tokio::io::AsyncReadExt;
        let (liveness, peer) = StandardUnixStream::pair().unwrap();
        peer.set_nonblocking(true).unwrap();
        let mut peer = UnixStream::from_std(peer).unwrap();
        let browser = Chromium {
            connection: Connection::new(tokio::io::empty(), tokio::io::sink()),
            version: String::new(),
            headless: true,
            artifacts_directory: PathBuf::new(),
            artifact_jobs: Arc::new(tokio::sync::RwLock::new(())),
            child: Mutex::new(None),
            process_group: Pid::from_raw(0),
            guardian_reap_audit: None,
            liveness: Mutex::new(Some(liveness)),
            shutdown: Mutex::new(None),
        };
        let artifacts = browser.artifact_jobs.clone().read_owned().await;
        let liveness = browser.retain_artifact_liveness().unwrap();
        let (release, completion) = std::sync::mpsc::channel();
        let physical = tokio::task::spawn_blocking(move || {
            let _artifacts = artifacts;
            let _liveness = liveness;
            let _ = completion.recv();
        });
        let waiter = tokio::spawn(async move { physical.await.unwrap() });
        waiter.abort();
        drop(browser);
        let mut byte = [0];
        assert!(
            timeout(Duration::from_millis(20), peer.read(&mut byte))
                .await
                .is_err()
        );
        release.send(()).unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), peer.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn guardian_cleanup_survives_cancelled_waiters_and_the_previous_kill_budget() {
        let child = Command::new("sleep")
            .arg("2.1")
            .process_group(0)
            .spawn()
            .unwrap();
        let process_group = Pid::from_raw(child.id().unwrap() as i32);
        let (liveness, _peer) = StandardUnixStream::pair().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let guardian_reap_audit =
            crate::guardian_reap_audit::GuardianReapAudit::read_environment(|name| {
                Some(if name.ends_with("REAPS") {
                    directory.path().as_os_str().to_owned()
                } else {
                    "0123456789abcdef0123456789abcdef".into()
                })
            })
            .unwrap();
        let browser = Chromium {
            connection: Connection::new(tokio::io::empty(), tokio::io::sink()),
            version: String::new(),
            headless: true,
            artifacts_directory: PathBuf::new(),
            artifact_jobs: Arc::new(tokio::sync::RwLock::new(())),
            child: Mutex::new(Some(child)),
            process_group,
            guardian_reap_audit,
            liveness: Mutex::new(Some(liveness)),
            shutdown: Mutex::new(None),
        };
        assert!(
            timeout(Duration::from_millis(20), browser.close())
                .await
                .is_err()
        );
        browser.close().await.unwrap();
        let receipt = directory
            .path()
            .join(format!("guardian-{}.json", process_group.as_raw()));
        let bytes = std::fs::read(&receipt).unwrap();
        browser.close().await.unwrap();
        drop(browser);
        assert_eq!(std::fs::read(&receipt).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn drop_records_original_guardian_after_artifacts_finish() {
        let directory = tempfile::tempdir().unwrap();
        let child = Command::new("true").spawn().unwrap();
        let process = child.id().unwrap();
        let audit = crate::guardian_reap_audit::GuardianReapAudit::read_environment(|name| {
            Some(if name.ends_with("REAPS") {
                directory.path().as_os_str().to_owned()
            } else {
                "0123456789abcdef0123456789abcdef".into()
            })
        })
        .unwrap();
        let browser = Chromium {
            connection: Connection::new(tokio::io::empty(), tokio::io::sink()),
            version: String::new(),
            headless: true,
            artifacts_directory: PathBuf::new(),
            artifact_jobs: Arc::new(tokio::sync::RwLock::new(())),
            child: Mutex::new(Some(child)),
            process_group: Pid::from_raw(process as i32),
            guardian_reap_audit: audit,
            liveness: Mutex::new(None),
            shutdown: Mutex::new(None),
        };
        let artifacts = browser.artifact_jobs.clone().read_owned().await;
        drop(browser);
        tokio::task::yield_now().await;
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        drop(artifacts);
        let receipt = directory.path().join(format!("guardian-{process}.json"));
        timeout(Duration::from_secs(2), async {
            while !receipt.is_file() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
        assert_eq!(record["guardianProcess"], process);
        assert_eq!(record["code"], 0);
    }
}
