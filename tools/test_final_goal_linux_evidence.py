"""Synthetic retained-byte and framing checks; no native resource admission."""

import copy
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from tools import final_goal_linux_evidence as evidence


FIXTURE = json.loads((Path(__file__).resolve().parents[1]
                     / 'compatibility/evidence/fixtures/linux-cgroup-originals-synthetic.json').read_text())


class RetainedLinuxEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.header = copy.deepcopy(FIXTURE['header'])
        self.originals = {name: raw.encode() for name, raw in FIXTURE['originals'].items()}

    def stream(self):
        return evidence.inputs.encode(self.header) + b''.join(self.originals[name] for name in evidence.FILE_LIMITS)

    def change(self, name, update):
        value = evidence.inputs.decode(self.originals[name])
        update(value)
        self.originals[name] = evidence.inputs.encode(value)
        self.header['files'][name] = {'bytes': len(self.originals[name]), 'sha256': evidence.inputs.digest(self.originals[name])}

    def test_shared_derivation_retains_charges_nonzero_exit_and_adopted_waits(self):
        with patch('builtins.open', side_effect=AssertionError('Original paths must not be opened')):
            observed = evidence.read_stream(io.BytesIO(self.stream()))
        self.assertEqual(observed, FIXTURE['expected'])
        self.assertEqual(observed['cgroupCpu']['usageMicroseconds'], '12')
        self.assertEqual(observed['cgroupChargedPeakBytes'], '1024')
        self.assertEqual(observed['wrapperExitCode'], 7)
        self.assertTrue(observed['observedDrainedMembership'])
        self.assertFalse(observed['nativeCleanObservedTeardown'])
        self.assertFalse(observed['resourceAdmission'])
        self.assertEqual(observed['adoptedChildren'], 1)
        self.assertNotIn('originalFiles', observed)

    def test_all_sizes_and_hashes_checked_before_any_original_is_parsed(self):
        self.originals['native'] += b' '
        with patch.object(evidence.inputs, 'decode', side_effect=AssertionError('Early parse')):
            with self.assertRaisesRegex(ValueError, 'bytes differ'):
                evidence.reconstruct(self.header, self.originals)

    def test_invalid_inventory_rejects_without_member_read(self):
        for change in (
            lambda h: h['files'].pop('native'),
            lambda h: h['files'].update(extra=h['files']['native']),
            lambda h: h['files']['before'].update(bytes=evidence.FILE_LIMITS['before'] + 1),
            lambda h: h['files']['before'].update(bytes=True),
            lambda h: h['files']['before'].update(bytes=0),
            lambda h: h['files']['before'].update(sha256='wrong'),
            lambda h: h.update(accountingClass='atomic-wait4-original-owner'),
            lambda h: h.update(schemaVersion=True),
        ):
            header = copy.deepcopy(self.header)
            change(header)
            stream = io.BytesIO(evidence.inputs.encode(header))
            with patch.object(stream, 'read', side_effect=AssertionError('Member read before validation')):
                with self.assertRaises(ValueError):
                    evidence.read_stream(stream)

    def test_aggregate_limit_rejects_before_read(self):
        for name, maximum in evidence.FILE_LIMITS.items():
            self.header['files'][name]['bytes'] = maximum
        stream = io.BytesIO(evidence.inputs.encode(self.header))
        with patch.object(stream, 'read', side_effect=AssertionError('Member read before validation')):
            with self.assertRaisesRegex(ValueError, 'aggregate'):
                evidence.read_stream(stream)

    def test_original_member_hash_cannot_be_replaced_by_new_header_hash(self):
        self.change('native', lambda n: n['after'].update(memoryPeak='2048\n'))
        with self.assertRaisesRegex(ValueError, 'member receipt differs'):
            evidence.reconstruct(self.header, self.originals)

    def test_unknown_missing_original_and_wrong_byte_type(self):
        for name, value in [('extra', b'{}'), ('native', '{}')]:
            originals = {**self.originals, name: value}
            with self.assertRaises(ValueError):
                evidence.reconstruct(self.header, originals)
        self.originals.pop('native')
        with self.assertRaises(ValueError):
            evidence.reconstruct(self.header, self.originals)

    def test_original_path_membership_is_checked_without_dereference(self):
        for path in ('/elsewhere/before.json', '/synthetic/original-linux-capture/other.json',
                     '/synthetic/../before.json', '/synthetic//before.json', 'before.json', '/synthetic/\\before.json'):
            self.change('capture', lambda r: r['before'].update(path=path))
            with self.assertRaises(ValueError):
                evidence.reconstruct(self.header, self.originals)

    def test_changed_summary_still_rejects_after_all_member_hashes_match(self):
        self.change('capture', lambda r: r['native'].update(adoptedChildren=2))
        with self.assertRaisesRegex(ValueError, 'summary differs'):
            evidence.reconstruct(self.header, self.originals)

    def test_bad_original_json_duplicate_keys_and_nonfinite_values(self):
        for raw in (b'{} invalid', b'{"same":1,"same":2}', b'{"value":NaN}', b'{"value":Infinity}', b'\xff', b'[]'):
            self.originals['capture'] = raw
            self.header['files']['capture'] = {'bytes': len(raw), 'sha256': evidence.inputs.digest(raw)}
            with self.assertRaises(ValueError):
                evidence.reconstruct(self.header, self.originals)

    def test_truncated_trailing_and_header_framing_reject(self):
        raw = self.stream()
        for invalid in (raw[:-1], raw + b'x', b' ' * (evidence.MAXIMUM_HEADER_BYTES + 1), b'{}', b'{}\n',
                        b'{"schemaVersion":1,"schemaVersion":1}\n'):
            with self.assertRaises(ValueError):
                evidence.read_stream(io.BytesIO(invalid))


if __name__ == '__main__':
    unittest.main()
