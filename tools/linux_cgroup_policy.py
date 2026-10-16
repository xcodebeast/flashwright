"""Read bounded Linux x64 cgroup-v2 policies without changing the hierarchy.

This is a non-atomic diagnostic snapshot of visible ancestors, never resource
admission, an effective quota calculation, or evidence of hidden ancestors.
"""

import ctypes
import errno
import hashlib
import json
import os
import platform
import re
import stat
import sys
import time


MAXIMUM_DEPTH = 64
MAXIMUM_PATH_COMPONENTS = 128
MAXIMUM_POLICY_BYTES = 4096
MAXIMUM_TOTAL_POLICY_BYTES = 1024 * 1024
MAXIMUM_MOUNTINFO_BYTES = 4 * 1024 * 1024
MAXIMUM_MOUNTS = 8192
MAXIMUM_LEAF_ENTRIES = 4096
POLICY_FILES = (
    "cgroup.type", "cgroup.controllers", "cgroup.subtree_control",
    "cpu.max", "cpu.max.burst", "cpu.weight", "cpu.idle",
    "cpu.uclamp.min", "cpu.uclamp.max",
    "cpuset.cpus.effective", "cpuset.mems.effective",
    "memory.max", "memory.high", "memory.swap.max", "pids.max",
)


class PolicyReadError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise PolicyReadError(code, message)


def _absolute(path):
    require(isinstance(path, str) and path.startswith("/") and "\0" not in path,
            "path", "Expected an absolute path without NUL")
    try:
        byte_length = len(path.encode("utf-8", errors="strict"))
    except UnicodeError as error:
        raise PolicyReadError("path", "Expected a UTF-8 path") from error
    require(byte_length <= 4096 and os.path.normpath(path) == path
            and not path.startswith("//"), "path", "Expected a bounded normalized path")
    return path


def _identity(details):
    return {"device": str(details.st_dev), "inode": str(details.st_ino),
            "mode": details.st_mode, "bytes": details.st_size,
            "modifiedNanoseconds": str(details.st_mtime_ns),
            "changedNanoseconds": str(details.st_ctime_ns)}


def _same_directory(left, right):
    return (left.st_dev, left.st_ino, left.st_mode) == (right.st_dev, right.st_ino, right.st_mode)


def _bounded_read(descriptor, maximum, budget=None):
    contents = bytearray()
    while True:
        chunk = os.read(descriptor, min(65536, maximum - len(contents) + 1))
        if not chunk:
            return bytes(contents)
        contents.extend(chunk)
        if budget is not None:
            budget[0] -= len(chunk)
            require(budget[0] >= 0, "byte-limit", "Aggregate policy byte limit exceeded")
        require(len(contents) <= maximum, "byte-limit", "File exceeds its bounded read limit")


def _proc_file(name, maximum):
    # Numeric PID avoids the intentional /proc/self symlink.
    path = f"/proc/{os.getpid()}/{name}"
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode), "file-type", "Expected a regular proc file")
        contents = _bounded_read(descriptor, maximum)
        require(_identity(before) == _identity(os.fstat(descriptor))
                == _identity(os.stat(path, follow_symlinks=False)),
                "identity", "Proc file identity changed during acquisition")
        return contents
    finally:
        os.close(descriptor)


def _mount_id(descriptor):
    contents = _proc_file(f"fdinfo/{descriptor}", 4096).decode("ascii")
    matches = re.findall(r"^mnt_id:\s*([0-9]+)$", contents, re.MULTILINE)
    require(len(matches) == 1, "mount-mapping", "Missing or ambiguous descriptor mount identity")
    return int(matches[0])


def _require_cgroup2(descriptor):
    # Linux x64 statfs begins with a native signed long filesystem magic.
    library = ctypes.CDLL(None, use_errno=True)
    function = library.fstatfs
    function.argtypes = [ctypes.c_int, ctypes.c_void_p]
    function.restype = ctypes.c_int
    result = ctypes.create_string_buffer(256)
    if function(descriptor, result):
        raise OSError(ctypes.get_errno(), "Cannot identify cgroup filesystem")
    require(ctypes.c_long.from_buffer(result).value == 0x63677270,
            "filesystem", "Selected directory is not a real cgroup-v2 filesystem")


def _mount_path(field, absolute=True):
    require(not re.search(r"\\(?!040|011|012|134)", field),
            "mountinfo", "Malformed mountinfo path escape")
    decoded = re.sub(r"\\(040|011|012|134)", lambda match: chr(int(match[1], 8)), field)
    # Other filesystems can expose opaque roots, e.g. nsfs net:[namespace].
    require(0 < len(decoded.encode("utf-8")) <= 4096 and "\0" not in decoded,
            "mountinfo", "Invalid mount root/path")
    return _absolute(decoded) if absolute else decoded


