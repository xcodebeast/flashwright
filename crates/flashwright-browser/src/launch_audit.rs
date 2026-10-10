//! Opt-in, bounded evidence of the actual native browser launch.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

const MAXIMUM_RECORD_BYTES: usize = 16 * 1024;
const MAXIMUM_ARGUMENT_BYTES: usize = 8192;
const MAXIMUM_ARGUMENTS: usize = 256;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchRecord<'a> {
    schema_version: u32,
    session: String,
    worker_instance: u64,
    worker_index: u64,
    parallel_index: u64,
    driver_process: u32,
    guardian_process: u32,
    browser_process: u32,
    executable: &'a str,
    arguments: Vec<&'a str>,
    profile: &'a str,
}

/// Record the spawned command without changing ownership or launch policy.
pub(crate) fn record_launch(
    command: &Command,
    profile: &Path,
    driver_process: u32,
    browser_process: u32,
) -> io::Result<()> {
    record_with_environment(command, profile, driver_process, browser_process, |name| {
        std::env::var_os(name)
    })
}

fn record_with_environment(
    command: &Command,
    profile: &Path,
    driver_process: u32,
    browser_process: u32,
    environment: impl Fn(&str) -> Option<OsString>,
) -> io::Result<()> {
    let Some(directory) = environment("FLASHWRIGHT_EXPERIMENT_LAUNCH_AUDIT") else {
        return Ok(());
    };
    let directory = PathBuf::from(directory);
    if !directory.is_absolute() {
        return Err(invalid_record());
    }
    let required_string = |name| {
        environment(name)
            .and_then(|value| value.into_string().ok())
            .ok_or_else(invalid_record)
    };
    let integer = |name| {
        required_string(name)?
            .parse::<u64>()
            .map_err(|_| invalid_record())
    };
    let session = required_string("FLASHWRIGHT_EXPERIMENT_SESSION")?;
    if session.len() != 32 || !session.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid_record());
    }
    let mut arguments = Vec::new();
    let mut argument_bytes = 0;
    for argument in command.get_args() {
        let argument = argument.to_str().ok_or_else(invalid_record)?;
        argument_bytes += argument.len();
        if arguments.len() >= MAXIMUM_ARGUMENTS || argument_bytes > MAXIMUM_ARGUMENT_BYTES {
            return Err(invalid_record());
        }
        arguments.push(argument);
    }
    let record = LaunchRecord {
        schema_version: 1,
        session,
        worker_instance: integer("FLASHWRIGHT_EXPERIMENT_WORKER_INSTANCE")?,
        worker_index: integer("TEST_WORKER_INDEX")?,
        parallel_index: integer("TEST_PARALLEL_INDEX")?,
        driver_process,
        guardian_process: std::process::id(),
        browser_process,
        executable: command.get_program().to_str().ok_or_else(invalid_record)?,
        arguments,
        profile: profile.to_str().ok_or_else(invalid_record)?,
    };
    let mut encoded = BoundedRecord(Vec::with_capacity(MAXIMUM_RECORD_BYTES));
    serde_json::to_writer(&mut encoded, &record).map_err(io::Error::other)?;
    encoded.write_all(b"\n")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join(format!("guardian-{}.json", record.guardian_process)))?;
    file.write_all(&encoded.0)
}

fn invalid_record() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "launch audit is unavailable")
}

struct BoundedRecord(Vec<u8>);

impl Write for BoundedRecord {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAXIMUM_RECORD_BYTES - self.0.len() {
            return Err(invalid_record());
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::PermissionsExt;

    fn environment(directory: &Path) -> HashMap<&'static str, OsString> {
        HashMap::from([
            (
                "FLASHWRIGHT_EXPERIMENT_LAUNCH_AUDIT",
                directory.as_os_str().to_owned(),
            ),
            (
                "FLASHWRIGHT_EXPERIMENT_SESSION",
                "0123456789abcdef0123456789abcdef".into(),
            ),
            ("FLASHWRIGHT_EXPERIMENT_WORKER_INSTANCE", "5".into()),
            ("TEST_WORKER_INDEX", "4".into()),
            ("TEST_PARALLEL_INDEX", "1".into()),
        ])
    }

