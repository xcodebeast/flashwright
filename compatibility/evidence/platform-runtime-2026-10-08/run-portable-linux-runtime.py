from pathlib import Path
import datetime,json,subprocess
root=Path.cwd();destination=root/'.cache/portable-linux-runtime-058';destination.mkdir()
container='flashwright-portable-linux-runtime-058'
image='docker.io/library/rust@sha256:58643a517df55089a44540d827eb9bfd8d5f121c249767be6e25f24b68c0563d'
command=['docker','--context','desktop-linux','run','--name',container,'--platform','linux/amd64','--init','-v',str(root)+':/source:ro','-v',str(destination)+':/output','-v',str(root/'.cache/linux-target-rust1.98-bullseye')+':/workspace/target',image,'bash','/source/.cache/build-portable-linux-runtime.sh']
(destination/'command.json').write_text(json.dumps(command,indent=2)+'\n')
with (destination/'run.log').open('w') as output:
 result=subprocess.run(['python3','tools/watchdog.py','--timeout','900','--report-directory',str(destination/'resources'),'--',*command],stdout=output,stderr=subprocess.STDOUT)
inspection=json.loads(subprocess.check_output(['docker','--context','desktop-linux','inspect',container],text=True))[0]
assert inspection['State']['Status']=='exited' and not inspection['State']['Running']
(destination/'container-audit.json').write_text(json.dumps({'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':inspection['Image'],'container':container,'state':inspection['State'],'hostExitCode':result.returncode,'scope':'Compile-only Bullseye build and real loader/protocol handshake; browser conformance is separate.'},indent=2)+'\n')
subprocess.run(['docker','--context','desktop-linux','rm',container],check=True)
print(json.dumps({'destination':str(destination),'exitCode':result.returncode}),flush=True)
raise SystemExit(result.returncode)