def parse_mountinfo(contents):
    require(len(contents) <= MAXIMUM_MOUNTINFO_BYTES, "byte-limit", "Mountinfo exceeds byte limit")
    try:
        text = contents.decode("utf-8", errors="strict")
    except UnicodeError as error:
        raise PolicyReadError("mountinfo", "Mountinfo is not UTF-8") from error
    lines = text.split("\n", MAXIMUM_MOUNTS + 1)
    if lines[-1] == "":
        lines.pop()
    require(0 < len(lines) <= MAXIMUM_MOUNTS and text.endswith("\n"),
            "mountinfo", "Invalid mountinfo line count or termination")
    mounts = []
    identities = set()
    for line in lines:
        halves = line.split(" - ", 1)
        require(len(halves) == 2, "mountinfo", "Malformed mountinfo separator")
        fields, tail = halves[0].split(" ", 64), halves[1].split(" ", 3)
        require(6 <= len(fields) <= 64 and len(tail) == 3 and all(fields + tail),
                "mountinfo", "Malformed mountinfo fields")
        require(re.fullmatch(r"[0-9]{1,10}", fields[0]) and int(fields[0]) > 0
                and re.fullmatch(r"[0-9]{1,10}", fields[1])
                and re.fullmatch(r"[0-9]{1,10}:[0-9]{1,10}", fields[2]),
                "mountinfo", "Malformed mountinfo identity")
        identity = int(fields[0])
        require(identity not in identities, "mount-mapping", "Duplicate mount identity")
        identities.add(identity)
        mounts.append({"id": identity, "parentId": int(fields[1]), "device": fields[2],
                       "root": _mount_path(fields[3], absolute=tail[0] == "cgroup2"), "mountPoint": _mount_path(fields[4]),
                       "options": fields[5], "optionalFields": fields[6:],
                       "filesystem": tail[0], "source": tail[1], "superOptions": tail[2],
                       "raw": line + "\n"})
    return mounts


def select_mount(path, mounts, descriptor_mount_id=None):
    path = _absolute(path)
    covering = [mount for mount in mounts if mount["mountPoint"] == "/"
                or path == mount["mountPoint"] or path.startswith(mount["mountPoint"] + "/")]
    require(covering, "mount-mapping", "No visible mount maps the supplied directory")
    length = max(len(mount["mountPoint"]) for mount in covering)
    selected = [mount for mount in covering if len(mount["mountPoint"]) == length]
    if descriptor_mount_id is not None:
        selected = [mount for mount in selected if mount["id"] == descriptor_mount_id]
    require(len(selected) == 1, "mount-mapping", "Ambiguous stacked mount mapping")
    require(selected[0]["filesystem"] == "cgroup2", "mount-mapping",
            "The most-specific visible mount is not cgroup v2")
    return selected[0]


class _DirectoryChain:
    def __init__(self, path):
        self.entries = []
        components = path.split("/")[1:] if path != "/" else []
        require(len(components) <= MAXIMUM_PATH_COMPONENTS, "depth-limit", "Absolute directory path is too deep")
        try:
            descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
            self.entries.append((None, "", descriptor, os.fstat(descriptor), "/"))
            for component in components:
                parent = descriptor
                descriptor = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent)
                previous_path = self.entries[-1][4]
                self.entries.append((parent, component, descriptor, os.fstat(descriptor),
                                     os.path.join(previous_path, component)))
        except BaseException:
            self.close()
            raise

    def validate(self):
        for parent, name, descriptor, before, path in self.entries:
            current = os.stat(name if parent is not None else path, dir_fd=parent, follow_symlinks=False)
            require(_same_directory(before, os.fstat(descriptor)) and _same_directory(before, current),
                    "identity", "Directory path or identity changed during acquisition")

    def close(self):
        for _parent, _name, descriptor, _before, _path in reversed(self.entries):
            os.close(descriptor)
        self.entries.clear()


def _unsigned(text):
    return re.fullmatch(r"(?:0|[1-9][0-9]{0,19})", text) is not None and int(text) <= 2**64 - 1


