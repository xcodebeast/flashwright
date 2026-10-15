#!/usr/bin/env python3
"""Bound a browser job independently and track its observed owned process tree."""

import argparse
import ctypes
import errno
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


class RootProcessCpuAccounting:
    """Reap the original owner atomically and retain its inclusive kernel usage.

    Popen's own wait lock prevents a competing poll. Only an actual positive
    wait4 result admits usage; cached status and ECHILD never fabricate zeros.
    """

    def __init__(self, child, started):
        self.child = child
        self.started = started
        self.receipt = {"status": "not-observed", "process": child.pid}

    def poll(self):
        if self.child.returncode is not None:
            return self.child.returncode
        if not self.child._waitpid_lock.acquire(False):
            return None
        try:
            if self.child.returncode is not None:
                return self.child.returncode
            started = time.monotonic() - self.started
            try:
                process, wait_status, usage = os.wait4(self.child.pid, os.WNOHANG)
            except ChildProcessError as error:
                # Match Popen's externally-reaped status convention, while
                # explicitly refusing resource admission for that status.
                self.child.returncode = 0
                self.receipt = {"status": "unavailable", "process": self.child.pid,
                                "reason": "original-owner-not-waitable", "error": str(error)}
                return self.child.returncode
            except InterruptedError:
                return None
            if process == 0:
                return None
            assert process == self.child.pid
            if not (os.WIFEXITED(wait_status) or os.WIFSIGNALED(wait_status)):
                return None
            reaped_nanoseconds = time.monotonic_ns()
            self.child._handle_exitstatus(wait_status)
            self.receipt = {
                "status": "observed", "process": process,
                "exitCode": self.child.returncode, "waitStatus": wait_status,
                "startedElapsedSeconds": started,
                "finishedElapsedSeconds": time.monotonic() - self.started,
                "reapedNanoseconds": str(reaped_nanoseconds),
                "method": "atomic-wait4-original-owner",
                "userSeconds": usage.ru_utime, "systemSeconds": usage.ru_stime,
                "cpuSeconds": usage.ru_utime + usage.ru_stime,
                "inclusiveMaximumResidentBytes": int(usage.ru_maxrss) * (1 if sys.platform == "darwin" else 1024),
                "coverage": "Exact wait4 resource record for the original owner, including descendants whose usage was rolled up through actual reaping. Live or orphaned descendants are excluded. Complete ownership coverage requires independent lifecycle records. Never add this inclusive CPU to descendant CPU; inclusive maximumRSS is not concurrent RSS.",
            }
            return self.child.returncode
        finally:
            self.child._waitpid_lock.release()


def adopt_orphaned_descendants():
    """Become the Linux child subreaper so detached grandchildren can be reaped after a crash."""
    if sys.platform != "linux":
        return False
    library = ctypes.CDLL(None, use_errno=True)
    library.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    library.prctl.restype = ctypes.c_int
    if library.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return True


