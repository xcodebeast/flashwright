//! Optional evidence of the driver's existing wait for its original guardian.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::ExitStatus;

use tokio::process::Child;

#[derive(Clone)]
pub(crate) struct GuardianReapAudit {
    directory: PathBuf,
    session: String,
}

impl GuardianReapAudit {
    /// Snapshot controls at launch so later environment changes cannot relabel a child.
    pub(crate) fn from_environment() -> Option<Self> {
        match Self::read_environment(|name| std::env::var_os(name)) {
            Ok(audit) => audit,
            Err(error) => {
                report_failure(error);
                None
            }
        }
    }

    pub(super) fn read_environment(
        environment: impl Fn(&str) -> Option<OsString>,
    ) -> io::Result<Option<Self>> {
        let Some(directory) = environment("FLASHWRIGHT_EXPERIMENT_GUARDIAN_REAPS") else {
            return Ok(None);
        };
        let directory = PathBuf::from(directory);
        let session = environment("FLASHWRIGHT_EXPERIMENT_SESSION")
            .and_then(|value| value.into_string().ok())
            .ok_or_else(invalid_record)?;
        if !directory.is_absolute()
            || session.len() != 32
            || !session.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid_record());
        }
        Ok(Some(Self { directory, session }))
    }

    fn record(
        &self,
        guardian_process: u32,
        status: ExitStatus,
        wait_started_nanoseconds: u128,
    ) -> io::Result<()> {
        let wait_completed_nanoseconds = monotonic_nanoseconds()?;
        if wait_completed_nanoseconds < wait_started_nanoseconds {
            return Err(invalid_record());
        }
        let record = serde_json::json!({
            "schemaVersion": 1,
            "method": "original-guardian-child-wait",
            "session": self.session,
            "driverProcess": std::process::id(),
            "guardianProcess": guardian_process,
            "clock": if cfg!(target_os = "macos") { "mach_absolute_time" } else { "CLOCK_MONOTONIC" },
            "waitStartedNanoseconds": wait_started_nanoseconds.to_string(),
            "waitCompletedNanoseconds": wait_completed_nanoseconds.to_string(),
            "waitStatus": status.into_raw(),
            "code": status.code(),
            "signal": status.signal(),
        });
        // Fixed fields and a validated 32-byte session bound this receipt independently
        // of browser output. Exclusive creation makes duplicate evidence an error.
        let mut bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
        bytes.push(b'\n');
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(
                self.directory
                    .join(format!("guardian-{guardian_process}.json")),
            )?;
        file.write_all(&bytes)
    }
}

/// Record only a successful terminal wait on the original, still-owned Child.
/// Diagnostic failures must not replace the actual shutdown outcome.
pub(crate) async fn wait_for_guardian(
    child: &mut Child,
    audit: Option<&GuardianReapAudit>,
) -> io::Result<ExitStatus> {
    let observation = audit.map(|_| {
        Ok::<_, io::Error>((
            child.id().ok_or_else(invalid_record)?,
            monotonic_nanoseconds()?,
        ))
    });
    let result = child.wait().await;
    if let Some(audit) = audit {
        let recorded = match (observation, &result) {
            (Some(Ok((process, started))), Ok(status)) => audit.record(process, *status, started),
            (Some(Err(error)), _) => Err(error),
            _ => Err(invalid_record()),
        };
        if let Err(error) = recorded {
            report_failure(error);
        }
    }
    result
}

fn invalid_record() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "original guardian wait evidence unavailable",
    )
}

fn report_failure(error: io::Error) {
    let _ = writeln!(io::stderr(), "guardian reap audit failed: {error}");
}

