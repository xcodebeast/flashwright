use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream as StandardUnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use command_fds::{CommandFdExt, FdMapping};
use flashwright_protocol::{ErrorCode, ErrorRecord};
use nix::unistd::Pid;
use serde::Deserialize;
use serde_json::json;
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

pub struct Chromium {
    pub connection: Connection,
    pub version: String,
    pub headless: bool,
    child: Mutex<Option<Child>>,
    process_group: Pid,
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
        let (liveness, guardian_liveness) = StandardUnixStream::pair().map_err(launch_error)?;
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
        let child = command.spawn().map_err(launch_error)?;
        drop(command);
        let process_group =
            Pid::from_raw(child.id().expect("new child has a process identifier") as i32);
        let mut browser = Self {
            connection: Connection::new(incoming, outgoing),
            version: String::new(),
            headless: options.headless,
            child: Mutex::new(Some(child)),
            process_group,
            liveness: Mutex::new(Some(liveness)),
            shutdown: Mutex::new(None),
        };
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
                tokio::spawn(async move {
                    let _ = timeout(
                        Duration::from_secs(1),
                        connection.call("Browser.close", json!({}), None),
                    )
                    .await;
                    connection.close();
                    drop(liveness);
                    let result = match child {
                        Some(mut child) => match child.wait().await {
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
        self.connection.close();
        self.liveness.get_mut().unwrap().take();
        // The guardian must outlive this value long enough to kill Chromium and remove its profile.
        if let Some(mut child) = self.child.get_mut().unwrap().take() {
            tokio::spawn(async move {
                let _ = child.wait().await;
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
    async fn guardian_cleanup_survives_cancelled_waiters_and_the_previous_kill_budget() {
        let child = Command::new("sleep")
            .arg("2.1")
            .process_group(0)
            .spawn()
            .unwrap();
        let process_group = Pid::from_raw(child.id().unwrap() as i32);
        let (liveness, _peer) = StandardUnixStream::pair().unwrap();
        let browser = Chromium {
            connection: Connection::new(tokio::io::empty(), tokio::io::sink()),
            version: String::new(),
            headless: true,
            child: Mutex::new(Some(child)),
            process_group,
            liveness: Mutex::new(Some(liveness)),
            shutdown: Mutex::new(None),
        };
        assert!(
            timeout(Duration::from_millis(20), browser.close())
                .await
                .is_err()
        );
        browser.close().await.unwrap();
        browser.close().await.unwrap();
    }
}
