"""Retain prospective file and host boot identities around an original launch.

This is local reproducibility evidence, not executable-memory attestation. The
reviewed caller still owns inventory completeness and actual process custody.
"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
import subprocess
import sys
import time

MAXIMUM_MANIFEST_BYTES = 16 * 1024 * 1024
MAXIMUM_SNAPSHOT_BYTES = 32 * 1024 * 1024
MAXIMUM_FILE_BYTES = 1024 * 1024 * 1024
MAXIMUM_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAXIMUM_FILES = 30000
HASH_PATTERN = re.compile(r"[a-f0-9]{64}\Z")
BOOT_PATTERN = re.compile(r"[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def digest(contents):
    return hashlib.sha256(contents).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON member")
        result[key] = value
    return result


def decode(contents):
    def invalid_constant(_value):
        raise ValueError("Non-finite JSON number")
    return json.loads(contents.decode("utf-8", errors="strict"), object_pairs_hook=unique_object,
                      parse_constant=invalid_constant)


def absolute_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 4096 and "\0" not in value
            and os.path.isabs(value) and os.path.normpath(value) == value, "Expected normalized absolute input path")
    return value


def file_identity(details):
    return {"device": str(details.st_dev), "inode": str(details.st_ino), "bytes": details.st_size,
            "mode": stat.S_IMODE(details.st_mode), "modifiedNanoseconds": str(details.st_mtime_ns),
            "changedNanoseconds": str(details.st_ctime_ns)}


def read_stable_file(path, maximum_bytes=MAXIMUM_FILE_BYTES, retain_bytes=False):
    """Hash a bounded regular file and reject path/identity changes during its read."""
    path = absolute_path(str(path))
    resolved = str(Path(path).resolve(strict=True))
    descriptor = os.open(resolved, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode), "Capture input is not a regular file")
        require(0 <= before.st_size <= maximum_bytes, "Capture input exceeds byte limit")
        hasher = hashlib.sha256()
        chunks = []
        consumed = 0
        while True:
            chunk = os.read(descriptor, min(256 * 1024, maximum_bytes - consumed + 1))
            if not chunk:
                break
            consumed += len(chunk)
            require(consumed <= maximum_bytes, "Capture input grew beyond byte limit")
            hasher.update(chunk)
            if retain_bytes:
                chunks.append(chunk)
        require(file_identity(before) == file_identity(os.fstat(descriptor)) and consumed == before.st_size,
                "Capture input changed while reading")
        require(str(Path(path).resolve(strict=True)) == resolved
                and file_identity(os.stat(resolved, follow_symlinks=False)) == file_identity(before),
                "Capture input path changed while reading")
        return {"path": path, "resolvedPath": resolved, "sha256": hasher.hexdigest(), **file_identity(before)}, b"".join(chunks)
    finally:
        os.close(descriptor)


def verify_receipt(value):
    require(isinstance(value, dict) and set(value) == {"path", "sha256", "bytes"}, "Invalid file receipt")
    absolute_path(value["path"])
    require(isinstance(value["sha256"], str) and HASH_PATTERN.fullmatch(value["sha256"]), "Invalid file hash")
    require(type(value["bytes"]) is int and 0 <= value["bytes"] <= MAXIMUM_FILE_BYTES, "Invalid file byte count")


def read_mac_host():
    """Namespace Mach time with the kernel boot UUID without retaining machine names or serials."""
    require(sys.platform == "darwin" and platform.machine() == "arm64", "Capture context requires native macOS arm64")
    values = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid", "hw.logicalcpu", "hw.memsize",
                             "kern.osrelease", "kern.osversion", "machdep.cpu.brand_string"],
                            check=True, capture_output=True, text=True, timeout=10).stdout.splitlines()
    require(len(values) == 6 and re.fullmatch(r"[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}", values[0]),
            "Missing kernel boot-session identity")
    require(values[1].isdigit() and values[2].isdigit() and int(values[1]) > 0 and int(values[2]) > 0,
            "Invalid host resource configuration")
    boot_digest = digest(values[0].lower().encode())
    configuration = {"platform": "darwin", "architecture": "arm64", "logicalCpuCount": int(values[1]),
                     "physicalMemoryBytes": int(values[2]), "kernelRelease": values[3],
                     "kernelBuild": values[4], "cpu": values[5]}
    identity = digest(encode({"configuration": configuration, "bootIdentitySha256": boot_digest}))
    return {"configuration": configuration, "identitySha256": identity, "bootIdentitySha256": boot_digest,
            "namespace": identity + ":" + boot_digest,
            "scope": "Configuration and kernel boot session; not a persistent machine identity across boots"}


def read_linux_host():
    """Read kernel configuration without retaining a hostname, machine ID or raw boot UUID."""
    require(sys.platform == "linux" and platform.machine() == "x86_64", "Capture context requires Linux x64")

    def read_proc(path, limit):
        with open(path, "rb") as stream:
            contents = stream.read(limit + 1)
        require(len(contents) <= limit, "Kernel host field exceeds byte limit")
        return contents.decode("utf-8", errors="strict").strip()

    boot = read_proc("/proc/sys/kernel/random/boot_id", 64)
    require(BOOT_PATTERN.fullmatch(boot), "Missing kernel boot-session identity")
    models = sorted({line.split(":", 1)[1].strip()
                     for line in read_proc("/proc/cpuinfo", 4 * 1024 * 1024).splitlines()
                     if line.split(":", 1)[0].strip() == "model name" and ":" in line})
    require(models and all(0 < len(model) <= 4096 and "\0" not in model for model in models),
            "Missing kernel CPU model")
    logical_cpus = os.sysconf("SC_NPROCESSORS_ONLN")
    pages = os.sysconf("SC_PHYS_PAGES")
    page_size = os.sysconf("SC_PAGESIZE")
    affinity = sorted(os.sched_getaffinity(0))
    require(all(type(value) is int and value > 0 for value in [logical_cpus, pages, page_size])
            and affinity and all(type(cpu) is int and cpu >= 0 for cpu in affinity),
            "Invalid host resource configuration")
    kernel = os.uname()
    require(all(0 < len(value) <= 4096 and "\0" not in value for value in [kernel.release, kernel.version]),
            "Missing kernel version")
    configuration = {"platform": "linux", "architecture": "x64", "logicalCpuCount": logical_cpus,
                     "physicalMemoryBytes": pages * page_size, "kernelRelease": kernel.release,
                     "kernelBuild": kernel.version, "cpuModels": models, "allowedCpuIds": affinity,
                     "resourceScope": "Kernel online CPUs, physical memory and collector affinity; cgroup quotas and workload affinity require separate admission"}
    boot_digest = digest(boot.lower().encode())
    identity = digest(encode({"configuration": configuration, "bootIdentitySha256": boot_digest}))
    return {"configuration": configuration, "identitySha256": identity, "bootIdentitySha256": boot_digest,
            "namespace": identity + ":" + boot_digest,
            "scope": "Configuration and kernel boot session; not a persistent machine identity across boots"}


def read_host():
    if sys.platform == "darwin":
        return read_mac_host()
    if sys.platform == "linux":
        return read_linux_host()
    raise ValueError("Capture context requires macOS arm64 or Linux x64")


def host_clock_implementation(host):
    configuration = host["configuration"]
    target = (configuration["platform"], configuration["architecture"])
    require(target in [("darwin", "arm64"), ("linux", "x64")], "Unsupported capture host")
    return "mach_absolute_time()" if target[0] == "darwin" else "clock_gettime(CLOCK_MONOTONIC)"


def write_receipt(path, record):
    chunks = []
    total_bytes = 0
    for chunk in json.JSONEncoder(sort_keys=True, separators=(",", ":"), ensure_ascii=True).iterencode(record):
        encoded = chunk.encode()
        total_bytes += len(encoded)
        require(total_bytes < MAXIMUM_SNAPSHOT_BYTES, "Capture snapshot exceeds byte limit")
        chunks.append(encoded)
    contents = b"".join(chunks) + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())
    return {"path": str(path.resolve()), "sha256": digest(contents), "bytes": len(contents), "status": record["status"]}


class CaptureContext:
    """Read both manifests and every declared input anew for each boundary snapshot."""

    def __init__(self, request_path, capture_identity, command):
        self.request_path = os.path.abspath(request_path)
        self.capture_identity = capture_identity
        self.command = list(command)
        self.before = None
        self.before_receipt = None

    def collect_inputs(self):
        request_record, contents = read_stable_file(self.request_path, MAXIMUM_MANIFEST_BYTES, True)
        request = decode(contents)
        require(isinstance(request, dict) and set(request) == {"schemaVersion", "source", "dependencies", "controls", "executables", "runtimeAssets"}
                and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1,
                "Invalid capture-input request")
        pending = {}
        manifests = {}
        for name in ["source", "dependencies"]:
            group = request[name]
            require(isinstance(group, dict) and set(group) == {"root", "manifest"}, "Invalid input manifest group")
            absolute_path(group["root"])
            verify_receipt(group["manifest"])
            require(group["manifest"]["bytes"] <= MAXIMUM_MANIFEST_BYTES, "Manifest exceeds byte limit")
        require(isinstance(request["executables"], dict) and set(request["executables"]) == {"runtime", "browser", "driver", "launcher"},
                "Missing executable roles")
        for name in ["controls", "runtimeAssets"]:
            require(isinstance(request[name], list) and len(request[name]) <= MAXIMUM_FILES, "Invalid input inventory")
        receipts = [*request["controls"], *request["runtimeAssets"], *request["executables"].values()]
        require(len(receipts) <= MAXIMUM_FILES, "Input count exceeds limit")
        for receipt in receipts:
            verify_receipt(receipt)
        total_bytes = 0
        records = {}

        def retain(record):
            nonlocal total_bytes
            if record["path"] in records:
                require(records[record["path"]] == record, "Input identity differs between inventories")
                return
            total_bytes += record["bytes"]
            require(total_bytes <= MAXIMUM_TOTAL_BYTES and len(records) < MAXIMUM_FILES, "Aggregate capture-input limit exceeded")
            records[record["path"]] = record

        def expect(path, expected_hash, expected_bytes=None):
            previous = pending.get(path)
            value = {"sha256": expected_hash, "bytes": expected_bytes}
            if previous:
                require(previous["sha256"] == expected_hash, "Conflicting expected input hashes")
                if expected_bytes is not None:
                    require(previous["bytes"] in [None, expected_bytes], "Conflicting expected input sizes")
                    previous["bytes"] = expected_bytes
            else:
                pending[path] = value
            require(len(pending) <= MAXIMUM_FILES, "Input count exceeds limit")

        retain(request_record)
        for name in ["source", "dependencies"]:
            group = request[name]
            receipt = group["manifest"]
            record, contents = read_stable_file(receipt["path"], MAXIMUM_MANIFEST_BYTES, True)
            require(record["sha256"] == receipt["sha256"] and record["bytes"] == receipt["bytes"], "Input manifest differs from request")
            retain(record)
            manifest = decode(contents)
            require(isinstance(manifest, dict) and 0 < len(manifest) <= MAXIMUM_FILES, "Invalid source/dependency manifest")
            for relative, expected_hash in manifest.items():
                require(isinstance(relative, str) and 0 < len(relative) <= 4096 and "\\" not in relative and "\0" not in relative
                        and not relative.startswith("/") and str(PurePosixPath(relative)) == relative
                        and not any(part in ["", ".", ".."] for part in relative.split("/")), "Invalid manifest member path")
                require(isinstance(expected_hash, str) and HASH_PATTERN.fullmatch(expected_hash), "Invalid manifest member hash")
                expect(str(Path(group["root"]) / relative), expected_hash)
            manifests[name] = {"root": group["root"], "manifest": record}
        for receipt in receipts:
            expect(receipt["path"], receipt["sha256"], receipt["bytes"])
        require(len(set(records) | set(pending)) <= MAXIMUM_FILES, "Aggregate capture-input count exceeded")
        planned_bytes = total_bytes
        for path, expected in pending.items():
            absolute_path(path)
            details = os.stat(path)
            require(stat.S_ISREG(details.st_mode), "Capture input is not a regular file")
            require(0 <= details.st_size <= MAXIMUM_FILE_BYTES, "Capture input exceeds byte limit")
            require(expected["bytes"] is None or details.st_size == expected["bytes"], "Capture input size differs: " + path)
            if path not in records:
                planned_bytes += details.st_size
            require(planned_bytes <= MAXIMUM_TOTAL_BYTES, "Aggregate capture-input byte limit exceeded")
        for path, expected in sorted(pending.items()):
            allowance = MAXIMUM_TOTAL_BYTES - total_bytes + records.get(path, {}).get("bytes", 0)
            record, _ = read_stable_file(path, min(MAXIMUM_FILE_BYTES, allowance))
            require(record["sha256"] == expected["sha256"], "Capture input content differs: " + path)
            require(expected["bytes"] is None or record["bytes"] == expected["bytes"], "Capture input size differs: " + path)
            retain(record)
        executables = {role: records[receipt["path"]] for role, receipt in request["executables"].items()}
        require(all(record["mode"] & 0o111 for record in executables.values()), "Declared executable is not executable")
        require(self.command and os.path.isabs(self.command[0])
                and str(Path(self.command[0]).resolve(strict=True)) == executables["runtime"]["resolvedPath"],
                "Owner command does not launch the declared runtime")
        return {"request": request_record, "manifests": manifests, "executables": executables,
                "files": [records[path] for path in sorted(records)], "totalBytes": total_bytes}

    def snapshot(self, phase, destination):
        record = {"schemaVersion": 1, "phase": phase, "captureIdentity": self.capture_identity,
                  "command": self.command, "supervisorProcess": os.getpid(), "status": "failed",
                  "startedNanoseconds": str(time.monotonic_ns())}
        if phase == "after":
            record["beforeReceipt"] = self.before_receipt
        try:
            require(re.fullmatch(r"[a-f0-9]{32}", self.capture_identity), "Invalid capture identity")
            record["host"] = read_host()
            clock = time.get_clock_info("monotonic")
            require(clock.monotonic and not clock.adjustable
                    and clock.implementation == host_clock_implementation(record["host"]),
                    "Unexpected supervisor clock domain")
            record["clock"] = {"implementation": clock.implementation, "resolutionSeconds": clock.resolution}
            record["inputs"] = self.collect_inputs()
            require(read_host() == record["host"], "Host or boot changed during input collection")
            record["producer"], _ = read_stable_file(str(Path(__file__).resolve()))
            record["supervisorSource"], _ = read_stable_file(str(Path(__file__).with_name("watchdog.py").resolve()))
            record["supervisorRuntime"], _ = read_stable_file(str(Path(sys.executable).resolve()))
            record["supervisorVersion"] = sys.version
            record["workingDirectory"] = str(Path.cwd())
            if phase == "after":
                require(self.before is not None, "Missing original before snapshot")
                original, _ = read_stable_file(self.before_receipt["path"], MAXIMUM_SNAPSHOT_BYTES)
                require(original["sha256"] == self.before_receipt["sha256"]
                        and original["bytes"] == self.before_receipt["bytes"], "Original before snapshot changed")
                for key in ["host", "inputs", "producer", "supervisorSource", "supervisorRuntime", "supervisorVersion", "clock", "workingDirectory"]:
                    require(record[key] == self.before[key], "Capture context changed after launch: " + key)
            else:
                require(phase == "before" and self.before is None, "Invalid capture phase")
            record["status"] = "verified"
        except Exception as error:
            record["error"] = type(error).__name__ + ": " + str(error)
        record["finishedNanoseconds"] = str(time.monotonic_ns())
        receipt = write_receipt(destination, record)
        if phase == "before" and record["status"] == "verified":
            self.before = record
            self.before_receipt = receipt
        return receipt


def verify_capture_context(report_path):
    """Join retained snapshots to original watchdog bytes, without admitting process-tree coverage.

    This checks local collector consistency. A release still needs a reviewed
    input inventory, admitted collector source and independently verified owners.
    """
    report_record, contents = read_stable_file(os.path.abspath(report_path), MAXIMUM_SNAPSHOT_BYTES, True)
    report = decode(contents)
    require(report.get("schemaVersion") == 2, "Expected original watchdog report")
    context = report.get("captureContext")
    require(isinstance(context, dict) and set(context) == {"schemaVersion", "before", "after", "status"}
            and type(context["schemaVersion"]) is int and context["schemaVersion"] == 1
            and context["status"] == "verified", "Capture context was not verified")
    for phase in ["before", "after"]:
        receipt = context[phase]
        require(isinstance(receipt, dict) and set(receipt) == {"path", "sha256", "bytes", "status"}
                and receipt["status"] == "verified", "Invalid snapshot receipt")
        verify_receipt({key: receipt[key] for key in ["path", "sha256", "bytes"]})
        require(0 < receipt["bytes"] <= MAXIMUM_SNAPSHOT_BYTES, "Snapshot exceeds byte limit")
    require(context["before"]["path"] != context["after"]["path"], "Snapshot path reused")
    snapshots = {}
    for phase in ["before", "after"]:
        receipt = context[phase]
        record, contents = read_stable_file(receipt["path"], receipt["bytes"], True)
        require(record["sha256"] == receipt["sha256"] and record["bytes"] == receipt["bytes"], "Snapshot bytes differ")
        snapshot = decode(contents)
        require(snapshot.get("schemaVersion") == 1 and snapshot.get("status") == "verified"
                and snapshot.get("phase") == phase, "Invalid verified snapshot")
        require(snapshot["captureIdentity"] == report["clock"]["identity"], "Snapshot capture identity differs")
        require(snapshot["command"] == report["command"], "Snapshot command differs")
        require(snapshot["clock"]["implementation"] == report["clock"]["implementation"]
                == host_clock_implementation(snapshot["host"])
                and snapshot["clock"]["resolutionSeconds"] == report["clock"]["resolutionSeconds"], "Snapshot clock differs")
        for field in ["startedNanoseconds", "finishedNanoseconds"]:
            require(isinstance(snapshot[field], str) and re.fullmatch(r"[1-9][0-9]{0,38}", snapshot[field]), "Invalid snapshot clock value")
        require(int(snapshot["startedNanoseconds"]) <= int(snapshot["finishedNanoseconds"]), "Reversed snapshot interval")
        snapshots[phase] = snapshot
    before, after = snapshots["before"], snapshots["after"]
    require(after.get("beforeReceipt") == context["before"], "After snapshot does not bind original before bytes")
    for key in ["host", "inputs", "producer", "supervisorSource", "supervisorRuntime", "supervisorVersion",
                "clock", "workingDirectory", "supervisorProcess"]:
        require(key in before and before[key] == after.get(key), "Snapshot context differs: " + key)
    host = before["host"]
    identity = digest(encode({"configuration": host["configuration"], "bootIdentitySha256": host["bootIdentitySha256"]}))
    require(host["identitySha256"] == identity and host["namespace"] == identity + ":" + host["bootIdentitySha256"],
            "Invalid host/boot namespace")
    require(report["rootPollCpu"]["status"] == "observed"
            and report["rootPollCpu"]["method"] == "atomic-wait4-original-owner"
            and report["rootPollCpu"]["process"] == report["ownerLaunch"]["process"]
            and report["rootPollCpu"]["exitCode"] == report["exitCode"], "Missing original owner reap")
    require(int(before["finishedNanoseconds"]) <= int(report["clock"]["originNanoseconds"])
            <= int(report["rootPollCpu"]["reapedNanoseconds"]) <= int(after["startedNanoseconds"]),
            "Snapshots do not bracket the original owner")
    return {"schemaVersion": 1, "status": "verified-prospective-capture-context",
            "watchdog": report_record, "before": context["before"], "after": context["after"],
            "captureIdentity": before["captureIdentity"], "host": host,
            "executables": before["inputs"]["executables"], "manifests": before["inputs"]["manifests"],
            "producer": before["producer"], "supervisorSource": before["supervisorSource"],
            "limitations": ["Local file snapshots do not attest loaded executable memory or transient changes and restoration.",
                            "Inventory completeness, collector-source admission and original process custody remain separate checks."]}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Verify retained prospective capture context for an original watchdog report.")
    parser.add_argument("report", type=Path)
    arguments = parser.parse_args()
    try:
        print(json.dumps(verify_capture_context(arguments.report), sort_keys=True))
    except (KeyError, TypeError, ValueError, OSError) as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        raise SystemExit(1)
