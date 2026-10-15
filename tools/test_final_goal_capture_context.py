"""Check original launch boundaries, input mutation and bounded file collection."""

import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from tools import final_goal_capture_context as capture


class CaptureFixture(unittest.TestCase):
    def setUp(self):
        workbench = Path(__file__).resolve().parents[1] / "workbench"
        workbench.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="capture-context-tests-", dir=workbench)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "source.js"
        self.source.write_text("export const value = 1;\n")
        self.dependency = self.directory / "dependency.js"
        self.dependency.write_text("export const version = 1;\n")
        self.runtime = Path(sys.executable).resolve()
        self.source_manifest = self.directory / "source-manifest.json"
        self.source_manifest.write_bytes(capture.encode({"source.js": capture.digest(self.source.read_bytes())}))
        dependency_manifest = self.directory / "dependency-manifest.json"
        dependency_manifest.write_bytes(capture.encode({"dependency.js": capture.digest(self.dependency.read_bytes())}))
        self.request = {
            "schemaVersion": 1,
            "source": {"root": str(self.directory), "manifest": self.receipt(self.source_manifest)},
            "dependencies": {"root": str(self.directory), "manifest": self.receipt(dependency_manifest)},
            "controls": [], "runtimeAssets": [],
            "executables": {role: self.receipt(self.runtime) for role in ["runtime", "browser", "driver", "launcher"]},
        }
        self.request_path = self.directory / "request.json"
        self.save_request()
        self.context = capture.CaptureContext(self.request_path, "a" * 32, [str(self.runtime), "-c", "pass"])

    @staticmethod
    def receipt(path):
        contents = path.read_bytes()
        return {"path": str(path), "sha256": capture.digest(contents), "bytes": len(contents)}

    def save_request(self):
        self.request_path.write_bytes(capture.encode(self.request))

    def set_manifest(self, manifest):
        self.source_manifest.write_bytes(capture.encode(manifest))
        self.request["source"]["manifest"] = self.receipt(self.source_manifest)
        self.save_request()


class CaptureInputTests(CaptureFixture):
    def test_collects_source_dependency_and_executable_bytes_once(self):
        inputs = self.context.collect_inputs()
        paths = [entry["path"] for entry in inputs["files"]]
        self.assertEqual(len(paths), 6)
        self.assertEqual(len(paths), len(set(paths)))
        self.assertEqual(inputs["totalBytes"], sum(entry["bytes"] for entry in inputs["files"]))
        self.assertEqual(inputs["executables"]["runtime"]["sha256"], self.receipt(self.runtime)["sha256"])

    def test_rejects_non_integer_schema(self):
        self.request["schemaVersion"] = True
        self.save_request()
        with self.assertRaisesRegex(ValueError, "Invalid capture-input request"):
            self.context.collect_inputs()

    def test_duplicate_members_and_invalid_utf8_are_not_accepted(self):
        for contents in [b'{"schemaVersion":1,"schemaVersion":1}', b'{"name":"\xff"}', b'{"value":NaN}']:
            with self.subTest(contents=contents), self.assertRaises(ValueError):
                capture.decode(contents)

    def test_manifest_paths_cannot_traverse_or_alias(self):
        for relative in ["../source.js", "/source.js", "./source.js", "one//source.js", "one/../source.js", "a\\b", "bad\0name"]:
            with self.subTest(relative=relative):
                self.set_manifest({relative: "0" * 64})
                with self.assertRaisesRegex(ValueError, "Invalid manifest member path"):
                    self.context.collect_inputs()

    def test_wrong_member_bytes_and_size_fail(self):
        self.source.write_text("different content")
        with self.assertRaisesRegex(ValueError, "content differs"):
            self.context.collect_inputs()
        self.request["controls"] = [{**self.receipt(self.dependency), "bytes": 0}]
        self.save_request()
        with self.assertRaisesRegex(ValueError, "size differs"):
            self.context.collect_inputs()

    def test_conflicting_inventories_fail(self):
        self.request["controls"] = [{**self.receipt(self.source), "sha256": "0" * 64}]
        self.save_request()
        with self.assertRaisesRegex(ValueError, "Conflicting expected input hashes"):
            self.context.collect_inputs()

    def test_aggregate_limit_is_enforced_before_reading_members(self):
        original = capture.read_stable_file
        with patch.object(capture, "MAXIMUM_TOTAL_BYTES", 4096), patch.object(capture, "read_stable_file", wraps=original) as reader:
            with self.assertRaisesRegex(ValueError, "Aggregate capture-input byte limit"):
                self.context.collect_inputs()
        self.assertEqual([call.args[0] for call in reader.call_args_list],
                         [str(self.request_path), str(self.source_manifest), self.request["dependencies"]["manifest"]["path"]])

    def test_file_and_count_limits_fail(self):
        with self.assertRaisesRegex(ValueError, "byte limit"):
            capture.read_stable_file(str(self.source), maximum_bytes=1)
        with patch.object(capture, "MAXIMUM_FILES", 5), self.assertRaisesRegex(ValueError, "count exceeded"):
            self.context.collect_inputs()

    def test_directories_and_fifos_are_not_read(self):
        fifo = self.directory / "pipe"
        os.mkfifo(fifo)
        for path in [self.directory, fifo]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "not a regular file"):
                capture.read_stable_file(str(path))

    def test_changed_during_read_is_rejected(self):
        original = os.read
        changed = False

        def mutate(descriptor, size):
            nonlocal changed
            result = original(descriptor, size)
            if not changed:
                changed = True
                self.source.write_text("changed after original bytes were read")
            return result

        with patch.object(capture.os, "read", side_effect=mutate), self.assertRaisesRegex(ValueError, "changed while reading"):
            capture.read_stable_file(str(self.source))

    def test_runtime_must_match_the_actual_owner_command(self):
        self.context.command = ["python3", "-c", "pass"]
        with self.assertRaisesRegex(ValueError, "declared runtime"):
            self.context.collect_inputs()


