from pathlib import Path
import json
import os
import re
import subprocess

root = Path.cwd()
destination = root / '.cache/resident-default-profile-001'
destination.mkdir()
node = root / '.tools/node-v24.15.0-darwin-arm64/bin/node'
environment = {**os.environ, 'PATH': str(node.parent) + os.pathsep + os.environ['PATH'], 'PLAYWRIGHT_SKIP_BROWSER_GC': '1',
               'FLASHWRIGHT_DRIVER_PATH': str(root / 'target/release/flashwright-driver'), 'FLASHWRIGHT_CONDITION_INSTRUMENTATION': '0',
               'FLASHWRIGHT_BROWSER_PATH': '/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
               'FLASHWRIGHT_VERIFICATION_REPORT': Path('.cache/resident-default-native-001/core-path.txt').read_text().strip()}
environment.pop('FLASHWRIGHT_RESIDENT_ASSERTIONS', None)
command = ['python3', 'tools/watchdog.py', '--timeout', '600', '--report-directory', str(destination / 'resources'), '--', str(node), 'benchmarks/paired.mjs']
with (destination / 'run.log').open('w') as output:
    result = subprocess.run(command, env=environment, stdout=output, stderr=subprocess.STDOUT)
attempt = {'command': command, 'exitCode': result.returncode, 'assertionEnvironmentSwitch': None}
(destination / 'attempt.json').write_text(json.dumps(attempt, indent=2) + '\n')
if result.returncode:
    raise SystemExit(result.returncode)
match = re.search(r'"destination": "([^"]+)"', (destination / 'run.log').read_text())
assert match
attempt['directory'] = match.group(1)
with (destination / 'verification.log').open('w') as output:
    result = subprocess.run([str(node), 'tools/verify-paired.mjs', attempt['directory']], env=environment, stdout=output, stderr=subprocess.STDOUT)
attempt['verificationExitCode'] = result.returncode
(destination / 'attempt.json').write_text(json.dumps(attempt, indent=2) + '\n')
print(json.dumps(attempt), flush=True)
raise SystemExit(result.returncode)
