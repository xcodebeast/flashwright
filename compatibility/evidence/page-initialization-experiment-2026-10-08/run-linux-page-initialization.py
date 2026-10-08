from pathlib import Path
import datetime
import json
import subprocess
import tarfile

root = Path.cwd()
destination = root / '.cache/linux-page-initialization-056'
destination.mkdir()
container = 'flashwright-page-initialization-056'
image = 'sha256:928479a7100c77d60d26880ac6aa181e69e231abdbe7892054cec83ad604c766'
command = ['docker', '--context', 'desktop-linux', 'run', '--name', container, '--platform', 'linux/amd64', '--init', '--shm-size=2g',
           '-v', f'{root}:/source:ro', '-v', f'{destination}:/output', '-v', f'{root}/.cache/linux-target-rust1.98-pw1.60:/workspace/target',
           '-e', 'PLAYWRIGHT_SKIP_BROWSER_GC=1', '-e', 'FLASHWRIGHT_BROWSER_PATH=/ms-playwright/chromium-1223/chrome-linux64/chrome',
           '-e', 'FLASHWRIGHT_ENVIRONMENT_CLASS=local-amd64-emulation-functional-only', '-e', f'FLASHWRIGHT_CONTAINER_IMAGE={image}',
           image, 'bash', '/source/.cache/linux-page-initialization.sh']
(destination / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
with (destination / 'run.log').open('w') as output:
    result = subprocess.run(['python3', 'tools/watchdog.py', '--timeout', '1800', '--report-directory', str(destination / 'host-resources'), '--', *command], stdout=output, stderr=subprocess.STDOUT)
inspection = json.loads(subprocess.check_output(['docker', '--context', 'desktop-linux', 'inspect', container], text=True))[0]
assert inspection['State']['Status'] == 'exited' and not inspection['State']['Running']
child = subprocess.Popen(['docker', '--context', 'desktop-linux', 'cp', container + ':/tmp', '-'], stdout=subprocess.PIPE)
with tarfile.open(fileobj=child.stdout, mode='r|') as archive:
    remaining_profiles = [member.name for member in archive if 'flashwright-chromium-' in member.name]
assert child.wait() == 0
audit = {'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'container': container, 'state': inspection['State'], 'image': inspection['Image'], 'remainingProfiles': remaining_profiles, 'hostExitCode': result.returncode}
(destination / 'container-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
assert not remaining_profiles
subprocess.run(['docker', '--context', 'desktop-linux', 'rm', container], check=True)
print(json.dumps(audit), flush=True)
raise SystemExit(result.returncode)
