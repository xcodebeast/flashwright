import json
import subprocess
import unittest
from test_console import ConsoleLifetimeTests

class ConsoleShutdownProbe(ConsoleLifetimeTests):
    def request(self, method, parameters):
        self.send(self.command(method, parameters))
        reply = self.receive()
        if reply['kind'] != 'result':
            print('FIRST_FAILURE', json.dumps(reply), flush=True)
            try:
                print('DRIVER_EXIT', self.driver.wait(timeout=12), flush=True)
            except subprocess.TimeoutExpired:
                print('DRIVER_STILL_RUNNING', flush=True)
        self.assertEqual(reply['kind'], 'result', reply)
        return reply['value']

suite = unittest.TestSuite([ConsoleShutdownProbe('test_unobserved_logs_do_not_consume_handle_slots_or_timeout_application_work')])
raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
