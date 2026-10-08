from pathlib import Path
import datetime
import json
import subprocess
import tarfile
import tempfile

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
containers = subprocess.check_output(['docker', '--context', 'desktop-linux', 'ps', '-a', '--format', '{{.Names}}'], text=True).splitlines()
attempts = [name for name in containers if name.startswith('flashwright-console-')]
audit = {'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'remainingOwnedProcesses':remaining_processes, 'remainingProfiles':profiles, 'remainingAttemptContainers':attempts, 'otherContainerNames':[name for name in containers if name not in attempts], 'scope':'Final native driver/profile and owned-container audit after the frozen Linux, native macOS and Node22 runs. Stopped-container profile audits are retained separately for attempts053 and054. No process or container was modified by this final read-only audit.'}
Path('.cache/console-cleanup-audit.json').write_text(json.dumps(audit, indent=2)+'\n')
assert not remaining_processes and not profiles and not attempts
print('Owned process, profile and container cleanup verified.')
