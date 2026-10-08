from pathlib import Path
import datetime
import json
import subprocess
import tarfile
import tempfile

container = 'flashwright-diagnostics-focused-047'
inspection = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
assert inspection['State']['Status'] == 'exited' and not inspection['State']['Running']
child = subprocess.Popen(['docker', 'cp', container + ':/tmp', '-'], stdout=subprocess.PIPE)
with tarfile.open(fileobj=child.stdout, mode='r|') as archive:
    remaining_profiles = [member.name for member in archive if 'flashwright-chromium-' in member.name]
assert child.wait() == 0
container_audit = {'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'container':container, 'state':inspection['State'], 'image':inspection['Image'], 'remainingProfiles':remaining_profiles}
Path('.cache/linux-diagnostics-047/container-audit.json').write_text(json.dumps(container_audit, indent=2)+'\n')
assert not remaining_profiles
subprocess.run(['docker', 'rm', container], check=True)

commands = {}
for line in subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True).splitlines():
    identifier, command = line.strip().split(None, 1)
    commands[int(identifier)] = command
remaining_processes = []
for line in subprocess.check_output(['ps', '-axo', 'pid=,args='], text=True).splitlines():
    fields = line.strip().split(None, 1)
    if len(fields) != 2:
        continue
    identifier, arguments = fields
    command = commands.get(int(identifier), '')
    if command.endswith('flashwright-driver') or ('chrome' in command.lower() and '--user-data-dir=' in arguments and 'flashwright-chromium-' in arguments):
        remaining_processes.append({'process':int(identifier), 'command':command})
profiles = [str(path) for path in Path(tempfile.gettempdir()).glob('flashwright-chromium-*')]
containers = subprocess.check_output(['docker', 'ps', '-a', '--format', '{{.Names}}'], text=True).splitlines()
attempts = [name for name in containers if name in [container]]
audit = {'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'remainingOwnedProcesses':remaining_processes, 'remainingProfiles':profiles, 'remainingAttemptContainers':attempts, 'otherContainerNames':[name for name in containers if name not in attempts], 'scope':'Final native driver/profile audit and stopped owned Linux container filesystem audit. Removed only the exact stopped verification container; no unrelated process/container was modified.'}
Path('.cache/diagnostics-cleanup-audit.json').write_text(json.dumps(audit, indent=2)+'\n')
assert not remaining_processes and not profiles and not attempts
print('Owned process, profile and container cleanup verified.')
