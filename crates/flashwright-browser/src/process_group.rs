//! Group termination keeps the unreaped leader's identity reserved until every member stops.

use std::io;
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;

/// SIGKILL delivery is asynchronous, and a concurrent fork can outlive a single group signal.
/// The caller must retain the unreaped leader until this barrier completes. Only the caller
/// wait has a cleanup budget: the guardian cannot abandon ownership while a member is alive.
pub(crate) fn terminate(group: Pid) -> io::Result<()> {
    loop {
        match killpg(group, Signal::SIGKILL) {
            Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
            Err(nix::errno::Errno::EPERM) if !has_live_members(group)? => return Ok(()),
            Err(error) => return Err(io::Error::from(error)),
        }
        if !has_live_members(group)? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn has_live_members(group: Pid) -> io::Result<bool> {
    let mut processes = vec![0_i32; 256];
    loop {
        // SAFETY: libproc writes at most the supplied byte capacity into this initialized PID array.
        // proc_listpgrppids returns a PID count (unlike the byte count from proc_listpids).
        let count = unsafe {
            nix::libc::proc_listpgrppids(
                group.as_raw(),
                processes.as_mut_ptr().cast(),
                std::mem::size_of_val(processes.as_slice()) as i32,
            )
        };
        if count <= 0 {
            return Err(io::Error::last_os_error());
        }
        if count as usize >= processes.len() {
            if processes.len() >= 65536 {
                return Err(io::Error::other("process group exceeds enumeration limit"));
            }
            processes.resize(processes.len() * 2, 0);
            continue;
        }
        processes.truncate(count as usize);
        break;
    }
    for process in processes {
        let mut information = std::mem::MaybeUninit::<nix::libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<nix::libc::proc_bsdinfo>() as i32;
        // SAFETY: the requested flavor fills exactly proc_bsdinfo; inspect it only after full success.
        let received = unsafe {
            nix::libc::proc_pidinfo(
                process,
                nix::libc::PROC_PIDTBSDINFO,
                0,
                information.as_mut_ptr().cast(),
                size,
            )
        };
        if received == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(nix::libc::ESRCH) {
                continue;
            }
            return Err(io::Error::new(
                error.kind(),
                format!("process {process} in group {group}: {error}"),
            ));
        }
        if received != size {
            return Err(io::Error::other(
                "incomplete process group member information",
            ));
        }
        let information = unsafe { information.assume_init() };
        if information.pbi_pgid == group.as_raw() as u32
            && information.pbi_status != nix::libc::SZOMB
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn has_live_members(group: Pid) -> io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
            continue;
        }
        let information = match read_member_information(&entry.path().join("stat"))? {
            Some(information) => information,
            None => continue,
        };
        let (_, fields) = information
            .rsplit_once(") ")
            .ok_or_else(|| io::Error::other("invalid process information"))?;
        let mut fields = fields.split_whitespace();
        let state = fields.next();
        let _parent = fields.next();
        let process_group = fields.next().and_then(|value| value.parse::<i32>().ok());
        if process_group == Some(group.as_raw()) && !matches!(state, Some("Z" | "X")) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn read_member_information(path: &std::path::Path) -> io::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(information) => Ok(Some(information)),
        // A proc inode can outlive its task: opening succeeds, but reading returns ESRCH.
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(nix::libc::ESRCH) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    #[cfg(target_os = "linux")]
    #[test]
    fn process_disappearing_after_stat_open_is_not_an_enumeration_failure() {
        use std::os::fd::AsRawFd;

        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let stat = std::fs::File::open(format!("/proc/{}/stat", child.id())).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();

        // Reopen the retained proc inode to exercise the same read path as enumeration.
        let retained = std::path::PathBuf::from(format!("/proc/self/fd/{}", stat.as_raw_fd()));
        let error = std::fs::read_to_string(&retained).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(nix::libc::ESRCH));
        assert_eq!(read_member_information(&retained).unwrap(), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn member_information_preserves_other_read_failures() {
        let directory = tempfile::tempdir().unwrap();
        assert!(read_member_information(directory.path()).is_err());
        assert_eq!(
            read_member_information(&directory.path().join("missing")).unwrap(),
            None
        );
        let invalid = directory.path().join("invalid");
        std::fs::write(&invalid, [0xff]).unwrap();
        assert_eq!(
            read_member_information(&invalid).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn termination_waits_for_members_after_the_leader_exits() {
        let mut unrelated = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let mut leader = Command::new("sh")
            .args(["-c", "sleep 30 & echo $!; exit 0"])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let group = Pid::from_raw(leader.id() as i32);
        let mut child = String::new();
        BufReader::new(leader.stdout.take().unwrap())
            .read_line(&mut child)
            .unwrap();
        assert!(child.trim().parse::<u32>().is_ok());
        let deadline = Instant::now() + Duration::from_secs(1);
        while !crate::supervision::child_exited_without_reaping(group).unwrap()
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        let leader_exited = crate::supervision::child_exited_without_reaping(group).unwrap();
        let result = terminate(group);
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        let _ = leader.wait();
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        result.unwrap();
        assert!(unrelated_alive);
        assert!(leader_exited);
    }
}
