"""Native init-script cancellation, owner closure, and retained-registration bounds."""

import json
import os
import signal
import threading
import time

from test_driver_protocol import OwnedDriverCase


def script_source(source):
    return {"sourceJson": json.dumps("(() => {\n" + source + "\n})();")}


class InitScriptLifecycleTests(OwnedDriverCase):
    def test_context_close_preserves_page_creation_error_and_sibling(self):
        for iteration in range(6):
            with self.subTest(iteration=iteration):
                context = self.request("browser.newContext", {"browser": self.browser})["identifier"]
                creation = self.command("context.newPage", {"context": context}, timeout=None)
                closure = self.command("context.close", {"context": context}, timeout=None)
                self.send(creation)
                self.send(closure)
                replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive()]}
                self.assertEqual(replies[closure["requestId"]]["kind"], "result")
                created = replies[creation["requestId"]]
                if created["kind"] == "error":
                    self.assertEqual(created["error"]["code"], "TargetClosedError", created)
                else:
                    # Publication can win the race, but closure must retire that exact page.
                    self.send(self.command("page.evaluate", {**self.evaluation("42"), "page": created["value"]["identifier"]}))
                    rejected = self.receive()
                    self.assertEqual(rejected["error"]["code"], "TargetClosedError", rejected)
                self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_late_native_registration_is_removed_before_the_timeout_reply(self):
        for method, owner in [("page.addInitScript", {"page": self.page}), ("context.addInitScript", {"context": self.context})]:
            with self.subTest(method=method):
                os.kill(self.browser_process, signal.SIGSTOP)
                resume = threading.Timer(0.3, lambda: os.kill(self.browser_process, signal.SIGCONT))
                resume.start()
                try:
                    self.send(self.command(method, {**owner, **script_source("globalThis.expiredScript = true")}, timeout=100))
                    reply = self.receive()
                    self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
                    self.assertEqual(reply["error"]["cleanup"], "initScriptDisposed", reply)
                finally:
                    resume.cancel()
                    resume.join()
                    os.kill(self.browser_process, signal.SIGCONT)
                self.request("page.goto", {"page": self.page, "url": "data:text/html,late-registration", "waitUntil": "load"})
                self.assertEqual(self.request("page.evaluate", self.evaluation("globalThis.expiredScript")), {"kind": "undefined"})

    def test_blocked_initial_script_times_out_without_losing_another_context(self):
        sibling_context = self.request("browser.newContext", {"browser": self.browser})["identifier"]
        sibling = self.request("context.newPage", {"context": sibling_context})["identifier"]
        registration = self.request("context.addInitScript", {"context": self.context, **script_source("while (true) {}")})
        pending = self.command("context.newPage", {"context": self.context}, timeout=100)
        self.send(pending)
        reply = self.receive()
        self.assertEqual(reply["requestId"], pending["requestId"])
        self.assertEqual(reply["error"]["code"], "TimeoutError", reply)
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": sibling}), {"kind": "number", "value": 42})
        self.request("initScript.dispose", {"script": registration["identifier"]})
        replacement = self.request("context.newPage", {"context": self.context})["identifier"]
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("42"), "page": replacement}), {"kind": "number", "value": 42})

    def test_context_close_releases_blocked_initialization_and_registration_waiter(self):
        self.request("context.addInitScript", {"context": self.context, **script_source("while (true) {}")})
        creation = self.command("context.newPage", {"context": self.context})
        self.send(creation)
        time.sleep(0.1)
        registration = self.command("context.addInitScript", {"context": self.context, **script_source("globalThis.waiterMustNotSurvive = true")})
        self.send(registration)
        closure = self.command("context.close", {"context": self.context})
        self.send(closure)
        replies = {reply["requestId"]: reply for reply in [self.receive(), self.receive(), self.receive()]}
        self.assertEqual(replies[closure["requestId"]]["kind"], "result")
        for command in [creation, registration]:
            self.assertEqual(replies[command["requestId"]]["kind"], "error")
        fresh_context = self.request("browser.newContext", {"browser": self.browser})["identifier"]
        fresh_page = self.request("context.newPage", {"context": fresh_context})["identifier"]
        self.assertEqual(self.request("page.evaluate", {**self.evaluation("globalThis.waiterMustNotSurvive"), "page": fresh_page}), {"kind": "undefined"})

    def test_registration_source_is_strictly_validated_at_native_boundary(self):
        for source_json in ['null', '{}', '[]', '"valid", "extra"', '"unterminated']:
            self.send(self.command("page.addInitScript", {"page": self.page, "sourceJson": source_json}))
            reply = self.receive()
            self.assertEqual(reply["error"]["code"], "InvalidArgumentError", reply)
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})


class InitScriptLimitTests(OwnedDriverCase):
    create_initial_page = False

    def test_initial_diagnostic_limit_rejects_only_the_unpublished_page(self):
        self.request("context.console.subscribe", {"context": self.context, "enabled": True})
        registration = self.request("context.addInitScript", {"context": self.context, **script_source("for(let index=0; index<1100; index++) console.log(index)")})
        self.send(self.command("context.newPage", {"context": self.context}))
        reply = self.receive()
        self.assertEqual(reply["kind"], "error", reply)
        self.assertEqual(reply["error"]["code"], "ResourceLimitError", reply)
        self.assertIn("initial page diagnostics", reply["error"]["message"])
        self.request("initScript.dispose", {"script": registration["identifier"]})
        replacement = self.request("context.newPage", {"context": self.context})
        self.assertEqual(replacement["initialEvents"], [])
        self.page = replacement["identifier"]
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_unsubscribed_initial_console_burst_does_not_retain_history(self):
        self.request("context.addInitScript", {"context": self.context, **script_source("for(let index=0; index<1100; index++) console.log(index)")})
        page = self.request("context.newPage", {"context": self.context})
        self.assertEqual(page["initialEvents"], [])
        self.page = page["identifier"]
        self.assertEqual(self.request("page.evaluate", self.evaluation("42")), {"kind": "number", "value": 42})

    def test_registration_capacity_is_reusable_after_disposal_and_context_close(self):
        registrations = [self.request("context.addInitScript", {"context": self.context, **script_source("")})["identifier"] for _ in range(1024)]
        self.send(self.command("context.addInitScript", {"context": self.context, **script_source("globalThis.overflow = true")}))
        self.assertEqual(self.receive()["error"]["code"], "ResourceLimitError")
        self.request("initScript.dispose", {"script": registrations[0]})
        self.request("context.addInitScript", {"context": self.context, **script_source("")})
        self.request("context.close", {"context": self.context})
        for identifier in registrations:
            self.request("initScript.dispose", {"script": identifier})

    def test_aggregate_source_capacity_is_released_by_disposal(self):
        source = script_source(" " * 1_000_000)
        registrations = [self.request("context.addInitScript", {"context": self.context, **source})["identifier"] for _ in range(4)]
        self.send(self.command("context.addInitScript", {"context": self.context, **source}))
        self.assertEqual(self.receive()["error"]["code"], "ResourceLimitError")
        self.request("initScript.dispose", {"script": registrations[0]})
        self.request("context.addInitScript", {"context": self.context, **source})