def validate_policy(name, contents):
    require(len(contents) <= MAXIMUM_POLICY_BYTES, "byte-limit", "Policy validation exceeds byte limit")
    try:
        text = contents.decode("ascii", errors="strict")
    except UnicodeError as error:
        raise PolicyReadError("malformed-policy", f"Non-ASCII policy: {name}") from error
    if name in ("cgroup.controllers", "cgroup.subtree_control"):
        valid = text == "" or (text.endswith("\n") and "\n" not in text[:-1])
        values = text.removesuffix("\n").split(" ") if text not in ("", "\n") else []
        valid = valid and len(values) == len(set(values)) and all(re.fullmatch(r"[a-z][a-z0-9_]*", value) for value in values)
    else:
        valid = text.endswith("\n") and "\n" not in text[:-1]
        value = text.removesuffix("\n")
        if name == "cgroup.type":
            valid = valid and value in ("domain", "domain threaded", "threaded", "domain (invalid)")
        elif name == "cpu.max":
            parts = value.split(" ")
            valid = valid and len(parts) == 2 and (parts[0] == "max" or (_unsigned(parts[0]) and int(parts[0]) > 0)) and _unsigned(parts[-1]) and int(parts[-1]) > 0
        elif name == "cpu.weight":
            # SCHED_IDLE groups expose zero. Keep this independent of the
            # separately acquired cpu.idle observation; the snapshot is not atomic.
            valid = valid and _unsigned(value) and 0 <= int(value) <= 10000
        elif name == "cpu.idle":
            valid = valid and value in ("0", "1")
        elif name in ("cpu.uclamp.min", "cpu.uclamp.max"):
            valid = valid and (value == "max" or (re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]{1,2})?", value) is not None and 0 <= float(value) <= 100))
        elif name.startswith("cpuset."):
            previous = -1
            for item in value.split(",") if value else []:
                parts = item.split("-")
                if len(parts) not in (1, 2) or not all(_unsigned(part) for part in parts):
                    valid = False
                    break
                low, high = int(parts[0]), int(parts[-1])
                if not previous < low <= high <= 2**32 - 1:
                    valid = False
                    break
                previous = high
        elif name == "cpu.max.burst":
            valid = valid and _unsigned(value)
        else:
            valid = valid and (value == "max" or _unsigned(value))
    require(valid, "malformed-policy", f"Malformed policy value: {name}")
    return text


def _unavailable(error, started, identity=None):
    return {"status": "missing" if error.errno == errno.ENOENT else "unreadable",
            "errno": error.errno, "error": errno.errorcode.get(error.errno, "UNKNOWN"),
            "raw": None, "identity": identity, "startedNanoseconds": str(started),
            "finishedNanoseconds": str(time.monotonic_ns())}


def _read_policy_file(directory, name, budget):
    started = time.monotonic_ns()
    try:
        before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.EACCES, errno.EPERM):
            return _unavailable(error, started)
        raise
    require(stat.S_ISREG(before.st_mode), "file-type", f"Policy is not a regular non-symlink file: {name}")
    require(before.st_dev == os.fstat(directory).st_dev, "mount-mapping", f"Policy device differs from its cgroup: {name}")
    require(0 <= before.st_size <= MAXIMUM_POLICY_BYTES, "byte-limit", f"Oversize policy: {name}")
    descriptor = None
    failure = None
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        require(_identity(before) == _identity(os.fstat(descriptor)), "identity", f"Policy was substituted before read: {name}")
        mount_id = _mount_id(directory)
        require(_mount_id(descriptor) == mount_id, "mount-mapping", f"Policy mount differs from its cgroup: {name}")
        contents = _bounded_read(descriptor, MAXIMUM_POLICY_BYTES, budget)
    except OSError as error:
        require(error.errno not in (errno.ENOENT, errno.ELOOP, errno.ENOTDIR), "identity", f"Policy path changed during read: {name}")
        failure = error
    finally:
        try:
            require(_identity(before) == _identity(os.stat(name, dir_fd=directory, follow_symlinks=False))
                    and (descriptor is None or _identity(before) == _identity(os.fstat(descriptor))),
                    "identity", f"Policy identity changed during acquisition: {name}")
        finally:
            if descriptor is not None:
                os.close(descriptor)
    if failure is not None:
        return _unavailable(failure, started, _identity(before))
    return {"status": "observed", "raw": validate_policy(name, contents), "mountId": mount_id,
            "identity": _identity(before), "bytes": len(contents),
            "startedNanoseconds": str(started), "finishedNanoseconds": str(time.monotonic_ns())}


def _require_leaf(descriptor):
    with os.scandir(descriptor) as entries:
        for count, entry in enumerate(entries, 1):
            require(count <= MAXIMUM_LEAF_ENTRIES, "entry-limit", "Too many leaf entries")
            require(not entry.is_symlink(), "file-type", "Symlink in supplied leaf directory")
            require(not entry.is_dir(follow_symlinks=False), "not-leaf", "Supplied cgroup has child directories")


def _namespace_ids():
    return {name: os.readlink(f"/proc/{os.getpid()}/ns/{name}") for name in ("mnt", "cgroup")}


