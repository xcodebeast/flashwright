from pathlib import Path
import json
import os
import re
import subprocess

root = Path.cwd()
destination = root / '.cache/resident-adoption-profiles-001'
destination.mkdir()
node = root / '.tools/node-v24.15.0-darwin-arm64/bin/node'
environment = {
    **os.environ,
    'PATH': str(node.parent) + os.pathsep + os.environ['PATH'],
    'PLAYWRIGHT_SKIP_BROWSER_GC': '1',
    'FLASHWRIGHT_DRIVER_PATH': str(root / 'target/release/flashwright-driver'),
    'FLASHWRIGHT_TEST_NODE': str(node),
    'FLASHWRIGHT_BROWSER_PATH': '/Users/P/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'FLASHWRIGHT_RESIDENT_ASSERTIONS': '1',
    'FLASHWRIGHT_CONDITION_INSTRUMENTATION': '0',
    'FLASHWRIGHT_BASELINE_VERIFICATION_REPORT': Path('.cache/event-profile-native-001/core-path.txt').read_text().strip(),
    'FLASHWRIGHT_VERIFICATION_REPORT': Path('.cache/resident-adoption-native-001/core-path.txt').read_text().strip(),
}
results = []
for label, script, verifier, budget in [
    ('playwright', 'benchmarks/paired.mjs', 'tools/verify-paired.mjs', 600),
    ('off-on', 'benchmarks/residency.mjs', 'tools/verify-residency.mjs', 600),
    ('load', 'benchmarks/resident-load.mjs', 'tools/verify-resident-load.mjs', 1800),
]:
    command = ['python3', 'tools/watchdog.py', '--timeout', str(budget), '--report-directory', str(destination / 'resources'), '--', str(node), script]
    with (destination / f'{label}.log').open('w') as log:
        result = subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT)
    entry = {'label': label, 'command': command, 'exitCode': result.returncode}
    results.append(entry)
    (destination / 'attempts.json').write_text(json.dumps(results, indent=2) + '\n')
    if result.returncode:
        raise SystemExit(result.returncode)
    match = re.search(r'"destination": "([^"]+)"', (destination / f'{label}.log').read_text())
    assert match
    entry['directory'] = match.group(1)
    with (destination / f'{label}-verification.log').open('w') as log:
        checked = subprocess.run([str(node), verifier, entry['directory']], env=environment, stdout=log, stderr=subprocess.STDOUT)
    entry['verificationExitCode'] = checked.returncode
    (destination / 'attempts.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(entry), flush=True)
    if checked.returncode:
        raise SystemExit(checked.returncode)
