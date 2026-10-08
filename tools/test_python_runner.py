"""A failed case must leave its traceback before a subsequent test can hang."""

from pathlib import Path
import os
import select
import subprocess
import sys
import tempfile
import time
import unittest


class ImmediateFailureTests(unittest.TestCase):
    def test_traceback_is_available_while_the_next_case_is_still_running(self):
        with tempfile.TemporaryDirectory(prefix="flashwright-python-diagnostic-") as directory:
            Path(directory, "test_diagnostic.py").write_text("""import time
import unittest
class Cases(unittest.TestCase):
    def test_a_failure(self):
        self.fail('retained diagnosis marker')
    def test_b_wait(self):
        print('later case started', flush=True)
        time.sleep(30)
""")
            worker = subprocess.Popen([sys.executable, str(Path(__file__).with_name("run-python-tests.py")), "--start-directory", directory], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            output = bytearray()
            try:
                deadline = time.monotonic() + 5
                while b"later case started" not in output and time.monotonic() < deadline:
                    ready, _, _ = select.select([worker.stdout], [], [], max(0, deadline - time.monotonic()))
                    if not ready:
                        break
                    chunk = os.read(worker.stdout.fileno(), 8192)
                    if not chunk:
                        break
                    output.extend(chunk)
                self.assertIsNone(worker.poll())
                self.assertIn(b"later case started", output)
                self.assertIn(b"Traceback (most recent call last)", output)
                self.assertIn(b"AssertionError: retained diagnosis marker", output)
            finally:
                if worker.poll() is None:
                    worker.terminate()
                worker.wait(timeout=5)
                worker.stdout.close()
