"""Public objects must observe independently lost browser and renderer processes."""

import os
import signal

from test_lifecycle import OwnedBrowserCase, read_message


class PublicLifecycleTests(OwnedBrowserCase):
    worker_script = "compatibility/m1/public-lifecycle-worker.mjs"

    def test_browser_crash_updates_public_objects(self):
        os.kill(self.browser_process, signal.SIGKILL)
        self.assertTrue(read_message(self.worker, 5)["disconnected"])
        self.assert_owned_processes_exit()

    def test_renderer_crash_updates_page_and_preserves_browser(self):
        self.send("crash")
        self.assertTrue(read_message(self.worker, 8)["crashRecovered"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_locator_deadline_suppresses_late_renderer_mutation(self):
        self.send("blocked-locator")
        self.assertTrue(read_message(self.worker, 8)["locatorRecovered"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_pointer_deadline_releases_button_and_modifiers(self):
        self.send("cancel-pointer")
        self.assertTrue(read_message(self.worker, 8)["pointerRecovered"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_blocked_input_handler_closes_page_without_replaying_input(self):
        self.send("blocked-pointer")
        self.assertTrue(read_message(self.worker, 15)["blockedPointerRecovered"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_keyboard_deadline_releases_keys_and_serializes_pointer_input(self):
        self.send("cancel-keyboard")
        self.assertTrue(read_message(self.worker, 8)["keyboardRecovered"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_blocked_keyboard_handler_closes_only_its_owned_page(self):
        self.send("blocked-keyboard")
        self.assertTrue(read_message(self.worker, 8)["blockedKeyboardRecovered"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_blocked_renderer_cannot_delay_assertion_deadline(self):
        self.send("blocked-assertion")
        self.assertTrue(read_message(self.worker, 8)["assertionRecovered"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_context_close_cancels_unbounded_assertion(self):
        self.send("close-assertion")
        self.assertTrue(read_message(self.worker, 8)["assertionDisposed"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()

    def test_context_close_cancels_page_keyboard_and_preserves_browser(self):
        self.send("close-page-keyboard")
        self.assertTrue(read_message(self.worker, 8)["pageKeyboardDisposed"])
        self.send("close")
        self.assertEqual(self.worker.wait(timeout=5), 0)
        self.assert_owned_processes_exit()
