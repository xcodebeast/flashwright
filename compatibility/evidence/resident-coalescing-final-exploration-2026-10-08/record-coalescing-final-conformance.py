import hashlib,json,re,shutil
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path,value):
    path=Path(path)
    assert not path.exists(),path
    path.write_text(json.dumps(value,indent=2)+'\n')


linux_output=Path('.cache/linux-core-024')
linux_reports=list((linux_output/'evidence').glob('core-*/report.json'))
assert len(linux_reports)==1
linux_report=read(linux_reports[0])
assert linux_report['status']=='passed'
shutil.copytree(linux_output/'evidence','compatibility/evidence',dirs_exist_ok=True)
linux_path=Path('compatibility/evidence')/linux_reports[0].parent.name/'report.json'
Path('.cache/resident-coalescing-final-linux-core-path.txt').write_text(str(linux_path)+'\n')
core_paths=[Path('.cache/resident-core-coalescing-final-'+label+'-path.txt').read_text().strip() for label in ['headless-on','headless-off','full-chrome-on']]+[str(linux_path)]
sources=read(core_paths[0])['sources']
assert len(sources)==158
for path,sha256 in sources.items():
    assert digest(path)==sha256,path
core=[]
registry=[]
for path in core_paths:
    report=read(path)
    assert report['status']=='passed' and len(report['checks'])==26 and report['sources']==sources
    assert not report['sourceChangedDuringVerification'] and not report['browserChangedDuringVerification']
    for check in report['checks']:
        assert check['code']==0 and digest(Path(path).parent/check['log'])==check['logSha256']
    binary=linux_output/'flashwright-driver-linux-x64' if report['platform']=='linux' else Path('target/release/flashwright-driver')
    assert digest(binary)==report['driverSha256']
    core.append({'path':path,'sha256':digest(path),'checks':26,'logsVerified':True,'driverSha256':report['driverSha256'],'browser':report['browser'],'configuration':report['engineConfiguration'],'environmentClass':report['environmentClass']})
    log=(Path(path).parent/report['checks'][19]['log']).read_text()
    registry_path=Path(re.findall(r'Resident registry evidence: (.+)',log)[-1])
    case_report=read(registry_path)
    assert case_report['sources']==sources and len(case_report['cases'])==54
    registry.append({'path':str(registry_path),'sha256':digest(registry_path),'cases':54})
    if report['platform']=='linux':
        artifacts=Path(path).parent/'artifacts'
        artifacts.mkdir()
        for source in (linux_output/'evidence').glob('*.json'):
            shutil.copy2(source,artifacts/source.name)
node22_log=Path('compatibility/evidence/resident-coalescing-final-node22-2026-10-08.txt')
node22_text=node22_log.read_text()
assert 'Ran 25 tests' in node22_text and '\nOK\n' in node22_text
node22_registry=Path(re.findall(r'Resident registry evidence: (.+)',node22_text)[-1])
assert read(node22_registry)['sources']==sources and len(read(node22_registry)['cases'])==54
exploration=Path('compatibility/evidence/resident-coalescing-final-exploration-2026-10-08')
exploration.mkdir()
for source in ['.cache/resident-coalescing-final-conditions-001.log','.cache/resident-coalescing-final-build.log','.cache/coalescing-final-diagnostic.mjs','.cache/run-resident-coalescing-final-profiles.sh','.cache/verify-resident-coalescing-final.sh']:
    shutil.copy2(source,exploration/Path(source).name)
shutil.copytree('.cache/coalescing-final-diagnostic-001',exploration/'diagnostic-001')
shutil.copy2('.cache/resident-coalescing-001/condition-registry-before.js',exploration/'condition-registry-before.js.txt')
checkpoint={
 'status':'Current scheduler passes 104 core groups across macOS and emulated Linux, plus Node22 checks. Residency remains disabled by default; ordinary performance comparisons are pending.',
 'sources':sources,'sourceCount':len(sources),'coreEvidence':core,'totalCoreGroups':104,'registryEvidence':registry,
 'node22':{'log':str(node22_log),'logSha256':digest(node22_log),'registry':str(node22_registry),'registrySha256':digest(node22_registry),'scope':'Assertion differential, 25 lifecycle/protocol tests and 54 registry cases on macOS full Chromium.'},
 'change':'Long waits add one four-millisecond batch window after the earliest 32-millisecond eligibility time, checking the entire pending group on each due timer. Early frames, immediate mutation/event invalidation, task fairness, independent deadlines and generation ownership remain intact.',
 'newConformance':['32 staggered conditions coalesce due checks and all make progress','128 staggered conditions coalesce due checks and all make progress','Updated controlled cadence preserves immediate events and independent deadlines'],
 'diagnostics':{'directory':str(exploration/'diagnostic-001'),'scope':'Five fixed-work instrumented public-API scenarios. Historical diagnostics are unmatched and cannot establish an attributed CPU/speed improvement.'},
 'plan':{'path':'compatibility/evidence/resident-coalescing-final-profile-plan-2026-10-08.json','sha256':digest('compatibility/evidence/resident-coalescing-final-profile-plan-2026-10-08.json')},
 'remaining':['Run all predeclared ordinary comparisons and independently verify them; retain every attempted launch.','Keep default-off unless equivalent-work resource and net-benefit gates pass.','Continue remaining M2 APIs, runner and artifacts, M3 transport evaluation, native Linux performance, contention and release gates.'],
 'scope':'Development conformance on native macOS arm64 Node24 headless shell on/off and full Chromium on, Linux x64 Node24 under local amd64 emulation, and macOS Node22 focused coverage. Linux timings are not native performance evidence.'}
path='compatibility/evidence/resident-coalescing-final-checkpoint-2026-10-08.json'
save(path,checkpoint)
print(path)