def read_policy(leaf):
    """Return raw visible-ancestor observations; reject an untrustworthy read.

    Missing and unreadable individual policy files are diagnostic gaps. Invalid
    bytes, symlinks, changing identities and uncertain mount mapping reject the
    snapshot via PolicyReadError/OSError. The caller owns a live cgroup and its
    immutable original capture; this reader never joins or admits that capture.
    """
    require(sys.platform == "linux" and platform.machine() in ("x86_64", "amd64"),
            "platform", "Policy reader requires native Linux x64")
    leaf = _absolute(os.fspath(leaf))
    started = time.monotonic_ns()
    namespaces = _namespace_ids()
    mountinfo = _proc_file("mountinfo", MAXIMUM_MOUNTINFO_BYTES)
    mounts = parse_mountinfo(mountinfo)
    chain = _DirectoryChain(leaf)
    budget = [MAXIMUM_TOTAL_POLICY_BYTES]
    rows = []
    try:
        chain.validate()
        mount = select_mount(leaf, mounts, _mount_id(chain.entries[-1][2]))
        relative = os.path.relpath(leaf, mount["mountPoint"])
        depth = 1 if relative == "." else len(relative.split("/")) + 1
        require(depth <= MAXIMUM_DEPTH, "depth-limit", "Visible cgroup hierarchy exceeds depth limit")
        _require_leaf(chain.entries[-1][2])
        root_index = next(index for index, entry in enumerate(chain.entries) if entry[4] == mount["mountPoint"])
        selected_entries = chain.entries[root_index:]
        require(len(selected_entries) == depth, "mount-mapping", "Unexpected ancestor path depth")
        major, minor = map(int, mount["device"].split(":"))
        for _parent, _name, descriptor, identity, path in reversed(selected_entries):
            _require_cgroup2(descriptor)
            require((os.major(identity.st_dev), os.minor(identity.st_dev)) == (major, minor)
                    and _mount_id(descriptor) == mount["id"], "mount-mapping", "Directory differs from selected cgroup mount")
            row_started = time.monotonic_ns()
            policies = {name: _read_policy_file(descriptor, name, budget) for name in POLICY_FILES}
            rows.append({"path": path, "hierarchyPath": os.path.normpath(os.path.join(mount["root"], os.path.relpath(path, mount["mountPoint"]))),
                         "directoryIdentity": _identity(identity), "mountId": mount["id"], "files": policies,
                         "startedNanoseconds": str(row_started), "finishedNanoseconds": str(time.monotonic_ns())})
        _require_leaf(chain.entries[-1][2])
        chain.validate()
        for _parent, _name, descriptor, _identity_before, _path in selected_entries:
            require(_mount_id(descriptor) == mount["id"], "mount-mapping", "Cgroup mount changed during acquisition")
        require(_proc_file("mountinfo", MAXIMUM_MOUNTINFO_BYTES) == mountinfo
                and _namespace_ids() == namespaces, "mount-mapping", "Mount table or namespace changed during acquisition")
    finally:
        chain.close()
    for index, row in enumerate(rows):
        parent = rows[index + 1] if index + 1 < len(rows) else None
        control = parent["files"]["cgroup.subtree_control"] if parent else None
        for name, observation in row["files"].items():
            if name.startswith("cgroup."):
                continue
            observation["controllerInObservedParentSubtree"] = (
                "outside-visible-hierarchy" if control is None else
                "unavailable" if control["status"] != "observed" else
                "listed" if name.split(".")[0] in control["raw"].split() else "not-listed")
    return {"schemaVersion": 1, "status": "diagnostic-snapshot", "platform": "linux-x64",
            "resourceAdmission": False, "leaf": leaf, "mount": mount,
            "mountinfoSha256": hashlib.sha256(mountinfo).hexdigest(), "namespaceIds": namespaces,
            "startedNanoseconds": str(started), "finishedNanoseconds": str(time.monotonic_ns()),
            "policyBytesRead": MAXIMUM_TOTAL_POLICY_BYTES - budget[0], "ancestorsLeafFirst": rows,
            "coverage": {"visibleAncestorsThroughMountRoot": True,
                         "mountRoot": mount["root"], "hiddenAncestors": "unverified-even-when-root-is-slash",
                         "limitations": ["Sequential reads are not an atomic policy snapshot; transient changes/restoration may be missed.",
                                         "Mount/cgroup namespaces or bind mounts can hide enforcing ancestors.",
                                         "Missing/unreadable files and observed controller enablement are separate acquisition observations; absence is not unlimited or zero.",
                                         "No effective quotas, scheduling-class applicability, CPU totals, workload membership or resource admission are derived."]}}


def main():
    try:
        require(len(sys.argv) == 2, "arguments", "Usage: python3 -B tools/linux_cgroup_policy.py ABSOLUTE_CGROUP_LEAF")
        result = read_policy(sys.argv[1])
    except (PolicyReadError, OSError) as error:
        result = {"schemaVersion": 1, "status": "rejected", "resourceAdmission": False,
                  "error": {"code": getattr(error, "code", "os-error"), "errno": getattr(error, "errno", None), "message": str(error)}}
        exit_code = 1
    else:
        exit_code = 0
    print(json.dumps(result, sort_keys=True, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