    fn write_record(command: &Command, directory: &Path) -> io::Result<()> {
        let values = environment(directory);
        record_with_environment(command, Path::new("/owned/profile"), 12, 34, |name| {
            values.get(name).cloned()
        })
    }

    #[test]
    fn absent_control_does_not_read_other_metadata() {
        record_with_environment(
            &Command::new("browser"),
            Path::new("profile"),
            0,
            0,
            |name| {
                assert_eq!(name, "FLASHWRIGHT_EXPERIMENT_LAUNCH_AUDIT");
                None
            },
        )
        .unwrap();
    }

    #[test]
    fn exact_arguments_identity_permissions_and_duplicate_custody() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = Command::new("/browser/é");
        command.args(["", "--first=two words", "\n", "--last"]);
        write_record(&command, directory.path()).unwrap();
        let file = directory
            .path()
            .join(format!("guardian-{}.json", std::process::id()));
        let bytes = std::fs::read(&file).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        let record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            record["arguments"],
            serde_json::json!(["", "--first=two words", "\n", "--last"])
        );
        assert_eq!(record["executable"], "/browser/é");
        assert_eq!(record["driverProcess"], 12);
        assert_eq!(record["browserProcess"], 34);
        assert_eq!(record["guardianProcess"], std::process::id());
        assert_eq!(record["workerInstance"], 5);
        assert_eq!(record["workerIndex"], 4);
        assert_eq!(record["parallelIndex"], 1);
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            write_record(&command, directory.path()).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(file).unwrap(), bytes);
    }

    #[test]
    fn invalid_control_and_identity_never_publish() {
        let directory = tempfile::tempdir().unwrap();
        for (key, value) in [
            ("FLASHWRIGHT_EXPERIMENT_LAUNCH_AUDIT", "relative"),
            ("FLASHWRIGHT_EXPERIMENT_SESSION", "not-a-session"),
            ("FLASHWRIGHT_EXPERIMENT_WORKER_INSTANCE", "-1"),
            ("TEST_WORKER_INDEX", "18446744073709551616"),
            ("TEST_PARALLEL_INDEX", ""),
        ] {
            let mut values = environment(directory.path());
            values.insert(key, value.into());
            assert!(
                record_with_environment(
                    &Command::new("browser"),
                    Path::new("profile"),
                    1,
                    2,
                    |name| values.get(name).cloned()
                )
                .is_err()
            );
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn non_utf8_metadata_is_rejected_without_lossy_conversion() {
        let directory = tempfile::tempdir().unwrap();
        let invalid = OsString::from_vec(vec![0xff]);
        assert!(write_record(&Command::new(&invalid), directory.path()).is_err());
        assert!(write_record(Command::new("browser").arg(&invalid), directory.path()).is_err());
        let values = environment(directory.path());
        assert!(
            record_with_environment(
                &Command::new("browser"),
                Path::new(&invalid),
                1,
                2,
                |name| values.get(name).cloned()
            )
            .is_err()
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn argument_limits_accept_boundaries_and_reject_excess() {
        for (count, bytes, accepted) in [
            (256, 0, true),
            (257, 0, false),
            (1, 8192, true),
            (1, 8193, false),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let mut command = Command::new("browser");
            command.args(vec!["x".repeat(bytes); count]);
            assert_eq!(write_record(&command, directory.path()).is_ok(), accepted);
            assert_eq!(
                std::fs::read_dir(directory.path()).unwrap().count(),
                usize::from(accepted)
            );
        }
    }

    #[test]
    fn encoded_record_limit_is_checked_before_creating_a_file() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = Command::new("browser");
        command.arg("\u{0001}".repeat(8192));
        assert!(write_record(&command, directory.path()).is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        let mut encoded = BoundedRecord(Vec::new());
        encoded
            .write_all(&vec![b'x'; MAXIMUM_RECORD_BYTES - 1])
            .unwrap();
        encoded.write_all(b"\n").unwrap();
        assert!(encoded.write_all(b"x").is_err());
        assert_eq!(encoded.0.len(), MAXIMUM_RECORD_BYTES);
    }

    #[test]
    fn filesystem_failure_is_returned_without_creating_parent_directories() {
        let directory = tempfile::tempdir().unwrap();
        assert!(write_record(&Command::new("browser"), &directory.path().join("missing")).is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
