import hashlib,json,subprocess,tempfile
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path,value):
    path=Path(path)
    assert not path.exists(),path
    path.write_text(json.dumps(value,indent=2)+'\n')


def relative(path):
    path=Path(path)
    return str(path.relative_to(Path.cwd())) if path.is_absolute() else str(path)


def metrics(comparison):
    return {key:comparison[key] for key in ['medianPairedSpeedup','pairedSpeedupConfidenceInterval','observedMaximumRatio']}


labels=['load','off-on','paired-first','paired-replication']
directories={label:Path(Path('.cache/resident-frame-pacing-'+label+'-path.txt').read_text().strip()) for label in labels}
metadata={label:read(path/'metadata.json') for label,path in directories.items()}
summaries={label:read(path/'summary.json') for label,path in directories.items()}
conformance_path='compatibility/evidence/resident-frame-pacing-checkpoint-2026-10-08.json'
conformance=read(conformance_path)
sources=conformance['sources']
for path,sha256 in sources.items():
    assert digest(path)==sha256,path
for label in labels:
    summary=summaries[label]
    assert summary['valid'] and summary['complete'] and summary['unexpectedFailures']==0
    assert all(not summary[field] for field in ['sourceChangedDuringTiming','driverChangedDuringTiming','browserChangedDuringTiming'])
    assert metadata[label]['sources']==sources
    assert metadata[label]['driver']['sha256']==conformance['coreEvidence'][0]['driverSha256']
    assert metadata[label]['browser']['sha256']==metadata['load']['browser']['sha256']
    assert metadata[label]['browser']['launchPolicy']==metadata['load']['browser']['launchPolicy']
    for name,sha256 in summary['retainedFileHashes'].items():
        assert digest(directories[label]/name)==sha256,name


def retained(label):
    directory=directories[label]
    return {'directory':relative(directory),'metadataSha256':digest(directory/'metadata.json'),'summarySha256':digest(directory/'summary.json'),'valid':True,'unexpectedFailures':0}


resources=[]
root_paths=subprocess.check_output(['git','ls-files','--others','--exclude-standard','compatibility/evidence/resources'],text=True).splitlines()
ordinary_paths=[path for directory in directories.values() for path in directory.rglob('resources-*.json')]
assert len(ordinary_paths)==210,len(ordinary_paths)
for path in [*map(Path,root_paths),*ordinary_paths]:
    report=read(path)
    assert not report['timedOut'] and not report['interrupted'] and not report['cleanupSignals'] and not report['remainingObservedProcesses'],path
    if path in ordinary_paths:
        assert report['exitCode']==0,path
    resources.append({'path':relative(path),'sha256':digest(path),'exitCode':report['exitCode']})
processes=[line for line in subprocess.check_output(['ps','-axo','pid=,comm='],text=True).splitlines() if 'flashwright-driver' in line]
profiles=list(Path(tempfile.gettempdir()).glob('flashwright-*'))
assert not processes and not profiles,(processes,profiles)
containers=subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
assert len(containers)==8 and all(name.startswith('tairox-') for name in containers),containers
cleanup_path='compatibility/evidence/resident-frame-pacing-performance-cleanup-2026-10-08.json'
save(cleanup_path,{'rootReports':len(root_paths),'ordinaryBenchmarkReports':len(ordinary_paths),'reports':resources,'remainingDriverProcesses':processes,'remainingProfiles':[str(path) for path in profiles],'unrelatedContainersPreserved':containers,'scope':'Root verification reports can include deliberate nonzero failure fixtures. All 210 ordinary launches exited zero. No timeout, forced watchdog cleanup, remaining observed process, driver or temporary browser profile was found.'})
verification_directory=Path('compatibility/evidence/resident-frame-pacing-verification-2026-10-08')
verification_directory.mkdir()
verification=[]
for label in labels:
    source=Path('.cache/resident-frame-pacing-'+label+'-verification.log')
    target=verification_directory/source.name
    target.write_bytes(source.read_bytes())
    verification.append({'label':label,'log':str(target),'sha256':digest(target)})
failed={gate:[entry['scenario'] for entry in summaries['load']['scenarios'] if not entry['comparisons'][0]['gate'][gate]] for gate in ['cpu','memory','completeTime']}
checkpoint={
 'status':'All 210 ordinary launches and independent verifications completed. See recorded gates; residency remains disabled by default.',
 'sources':sources,'sourceCount':len(sources),'productionDriverSha256':metadata['load']['driver']['sha256'],
 'conformance':{'path':conformance_path,'sha256':digest(conformance_path),'coreGroups':104,'registryCases':52},
 'host':{key:metadata['load'][key] for key in ['platform','architecture','cpu','node','operatingSystem','release','logicalProcessors','totalMemoryBytes','environmentClass']},
 'browser':{key:value for key,value in metadata['load']['browser'].items() if key!='launchPolicy'},
 'loadComparison':{**retained('load'),'independentGroups':6,'ordinaryLaunches':162,'scenarios':summaries['load']['scenarios'],'failedGates':failed},
 'residencyComparison':{**retained('off-on'),'independentPairs':8,'completeLaunch':metrics(summaries['off-on']['completeLaunch']),'workloads':summaries['off-on']['workloads']},
 'playwrightComparisons':[{**retained(label),'label':label,'independentPairs':8,'completeLaunch':metrics(summaries[label]['completeLaunch']),'workloads':summaries[label]['workloads'],'policy':summaries[label]['policy']} for label in ['paired-first','paired-replication']],
 'independentVerification':verification,
 'plan':{'path':'compatibility/evidence/resident-frame-pacing-profile-plan-2026-10-08.json','sha256':digest('compatibility/evidence/resident-frame-pacing-profile-plan-2026-10-08.json'),'completed':True,'ordinaryLaunches':210},
 'diagnostics':{'directory':'compatibility/evidence/resident-frame-pacing-exploration-2026-10-08/diagnostic-001','scope':'Five separate instrumented fixed-work checks confirm scheduler counters and cleanup. Historical runs are unmatched, so they do not establish an attributed CPU improvement.'},
 'limitations':['Shared native Apple M3 Pro macOS host, one worker, pinned Playwright 1.60.0 and the same Chromium headless shell; no native Linux, contention, broad-suite or competitor-set claim.','Six load groups and eight complete-flow pairs support bootstrap intervals and observed maxima, not percentile tails. Resource gates use the predeclared median paired ratios.','CPU is the maximum observed time per process identity; sampling may miss short-lived work and the final interval. Memory is the maximum sampled concurrent RSS.','Historical before/after snapshots are not an alternating direct comparison between driver revisions.'],
 'cleanup':{'path':cleanup_path,'sha256':digest(cleanup_path)},
 'remaining':['Retain default-off pending resource and complete-flow gates; diagnose remaining costs using the current results.','Continue unfinished M2 APIs, runner and artifacts, M3 transport evaluation, native Linux performance, contention, installation and release gates.']}
path='compatibility/evidence/resident-frame-pacing-performance-checkpoint-2026-10-08.json'
save(path,checkpoint)
print(path)
print('Failed load gates:',failed)
for label in ['off-on','paired-first','paired-replication']:
    print(label,metrics(summaries[label]['completeLaunch']))
    if 'policy' in summaries[label]:
        print(summaries[label]['policy'])
