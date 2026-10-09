"""Native setting validation and cancelled initialization keep resource ownership intact."""

import os
import signal
import threading

from test_driver_protocol import OwnedDriverCase


class ContextSettingsLifecycleTests(OwnedDriverCase):
    def test_malformed_wire_settings_reject_without_losing_existing_page(self):
        for name in ['ignoreHTTPSErrors', 'javaScriptEnabled']:
            for value in [None, 0, 1, 'true', {}, []]:
                with self.subTest(name=name, value=value):
                    command = self.command('browser.newContext', {'browser': self.browser, name: value})
                    self.send(command)
                    reply = self.receive()
                    self.assertEqual(reply['requestId'], command['requestId'])
                    self.assertEqual(reply['error']['code'], 'InvalidArgumentError', reply)
        self.assertEqual(self.request('page.evaluate', self.evaluation('42')), {'kind': 'number', 'value': 42})

    def test_cancelled_page_allocation_preserves_settings_for_the_next_page(self):
        context = self.request('browser.newContext', {
            'browser': self.browser, 'ignoreHTTPSErrors': True, 'javaScriptEnabled': False,
        })['identifier']
        os.kill(self.browser_process, signal.SIGSTOP)
        resume = threading.Timer(0.3, lambda: os.kill(self.browser_process, signal.SIGCONT))
        resume.start()
        try:
            command = self.command('context.newPage', {'context': context}, timeout=80)
            self.send(command)
            reply = self.receive()
            self.assertEqual(reply['requestId'], command['requestId'])
            self.assertEqual(reply['error']['code'], 'TimeoutError', reply)
        finally:
            resume.cancel()
            resume.join()
            os.kill(self.browser_process, signal.SIGCONT)
        replacement = self.request('context.newPage', {'context': context})['identifier']
        self.request('page.goto', {'page': replacement, 'url': 'data:text/html,<script>globalThis.applicationRan=true</script>', 'waitUntil': 'load'})
        self.assertEqual(self.request('page.evaluate', {**self.evaluation('globalThis.applicationRan'), 'page': replacement}), {'kind': 'undefined'})
        self.assertEqual(self.request('page.evaluate', self.evaluation('42')), {'kind': 'number', 'value': 42})
        self.request('context.close', {'context': context})
