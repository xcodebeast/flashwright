from pathlib import Path
import json
import os
import re
import subprocess

root = Path.cwd()
destination = root / '.cache/page-initialization-profiles-001'
destination.mkdir()
node = root / '.tools/node-v24.15.0-darwin-arm64/bin/node'
environment = {**os.environ, 'PATH': str(node.parent) + os.pathsep + os.environ['PATH'], 'PLAYWRIGHT_SKIP_BROWSER_GC': '1',
               'FLASHWRIGHT_DRIVER_PATH': str(root / 'target/release/flashwright-driver'), 'FLASHWRIGHT_CONDITION_INSTRUMENTATION': '0',
               'FLASHWRIGHT_BROWSER_PATH': '/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
               'FLASHWRIGHT_VERIFICATION_REPORT': Path('.cache/page-initialization-native-001/core-path.txt').read_text().strip()}
environment.pop('FLASHWRIGHT_RESIDENT_ASSERTIONS', None)
environment['FLASHWRIGHT_REFERENCE_DRIVER_PATH'] = str(root / '.cache/resident-default-native-001/flashwright-driver')
environment['FLASHWRIGHT_REFERENCE_VERIFICATION_REPORT'] = str(root / 'compatibility/evidence/core-darwin-arm64-24.15.0-2026-10-08T19-32-26.984Z/report.json')
attempts = []
for label, producer, verifier in [('drivers', 'benchmarks/compare-drivers.mjs', 'tools/verify-driver-comparison.mjs'), ('playwright', 'benchmarks/paired.mjs', 'tools/verify-paired.mjs'), ('attribution', 'benchmarks/attribution.mjs', 'tools/verify-attribution.mjs')]:
    command = ['python3', 'tools/watchdog.py', '--timeout', '600', '--report-directory', str(destination / 'resources'), '--', str(node), producer]
    with (destination / f'{label}.log').open('w') as output:
        result = subprocess.run(command, env=environment, stdout=output, stderr=subprocess.STDOUT)
    attempt = {'label': label, 'command': command, 'exitCode': result.returncode, 'assertionEnvironmentSwitch': None}
    attempts.append(attempt)
    (destination / 'attempts.json').write_text(json.dumps(attempts, indent=2) + '\n')
    if result.returncode:
        raise SystemExit(result.returncode)
    match = re.search(r'"destination": "([^"]+)"', (destination / f'{label}.log').read_text())
    assert match
    attempt['directory'] = match.group(1)
    with (destination / f'{label}-verification.log').open('w') as output:
        result = subprocess.run([str(node), verifier, attempt['directory']], env=environment, stdout=output, stderr=subprocess.STDOUT)
    attempt['verificationExitCode'] = result.returncode
    (destination / 'attempts.json').write_text(json.dumps(attempts, indent=2) + '\n')
    print(json.dumps(attempt), flush=True)
    if result.returncode: raise SystemExit(result.returncode)
