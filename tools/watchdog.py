#!/usr/bin/env python3
"""Bound a browser job independently and track its observed owned process tree."""

import argparse
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


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


def process_snapshot():
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid=,rss=,time=,lstart="], text=True)
    processes = {}
    for line in output.splitlines():
        fields = line.split(None, 5)
        if len(fields) != 6:
            continue
        process, parent, group, memory, cpu_time, started = fields
        days, separator, clock = cpu_time.rpartition("-")
        parts = [float(part) for part in clock.split(":")]
        seconds = sum(part * 60 ** index for index, part in enumerate(reversed(parts)))
        if separator:
            seconds += int(days) * 86400
        processes[int(process)] = {
            "parent": int(parent), "group": int(group), "rssBytes": int(memory) * 1024,
            "cpuSeconds": seconds, "started": started,
        }
    return processes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, required=True)
    reports = parser.add_mutually_exclusive_group()
    reports.add_argument("--report", type=Path)
    reports.add_argument("--report-directory", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    command = arguments.command[1:] if arguments.command[:1] == ["--"] else arguments.command
    if not command or arguments.timeout <= 0:
        parser.error("A command and positive timeout are required.")
    if arguments.report_directory:
        identifier = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ") + "-" + uuid.uuid4().hex[:8]
        arguments.report = arguments.report_directory / (identifier + ".json")
    environment = os.environ.copy()
    if arguments.report:
        if arguments.report.exists():
            parser.error("Resource reports are immutable; choose a new path or --report-directory.")
        environment["FLASHWRIGHT_RESOURCE_REPORT"] = str(arguments.report.resolve())
    subreaper = adopt_orphaned_descendants()
    child = subprocess.Popen(command, start_new_session=True, env=environment)
    known = {}
    samples = []
    started = time.monotonic()
    interrupted = False
    timed_out = False

    def interrupt(_signal, _frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)

    def observe():
        snapshot = process_snapshot()
        adopted = set()
        for process, details in list(snapshot.items()):
            if details["parent"] != os.getpid() or process == child.pid:
                continue
            try:
                reaped, _status = os.waitpid(process, os.WNOHANG)
                if reaped:
                    known[process] = details
                    snapshot.pop(process)
                elif subreaper:
                    adopted.add(process)
            except ChildProcessError:
                # The process-table query has already been reaped by subprocess.check_output.
                snapshot.pop(process)
        owned = {process for process, details in known.items() if process in snapshot and snapshot[process]["started"] == details["started"]}
        owned.update(adopted)
        if child.poll() is None:
            owned.add(child.pid)
        changed = True
        while changed:
            added = {process for process, details in snapshot.items() if details["parent"] in owned and process not in owned}
            owned.update(added)
            changed = bool(added)
        for process in owned:
            if process in snapshot:
                known[process] = snapshot[process]
        samples.append({
            "elapsedSeconds": time.monotonic() - started,
            "concurrentRssBytes": sum(snapshot[process]["rssBytes"] for process in owned if process in snapshot),
            "liveOwnedProcesses": len(owned),
        })
        return {process: snapshot[process] for process in owned if process in snapshot}

    try:
        while child.poll() is None and not interrupted:
            observe()
            if time.monotonic() - started >= arguments.timeout:
                timed_out = True
                break
            time.sleep(0.1)
    finally:
        remaining = observe()
        cleanup_signals = []
        for termination_signal in (signal.SIGTERM, signal.SIGKILL):
            # A browser may create its own process group; only observed identities are signalled.
            for process in remaining:
                try:
                    os.kill(process, termination_signal)
                    cleanup_signals.append({"process": process, "signal": termination_signal.name})
                except ProcessLookupError:
                    pass
            if remaining:
                time.sleep(0.2)
            remaining = observe()
        child.wait(timeout=5)
        report = {
            "command": command, "timeoutSeconds": arguments.timeout, "timedOut": timed_out,
            "interrupted": interrupted, "exitCode": child.returncode,
            "elapsedSeconds": time.monotonic() - started, "samplingIntervalSeconds": 0.1,
            "maximumSampledConcurrentRssBytes": max(sample["concurrentRssBytes"] for sample in samples),
            "observedCpuSeconds": sum(details["cpuSeconds"] for details in known.values()),
            "observedProcessCount": len(known), "remainingObservedProcesses": list(remaining),
            "cleanupSignals": cleanup_signals,
            "linuxChildSubreaper": subreaper,
            "coverage": "Observed descendants including detached browser groups; sub-sampling-lifetime children and processes reparented before observation may be missed. CPU is accumulated last-observed process time, not an exact kernel tree accounting. RSS is a concurrent sum, not summed per-process maxima.",
            "samples": samples,
        }
        if arguments.report:
            arguments.report.parent.mkdir(parents=True, exist_ok=True)
            with arguments.report.open("x") as report_file:
                json.dump(report, report_file, indent=2)
                report_file.write("\n")
    return 124 if timed_out else 130 if interrupted else child.returncode


if __name__ == "__main__":
    raise SystemExit(main())