/// Match the native collector's system-wide monotonic clock, without an Instant origin.
#[allow(unsafe_code)]
#[cfg_attr(
    target_os = "macos",
    allow(
        deprecated,
        reason = "Pinned libc retains these stable Mach APIs; use the collector's exact clock without adding another binding crate"
    )
)]
fn monotonic_nanoseconds() -> io::Result<u128> {
    #[cfg(target_os = "macos")]
    {
        let mut timebase = nix::libc::mach_timebase_info { numer: 0, denom: 0 };
        // Both calls only read the clock; the out-pointer references initialized storage.
        let result = unsafe { nix::libc::mach_timebase_info(&mut timebase) };
        if result != 0 || timebase.numer == 0 || timebase.denom == 0 {
            return Err(invalid_record());
        }
        let ticks = unsafe { nix::libc::mach_absolute_time() };
        Ok(u128::from(ticks) * u128::from(timebase.numer) / u128::from(timebase.denom))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut timestamp = nix::libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // The out-pointer references writable initialized storage for this clock query.
        if unsafe { nix::libc::clock_gettime(nix::libc::CLOCK_MONOTONIC, &mut timestamp) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if timestamp.tv_sec < 0 || !(0..1_000_000_000).contains(&timestamp.tv_nsec) {
            return Err(invalid_record());
        }
        Ok(timestamp.tv_sec as u128 * 1_000_000_000 + timestamp.tv_nsec as u128)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::process::Command;

    fn audit(directory: &std::path::Path) -> GuardianReapAudit {
        GuardianReapAudit {
            directory: directory.to_owned(),
            session: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    #[test]
    fn disabled_control_reads_no_session_and_invalid_controls_fail() {
        assert!(
            GuardianReapAudit::read_environment(|name| {
                assert_eq!(name, "FLASHWRIGHT_EXPERIMENT_GUARDIAN_REAPS");
                None
            })
            .unwrap()
            .is_none()
        );
        for (directory, session) in [
            ("relative", "0123456789abcdef0123456789abcdef"),
            ("/absolute", "invalid"),
        ] {
            assert!(
                GuardianReapAudit::read_environment(|name| Some(
                    if name.ends_with("REAPS") {
                        directory
                    } else {
                        session
                    }
                    .into()
                ))
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn terminal_wait_retains_original_identity_status_clock_and_private_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let audit = audit(directory.path());
        let mut child = Command::new("sh").args(["-c", "exit 7"]).spawn().unwrap();
        let process = child.id().unwrap();
        let before = monotonic_nanoseconds().unwrap();
        let status = wait_for_guardian(&mut child, Some(&audit)).await.unwrap();
        let after = monotonic_nanoseconds().unwrap();
        assert_eq!(status.code(), Some(7));
        let file = directory.path().join(format!("guardian-{process}.json"));
        let bytes = std::fs::read(&file).unwrap();
        let record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(record["driverProcess"], std::process::id());
        assert_eq!(record["guardianProcess"], process);
        assert_eq!(record["session"], audit.session);
        assert_eq!(record["waitStatus"], status.into_raw());
        assert_eq!(record["code"], 7);
        assert!(record["signal"].is_null());
        let started = record["waitStartedNanoseconds"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
        let completed = record["waitCompletedNanoseconds"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
        assert!(before <= started && started <= completed && completed <= after);
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert!(audit.record(process, status, before).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
    }

    #[tokio::test]
    async fn cached_wait_is_not_new_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = Command::new("true").spawn().unwrap();
        child.wait().await.unwrap();
        assert!(
            wait_for_guardian(&mut child, Some(&audit(directory.path())))
                .await
                .unwrap()
                .success()
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn external_reaper_cannot_publish_a_terminal_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = Command::new("true").spawn().unwrap();
        let process = nix::unistd::Pid::from_raw(child.id().unwrap() as i32);
        nix::sys::wait::waitpid(process, None).unwrap();
        assert!(
            wait_for_guardian(&mut child, Some(&audit(directory.path())))
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn publication_failure_preserves_real_signal_status() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = Command::new("sh")
            .args(["-c", "kill -TERM $$"])
            .spawn()
            .unwrap();
        let status = wait_for_guardian(&mut child, Some(&audit(&directory.path().join("missing"))))
            .await
            .unwrap();
        assert_eq!(status.signal(), Some(nix::libc::SIGTERM));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
