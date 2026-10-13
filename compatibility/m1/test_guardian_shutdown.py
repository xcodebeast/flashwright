"""Exercise the actual guardian executable with deterministic delayed child teardown."""

import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest


class GuardianShutdownTests(unittest.TestCase):
    def setUp(self):
        self.commands, browser_commands = socket.socketpair()
        self.events, browser_events = socket.socketpair()
        self.liveness, guardian_liveness = socket.socketpair()
        sockets = [self.commands, browser_commands, self.events, browser_events,
                   self.liveness, guardian_liveness]
        descriptors = [stream.fileno() for stream in sockets]
        inherited = [browser_commands.fileno(), browser_events.fileno(), guardian_liveness.fileno()]

        def map_descriptors():
            copies = [os.dup(descriptor) for descriptor in inherited]
            for destination, source in zip([3, 4, 5], copies):
                os.dup2(source, destination)
            for descriptor in set(descriptors + copies) - {3, 4, 5}:
                os.close(descriptor)

        self.diagnostics = tempfile.TemporaryFile()
        environment = dict(os.environ)
        environment.pop('FLASHWRIGHT_GUARDIAN_HAS_NODE_PIPE', None)
        self.guardian = subprocess.Popen([
            os.environ['FLASHWRIGHT_DRIVER_PATH'], '--browser-guardian', sys.executable,
            str(Path(__file__).with_name('guardian-shutdown-browser.py')),
            '--user-data-dir=__FLASHWRIGHT_PROFILE__',
        ], pass_fds=tuple(set(descriptors)), preexec_fn=map_descriptors,
            stdout=subprocess.DEVNULL, stderr=self.diagnostics, env=environment)
        browser_commands.close()
        browser_events.close()
        guardian_liveness.close()
        self.addCleanup(self.cleanup)
        self.liveness.settimeout(8)
        self.events.settimeout(8)
        length = struct.unpack('<I', self.receive_exact(4))[0]
        self.profile = Path(os.fsdecode(self.receive_exact(length))).parent
        self.event_reader = self.events.makefile('rb')
        self.browser = json.loads(self.event_reader.readline())['process']

    def receive_exact(self, count):
        result = bytearray()
        while len(result) < count:
            received = self.liveness.recv(count - len(result))
            self.assertTrue(received, 'guardian closed before sending completion')
            result.extend(received)
        return bytes(result)

    def cleanup(self):
        self.liveness.close()
        self.commands.close()
        if hasattr(self, 'event_reader'):
            self.event_reader.close()
        self.events.close()
        try:
            self.assertEqual(self.guardian.wait(timeout=8), 0)
            if hasattr(self, 'profile'):
                self.assertFalse(self.profile.exists())
        finally:
            self.diagnostics.close()

    def assert_browser_reaped(self):
        with self.assertRaises(ProcessLookupError):
            os.kill(self.browser, 0)
        self.assertIsNone(self.guardian.poll())
        self.assertTrue(self.profile.exists(), 'liveness still owns profile')

    def test_acknowledgment_waits_for_native_cleanup_and_reap(self):
        self.liveness.sendall(b'C')
        self.commands.sendall(b'C')
        self.assertEqual(self.event_reader.readline(), b'acknowledged\n')
        started = time.monotonic()
        self.assertEqual(self.receive_exact(1), b'R')
        self.assertGreaterEqual(time.monotonic() - started, 0.2)
        self.assertEqual(self.event_reader.readline(), b'cleanup-complete\n')
        self.assert_browser_reaped()

    def test_already_exited_browser_can_acknowledge_close(self):
        self.commands.sendall(b'C')
        self.assertEqual(self.event_reader.readline(), b'acknowledged\n')
        self.assertEqual(self.event_reader.readline(), b'cleanup-complete\n')
        self.assertEqual(self.event_reader.read(), b'')
        self.liveness.sendall(b'C')
        self.assertEqual(self.receive_exact(1), b'R')
        self.assert_browser_reaped()

    def test_stopped_browser_has_independent_nonextendable_deadline(self):
        os.kill(self.browser, signal.SIGSTOP)
        started = time.monotonic()
        self.liveness.sendall(b'C')
        time.sleep(2)
        self.liveness.sendall(b'C' * 128)
        self.assertEqual(self.receive_exact(1), b'K')
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 4.8)
        self.assertLess(elapsed, 6.5)
        self.assert_browser_reaped()

    def test_driver_death_overrides_grace_immediately(self):
        os.kill(self.browser, signal.SIGSTOP)
        self.liveness.sendall(b'C')
        started = time.monotonic()
        self.liveness.close()
        self.assertEqual(self.guardian.wait(timeout=2), 0)
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(self.profile.exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(self.browser, 0)


if __name__ == '__main__':
    unittest.main()
