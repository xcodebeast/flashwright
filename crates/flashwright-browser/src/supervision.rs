use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use command_fds::{CommandFdExt, FdMapping};
use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Pid, getppid};

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
        eprintln!(
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
    command.fd_mappings(vec![
        FdMapping {
            parent_fd: browser_input,
            child_fd: 3,
        },
        FdMapping {
            parent_fd: browser_output,
            child_fd: 4,
        },
    ])?;
    let mut browser = command.spawn()?;
    drop(command);
    let browser_group = Pid::from_raw(browser.id() as i32);
    if trace_ownership {
        eprintln!(
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
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
            let _ = sender.send(node_pipe);
        });
    }
    drop(lost_parent);
    loop {
        // Do not reap the browser before signalling its group: its unreaped PID protects ownership.
        match events.recv_timeout(Duration::from_millis(50)) {
            Ok(node_pipe) => {
                if trace_ownership {
                    eprintln!(
                        "guardian {} lost {} liveness",
                        std::process::id(),
                        if node_pipe { "node" } else { "driver" }
                    );
                }
                if node_pipe && getppid() == parent {
                    let _ = kill(parent, Signal::SIGKILL);
                }
                crate::process_group::terminate(browser_group)?;
                let _ = browser.wait();
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if child_exited_without_reaping(browser_group)? {
                    crate::process_group::terminate(browser_group)?;
                    let _ = browser.wait();
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if trace_ownership {
        eprintln!(
            "guardian {} removing profile {}",
            std::process::id(),
            profile.path().display()
        );
    }
    profile.close()?;
    if trace_ownership {
        eprintln!("guardian {} removed profile", std::process::id());
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
