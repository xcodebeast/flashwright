"""Keep source binding strict around the pinned reference's anonymous async frames."""

import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
import zipfile


specification = importlib.util.spec_from_file_location(
    'frame_trace_verifier', Path(__file__).with_name('verify-frame-locator-traces.py'))
verifier = importlib.util.module_from_spec(specification)
specification.loader.exec_module(verifier)


class SourceBindingTests(unittest.TestCase):
    source_path = '/fixture/compatibility/m2/frame-locators.mjs'
    source = b'first line\nsecond line\n'

    def review(self, engine='reference', frames=None, content=None, include_source=True):
        if frames is None:
            frames = [self.frame(), self.frame('async file://' + self.source_path)]
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            if include_source:
                name = 'resources/src@' + hashlib.sha1(self.source_path.encode()).hexdigest() + '.txt'
                archive.writestr(name, self.source if content is None else content)
        with zipfile.ZipFile(buffer) as archive:
            return verifier.source_evidence(archive, [{'callId': 'call@1', 'stack': frames}],
                                            {'fixtureSha256': verifier.sha256(self.source)}, engine)

    def frame(self, path=None, line=1):
        return {'file': path or self.source_path, 'line': line, 'column': 1}

    def test_reference_async_descriptor_binds_existing_source_and_records_difference(self):
        sources, observations = self.review()
        self.assertEqual(len(sources), 1)
        self.assertEqual(observations[0]['observedFile'], 'async file://' + self.source_path)
        self.assertEqual(observations[0]['archivedFile'], self.source_path)

    def test_ordinary_candidate_and_reference_sources_remain_required(self):
        for engine in ['reference', 'flashwright']:
            with self.subTest(engine=engine):
                self.assertEqual(self.review(engine, [self.frame()])[1], [])
                with self.assertRaisesRegex(ValueError, 'Missing source artifact'):
                    self.review(engine, [self.frame()], include_source=False)

    def test_candidate_cannot_inherit_reference_parser_exception(self):
        with self.assertRaisesRegex(ValueError, 'Missing source artifact'):
            self.review('flashwright')

    def test_descriptor_alone_cannot_establish_call_site(self):
        with self.assertRaisesRegex(ValueError, 'missing filesystem fixture call site'):
            self.review(frames=[self.frame('async file://' + self.source_path)])

    def test_descriptor_cannot_bind_another_file(self):
        with self.assertRaisesRegex(ValueError, 'no matching filesystem caller'):
            self.review(frames=[self.frame(), self.frame('async file:///other' + self.source_path)])

    def test_descriptor_coordinates_must_belong_to_archived_bytes(self):
        with self.assertRaisesRegex(ValueError, 'invalid source line'):
            self.review(frames=[self.frame(), self.frame('async file://' + self.source_path, line=3)])

    def test_changed_source_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'fixture source differs'):
            self.review(content=b'tampered\n')


if __name__ == '__main__':
    unittest.main()