def parse_linux_process_stat(output, clock_ticks, page_size, boot_seconds):
    # comm is parenthesized but can itself contain spaces, ')' and newlines.
    # Everything after its final ')' has the fixed /proc/PID/stat field order.
    process = int(output.split(' (', 1)[0])
    fields = output[output.rindex(')') + 2:].split()
    return process, {
        "parent": int(fields[1]), "group": int(fields[2]),
        "rssBytes": int(fields[21]) * page_size,
        "cpuSeconds": (int(fields[11]) + int(fields[12])) / clock_ticks,
        "state": fields[0],
        "started": time.asctime(time.localtime(boot_seconds + int(fields[19]) // clock_ticks)),
    }


def linux_process_snapshot():
    clock_ticks = os.sysconf('SC_CLK_TCK')
    page_size = os.sysconf('SC_PAGE_SIZE')
    boot_seconds = next(int(line.split()[1]) for line in Path('/proc/stat').read_text().splitlines()
                        if line.startswith('btime '))
    processes = {}
    with os.scandir('/proc') as entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            try:
                output = (Path(entry.path) / 'stat').read_text(errors='surrogateescape')
            except OSError as error:
                if error.errno in (errno.ENOENT, errno.ESRCH, errno.EACCES, errno.EPERM):
                    continue  # Exited or hidden processes are outside this sample.
                raise
            process, details = parse_linux_process_stat(output, clock_ticks, page_size, boot_seconds)
            assert process == int(entry.name)
            processes[process] = details
    return processes


def process_snapshot():
    if sys.platform == 'linux':
        return linux_process_snapshot()
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid=,rss=,time=,stat=,lstart="], text=True)
    processes = {}
    for line in output.splitlines():
        fields = line.split(None, 6)
        if len(fields) != 7:
            continue
        process, parent, group, memory, cpu_time, state, started = fields
        days, separator, clock = cpu_time.rpartition("-")
        parts = [float(part) for part in clock.split(":")]
        seconds = sum(part * 60 ** index for index, part in enumerate(reversed(parts)))
        if separator:
            seconds += int(days) * 86400
        processes[int(process)] = {
            "parent": int(parent), "group": int(group), "rssBytes": int(memory) * 1024,
            "cpuSeconds": seconds, "state": state, "started": started,
        }
    return processes


def record_cpu_observation(records, process, details):
    """Retain work already observed when exit reporting resets CPU, and distinguish reused PIDs."""
    identity = (process, details["started"])
    previous = records.get(identity, {}).get("cpuSeconds", 0)
    records[identity] = {**details, "cpuSeconds": max(previous, details["cpuSeconds"])}


CLEANUP_GRACE_SECONDS = 2
CLEANUP_STAGED_SECONDS = 10
CLEANUP_FORCED_SECONDS = 2


def cleanup_owned_processes(observe, root_process):
    """Stop owners before their descendants so independent resource cleanup can finish.

    Orphaned descendants receive a grace period before promotion to the next owners.
    Stopped/ignoring owners are killed individually; a final whole-tree deadline bounds
    adversarial trees without relying on executable names or shared process groups.
    """
    started = time.monotonic()
    staged_deadline = started + CLEANUP_STAGED_SECONDS
    remaining = observe()
    signals = []

    def signal_processes(identities, termination_signal):
        for process, identity in identities.items():
            details = remaining.get(process)
            if not details or details["started"] != identity["started"] or details["state"].startswith(("Z", "X")):
                continue
            try:
                os.kill(process, termination_signal)
                signals.append({"process": process, "signal": termination_signal.name, "cleanupElapsedSeconds": time.monotonic() - started})
            except ProcessLookupError:
                pass

    def wait_until(deadline):
        nonlocal remaining
        while remaining and time.monotonic() < deadline:
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            remaining = observe()

    def live_owners():
        live = {process: details for process, details in remaining.items() if not details["state"].startswith(("Z", "X"))}
        return {process: details for process, details in live.items() if details["parent"] not in live}

    root_details = remaining.get(root_process)
    previous_owners = live_owners()
    if not root_details or root_details["state"].startswith(("Z", "X")):
        wait_until(min(staged_deadline, time.monotonic() + CLEANUP_GRACE_SECONDS))
    while remaining and time.monotonic() < staged_deadline:
        owners = live_owners()
        promoted = any(process not in previous_owners or details["started"] != previous_owners[process]["started"]
                       for process, details in owners.items())
        previous_owners = owners
        if promoted:
            # A parent can exit near the end of its own signal grace. Its child
            # needs a fresh interval to finish cleanup after observing that death.
            wait_until(min(staged_deadline, time.monotonic() + CLEANUP_GRACE_SECONDS))
            continue
        signal_processes(owners, signal.SIGTERM)
        wait_until(min(staged_deadline, time.monotonic() + CLEANUP_GRACE_SECONDS))
        signals_before_kill = len(signals)
        signal_processes(owners, signal.SIGKILL)
        if len(signals) != signals_before_kill:
            wait_until(min(staged_deadline, time.monotonic() + CLEANUP_GRACE_SECONDS))

    forced = bool(remaining)
    forced_deadline = staged_deadline + CLEANUP_FORCED_SECONDS
    while remaining and time.monotonic() < forced_deadline:
        # Reobserve between attempts: an owned process can fork during shutdown.
        signal_processes(remaining, signal.SIGKILL)
        wait_until(min(forced_deadline, time.monotonic() + 0.1))
    return remaining, signals, {
        "policy": "owners-before-descendants",
        "graceSeconds": CLEANUP_GRACE_SECONDS,
        "stagedTimeoutSeconds": CLEANUP_STAGED_SECONDS,
        "forcedTimeoutSeconds": CLEANUP_FORCED_SECONDS,
        "wholeTreeEscalation": forced,
        "elapsedSeconds": time.monotonic() - started,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, required=True)
    reports = parser.add_mutually_exclusive_group()
    reports.add_argument("--report", type=Path)
    reports.add_argument("--report-directory", type=Path)
    parser.add_argument("--capture-inputs", type=Path,
                        help="Verify declared source, dependency and executable inputs around the original launch (macOS arm64).")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    command = arguments.command[1:] if arguments.command[:1] == ["--"] else arguments.command
    if not command or arguments.timeout <= 0:
        parser.error("A command and positive timeout are required.")
    if arguments.report_directory:
        identifier = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ") + "-" + uuid.uuid4().hex[:8]
        arguments.report = arguments.report_directory / (identifier + ".json")
    if arguments.capture_inputs and not arguments.report:
        parser.error("--capture-inputs requires an immutable resource report.")
    environment = os.environ.copy()
    if arguments.report:
        if arguments.report.exists():
            parser.error("Resource reports are immutable; choose a new path or --report-directory.")
        environment["FLASHWRIGHT_RESOURCE_REPORT"] = str(arguments.report.resolve())
    capture_identity = uuid.uuid4().hex
    context = None
    capture_context = None
    if arguments.capture_inputs:
        if __package__:
            from .final_goal_capture_context import CaptureContext
        else:
            from final_goal_capture_context import CaptureContext
        before_path = arguments.report.with_name(arguments.report.name + ".context-before.json")
        after_path = arguments.report.with_name(arguments.report.name + ".context-after.json")
        if before_path.exists() or after_path.exists():
            parser.error("Capture snapshots are immutable; choose a new report path.")
        context = CaptureContext(arguments.capture_inputs, capture_identity, command)
        before = context.snapshot("before", before_path)
        if before["status"] != "verified":
            print("Capture inputs failed before launch; see " + before["path"], file=sys.stderr)
            return 125
        capture_context = {"schemaVersion": 1, "before": before, "status": "pending"}
    subreaper = adopt_orphaned_descendants()
    # Capture the origin before Popen: a fast child can execute before Popen returns.
    # This is the supervisor clock only; other runtimes still need a measured mapping.
    started_nanoseconds = time.monotonic_ns()
    started = started_nanoseconds / 1_000_000_000
    clock = {
        "schemaVersion": 1,
        "identity": capture_identity,
        "type": "monotonic",
        "implementation": time.get_clock_info("monotonic").implementation,
        "originNanoseconds": str(started_nanoseconds),
        "resolutionSeconds": time.get_clock_info("monotonic").resolution,
        "scope": "Supervisor process clock; cross-process/runtime mapping is not established by this record.",
    }
    environment["FLASHWRIGHT_WATCHDOG_CLOCK"] = json.dumps(clock)
    known = {}
    cpu_records = {}
    # No command-owned process exists before launch. Retain this actual empty boundary.
    samples = [{"elapsedSeconds": time.monotonic() - started,
                "concurrentRssBytes": 0, "liveOwnedProcesses": 0, "processes": [],
                "phase": "before-owner-launch"}]
    launch_started = time.monotonic() - started
    child = subprocess.Popen(command, start_new_session=True, env=environment)
    launch_returned = time.monotonic() - started
    root_cpu = RootProcessCpuAccounting(child, started)
    interrupted = False
    timed_out = False

    def interrupt(_signal, _frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)

    def observe():
        # An unreaped child's PID cannot be reused during this query. A later poll
        # must not erase ownership of a root and descendants already in the snapshot.
        root_unreaped_before_snapshot = child.returncode is None
        acquisition_started = time.monotonic() - started
        snapshot = process_snapshot()
        acquisition_finished = time.monotonic() - started
        adopted = set()
        for process, details in list(snapshot.items()):
            if details["parent"] != os.getpid() or process == child.pid:
                continue
            try:
                reaped, _status = os.waitpid(process, os.WNOHANG)
                if reaped:
                    known[process] = details
                    adopted.add(process)
                elif subreaper:
                    adopted.add(process)
            except ChildProcessError:
                # The process-table query has already been reaped by subprocess.check_output.
                snapshot.pop(process)
        owned = {process for process, details in known.items() if process in snapshot and snapshot[process]["started"] == details["started"]}
        owned.update(adopted)
        if root_unreaped_before_snapshot:
            owned.add(child.pid)
        root_cpu.poll()
        changed = True
        while changed:
            added = {process for process, details in snapshot.items() if details["parent"] in owned and process not in owned}
            owned.update(added)
            changed = bool(added)
        for process in owned:
            if process in snapshot:
                known[process] = snapshot[process]
                record_cpu_observation(cpu_records, process, snapshot[process])
        observed = [{"process": process, **snapshot[process]} for process in sorted(owned) if process in snapshot]
        samples.append({
            "elapsedSeconds": time.monotonic() - started,
            "acquisitionStartedElapsedSeconds": acquisition_started,
            "acquisitionFinishedElapsedSeconds": acquisition_finished,
            "concurrentRssBytes": sum(process["rssBytes"] for process in observed),
            "liveOwnedProcesses": len(observed), "processes": observed,
        })
        return {process: snapshot[process] for process in owned if process in snapshot}

    try:
        while root_cpu.poll() is None and not interrupted:
            observe()
            if time.monotonic() - started >= arguments.timeout:
                timed_out = True
                break
            time.sleep(0.1)
    finally:
        remaining, cleanup_signals, cleanup = cleanup_owned_processes(observe, child.pid)
        root_cpu.poll()
        report = {
            "schemaVersion": 2, "cpuAccounting": "maximum-per-observed-process-identity",
            "clock": clock,
            "ownerLaunch": {"process": child.pid, "startedElapsedSeconds": launch_started,
                            "returnedElapsedSeconds": launch_returned},
            "command": command, "timeoutSeconds": arguments.timeout, "timedOut": timed_out,
            "interrupted": interrupted, "exitCode": child.returncode,
            "elapsedSeconds": time.monotonic() - started, "samplingIntervalSeconds": 0.1,
            "maximumSampledConcurrentRssBytes": max(sample["concurrentRssBytes"] for sample in samples),
            "observedCpuSeconds": sum(details["cpuSeconds"] for details in cpu_records.values()),
            "rootPollCpu": root_cpu.receipt,
            "observedProcessCount": len(cpu_records), "remainingObservedProcesses": list(remaining),
            "processes": [{"process": process, **details} for (process, _started), details in cpu_records.items()],
            "cleanupSignals": cleanup_signals,
            "cleanup": cleanup,
            "linuxChildSubreaper": subreaper,
            "coverage": "Observed descendants including detached browser groups; sub-sampling-lifetime children and processes reparented before observation may be missed. CPU sums maximum observed process time per PID/start identity, preserving work when zombie accounting resets; it is not an exact kernel tree accounting. Linux CPU uses /proc/PID/stat user/system ticks at SC_CLK_TCK resolution; macOS uses ps centiseconds. Start tokens retain process-table whole-second precision. RSS is a concurrent sum of sampled resident counters, not summed per-process maxima or an exact page-table census.",
            "samples": samples,
        }
        if context:
            try:
                capture_context["after"] = context.snapshot("after", after_path)
                capture_context["status"] = capture_context["after"]["status"]
            except (OSError, ValueError) as error:
                # A failed evidence write must not discard the original owner's result or wait4 receipt.
                capture_context["status"] = "failed"
                capture_context["error"] = type(error).__name__ + ": " + str(error)
            report["captureContext"] = capture_context
        if arguments.report:
            arguments.report.parent.mkdir(parents=True, exist_ok=True)
            with arguments.report.open("x") as report_file:
                json.dump(report, report_file, indent=2)
                report_file.write("\n")
    capture_failed = capture_context is not None and capture_context["status"] != "verified"
    return 124 if timed_out else 130 if interrupted else 125 if remaining or child.returncode is None or capture_failed else child.returncode


if __name__ == "__main__":
    raise SystemExit(main())
