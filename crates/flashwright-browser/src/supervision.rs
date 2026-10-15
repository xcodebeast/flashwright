use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use command_fds::{CommandFdExt, FdMapping};
use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Pid, getppid};

pub(crate) const GRACEFUL_SHUTDOWN_REQUEST: u8 = b'C';
pub(crate) const BROWSER_REAPED: u8 = b'R';
pub(crate) const BROWSER_TERMINATED: u8 = b'K';
pub(crate) const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

enum GuardianEvent {
    GracefulShutdown,
    ParentLost { node: bool },
}

/// Keep the browser leader unreaped until its process group has stopped, even
/// when a later guardian operation returns an error.
struct BrowserCustody {
    child: std::process::Child,
    capture: Option<crate::native_resource_capture::Capture>,
    reaped: bool,
}

impl BrowserCustody {
    fn id(&self) -> u32 {
        self.child.id()
    }

    fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let status = self.child.wait()?;
        self.reaped = true;
        if let Some(capture) = &self.capture {
            capture.record_browser_exit(self.child.id(), status);
        }
        Ok(status)
    }

    fn finish_capture(&mut self) -> std::io::Result<()> {
        if let Some(capture) = &mut self.capture {
            capture.finish()?;
        }
        Ok(())
    }
}

impl Drop for BrowserCustody {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        // Enumeration failure must not release the unreaped group leader. The
        // caller may time out, but this independent owner still owes cleanup.
        let group = Pid::from_raw(self.child.id() as i32);
        while let Err(error) = crate::process_group::terminate(group) {
            let _ = writeln!(std::io::stderr(), "guardian group cleanup: {error}");
            std::thread::sleep(Duration::from_millis(50));
        }
        while let Err(error) = self.wait() {
            let _ = writeln!(std::io::stderr(), "guardian original browser reap: {error}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Take ownership only of an inherited descriptor explicitly assigned by the parent launch contract.
/// This is the sole raw-descriptor boundary; all later ownership and spawning uses safe APIs.
#[allow(unsafe_code)]
pub fn take_inherited_descriptor(descriptor: RawFd) -> std::io::Result<OwnedFd> {
    // SAFETY: the launcher transfers these descriptors to this process exactly once, before use.
    // Validate that the descriptor exists before constructing the owning handle.
    if unsafe { nix::libc::fcntl(descriptor, nix::libc::F_GETFD) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    fcntl(&descriptor, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC)).map_err(std::io::Error::from)?;
    Ok(descriptor)
}

/// A process independent of Rust's async executor and Node's event loop owns the browser lifetime.
pub fn run_guardian(arguments: &[OsString]) -> Result<(), Box<dyn std::error::Error>> {
    let executable = arguments
        .first()
        .ok_or("browser guardian requires an executable")?;
    let trace_ownership = std::env::var_os("FLASHWRIGHT_DEBUG_OWNERSHIP").is_some();
    let parent = getppid();
    let browser_input = take_inherited_descriptor(3)?;
    let browser_output = take_inherited_descriptor(4)?;
    let driver_liveness = take_inherited_descriptor(5)?;
    let node_liveness = if std::env::var_os("FLASHWRIGHT_GUARDIAN_HAS_NODE_PIPE").is_some() {
        Some(take_inherited_descriptor(6)?)
    } else {
        None
    };
    let profile = tempfile::Builder::new()
        .prefix("flashwright-chromium-")
        .tempdir()?;
    let artifacts = profile.path().join("flashwright-artifacts");
    std::fs::create_dir(&artifacts)?;
    let mut driver_notifications = File::from(driver_liveness.try_clone()?);
    crate::guardian_metadata::write_directory(&mut driver_notifications, &artifacts)?;
    let mut command = Command::new(executable);
    let mut profile_arguments = 0;
    for argument in &arguments[1..] {
        if argument == "--user-data-dir=__FLASHWRIGHT_PROFILE__" {
            command.arg(format!("--user-data-dir={}", profile.path().display()));
            profile_arguments += 1;
        } else {
            command.arg(argument);
        }
    }
    if profile_arguments != 1 {
        return Err("browser launch policy requires exactly one owned profile argument".into());
    }
    if std::env::var_os("FLASHWRIGHT_DEBUG_BROWSER").is_some() {
        let _ = writeln!(
            std::io::stderr(),
            "flashwright:browser <launching> {}",
            serde_json::json!({
                "executable": executable.to_string_lossy(),
                "arguments": command.get_args().map(|argument| argument.to_string_lossy()).collect::<Vec<_>>(),
            })
        );
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .process_group(0);
    let mut mappings = vec![
        FdMapping {
            parent_fd: browser_input,
            child_fd: 3,
        },
        FdMapping {
            parent_fd: browser_output,
            child_fd: 4,
        },
    ];
    let capture =
        if let Some(directory) = std::env::var_os("FLASHWRIGHT_EXPERIMENT_NATIVE_RESOURCES") {
            let (capture, diagnostic) =
                crate::native_resource_capture::Capture::start(std::path::Path::new(&directory))?;
            mappings.push(FdMapping {
                parent_fd: diagnostic,
                child_fd: 5,
            });
            command.env("FLASHWRIGHT_FORK_DIAGNOSTIC_FD", "5");
            command.env("FLASHWRIGHT_NATIVE_RESOURCE_DIAGNOSTICS", "1");
            Some(capture)
        } else {
            None
        };
    command.fd_mappings(mappings)?;
    let mut browser = BrowserCustody {
        child: command.spawn()?,
        capture,
        reaped: false,
    };
    if crate::launch_audit::record_launch(
        &command,
        profile.path(),
        parent.as_raw() as u32,
        browser.id(),
    )
    .is_err()
    {
        // Audit failure invalidates measurement, never the guardian's existing cleanup ownership.
        let _ = writeln!(std::io::stderr(), "flashwright:launch-audit unavailable");
    }
    drop(command);
    let browser_group = Pid::from_raw(browser.id() as i32);
    if trace_ownership {
        let _ = writeln!(
            std::io::stderr(),
            "guardian {} owns browser {browser_group} profile {}",
            std::process::id(),
            profile.path().display()
        );
    }
    let (lost_parent, events) = mpsc::channel();
    for (descriptor, node_pipe) in std::iter::once((driver_liveness, false))
        .chain(node_liveness.map(|descriptor| (descriptor, true)))
    {
        let sender = lost_parent.clone();
        std::thread::spawn(move || {
            if let Ok(flags) = fcntl(&descriptor, FcntlArg::F_GETFL) {
                let _ = fcntl(
                    &descriptor,
                    FcntlArg::F_SETFL(
                        nix::fcntl::OFlag::from_bits_retain(flags) & !nix::fcntl::OFlag::O_NONBLOCK,
                    ),
                );
            }
            let mut pipe = File::from(descriptor);
            let mut buffer = [0_u8; 64];
            let mut shutdown_requested = false;
            loop {
                match pipe.read(&mut buffer) {
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Ok(0) | Err(_) => break,
                    Ok(count) if !node_pipe => {
                        if !shutdown_requested
                            && buffer[..count].contains(&GRACEFUL_SHUTDOWN_REQUEST)
                        {
                            shutdown_requested = true;
                            let _ = sender.send(GuardianEvent::GracefulShutdown);
                        }
                    }
                    Ok(_) => {}
                }
            }
            let _ = sender.send(GuardianEvent::ParentLost { node: node_pipe });
        });
    }
    drop(lost_parent);
    let mut browser_exited = false;
    let mut shutdown_deadline = None;
    let mut browser_reap_announced = false;
    let mut browser_terminated = false;
    loop {
        // Do not reap the browser before signalling its group: its unreaped PID protects ownership.
        match events.recv_timeout(Duration::from_millis(50)) {
            Ok(GuardianEvent::GracefulShutdown) => {
                shutdown_deadline.get_or_insert_with(|| Instant::now() + GRACEFUL_SHUTDOWN_TIMEOUT);
            }
            Ok(GuardianEvent::ParentLost { node: node_pipe }) => {
                if trace_ownership {
                    let _ = writeln!(
                        std::io::stderr(),
                        "guardian {} lost {} liveness",
                        std::process::id(),
                        if node_pipe { "node" } else { "driver" }
                    );
                }
                if node_pipe && getppid() == parent {
                    let _ = kill(parent, Signal::SIGKILL);
                }
                if !browser_exited {
                    crate::process_group::terminate(browser_group)?;
                    let _ = browser.wait();
                }
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if !browser_exited {
            let exited = child_exited_without_reaping(browser_group)?;
            let expired = shutdown_deadline.is_some_and(|deadline| Instant::now() >= deadline);
            if exited || expired {
                browser_terminated = !exited;
                crate::process_group::terminate(browser_group)?;
                browser.wait()?;
                // A live driver may still own file I/O after the browser exits.
                // Its liveness lease ends only after those jobs drain, or it dies.
                browser_exited = true;
            }
        }
        if browser_exited && shutdown_deadline.is_some() && !browser_reap_announced {
            browser_reap_announced = true;
            let completion = if browser_terminated {
                BROWSER_TERMINATED
            } else {
                BROWSER_REAPED
            };
            let _ = driver_notifications.write_all(&[completion]);
        }
    }
    if trace_ownership {
        let _ = writeln!(
            std::io::stderr(),
            "guardian {} removing profile {}",
            std::process::id(),
            profile.path().display()
        );
    }
    // Finish diagnostics after custody cleanup and before publishing successful
    // guardian completion. Capture failure must not bypass browser termination.
    if !browser.reaped {
        crate::process_group::terminate(browser_group)?;
        browser.wait()?;
    }
    browser.finish_capture()?;
    drop(browser);
    profile.close()?;
    if trace_ownership {
        let _ = writeln!(
            std::io::stderr(),
            "guardian {} removed profile",
            std::process::id()
        );
    }
    Ok(())
}

/// Keep the owned child's PID reserved until its whole process group has been terminated.
/// nix does not expose waitid on macOS, so this small wrapper covers both supported platforms.
#[allow(unsafe_code)]
pub(crate) fn child_exited_without_reaping(process: Pid) -> std::io::Result<bool> {
    let mut information = std::mem::MaybeUninit::<nix::libc::siginfo_t>::zeroed();
    // SAFETY: waitid writes to a correctly sized C structure. Zero initialization also covers
    // WNOHANG's no-event result; WNOWAIT deliberately leaves this exclusively owned child unreaped.
    let result = unsafe {
        nix::libc::waitid(
            nix::libc::P_PID,
            process.as_raw() as nix::libc::id_t,
            information.as_mut_ptr(),
            nix::libc::WEXITED | nix::libc::WNOHANG | nix::libc::WNOWAIT,
        )
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    let process_identifier = unsafe { information.si_pid() };
    // Darwin can report CLD_STOPPED despite WEXITED. A stopped child is still alive;
    // killing it here would turn a recoverable operation timeout into a disconnect.
    Ok(process_identifier != 0
        && matches!(
            information.si_code,
            nix::libc::CLD_EXITED | nix::libc::CLD_KILLED | nix::libc::CLD_DUMPED
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guardian_error_retains_custody_until_browser_termination_and_reap() {
        let mut unrelated = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let process = Pid::from_raw(child.id() as i32);
        let fail_after_spawn = || -> std::io::Result<()> {
            let _custody = BrowserCustody {
                child,
                capture: None,
                reaped: false,
            };
            Err(std::io::Error::other("injected guardian work failure"))
        };
        let result = fail_after_spawn();
        let owned_process_gone = kill(process, None) == Err(nix::errno::Errno::ESRCH);
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        assert!(result.is_err());
        assert!(owned_process_gone);
        assert!(unrelated_alive);
    }

    #[test]
    fn successful_reap_releases_custody_without_touching_other_processes() {
        let child = Command::new("true").process_group(0).spawn().unwrap();
        let mut custody = BrowserCustody {
            child,
            capture: None,
            reaped: false,
        };
        let status = custody.wait().unwrap();
        assert!(status.success());
        assert!(custody.reaped);
        drop(custody);
    }
}
