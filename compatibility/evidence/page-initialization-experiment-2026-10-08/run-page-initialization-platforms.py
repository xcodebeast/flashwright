from pathlib import Path
import json
import os
import subprocess

root = Path.cwd()
destination = root / '.cache/page-initialization-platforms-001'
destination.mkdir()
base = {**os.environ, 'PLAYWRIGHT_SKIP_BROWSER_GC': '1', 'FLASHWRIGHT_CONDITION_INSTRUMENTATION': '0', 'FLASHWRIGHT_DRIVER_PATH': str(root / 'target/release/flashwright-driver'), 'FLASHWRIGHT_BROWSER_PATH': '/Users/P/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'}
base.pop('FLASHWRIGHT_RESIDENT_ASSERTIONS', None)
attempts = []
for label, version, mode in [('node22-full-chromium', '22.22.0', 'default')]:
    node = root / f'.tools/node-v{version}-darwin-arm64/bin/node'
    environment = {**base, 'PATH': str(node.parent) + os.pathsep + os.environ['PATH'], 'FLASHWRIGHT_TEST_NODE': str(node)}
    if mode == 'off':
        environment['FLASHWRIGHT_RESIDENT_ASSERTIONS'] = '0'
    command = ['python3', 'tools/watchdog.py', '--timeout', '600', '--report-directory', str(destination / 'resources'), '--', str(node), '.cache/verify-page-initialization-platform.mjs', str(destination / label), mode]
    with (destination / f'{label}.log').open('w') as output:
        result = subprocess.run(command, env=environment, stdout=output, stderr=subprocess.STDOUT)
    attempts.append({'label': label, 'command': command, 'exitCode': result.returncode})
    (destination / 'attempts.json').write_text(json.dumps(attempts, indent=2) + '\n')
    print(json.dumps(attempts[-1]), flush=True)
    if result.returncode:
        raise SystemExit(result.returncode)
