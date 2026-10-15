//! Opt-in diagnostic transport; completeness is checked by the external lifecycle verifier.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::{UnixDatagram, UnixStream};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MAXIMUM_DATAGRAM_BYTES: usize = 64 * 1024;
const MAXIMUM_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
const MAXIMUM_SHUTDOWN_DRAIN: Duration = Duration::from_millis(100);

pub(crate) struct Capture {
    stopped: Arc<AtomicBool>,
    shutdown: Option<UnixStream>,
    reader: Option<JoinHandle<io::Result<()>>>,
    browser_exit: Arc<Mutex<Option<serde_json::Value>>>,
}

impl Capture {
    /// The guardian owns the reader through browser termination, including launch failure.
    pub(crate) fn start(directory: &Path) -> io::Result<(Self, OwnedFd)> {
        if !directory.is_absolute() {
            return Err(io::Error::other(
                "native capture directory must be absolute",
            ));
        }
        let identity = format!("guardian-{}", std::process::id());
        let output = private_file(&directory.join(format!("{identity}.jsonl")))?;
        let completion = private_file(&directory.join(format!("{identity}.complete.json")))?;
        Self::start_reader(output, completion, MAXIMUM_CAPTURE_BYTES)
    }

    fn start_reader(
        output: File,
        completion: File,
        maximum_bytes: usize,
    ) -> io::Result<(Self, OwnedFd)> {
        let (incoming, outgoing) = UnixDatagram::pair()?;
        incoming.set_nonblocking(true)?;
        outgoing.set_nonblocking(true)?;
        let (shutdown, shutdown_reader) = UnixStream::pair()?;
        let stopped = Arc::new(AtomicBool::new(false));
        let reader_stopped = stopped.clone();
        let browser_exit = Arc::new(Mutex::new(None));
        let recorded_exit = browser_exit.clone();
        let reader = std::thread::Builder::new()
            .name("native-resource-capture".into())
            .spawn(move || {
                collect(
                    |buffer| {
                        if !reader_stopped.load(Ordering::Acquire) {
                            wait_for_input_or_shutdown(&incoming, &shutdown_reader)?;
                        }
                        incoming.recv(buffer)
                    },
                    output,
                    completion,
                    reader_stopped.clone(),
                    recorded_exit,
                    maximum_bytes,
                    MAXIMUM_SHUTDOWN_DRAIN,
                )
            })?;
        Ok((
            Self {
                stopped,
                shutdown: Some(shutdown),
                reader: Some(reader),
                browser_exit,
            },
            outgoing.into(),
        ))
    }

    /// Join only after the original browser has terminated. A busy diagnostic
    /// producer cannot extend the bounded shutdown drain indefinitely.
    pub(crate) fn finish(&mut self) -> io::Result<()> {
        self.stopped.store(true, Ordering::Release);
        // Closing a separate control socket wakes poll without injecting a diagnostic record.
        // The reader then consumes the data socket nonblockingly until it is drained.
        self.shutdown.take();
        match self.reader.take() {
            Some(reader) => reader
                .join()
                .map_err(|_| io::Error::other("native capture reader panicked"))?,
            None => Ok(()),
        }
    }

    pub(crate) fn record_browser_exit(&self, process: u32, status: ExitStatus) {
        *self.browser_exit.lock().unwrap() = Some(serde_json::json!({
            "process": process, "code": status.code(), "signal": status.signal(),
        }));
    }
}

#[allow(unsafe_code)]
fn wait_for_input_or_shutdown(incoming: &UnixDatagram, shutdown: &UnixStream) -> io::Result<()> {
    let mut descriptors =
        [incoming.as_raw_fd(), shutdown.as_raw_fd()].map(|descriptor| nix::libc::pollfd {
            fd: descriptor,
            events: nix::libc::POLLIN,
            revents: 0,
        });
    // Both borrowed sockets remain open for this call, and poll writes only into this array.
    let result = unsafe { nix::libc::poll(descriptors.as_mut_ptr(), 2, -1) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    if descriptors
        .iter()
        .any(|descriptor| descriptor.revents & nix::libc::POLLNVAL != 0)
    {
        return Err(io::Error::other(
            "native capture poll descriptor is invalid",
        ));
    }
    Ok(())
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            let _ = writeln!(io::stderr(), "native resource capture failed: {error}");
        }
    }
}

fn private_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