@unittest.skipUnless(sys.platform == "darwin" and platform.machine() == "arm64", "native macOS arm64 capture")
class CaptureBoundaryTests(CaptureFixture):
    def snapshot(self, phase):
        path = self.directory / (phase + ".json")
        receipt = self.context.snapshot(phase, path)
        self.assertEqual(receipt["sha256"], capture.digest(path.read_bytes()))
        return json.loads(path.read_text())

    def test_original_before_and_after_match_and_bind_raw_receipt(self):
        before = self.snapshot("before")
        after = self.snapshot("after")
        self.assertEqual(before["status"], "verified")
        self.assertEqual(after["status"], "verified")
        self.assertEqual(after["beforeReceipt"]["sha256"], capture.digest((self.directory / "before.json").read_bytes()))
        self.assertLessEqual(int(before["finishedNanoseconds"]), int(after["startedNanoseconds"]))
        self.assertEqual(before["host"], after["host"])
        self.assertNotIn("bootSessionUuid", before["host"])

    def test_replacement_with_identical_bytes_is_detected(self):
        self.assertEqual(self.snapshot("before")["status"], "verified")
        replacement = self.directory / "replacement"
        replacement.write_bytes(self.source.read_bytes())
        replacement.replace(self.source)
        after = self.snapshot("after")
        self.assertEqual(after["status"], "failed")
        self.assertIn("changed after launch: inputs", after["error"])

    def test_request_symlink_retarget_is_detected(self):
        alias = self.directory / "alias.json"
        alias.symlink_to(self.request_path)
        self.context = capture.CaptureContext(alias, "a" * 32, [str(self.runtime)])
        self.assertEqual(self.snapshot("before")["status"], "verified")
        replacement = self.directory / "other-request.json"
        replacement.write_bytes(self.request_path.read_bytes())
        alias.unlink()
        alias.symlink_to(replacement)
        after = self.snapshot("after")
        self.assertEqual(after["status"], "failed")
        self.assertIn("changed after launch: inputs", after["error"])

    def test_host_change_and_unknown_clock_fail(self):
        host = capture.read_mac_host()
        with patch.object(capture, "read_mac_host", side_effect=[host, {**host, "namespace": "changed"}]):
            before = self.snapshot("before")
        self.assertEqual(before["status"], "failed")
        self.assertIn("Host or boot changed", before["error"])
        with patch.object(capture.time, "get_clock_info", return_value=type("Clock", (), {
                "monotonic": True, "adjustable": False, "implementation": "other"})()):
            receipt = self.context.snapshot("before", self.directory / "unknown-clock.json")
        self.assertEqual(receipt["status"], "failed")

    def test_snapshot_outputs_are_immutable(self):
        self.snapshot("before")
        original = (self.directory / "before.json").read_bytes()
        with self.assertRaises(FileExistsError):
            self.context.snapshot("before", self.directory / "before.json")
        self.assertEqual((self.directory / "before.json").read_bytes(), original)

    def test_before_snapshot_rewrite_invalidates_after(self):
        self.snapshot("before")
        (self.directory / "before.json").write_text("rewritten")
        after = self.snapshot("after")
        self.assertEqual(after["status"], "failed")
        self.assertIn("Original before snapshot changed", after["error"])

    def launch(self, body, report_name="resources.json"):
        self.report_path = self.directory / report_name
        return subprocess.run([
            sys.executable, "tools/watchdog.py", "--timeout", "5", "--report", str(self.report_path),
            "--capture-inputs", str(self.request_path), "--", str(self.runtime), "-c", body,
        ], capture_output=True, text=True, timeout=20)

    def test_real_child_observes_before_receipt_and_original_clock(self):
        observation = self.directory / "observed.json"
        before_path = self.directory / "resources.json.context-before.json"
        result = self.launch("import json,os,pathlib,time; "
                             f"before=json.loads(pathlib.Path({str(before_path)!r}).read_text()); "
                             "clock=json.loads(os.environ['FLASHWRIGHT_WATCHDOG_CLOCK']); "
                             "assert before['captureIdentity']==clock['identity']; "
                             "assert int(before['finishedNanoseconds'])<=int(clock['originNanoseconds']); "
                             f"pathlib.Path({str(observation)!r}).write_text(str(time.monotonic_ns())); "
                             "raise SystemExit(7)")
        self.assertEqual(result.returncode, 7, result.stderr)
        report = json.loads(self.report_path.read_text())
        self.assertEqual(report["captureContext"]["status"], "verified")
        self.assertEqual(report["exitCode"], 7)
        self.assertEqual(report["rootPollCpu"]["exitCode"], 7)
        after = json.loads(Path(report["captureContext"]["after"]["path"]).read_text())
        self.assertLessEqual(int(observation.read_text()), int(report["rootPollCpu"]["reapedNanoseconds"]))
        self.assertLessEqual(int(report["rootPollCpu"]["reapedNanoseconds"]), int(after["startedNanoseconds"]))
        self.assertEqual(report["remainingObservedProcesses"], [])
        verified = capture.verify_capture_context(self.report_path)
        self.assertEqual(verified["status"], "verified-prospective-capture-context")
        self.assertEqual(verified["watchdog"]["sha256"], capture.digest(self.report_path.read_bytes()))

    def test_retained_verifier_rejects_wrong_clock_identity_command_and_receipt(self):
        result = self.launch("pass")
        self.assertEqual(result.returncode, 0, result.stderr)
        original = self.report_path.read_bytes()
        for field in ["identity", "origin", "command", "receipt"]:
            report = json.loads(original)
            if field == "identity":
                report["clock"]["identity"] = "f" * 32
            elif field == "origin":
                report["clock"]["originNanoseconds"] = "1"
            elif field == "command":
                report["command"] = ["another command"]
            else:
                report["captureContext"]["before"]["sha256"] = "0" * 64
            self.report_path.write_bytes(capture.encode(report))
            with self.subTest(field=field), self.assertRaises(ValueError):
                capture.verify_capture_context(self.report_path)
        self.report_path.write_bytes(original)
        before_path = Path(json.loads(original)["captureContext"]["before"]["path"])
        before_path.write_text("tampered")
        with self.assertRaisesRegex(ValueError, "Snapshot bytes differ"):
            capture.verify_capture_context(self.report_path)

    def test_bad_before_prevents_child_launch(self):
        marker = self.directory / "child-ran"
        self.source.write_text("changed")
        result = self.launch(f"import pathlib; pathlib.Path({str(marker)!r}).touch()")
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertFalse(marker.exists())
        self.assertFalse(self.report_path.exists())
        before = json.loads(self.report_path.with_name(self.report_path.name + ".context-before.json").read_text())
        self.assertEqual(before["status"], "failed")

    def test_child_mutation_invalidates_capture_but_preserves_original_exit_and_cpu(self):
        result = self.launch(f"import pathlib; pathlib.Path({str(self.source)!r}).write_text('changed'); raise SystemExit(7)")
        self.assertEqual(result.returncode, 125, result.stderr)
        report = json.loads(self.report_path.read_text())
        self.assertEqual(report["captureContext"]["status"], "failed")
        self.assertEqual(report["exitCode"], 7)
        self.assertEqual(report["rootPollCpu"]["status"], "observed")
        self.assertEqual(report["rootPollCpu"]["exitCode"], 7)

    def test_after_write_failure_preserves_original_resource_report(self):
        path = self.directory / "resources.json.context-after.json"
        result = self.launch(f"import pathlib; pathlib.Path({str(path)!r}).write_text('occupied')")
        self.assertEqual(result.returncode, 125, result.stderr)
        report = json.loads(self.report_path.read_text())
        self.assertEqual(report["captureContext"]["status"], "failed")
        self.assertIn("FileExistsError", report["captureContext"]["error"])
        self.assertEqual(report["rootPollCpu"]["status"], "observed")
        self.assertEqual(path.read_text(), "occupied")


if __name__ == "__main__":
    unittest.main()
