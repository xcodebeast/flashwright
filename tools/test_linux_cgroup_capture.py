"""Capture integration controls; fabricated native records are labelled synthetic."""

import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from tools import linux_cgroup_capture as capture
from tools.test_final_goal_capture_context import CaptureFixture


def synthetic_policy():
    return {'status': 'diagnostic-snapshot', 'resourceAdmission': False, 'leaf': '/synthetic',
            'mount': {'id': 1}, 'mountinfoSha256': 'a' * 64, 'namespaceIds': {'mnt': 'synthetic'},
            'ancestorsLeafFirst': [{'path': '/synthetic', 'hierarchyPath': '/leaf', 'mountId': 1,
                                   'directoryIdentity': {'device': '4', 'inode': '8', 'mode': 16877},
                                   'files': {'cpu.max': {'status': 'observed', 'raw': 'max 100000\n',
                                                        'mountId': 1, 'identity': {'inode': '10'}}}}]}


class OriginalCollectorWaitTests(unittest.TestCase):
    def test_atomic_wait_preserves_actual_nonzero_terminal_outcome(self):
        process = subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)'])
        receipt, signals = capture.wait_collector(process, 5)
        self.assertEqual(receipt['method'], 'atomic-wait4-collector')
        self.assertEqual(receipt['exitCode'], 7)
        self.assertEqual(os.waitstatus_to_exitcode(receipt['status']), 7)
        self.assertEqual(process.returncode, 7)
        self.assertEqual(signals, [])
        self.assertGreaterEqual(receipt['userSeconds'], 0)

    def test_already_consumed_wait_cannot_become_zero(self):
        process = subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)'])
        self.assertEqual(process.wait(timeout=5), 7)
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            capture.wait_collector(process, 5)

    def test_forced_cleanup_does_not_call_popen_poll_or_lose_original_wait(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        with patch.object(process, 'poll', side_effect=AssertionError('Must not consume wait through poll')):
            receipt, signals = capture.wait_collector(process, 0)
        self.assertEqual(receipt['exitCode'], -15)
        self.assertEqual([entry['signal'] for entry in signals], [15])


class BoundaryTests(CaptureFixture):
    def run_boundary(self, name, before=None):
        with patch.object(capture.policy, 'read_policy', return_value=synthetic_policy()):
            return capture.boundary(self.context, '/synthetic', self.runtime, self.directory / name, before)

    def test_actual_input_host_tool_bindings_with_synthetic_policy(self):
        receipt, before = self.run_boundary('before.json')
        _, after = self.run_boundary('after.json', before)
        self.assertEqual(before['status'], 'verified')
        self.assertEqual(after['status'], 'verified')
        self.assertEqual(before['tools']['coordinator']['path'], str(Path(capture.__file__).resolve()))
        self.assertEqual(receipt['sha256'], self.receipt(self.directory / 'before.json')['sha256'])

    def test_changed_input_is_retained_as_rejected_after_snapshot(self):
        _, before = self.run_boundary('before.json')
        self.source.write_text('changed by synthetic workload')
        _, after = self.run_boundary('after.json', before)
        self.assertEqual(after['status'], 'failed')
        self.assertIn('differs', after['error']['message'])
        self.assertTrue((self.directory / 'after.json').exists())

    def test_changed_policy_is_rejected_without_defaulting_missing(self):
        _, before = self.run_boundary('before.json')
        changed = synthetic_policy()
        changed['ancestorsLeafFirst'][0]['files']['cpu.max'] = {'status': 'missing', 'raw': None, 'errno': 2}
        with patch.object(capture.policy, 'read_policy', return_value=changed):
            _, after = capture.boundary(self.context, '/synthetic', self.runtime, self.directory / 'after.json', before)
        self.assertEqual(after['status'], 'failed')
        self.assertIn('policy changed', after['error']['message'])

    def test_before_rejection_does_not_launch_collector(self):
        self.source.write_text('wrong hash')
        output = self.directory / 'rejected'
        with patch.object(capture.subprocess, 'Popen') as launch:
            report = capture.capture('/synthetic', self.runtime, self.request_path, output, 500,
                                     [str(self.runtime), '-c', 'pass'])
        launch.assert_not_called()
        self.assertEqual(report['status'], 'rejected')
        self.assertIsNone(report['originalCollectorWait'])
        self.assertFalse(report['outerCleanupRequired'])
        self.assertTrue((output / 'capture.json').exists())

    def test_occupied_output_and_invalid_timeout_never_launch(self):
        for timeout in (0, 49, 3600001, True):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                capture.capture('/synthetic', self.runtime, self.request_path, self.directory / 'unused',
                                timeout, [str(self.runtime)])
        with self.assertRaises(FileExistsError):
            capture.capture('/synthetic', self.runtime, self.request_path, self.directory, 500, [str(self.runtime)])

    def test_declared_workload_outputs_must_be_fresh_and_inside_workbench(self):
        for paths in ([str(self.source)], ['/etc/passwd'], [str(self.directory / 'future')] * 2):
            with self.subTest(paths=paths), patch.object(capture.subprocess, 'Popen') as launch, self.assertRaises(ValueError):
                capture.capture('/synthetic', self.runtime, self.request_path, self.directory / 'outputs',
                                500, [str(self.runtime)], paths)
            launch.assert_not_called()

    def test_failed_after_publication_is_not_retried_or_allowed_to_hide_original_failure(self):
        calls = []

        def boundary(_context, _leaf, _collector, destination, before=None):
            calls.append(destination.name)
            if before is None:
                return {'status': 'verified'}, {'status': 'verified', 'policy': synthetic_policy()}
            destination.write_text('partial original after snapshot')
            raise OSError('synthetic exclusive after publication failed')

        output = self.directory / 'publication-failure'
        with patch.object(capture, 'boundary', side_effect=boundary), \
                patch.object(capture.subprocess, 'Popen', return_value=SimpleNamespace(pid=123)), \
                patch.object(capture, 'wait_collector', return_value=({'process': 123, 'exitCode': 0}, [])):
            report = capture.capture('/synthetic', self.runtime, self.request_path, output, 500, [str(self.runtime)])
        self.assertEqual(calls, ['before.json', 'after.json'])
        self.assertEqual(report['status'], 'rejected')
        self.assertEqual(report['error']['message'], 'synthetic exclusive after publication failed')
        self.assertEqual((output / 'after.json').read_text(), 'partial original after snapshot')
        self.assertTrue((output / 'capture.json').exists())


class NativeJoinTests(unittest.TestCase):
    def setUp(self):
        self.command = ['/usr/bin/bwrap', '--', '/runtime', 'unicode-λ']
        self.before = {'finishedNanoseconds': '100'}
        self.after = {'startedNanoseconds': '900'}
        self.leaf = {'device': '4', 'inode': '8'}
        self.native = {'schemaVersion': 1, 'captureClass': 'experimental-linux-cgroup-command',
                       'resourceAdmission': False, 'identity': 'a' * 32,
                       'clock': 'clock_gettime(CLOCK_MONOTONIC)', 'collectorProcess': 123,
                       'ownerProcess': 456, 'commandBytes': [os.fsencode(arg).decode('latin1') for arg in self.command],
                       'commandEncoding': 'Each original argv byte is represented by its equal-valued Unicode codepoint',
                       'cgroupDevice': '4', 'cgroupInode': '8', 'cloneStartedNanoseconds': '200',
                       'cloneFinishedNanoseconds': '210',
                       'before': {'startedNanoseconds': '120', 'finishedNanoseconds': '140',
                                  'cpuStat': 'usage_usec 0\nuser_usec 0\nsystem_usec 0\n',
                                  'memoryPeak': '0\n', 'events': 'populated 0\n', 'processes': '', 'type': 'domain\n'},
                       'after': {'startedNanoseconds': '800', 'finishedNanoseconds': '820',
                                 'cpuStat': 'usage_usec 12\nuser_usec 6\nsystem_usec 6\n',
                                 'memoryPeak': '1024\n', 'events': 'populated 0\n', 'processes': '', 'type': 'domain\n'},
                       'originalWait': {'method': 'atomic-wait4-original-owner', 'process': 456,
                                        'exitCode': 7, 'status': 7 << 8, 'userMicroseconds': 1, 'systemMicroseconds': 2,
                                        'startedNanoseconds': '700', 'finishedNanoseconds': '710'},
                       'adoptedChildren': 0, 'adoptedWaits': [], 'cleanObservedTeardown': True,
                       'timedOut': False, 'groupKilled': False, 'noRemainingChildren': True,
                       'identityUnchanged': True, 'afterValid': True, 'finalLeaf': True,
                       'cleanupError': False, 'launchErrno': 0, 'interruptedSignal': 0, 'survivorsAfterOwner': 0}

    def join(self):
        return capture.native_summary(self.native, 'a' * 32, self.command, self.leaf,
                                      self.before, self.after, 123)

    def test_nonzero_workload_is_retained_without_resource_admission(self):
        result = self.join()
        self.assertEqual(result['originalWrapperWait']['exitCode'], 7)
        self.assertFalse(result['resourceAdmission'])

    def test_adoption_and_timeout_stay_rejected_cleanup_outcomes(self):
        self.native.update(adoptedChildren=1, adoptedWaits=[{**self.native['originalWait'], 'process': 789}],
                           cleanObservedTeardown=False, timedOut=True, groupKilled=True)
        result = self.join()
        self.assertFalse(result['cleanObservedTeardown'])
        self.assertTrue(result['timedOut'])
        self.assertTrue(result['groupKilled'])
        self.assertEqual(result['adoptedChildren'], 1)

    def test_native_identity_command_and_leaf_corruption_reject(self):
        for key, value in [('identity', 'b' * 32), ('collectorProcess', 999), ('cgroupInode', '9'),
                           ('commandBytes', self.command), ('resourceAdmission', True)]:
            with self.subTest(key=key):
                original = self.native[key]
                self.native[key] = value
                with self.assertRaises(ValueError):
                    self.join()
                self.native[key] = original

    def test_native_clock_and_reap_corruption_reject(self):
        cases = [('cloneStartedNanoseconds', '90'), ('cloneFinishedNanoseconds', '999'),
                 ('originalWait', {**self.native['originalWait'], 'process': 999}),
                 ('after', {'startedNanoseconds': '800', 'finishedNanoseconds': '950'})]
        for key, value in cases:
            with self.subTest(key=key):
                original = self.native[key]
                self.native[key] = value
                with self.assertRaises(ValueError):
                    self.join()
                self.native[key] = original

    def test_incomplete_adopted_wait_inventory_rejects(self):
        self.native['adoptedChildren'] = 1
        with self.assertRaisesRegex(ValueError, 'inventory'):
            self.join()

    def test_forged_clean_teardown_and_duplicate_counters_reject(self):
        self.native['timedOut'] = True
        with self.assertRaisesRegex(ValueError, 'predicate'):
            self.join()
        self.native['timedOut'] = False
        self.native['after']['cpuStat'] += 'usage_usec 12\n'
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.join()

    def test_nonzero_initial_usage_and_nonterminal_wait_reject(self):
        self.native['before']['cpuStat'] = 'usage_usec 1\nuser_usec 1\nsystem_usec 0\n'
        with self.assertRaisesRegex(ValueError, 'unused'):
            self.join()
        self.native['before']['cpuStat'] = 'usage_usec 0\nuser_usec 0\nsystem_usec 0\n'
        self.native['originalWait']['status'] = 0x137f
        with self.assertRaisesRegex(ValueError, 'not terminal'):
            self.join()


if __name__ == '__main__':
    unittest.main()
