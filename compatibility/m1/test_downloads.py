"""Real blocked filesystem work retains guardian ownership after caller cancellation."""

import os
import signal
import tempfile
import time
import unittest
from pathlib import Path
from test_driver_protocol import OwnedDriverCase

class DownloadLifecycleTests(OwnedDriverCase):
    def test_context_directory_is_created_by_first_download(self):
        directory = self.profile / 'flashwright-artifacts' / self.context
        self.assertFalse(directory.exists())
        _, source = self.completed_download()
        self.assertEqual(source.parent, directory)
        self.assertTrue(directory.is_dir())

    def completed_download(self):
        self.request('page.evaluate', self.evaluation("(() => { const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['x'.repeat(65536)]));a.download='fixture.txt';a.click(); })()"))
        for _ in range(100):
            downloads = [event['parameters'] for event in self.events if event['event']=='download']
            if downloads: break
            self.request('page.evaluate', self.evaluation('42'))
            time.sleep(.01)
        self.assertTrue(downloads)
        owner = {name: downloads[0][name] for name in ['context','download']}
        source = Path(self.request('download.path', owner))
        self.assertEqual(source.stat().st_size, 65536)
        return owner, source

    def blocked_copy(self, owner):
        destination = self.profile / 'blocked-copy'
        os.mkfifo(destination)
        first = self.command('download.saveAs', {**owner,'path':str(destination)}, timeout=100)
        self.send(first)
        reply = self.receive()
        self.assertEqual(reply.get('error',{}).get('code'), 'TimeoutError', reply)
        return destination

    def test_cancelled_copy_keeps_physical_lease_and_withdraws_queued_copy(self):
        owner, _ = self.completed_download()
        destination = self.blocked_copy(owner)
        with tempfile.TemporaryDirectory(prefix='download-queued-') as temporary:
            forbidden = Path(temporary)/'must-not-write'
            second = self.command('download.saveAs', {**owner,'path':str(forbidden)}, timeout=100)
            self.send(second)
            reply = self.receive()
            self.assertEqual(reply.get('error',{}).get('code'), 'TimeoutError', reply)
            os.kill(self.browser_process, signal.SIGKILL)
            time.sleep(.2)
            self.assertTrue(self.profile.exists(), 'guardian removed a live file job directory')
            with open(destination,'rb') as reader:
                content = reader.read()
            self.assertEqual(content, b'x'*65536)
            self.assert_resources_released()
            self.assertFalse(forbidden.exists(), 'cancelled queued copy ran later')

    def test_driver_death_releases_blocked_file_job_and_profile(self):
        owner, _ = self.completed_download()
        self.blocked_copy(owner)
        self.driver.kill()
        self.driver.wait(timeout=5)
        self.assert_resources_released()

    def test_context_close_waits_for_started_copy_and_preserves_completed_bytes(self):
        owner, source = self.completed_download()
        destination = self.blocked_copy(owner)
        closing = self.command('context.close', {'context': self.context})
        self.send(closing)
        for _ in range(100):
            self.send(self.command('download.failure', owner))
            reply = self.receive()
            self.assertNotEqual(reply['requestId'], closing['requestId'], 'context closed before physical copy settled')
            if reply.get('error', {}).get('code') == 'TargetClosedError':
                break
            time.sleep(.01)
        else:
            self.fail('context did not reject new download calls while closing')
        self.assertTrue(source.exists())
        with open(destination, 'rb') as reader:
            self.assertEqual(reader.read(), b'x' * 65536)
        reply = self.receive()
        self.assertEqual(reply['requestId'], closing['requestId'])
        self.assertEqual(reply['kind'], 'result', reply)
        self.assertFalse(source.parent.exists())


if __name__ == '__main__':
    unittest.main()
