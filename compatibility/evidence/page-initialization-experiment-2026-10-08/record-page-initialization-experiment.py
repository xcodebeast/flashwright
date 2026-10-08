from pathlib import Path
import datetime,hashlib,json,shutil,subprocess,tempfile
root=Path.cwd();archive=Path('compatibility/evidence/page-initialization-experiment-2026-10-08');checkpoint=Path('compatibility/evidence/page-initialization-checkpoint-2026-10-08.json')
assert not checkpoint.exists()
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def reference(path):return {'path':str(path),'sha256':digest(path)}
def read(path):return json.loads(Path(path).read_text())
def write(path,value):Path(path).write_text(json.dumps(value,indent=2)+'\n')
shutil.copytree('.cache/page-initialization-restored-native-001',archive/'page-initialization-restored-native-001',ignore=shutil.ignore_patterns('flashwright-driver'))
shutil.copy2('.cache/page-initialization-comparison-policy.json',archive/'comparison-policy.json')
canonical=[]
for name in subprocess.check_output(['git','diff','--name-only','--','compatibility/evidence'],text=True).splitlines():
 assert name.endswith('.json')
 target=archive/'restored-canonical-artifacts'/Path(name).name;target.parent.mkdir(exist_ok=True);shutil.copy2(name,target)
 assert Path(name).read_bytes()==target.read_bytes()
 canonical.append({'originalPath':name,**reference(target)})
 Path(name).write_bytes(subprocess.check_output(['git','show','HEAD:'+name]))
processes=subprocess.check_output(['ps','-axo','pid,ppid,stat,command'],text=True).splitlines()
owned=[line for line in processes if '/flashwright-driver' in line or '--user-data-dir=' in line and 'flashwright-chromium-' in line]
profiles=[str(path) for path in Path(tempfile.gettempdir()).glob('flashwright-chromium-*')]
audit={'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'remainingOwnedProcessLines':owned,'remainingOwnedProfiles':profiles,'runningContainers':subprocess.check_output(['docker','--context','desktop-linux','ps','--format','{{.Names}}'],text=True).splitlines()}
write(archive/'final-cleanup.json',audit)
assert not owned and not profiles and 'flashwright-page-initialization-056' not in audit['runningContainers']
candidate_path=Path('.cache/page-initialization-native-001/core-path.txt').read_text().strip();restored_path=Path('.cache/page-initialization-restored-native-001/core-path.txt').read_text().strip()
candidate=read(candidate_path);restored=read(restored_path)
node22_path=archive/'page-initialization-platforms-001/node22-full-chromium/report.json';linux_path=archive/'linux-page-initialization-056/evidence/page-initialization-linux/report.json'
for path in [candidate_path,restored_path,node22_path,linux_path]:
 report=read(path);assert report['status']=='passed' and not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification']
 assert not report.get('driverChangedDuringVerification',False)
 for check in report['checks']:
  assert check['code']==0 and digest(Path(path).parent/check['log'])==check.get('logSha256',check.get('sha256'))
assert len(candidate['sources'])==209 and len(restored['sources'])==208
assert read(node22_path)['sources']==candidate['sources']==read(linux_path)['sources']
for name,sha in candidate['sources'].items():
 path=archive/'page-initialization-rejected-candidate'/name if name in ['crates/flashwright-engine/src/lib.rs','crates/flashwright-engine/src/page_initialization.rs'] else Path(name)
 assert digest(path)==sha,name
for name,sha in restored['sources'].items(): assert digest(name)==sha,name
assert restored['driverSha256']==digest('target/release/flashwright-driver')==digest('.cache/resident-default-native-001/flashwright-driver')
comparisons=[]
for attempt in read('.cache/page-initialization-profiles-001/attempts.json'):
 assert attempt['exitCode']==0 and attempt['verificationExitCode']==0
 folder=Path(attempt['directory']).relative_to(root);metadata=read(folder/'metadata.json');summary=read(folder/'summary.json');assert summary['valid'] and metadata['sources']==candidate['sources']
 for name,sha in summary['retainedFileHashes'].items():assert digest(folder/name)==sha,name
 entry={'label':attempt['label'],'directory':str(folder),'metadata':reference(folder/'metadata.json'),'summary':reference(folder/'summary.json'),'adoptedCandidate':False}
 if 'completeLaunch' in summary:
  entry.update({name:summary[name] for name in ['completeLaunch','processWall','coldLaunch','workloads']})
  entry['resources']=summary.get('resources',summary.get('memory'));entry['policy']=summary.get('policy',read(archive/'comparison-policy.json'))
 else:entry['launches']=len(summary['launches']);entry['scope']='Instrumented protocol attribution only; no production speed or resource inference.'
 comparisons.append(entry)
record={'schemaVersion':1,'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'Experiment rejected; established production initialization restored byte-for-byte. Reusable paired driver comparison and independent verifier retained.',
 'decision':read(archive/'page-initialization-rejected-candidate/decision.json'),
 'candidate':{'sources':candidate['sources'],'sourceCount':209,'driverSha256':candidate['driverSha256'],'linuxDriverSha256':read(linux_path)['driverSha256'],'verificationGroups':56,'nativeRustTests':68,'nativeLifecycleCases':82,'nativeCore':reference(candidate_path),'node22FullChromium':reference(node22_path),'linuxEmulation':reference(linux_path),'recoverablePatch':reference(archive/'page-initialization-rejected-candidate/candidate.patch')},
 'currentProduction':{'sources':restored['sources'],'sourceCount':208,'driverSha256':restored['driverSha256'],'verificationGroups':35,'nativeRustTests':65,'nativeLifecycleCases':82,'core':reference(restored_path),'identity':'Production sources and optimized binary are unchanged from fc7544cf7e9bac3f098e65a46cbd61e5e89cff9c; only benchmark producer, admission/verifier and harness tests changed. Earlier default platform coverage remains bound to its own source snapshot.','priorDefaultCheckpoint':reference('compatibility/evidence/resident-default-checkpoint-2026-10-08.json')},
 'comparisons':comparisons,'ordinaryLaunches':32,'instrumentedLaunches':4,
 'verifierAudit':reference(archive/'comparison-audit/report.json'),'verifierAuditScope':'Relocation accepted; six independently corrupted copies rejected after hashes were refreshed where applicable. Original results untouched.',
 'initialDevelopmentFailure':'The first new Rust test compile failed on Box<str> comparison; corrected before any browser comparison. Original compiler log, repaired tests, candidate source and patch retained.',
 'canonicalArtifactsRestored':canonical,'cleanup':reference(archive/'final-cleanup.json'),
 'limitations':['Candidate comparison is not current production speed evidence; initialization change was not adopted.','One worker, seven existing fixtures on shared native macOS arm64; no representative corpus or contention sweep.','Linux x64 run uses local emulation for correctness only. Native Linux performance still needs an execution host.','10% complete-flow release target, failure-path/observed-maximum regressions and broader compatibility/distribution/release gates remain open.'],
 'retainedFiles':[]}
shutil.copy2('.cache/record-page-initialization-experiment.py',archive/'record-page-initialization-experiment.py')
files={str(path) for path in archive.rglob('*') if path.is_file()}
files.update(subprocess.check_output(['git','ls-files','--others','--exclude-standard','--','compatibility/evidence'],text=True).splitlines())
record['retainedFiles']=[reference(path) for path in sorted(files) if Path(path).is_file()]
write(checkpoint,record)
print(json.dumps({'checkpoint':str(checkpoint),'retainedFiles':len(record['retainedFiles']),'canonicalRestored':len(canonical),'sourceCounts':[209,208],'cleanup':audit}))