fn collect(
    mut receive: impl FnMut(&mut [u8]) -> io::Result<usize>,
    mut output: File,
    mut completion: File,
    stopped: Arc<AtomicBool>,
    browser_exit: Arc<Mutex<Option<serde_json::Value>>>,
    maximum_bytes: usize,
    maximum_shutdown_drain: Duration,
) -> io::Result<()> {
    let mut buffer = vec![0; MAXIMUM_DATAGRAM_BYTES + 1];
    let mut received = 0_u64;
    let mut retained_bytes = 0;
    let mut failure = None;
    let mut shutdown_started = None;
    let mut shutdown_drain_complete = true;
    loop {
        if stopped.load(Ordering::Acquire) {
            let started = shutdown_started.get_or_insert_with(Instant::now);
            if started.elapsed() >= maximum_shutdown_drain {
                shutdown_drain_complete = false;
                failure
                    .get_or_insert_with(|| "native diagnostic shutdown drain expired".to_owned());
                break;
            }
        }
        match receive(&mut buffer) {
            Ok(length) => {
                received += 1;
                if failure.is_some() {
                    continue;
                }
                let message = &buffer[..length];
                if length > MAXIMUM_DATAGRAM_BYTES || length > maximum_bytes - retained_bytes {
                    failure = Some("capture capacity exceeded".to_owned());
                } else if message.last() != Some(&b'\n')
                    || serde_json::from_slice::<serde_json::Value>(message).is_err()
                {
                    failure = Some("invalid native diagnostic datagram".to_owned());
                } else if let Err(error) = output.write_all(message) {
                    failure = Some(error.to_string());
                } else {
                    retained_bytes += length;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            // Darwin reports the connected datagram peer closing after queued messages drain.
            // It is not a malformed message; original browser status is checked independently.
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                // No writers remain when the guardian drops this owner. Consume every queued
                // datagram before declaring completion; the stop request alone is insufficient.
                if stopped.load(Ordering::Acquire) {
                    break;
                }
            }
            Err(error) => {
                failure.get_or_insert_with(|| error.to_string());
                break;
            }
        }
    }
    if let Err(error) = output.flush() {
        failure.get_or_insert_with(|| error.to_string());
    }
    let browser_exit = browser_exit.lock().unwrap().clone();
    if browser_exit.is_none() {
        failure.get_or_insert_with(|| "original browser exit was not observed".to_owned());
    }
    let record = serde_json::json!({
        "status": if failure.is_none() { "captured" } else { "failed" },
        "guardianProcess": std::process::id(),
        "datagramsReceived": received,
        "retainedBytes": retained_bytes,
        "error": failure,
        "shutdownDrainComplete": shutdown_drain_complete,
        "browserExit": browser_exit,
    });
    writeln!(completion, "{record}")?;
    completion.flush()?;
    match failure {
        Some(error) => Err(io::Error::other(error)),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_socket_wakes_reader_while_diagnostic_writer_remains_open() {
        let (incoming, _outgoing) = UnixDatagram::pair().unwrap();
        let (shutdown, shutdown_reader) = UnixStream::pair().unwrap();
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (finished_sender, finished_receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            started_sender.send(()).unwrap();
            finished_sender
                .send(wait_for_input_or_shutdown(&incoming, &shutdown_reader))
                .unwrap();
        });
        started_receiver.recv().unwrap();
        assert!(matches!(
            finished_receiver.recv_timeout(Duration::from_millis(20)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        drop(shutdown);
        finished_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn shutdown_control_preserves_queued_data_with_an_open_writer() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("events");
        let completion = directory.path().join("completion");
        let (mut capture, writer) = Capture::start_reader(
            private_file(&output).unwrap(),
            private_file(&completion).unwrap(),
            1000,
        )
        .unwrap();
        let writer = UnixDatagram::from(writer);
        for _ in 0..16 {
            writer.send(b"{}\n").unwrap();
        }
        capture.record_browser_exit(123, ExitStatus::from_raw(0));
        capture.finish().unwrap();
        assert_eq!(std::fs::read_to_string(output).unwrap(), "{}\n".repeat(16));
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(completion).unwrap()).unwrap();
        assert_eq!(record["status"], "captured");
        assert_eq!(record["datagramsReceived"], 16);
        assert_eq!(record["shutdownDrainComplete"], true);
        assert!(capture.finish().is_ok());
        drop(writer);
    }

    #[test]
    fn continuous_input_cannot_prevent_shutdown_after_capacity_failure() {
        let directory = tempfile::tempdir().unwrap();
        let output_path = directory.path().join("events");
        let completion_path = directory.path().join("completion");
        let stopped = Arc::new(AtomicBool::new(true));
        let exit = Arc::new(Mutex::new(Some(serde_json::json!({
            "process": 123, "code": 0, "signal": null,
        }))));
        let started = Instant::now();
        let result = collect(
            |buffer| {
                buffer[..3].copy_from_slice(b"{}\n");
                Ok(3)
            },
            private_file(&output_path).unwrap(),
            private_file(&completion_path).unwrap(),
            stopped,
            exit,
            3,
            Duration::from_millis(10),
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(result.is_err());
        assert_eq!(std::fs::read(output_path).unwrap(), b"{}\n");
        let completion: serde_json::Value =
            serde_json::from_slice(&std::fs::read(completion_path).unwrap()).unwrap();
        assert_eq!(completion["status"], "failed");
        assert_eq!(completion["shutdownDrainComplete"], false);
        assert!(completion["datagramsReceived"].as_u64().unwrap() > 1);
    }

    #[test]
    fn interrupted_receive_cannot_prevent_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let completion_path = directory.path().join("completion");
        let started = Instant::now();
        let result = collect(
            |_| Err(io::ErrorKind::Interrupted.into()),
            private_file(&directory.path().join("events")).unwrap(),
            private_file(&completion_path).unwrap(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(Mutex::new(None)),
            1000,
            Duration::from_millis(10),
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(result.is_err());
        let completion: serde_json::Value =
            serde_json::from_slice(&std::fs::read(completion_path).unwrap()).unwrap();
        assert_eq!(
            completion["error"],
            "native diagnostic shutdown drain expired"
        );
        assert_eq!(completion["shutdownDrainComplete"], false);
    }

    #[test]
    fn completion_publication_failure_is_returned() {
        let directory = tempfile::tempdir().unwrap();
        let completion_path = directory.path().join("completion");
        std::fs::write(&completion_path, b"").unwrap();
        let result = collect(
            |_| Err(io::ErrorKind::TimedOut.into()),
            private_file(&directory.path().join("events")).unwrap(),
            File::open(&completion_path).unwrap(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(Mutex::new(None)),
            1000,
            Duration::from_millis(10),
        );
        assert_eq!(result.unwrap_err().raw_os_error(), Some(nix::libc::EBADF));
        assert!(std::fs::read(completion_path).unwrap().is_empty());
    }

    #[test]
    fn reader_panic_is_returned_by_explicit_finish() {
        let mut capture = Capture {
            stopped: Arc::new(AtomicBool::new(false)),
            shutdown: None,
            reader: Some(std::thread::spawn(|| panic!("injected reader failure"))),
            browser_exit: Arc::new(Mutex::new(None)),
        };
        assert_eq!(
            capture.finish().unwrap_err().to_string(),
            "native capture reader panicked"
        );
        assert!(capture.finish().is_ok());
    }

    fn exercise(messages: &[&[u8]], capacity: usize) -> (String, serde_json::Value) {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("events");
        let completion = directory.path().join("completion");
        let (capture, writer) = Capture::start_reader(
            private_file(&output).unwrap(),
            private_file(&completion).unwrap(),
            capacity,
        )
        .unwrap();
        let writer = UnixDatagram::from(writer);
        for message in messages {
            writer.send(message).unwrap();
        }
        drop(writer);
        capture.record_browser_exit(123, ExitStatus::from_raw(0));
        drop(capture);
        (
            std::fs::read_to_string(output).unwrap(),
            serde_json::from_slice(&std::fs::read(completion).unwrap()).unwrap(),
        )
    }

    #[test]
    fn shutdown_drains_queued_whole_events() {
        let (output, completion) = exercise(
            &[b"{\"event\":\"born\"}\n", b"{\"event\":\"reaped\"}\n"],
            1000,
        );
        assert_eq!(output, "{\"event\":\"born\"}\n{\"event\":\"reaped\"}\n");
        assert_eq!(completion["status"], "captured");
        assert_eq!(completion["datagramsReceived"], 2);
        assert_eq!(completion["retainedBytes"], output.len());
    }

    #[test]
    fn capacity_failure_remains_explicit_while_reader_drains() {
        let (output, completion) = exercise(&[b"{}\n", b"{}\n", b"{}\n"], 3);
        assert_eq!(output, "{}\n");
        assert_eq!(completion["status"], "failed");
        assert_eq!(completion["datagramsReceived"], 3);
        assert_eq!(completion["error"], "capture capacity exceeded");
    }

    #[test]
    fn malformed_record_cannot_become_successful_capture() {
        let (output, completion) = exercise(&[b"{broken}\n", b"{}\n"], 1000);
        assert!(output.is_empty());
        assert_eq!(completion["status"], "failed");
        assert_eq!(completion["datagramsReceived"], 2);
    }

    #[test]
    fn missing_original_browser_reap_invalidates_capture() {
        let directory = tempfile::tempdir().unwrap();
        let completion = directory.path().join("completion");
        let (capture, writer) = Capture::start_reader(
            private_file(&directory.path().join("events")).unwrap(),
            private_file(&completion).unwrap(),
            1000,
        )
        .unwrap();
        drop(writer);
        drop(capture);
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(completion).unwrap()).unwrap();
        assert_eq!(record["status"], "failed");
        assert_eq!(record["error"], "original browser exit was not observed");
    }
}
