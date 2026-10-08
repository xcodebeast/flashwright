from pathlib import Path
import copy,hashlib,json,shutil,subprocess
root=Path.cwd(); node=root/'.tools/node-v24.15.0-darwin-arm64/bin/node'
attempts=json.loads(Path('.cache/page-initialization-profiles-001/attempts.json').read_text())
source=Path(next(a['directory'] for a in attempts if a['label']=='drivers'))
destination=root/'.cache/page-initialization-comparison-audit-001';destination.mkdir()
relocated=destination/'relocated';shutil.copytree(source,relocated)
original={str(p.relative_to(relocated)):p.read_bytes() for p in relocated.rglob('*') if p.is_file()}
def write(name,value): (relocated/name).write_text(json.dumps(value,indent=2)+'\n')
def read(name): return json.loads((relocated/name).read_text())
def hash_file(name): return hashlib.sha256((relocated/name).read_bytes()).hexdigest()
def refresh_report(variant):
    metadata=read('metadata.json');metadata['verification'][variant]['sha256']=hash_file(f'verification/{variant}/report.json');write('metadata.json',metadata)
def refresh_hashes():
    summary=read('summary.json');summary['retainedFileHashes']={name:hash_file(name) for name in summary['retainedFileHashes']};write('summary.json',summary)
def changed_configuration():
    metadata=read('metadata.json');metadata['configuration']['expectedFailureTimeoutMilliseconds']=1;write('metadata.json',metadata)
def changed_workload():
    report=read('verification/reference/report.json');report['sources']['benchmarks/sample.mjs']='0'*64;write('verification/reference/report.json',report);refresh_report('reference')
def wrong_candidate_driver():
    report=read('verification/candidate/report.json');report['driverSha256']='0'*64;write('verification/candidate/report.json',report);refresh_report('candidate')
def corrupted_cpu():
    name='candidate/resources-0-flashwright.json';resources=read(name);resources['observedCpuSeconds']+=1;write(name,resources)
    launch=read('candidate/launch-0-flashwright.json');launch['resources']=resources;write('candidate/launch-0-flashwright.json',launch)
def corrupted_observation():
    name='candidate/launch-0-flashwright.json';launch=read(name);
    for sample in launch['workloads'][0]['samples']: sample['milliseconds']*=10
    write(name,launch)
def missing_log():
    report=read('verification/candidate/report.json');(relocated/'verification/candidate'/report['checks'][0]['log']).unlink()
results=[]
for label,mutate in [('relocated-valid',None),('changed-configuration',changed_configuration),('unverified-workload',changed_workload),('wrong-candidate-binary',wrong_candidate_driver),('fabricated-cpu-total',corrupted_cpu),('changed-raw-observation',corrupted_observation),('missing-conformance-log',missing_log)]:
    for name,contents in original.items(): (relocated/name).write_bytes(contents)
    if mutate:
        mutate()
        if label!='missing-conformance-log': refresh_hashes()
    result=subprocess.run([str(node),'tools/verify-driver-comparison.mjs',str(relocated)],capture_output=True,text=True)
    (destination/f'{label}.log').write_text(result.stdout+result.stderr)
    results.append({'label':label,'exitCode':result.returncode,'expectedAcceptance':mutate is None})
    assert (result.returncode==0)==(mutate is None),results[-1]
for name,contents in original.items(): (relocated/name).write_bytes(contents)
(destination/'report.json').write_text(json.dumps({'source':str(source),'status':'passed','checks':results,'note':'Corrupted copies refreshed hashes to exercise semantic validation. Original result unchanged; valid relocated copy restored.'},indent=2)+'\n')
print(json.dumps(results),flush=True)
