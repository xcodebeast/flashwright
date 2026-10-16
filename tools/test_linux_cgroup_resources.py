"""Synthetic accounting/retained-byte controls; never physical capture evidence."""

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from tools import linux_cgroup_capture as capture
from tools import linux_cgroup_resources as resources
from tools import test_linux_cgroup_capture as fixtures


class ResourceObservationTests(unittest.TestCase):
    def setUp(self):
        workbench = Path(__file__).resolve().parents[1] / 'workbench'
        self.temporary = tempfile.TemporaryDirectory(prefix='linux-resource-tests-', dir=workbench)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        fixture = fixtures.NativeJoinTests()
        fixture.setUp()
        self.native = copy.deepcopy(fixture.native)
        self.command = ['/synthetic/bun', '/synthetic/test.mjs']
        self.wrapper = [str(capture.WRAPPER), *capture.WRAPPER_FLAGS, *self.command]
        self.native['commandBytes'] = self.wrapper
        host = {'configuration': {'platform': 'linux', 'architecture': 'x64'}, 'bootIdentitySha256': 'b' * 64}
        host['identitySha256'] = capture.inputs.digest(capture.inputs.encode(host))
        host['namespace'] = host['identitySha256'] + ':' + host['bootIdentitySha256']
        self.before = {
            'schemaVersion': 1, 'status': 'verified', 'phase': 'before', 'captureIdentity': 'a' * 32,
            'startedNanoseconds': '10', 'finishedNanoseconds': '100', 'workloadCommand': self.command,
            'host': host, 'inputs': {'executables': {'runtime': {'resolvedPath': self.command[0]}},
                                    'files': [{'path': self.command[0], 'resolvedPath': self.command[0]}]},
            'tools': {name: {'path': '/synthetic/' + name} for name in
                      ('coordinator', 'inputReader', 'policyReader', 'interpreter', 'collector', 'wrapper')},
            'policy': fixtures.synthetic_policy(), 'interpreterVersion': 'synthetic',
            'workingDirectory': '/synthetic', 'supervisorProcess': 99,
        }
        self.before['tools']['wrapper']['path'] = str(capture.WRAPPER)
        self.after = copy.deepcopy(self.before)
        self.after.update(phase='after', startedNanoseconds='900', finishedNanoseconds='950')
        self.report = {
            'schemaVersion': 1, 'status': 'captured', 'captureClass': 'diagnostic-linux-cgroup-capture',
            'resourceAdmission': False, 'performanceAccepted': False, 'captureIdentity': 'a' * 32,
            'workloadCommand': self.command, 'wrapperCommand': self.wrapper, 'collectorProcess': 123,
            'originalCollectorWait': {'method': 'atomic-wait4-collector', 'process': 123, 'status': 0, 'exitCode': 0,
                                      'startedNanoseconds': '830', 'finishedNanoseconds': '850',
                                      'userSeconds': 50, 'systemSeconds': 20, 'inclusiveMaximumRssKiB': 1024},
            'timeoutMilliseconds': 1000, 'outerCleanupRequired': False, 'collectorSignals': [],
            'nativeReceipt': {'path': str(self.directory / 'native.json')},
        }
        self.report['collectorCommand'] = ['/synthetic/collector', '/synthetic', str(self.directory / 'native.json'),
                                           'a' * 32, '1000', *self.wrapper]
        self.refresh_native_summary()

    def refresh_native_summary(self):
        self.report['native'] = capture.native_summary(self.native, 'a' * 32, self.wrapper,
                                                       {'device': '4', 'inode': '8'}, self.before, self.after, 123)

    def observe(self):
        return resources.derive_observations(self.report, self.before, self.after, self.native)

    def adopt(self):
        self.native['cleanObservedTeardown'] = False
        self.native['adoptedChildren'] = 1
        self.native['adoptedWaits'] = [{**self.native['originalWait'], 'process': 789,
                                       'startedNanoseconds': '720', 'finishedNanoseconds': '730'}]
        self.report['originalCollectorWait'].update(status=1 << 8, exitCode=1)
        self.refresh_native_summary()

    def test_kernel_charges_are_not_summed_with_inclusive_wait_usage(self):
        observed = self.observe()
        self.assertEqual(observed['cgroupCpu']['usageMicroseconds'], '12')
        self.assertEqual(observed['originalCollectorWait']['userSeconds'], 50)
        self.assertEqual(observed['commandInterval']['elapsedNanoseconds'], '620')
        self.assertEqual(observed['cgroupChargedPeakBytes'], '1024')
        self.assertNotIn('sampledConcurrentBytes', observed)
        self.assertFalse(observed['resourceAdmission'])
        self.assertFalse(observed['performanceAccepted'])

    def test_exited_adopted_descendant_can_be_drained_without_rewriting_native_clean_flag(self):
        self.adopt()
        observed = self.observe()
        self.assertTrue(observed['observedDrainedMembership'])
        self.assertFalse(observed['nativeCleanObservedTeardown'])
        self.assertEqual(observed['adoptedChildren'], 1)
        self.assertEqual(observed['adoptedWaits'], self.native['adoptedWaits'])

    def test_nonzero_workload_is_not_promoted_to_success(self):
        observed = self.observe()
        self.assertTrue(observed['observedDrainedMembership'])
        self.assertEqual(observed['wrapperExitCode'], 7)

    def test_timeout_live_survivor_and_forced_cleanup_cannot_pass_drain(self):
        for change, phrase in [({'timedOut': True, 'groupKilled': True}, 'timed out'),
                               ({'survivorsAfterOwner': 1, 'groupKilled': True}, 'Membership remained'),
                               ({'interruptedSignal': 15, 'groupKilled': True}, 'interrupted')]:
            with self.subTest(change=change):
                original = copy.deepcopy(self.native)
                self.native.update(change, cleanObservedTeardown=False)
                self.report['originalCollectorWait'].update(status=1 << 8, exitCode=1)
                self.refresh_native_summary()
                observed = self.observe()
                self.assertFalse(observed['observedDrainedMembership'])
                self.assertTrue(any(phrase in reason for reason in observed['drainRejectionReasons']))
                self.native = original

    def test_missing_atomic_collector_receipt_is_rejected(self):
        self.report['originalCollectorWait']['method'] = 'subprocess-original-child-wait'
        with self.assertRaisesRegex(ValueError, 'atomic'):
            self.observe()

    def test_workload_clock_is_joined_to_the_original_capture_and_launch(self):
        self.report['workloadClock'] = {'schemaVersion': 1, 'type': 'monotonic',
                                        'implementation': 'clock_gettime(CLOCK_MONOTONIC)',
                                        'identity': 'a' * 32, 'originNanoseconds': '150', 'resolutionSeconds': 1e-9}
        self.assertEqual(self.observe()['workloadClock'], self.report['workloadClock'])
        self.report['workloadClock']['originNanoseconds'] = '250'
        with self.assertRaisesRegex(ValueError, 'clock bridge'):
            self.observe()

    def test_rejected_capture_and_changed_policy_are_rejected(self):
        self.report['status'] = 'rejected'
        with self.assertRaisesRegex(ValueError, 'Rejected capture'):
            self.observe()
        self.report['status'] = 'captured'
        self.after['policy']['ancestorsLeafFirst'][0]['files']['cpu.max']['raw'] = '1000 100000\n'
        with self.assertRaisesRegex(ValueError, 'policy'):
            self.observe()

    def test_wrong_native_summary_or_collector_command_rejects(self):
        self.report['native']['adoptedChildren'] = 2
        with self.assertRaisesRegex(ValueError, 'summary'):
            self.observe()
        self.refresh_native_summary()
        self.report['collectorCommand'][-1] = '/wrong/test.mjs'
        with self.assertRaisesRegex(ValueError, 'invocation'):
            self.observe()

    def test_out_of_order_adopted_waits_reject(self):
        self.adopt()
        self.native['adoptedWaits'][0].update(startedNanoseconds='650', finishedNanoseconds='660')
        self.refresh_native_summary()
        with self.assertRaisesRegex(ValueError, 'consuming order'):
            self.observe()

    def save_bundle(self):
        for field, record, name in [('before', self.before, 'before.json'), ('after', self.after, 'after.json'),
                                    ('nativeReceipt', self.native, 'native.json')]:
            contents = json.dumps(record).encode()
            path = self.directory / name
            path.write_bytes(contents)
            self.report[field] = {'path': str(path), 'bytes': len(contents), 'sha256': hashlib.sha256(contents).hexdigest()}
        report_path = self.directory / 'capture.json'
        report_path.write_text(json.dumps(self.report))
        return report_path

    def test_original_file_hashes_are_checked_before_deriving_metrics(self):
        report_path = self.save_bundle()
        observed = resources.read_resources(report_path)
        self.assertEqual(observed['cgroupCpu']['usageMicroseconds'], '12')
        native_path = self.directory / 'native.json'
        native_path.write_text(native_path.read_text().replace('usage_usec 12', 'usage_usec 99'))
        with self.assertRaisesRegex(ValueError, 'bytes differ'):
            resources.read_resources(report_path)

    def test_outside_or_symlink_receipts_and_oversize_declarations_reject(self):
        report_path = self.save_bundle()
        self.report['before']['path'] = str(self.directory.parent / 'outside.json')
        report_path.write_text(json.dumps(self.report))
        with self.assertRaisesRegex(ValueError, 'member path'):
            resources.read_resources(report_path)
        report_path = self.save_bundle()
        self.report['before']['bytes'] = capture.inputs.MAXIMUM_SNAPSHOT_BYTES + 1
        report_path.write_text(json.dumps(self.report))
        with self.assertRaisesRegex(ValueError, 'byte count'):
            resources.read_resources(report_path)
        report_path = self.save_bundle()
        original = self.directory / 'before.json'
        saved = self.directory / 'saved-before.json'
        original.rename(saved)
        original.symlink_to(saved)
        with self.assertRaisesRegex(ValueError, 'non-symlink'):
            resources.read_resources(report_path)


if __name__ == '__main__':
    unittest.main()
