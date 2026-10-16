"""Synthetic adversarial controls plus one separate read-only kernel control."""

from contextlib import ExitStack, contextmanager
import errno
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import linux_cgroup_policy as policy


class SyntheticPolicyTests(unittest.TestCase):
    def setUp(self):
        workbench = Path(__file__).resolve().parents[1] / "workbench/linux-cgroup-policy-001"
        workbench.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="synthetic-", dir=workbench)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.leaf = self.root / "leaf"
        self.leaf.mkdir()
        self.values = {
            "cgroup.type": "domain\n", "cgroup.controllers": "cpu cpuset memory pids\n",
            "cgroup.subtree_control": "cpu cpuset memory pids\n",
            "cpu.max": "max 100000\n", "cpu.max.burst": "0\n", "cpu.weight": "100\n",
            "cpu.idle": "0\n", "cpu.uclamp.min": "0.00\n", "cpu.uclamp.max": "max\n",
            "cpuset.cpus.effective": "0-3,5\n", "cpuset.mems.effective": "0\n",
            "memory.max": "max\n", "memory.high": "100000\n", "memory.swap.max": "0\n", "pids.max": "512\n",
        }
        for directory in (self.root, self.leaf):
            for name, value in self.values.items():
                (directory / name).write_text(value)
        self.device = f"{os.major(self.root.stat().st_dev)}:{os.minor(self.root.stat().st_dev)}"
        self.mountinfo = self.mount_line()

    def mount_line(self, identity=99, root="/delegated", point=None, filesystem="cgroup2", options="rw"):
        point = str(point or self.root).replace("\\", "\\134").replace(" ", "\\040")
        return f"{identity} 1 {self.device} {root} {point} {options} - {filesystem} cgroup2 {options}\n".encode()

    @contextmanager
    def environment(self, mountinfo=None, mount_ids=99):
        # Fixture files are ordinary files. Only this test context substitutes
        # filesystem/mount/proc observations; it is not kernel evidence.
        with ExitStack() as stack:
            stack.enter_context(patch.object(policy.sys, "platform", "linux"))
            stack.enter_context(patch.object(policy.platform, "machine", return_value="x86_64"))
            stack.enter_context(patch.object(policy, "_require_cgroup2"))
            stack.enter_context(patch.object(policy, "_namespace_ids", return_value={"mnt": "synthetic", "cgroup": "synthetic"}))
            stack.enter_context(patch.object(policy, "_mount_id", **({"return_value": mount_ids} if isinstance(mount_ids, int) else {"side_effect": mount_ids})))
            stack.enter_context(patch.object(policy, "_proc_file", return_value=mountinfo or self.mountinfo))
            yield

    def snapshot(self):
        with self.environment():
            return policy.read_policy(self.leaf)

    def test_synthetic_retains_every_raw_policy_and_visible_ancestor_bracket(self):
        snapshot = self.snapshot()
        self.assertFalse(snapshot["resourceAdmission"])
        self.assertEqual([row["hierarchyPath"] for row in snapshot["ancestorsLeafFirst"]], ["/delegated/leaf", "/delegated"])
        self.assertEqual(snapshot["coverage"]["hiddenAncestors"], "unverified-even-when-root-is-slash")
        for row in snapshot["ancestorsLeafFirst"]:
            self.assertEqual(set(row["files"]), set(policy.POLICY_FILES))
            for name, value in row["files"].items():
                self.assertEqual(value["raw"], self.values[name])
                self.assertLessEqual(int(snapshot["startedNanoseconds"]), int(value["startedNanoseconds"]))
                self.assertLessEqual(int(value["startedNanoseconds"]), int(value["finishedNanoseconds"]))
                self.assertLessEqual(int(value["finishedNanoseconds"]), int(snapshot["finishedNanoseconds"]))
        self.assertEqual(snapshot["policyBytesRead"], 2 * sum(len(value) for value in self.values.values()))
        self.assertEqual(snapshot["ancestorsLeafFirst"][0]["files"]["cpu.max"]["controllerInObservedParentSubtree"], "listed")

    def test_synthetic_missing_and_disabled_remain_separate_without_defaults(self):
        (self.leaf / "cpu.max").unlink()
        (self.root / "cgroup.subtree_control").write_bytes(b"")
        observed = self.snapshot()["ancestorsLeafFirst"][0]["files"]["cpu.max"]
        self.assertEqual(observed["status"], "missing")
        self.assertIsNone(observed["raw"])
        self.assertEqual(observed["errno"], errno.ENOENT)
        self.assertEqual(observed["controllerInObservedParentSubtree"], "not-listed")

    def test_synthetic_unreadable_policy_is_explicit(self):
        original = os.open

        def deny(name, flags, *args, **kwargs):
            if name == "memory.max":
                raise PermissionError(errno.EACCES, "synthetic denial")
            return original(name, flags, *args, **kwargs)

        with self.environment(), patch.object(policy.os, "open", side_effect=deny):
            observation = policy.read_policy(self.leaf)["ancestorsLeafFirst"][0]["files"]["memory.max"]
        self.assertEqual(observation["status"], "unreadable")
        self.assertEqual(observation["errno"], errno.EACCES)
        self.assertIsNone(observation["raw"])
        self.assertIsNotNone(observation["identity"])

    def test_synthetic_partial_failed_read_still_consumes_aggregate_budget(self):
        descriptor = os.open(self.leaf, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, descriptor)
        count = 0

        def fail_after_bytes(_descriptor, _maximum):
            nonlocal count
            count += 1
            if count == 1:
                return b"123"
            raise OSError(errno.EIO, "synthetic read failure")

        budget = [10]
        with patch.object(policy, "_mount_id", return_value=99), patch.object(policy.os, "read", side_effect=fail_after_bytes):
            observed = policy._read_policy_file(descriptor, "memory.max", budget)
        self.assertEqual(observed["status"], "unreadable")
        self.assertEqual(budget, [7])

    def test_synthetic_rejects_symlink_leaf_and_intermediate_component(self):
        alias = self.root / "alias"
        alias.symlink_to(self.leaf, target_is_directory=True)
        for target in (alias, alias / "nested"):
            with self.subTest(target=target), self.environment(), self.assertRaises(OSError):
                policy.read_policy(target)

    def test_synthetic_rejects_symlink_and_fifo_policy_without_blocking(self):
        target = self.leaf / "cpu.max"
        target.unlink()
        target.symlink_to(self.root / "cpu.max")
        with self.assertRaisesRegex(policy.PolicyReadError, "Symlink"):
            self.snapshot()
        target.unlink()
        os.mkfifo(target)
        with self.assertRaisesRegex(policy.PolicyReadError, "regular"):
            self.snapshot()

    def test_synthetic_rejects_substituted_file_even_when_original_fd_stays_open(self):
        original = os.read
        changed = False

        def replace(descriptor, maximum):
            nonlocal changed
            path = Path(os.readlink(f"/proc/{os.getpid()}/fd/{descriptor}"))
            if path == self.leaf / "cpu.max" and not changed:
                changed = True
                path.rename(self.leaf / "saved-policy")
                path.write_text("max 100000\n")
            return original(descriptor, maximum)

        with self.environment(), patch.object(policy.os, "read", side_effect=replace), self.assertRaisesRegex(policy.PolicyReadError, "identity changed"):
            policy.read_policy(self.leaf)
        self.assertTrue(changed)

    def test_synthetic_rejects_substituted_directory_with_original_descriptors_alive(self):
        original = policy._read_policy_file
        changed = False

        def replace(directory, name, budget):
            nonlocal changed
            result = original(directory, name, budget)
            if not changed:
                changed = True
                self.leaf.rename(self.root / "saved-leaf")
                self.leaf.mkdir()
            return result

        with self.environment(), patch.object(policy, "_read_policy_file", side_effect=replace), self.assertRaisesRegex(policy.PolicyReadError, "Directory path"):
            policy.read_policy(self.leaf)

    def test_synthetic_rejects_oversize_files_and_bounded_stream_overflow(self):
        (self.leaf / "cpu.max").write_bytes(b"1" * (policy.MAXIMUM_POLICY_BYTES + 1))
        with self.assertRaisesRegex(policy.PolicyReadError, "Oversize"):
            self.snapshot()
        descriptor = os.open(self.leaf / "cpu.max", os.O_RDONLY)
        self.addCleanup(os.close, descriptor)
        with self.assertRaisesRegex(policy.PolicyReadError, "bounded read"):
            policy._bounded_read(descriptor, policy.MAXIMUM_POLICY_BYTES)

    def test_synthetic_enforces_aggregate_depth_and_entry_bounds(self):
        for constant, value, message in [("MAXIMUM_TOTAL_POLICY_BYTES", 3, "Aggregate"), ("MAXIMUM_DEPTH", 1, "depth limit"), ("MAXIMUM_PATH_COMPONENTS", 1, "too deep"), ("MAXIMUM_LEAF_ENTRIES", 1, "Too many")]:
            with self.subTest(constant=constant), patch.object(policy, constant, value), self.assertRaisesRegex(policy.PolicyReadError, message):
                self.snapshot()

    def test_synthetic_rejects_nonleaf_directory(self):
        (self.leaf / "child").mkdir()
        with self.assertRaisesRegex(policy.PolicyReadError, "child directories"):
            self.snapshot()

    def test_synthetic_visible_ro_overmount_is_selected_using_opened_mount_id(self):
        mounts = self.mountinfo + self.mount_line(identity=100, options="ro")
        with self.environment(mountinfo=mounts, mount_ids=100):
            snapshot = policy.read_policy(self.leaf)
        self.assertEqual(snapshot["mount"]["id"], 100)
        self.assertEqual(snapshot["mount"]["options"], "ro")
        parsed = policy.parse_mountinfo(mounts)
        with self.assertRaisesRegex(policy.PolicyReadError, "Ambiguous"):
            policy.select_mount(str(self.leaf), parsed)
        with self.environment(mountinfo=mounts, mount_ids=101), self.assertRaisesRegex(policy.PolicyReadError, "Ambiguous"):
            policy.read_policy(self.leaf)

    def test_synthetic_rejects_more_specific_noncgroup_overmount(self):
        mounts = self.mountinfo + self.mount_line(identity=100, point=self.leaf, filesystem="tmpfs")
        with self.environment(mountinfo=mounts, mount_ids=100), self.assertRaisesRegex(policy.PolicyReadError, "not cgroup v2"):
            policy.read_policy(self.leaf)

    def test_synthetic_rejects_mount_device_mismatch(self):
        mounts = self.mountinfo.replace(self.device.encode(), b"99:99")
        with self.environment(mountinfo=mounts), self.assertRaisesRegex(policy.PolicyReadError, "selected cgroup mount"):
            policy.read_policy(self.leaf)

    def test_synthetic_rejects_mount_identity_change_during_acquisition(self):
        calls = len(policy.POLICY_FILES) * 4 + 5
        with self.environment(mount_ids=[99] * (calls - 1) + [100]), self.assertRaisesRegex(policy.PolicyReadError, "mount changed"):
            policy.read_policy(self.leaf)

    def test_synthetic_rejects_same_device_policy_file_from_a_different_mount(self):
        def mount_id(descriptor):
            path = os.readlink(f"/proc/{os.getpid()}/fd/{descriptor}")
            return 100 if path.endswith("/cpu.max") else 99

        with self.environment(), patch.object(policy, "_mount_id", side_effect=mount_id), self.assertRaisesRegex(policy.PolicyReadError, "Policy mount differs"):
            policy.read_policy(self.leaf)

    def test_synthetic_rejects_changed_mount_table_and_namespace(self):
        with self.environment(), patch.object(policy, "_proc_file", side_effect=[self.mountinfo, self.mountinfo + self.mount_line(identity=100)]), self.assertRaisesRegex(policy.PolicyReadError, "Mount table"):
            policy.read_policy(self.leaf)
        with self.environment(), patch.object(policy, "_namespace_ids", side_effect=[{"mnt": "first"}, {"mnt": "second"}]), self.assertRaisesRegex(policy.PolicyReadError, "namespace"):
            policy.read_policy(self.leaf)

    def test_synthetic_root_slash_does_not_admit_hidden_ancestor_coverage(self):
        with self.environment(mountinfo=self.mount_line(root="/")):
            snapshot = policy.read_policy(self.leaf)
        self.assertEqual(snapshot["coverage"]["hiddenAncestors"], "unverified-even-when-root-is-slash")
        self.assertFalse(snapshot["resourceAdmission"])

    def test_synthetic_mountinfo_parsing_rejects_malformed_and_unbounded_mapping(self):
        invalid = [b"", self.mountinfo.rstrip(b"\n"), self.mountinfo + self.mountinfo,
                   self.mountinfo.replace(b" - ", b" wrong "), self.mountinfo.replace(b"/delegated", b"relative"),
                   self.mountinfo.replace(b"/delegated", b"/bad\\999"), b"\xff\n"]
        for contents in invalid:
            with self.subTest(contents=contents[:100]), self.assertRaises(policy.PolicyReadError):
                policy.parse_mountinfo(contents)
        with patch.object(policy, "MAXIMUM_MOUNTINFO_BYTES", 1), self.assertRaisesRegex(policy.PolicyReadError, "byte limit"):
            policy.parse_mountinfo(self.mountinfo)
        with patch.object(policy, "MAXIMUM_MOUNTS", 1), self.assertRaisesRegex(policy.PolicyReadError, "line count"):
            policy.parse_mountinfo(self.mountinfo + self.mount_line(identity=100))

    def test_synthetic_mountinfo_escaped_space_is_not_shell_parsed(self):
        directory = self.root / "space directory"
        directory.mkdir()
        parsed = policy.parse_mountinfo(self.mount_line(point=directory))
        self.assertEqual(parsed[0]["mountPoint"], str(directory))

    def test_synthetic_unrelated_nsfs_opaque_root_does_not_corrupt_cgroup_mapping(self):
        opaque = self.mount_line(identity=100, root="net:[12345]", point=self.root / "unrelated", filesystem="nsfs")
        parsed = policy.parse_mountinfo(self.mountinfo + opaque)
        self.assertEqual(parsed[1]["root"], "net:[12345]")
        self.assertEqual(policy.select_mount(str(self.leaf), parsed)["id"], 99)

    def test_synthetic_rejects_malformed_values_without_expanding_cpu_ranges(self):
        cases = {"cpu.max": [b"max\n", b"1 0\n", b"1 2 3\n", b"-1 100000\n"],
                 "cpu.max.burst": [b"-1\n", b"18446744073709551616\n"],
                 "cpu.weight": [b"-1\n", b"10001\n"], "cpu.idle": [b"2\n"],
                 "cpu.uclamp.min": [b"NaN\n", b"100.01\n", b"-1\n"],
                 "cpuset.cpus.effective": [b"2-1\n", b"0-3,2\n", b"0,,1\n", b"4294967296\n"],
                 "cgroup.controllers": [b"cpu cpu\n", b"+cpu\n", b"cpu\nother\n"],
                 "memory.max": [b"\n", b"max\nextra\n", b"\x00\n", b"\xff\n"], "pids.max": [b"unlimited\n"]}
        for name, contents in cases.items():
            for value in contents:
                with self.subTest(name=name, value=value), self.assertRaises(policy.PolicyReadError):
                    policy.validate_policy(name, value)
        self.assertEqual(policy.validate_policy("cpuset.cpus.effective", b"0-4294967295\n"), "0-4294967295\n")
        for contents in (b"", b"\n"):
            self.assertEqual(policy.validate_policy("cgroup.subtree_control", contents), contents.decode())

    def test_synthetic_preserves_kernel_idle_group_zero_weight_without_cross_file_inference(self):
        (self.leaf / "cpu.weight").write_text("0\n")
        (self.leaf / "cpu.idle").write_text("1\n")
        observed = self.snapshot()["ancestorsLeafFirst"][0]["files"]
        self.assertEqual(observed["cpu.weight"]["raw"], "0\n")
        self.assertEqual(observed["cpu.idle"]["raw"], "1\n")

    def test_synthetic_malformed_file_rejects_entire_snapshot(self):
        (self.leaf / "cpu.max").write_bytes(b"not-a-policy\n")
        with self.assertRaisesRegex(policy.PolicyReadError, "Malformed policy"):
            self.snapshot()

    def test_synthetic_path_aliases_and_wrong_platform_are_rejected(self):
        for path in ["relative", str(self.leaf) + "/", str(self.leaf) + "/../leaf", "//sys/fs/cgroup", "/bad\0name", "/bad\udcff"]:
            with self.subTest(path=repr(path)), self.environment(), self.assertRaises(policy.PolicyReadError):
                policy.read_policy(path)
        with patch.object(policy.sys, "platform", "darwin"), self.assertRaisesRegex(policy.PolicyReadError, "native Linux x64"):
            policy.read_policy(self.leaf)

    def test_real_filesystem_gate_rejects_ordinary_fixture_without_mocks(self):
        if os.name != "posix" or platform.machine() != "x86_64":
            self.skipTest("Linux x64 filesystem gate")
        descriptor = os.open(self.leaf, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, descriptor)
        with self.assertRaisesRegex(policy.PolicyReadError, "real cgroup-v2"):
            policy._require_cgroup2(descriptor)


class KernelReadOnlyTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux" and platform.machine() == "x86_64", "Native Linux x64 only")
    def test_actual_kernel_hierarchy_without_filesystem_or_mount_mocks(self):
        membership = Path(f"/proc/{os.getpid()}/cgroup").read_text()
        paths = [line[3:] for line in membership.splitlines() if line.startswith("0::")]
        self.assertEqual(len(paths), 1)
        mounts = policy.parse_mountinfo(policy._proc_file("mountinfo", policy.MAXIMUM_MOUNTINFO_BYTES))
        roots = [mount for mount in mounts if mount["filesystem"] == "cgroup2" and mount["root"] == "/"]
        if len(roots) != 1:
            self.skipTest("Actual self-membership root mapping requires a separate namespace admission")
        leaf = Path(roots[0]["mountPoint"]) / paths[0].lstrip("/")
        snapshot = policy.read_policy(leaf)
        self.assertEqual(snapshot["status"], "diagnostic-snapshot")
        self.assertFalse(snapshot["resourceAdmission"])
        self.assertEqual(snapshot["ancestorsLeafFirst"][0]["path"], str(leaf))
        self.assertEqual(snapshot["ancestorsLeafFirst"][-1]["path"], roots[0]["mountPoint"])
        self.assertTrue(all(value["status"] in ("observed", "missing", "unreadable") for row in snapshot["ancestorsLeafFirst"] for value in row["files"].values()))
        json.dumps(snapshot)


if __name__ == "__main__":
    unittest.main()
