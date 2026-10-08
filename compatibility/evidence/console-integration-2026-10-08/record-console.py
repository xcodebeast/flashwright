from pathlib import Path
import datetime,hashlib,json,re,shutil,subprocess


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def reference(path):
    return {'path':str(path),'sha256':digest(path)}


native_path=Path(Path('.cache/resident-core-console-003-path.txt').read_text().strip())
node22_path=Path('.cache/console-node22-002/report.json')
linux_path=Path('.cache/linux-console-053/evidence/console-focused-linux/report.json')
native,node22,linux=[read(path) for path in [native_path,node22_path,linux_path]]
sources=native['sources']; assert len(sources)==205
for path,expected in sources.items(): assert digest(path)==expected,path
for path,report,count,log_key in [(native_path,native,35,'logSha256'),(node22_path,node22,16,'sha256'),(linux_path,linux,19,'sha256')]:
    assert report['status']=='passed' and len(report['checks'])==count,path
    assert report['sources']==sources,path
    assert not any(report.get(key,False) for key in ['sourceChangedDuringVerification','driverChangedDuringVerification','browserChangedDuringVerification'])
    for check in report['checks']: assert check['code']==0 and digest(path.parent/check['log'])==check[log_key],check
for path,report in [(native_path,native),(linux_path,linux)]:
    rust=(path.parent/report['checks'][2]['log']).read_text()
    assert sum(map(int,re.findall(r'test result: ok\. (\d+) passed',rust)))==65
lifecycle_check=next(check for check in native['checks'] if check['command']==['npm','run','test:lifecycle'])
lifecycle=(native_path.parent/lifecycle_check['log']).read_text()
assert list(map(int,re.findall(r'Ran (\d+) tests',lifecycle)))==[8,22,7,7,10,11,11,6]
assert lifecycle.count('\nOK\n')==8
for path,report in [(node22_path,node22),(linux_path,linux)]:
    for pattern,count in [('output_limits.py','11'),('test_handles.py','7'),('test_console.py','8'),('test_lifecycle.py','7'),('watchdog_lifecycle.py','6')]:
        check=next(check for check in report['checks'] if check['command'][-1]==pattern)
        log=(path.parent/check['log']).read_text()
        assert re.findall(r'Ran (\d+) tests',log)==[count] and '\nOK\n' in log
assert native['driverSha256']==node22['driverSha256']==digest('.cache/console-core-003/flashwright-driver')
assert linux['driverSha256']==digest('.cache/linux-console-053/flashwright-driver-linux-x64')
assert linux['environmentClass']=='local-amd64-emulation-functional-only'
assert 'Ran 12 tests' in Path('.cache/linux-console-probe-054/run.log').read_text() and '\nOK\n' in Path('.cache/linux-console-probe-054/run.log').read_text()
assert read('.cache/linux-console-probe-054/source-report.json')['sources']==sources
assert not read('.cache/linux-console-probe-054/container-audit.json')['remainingProfiles']
audit=read('.cache/console-cleanup-audit.json')
assert not audit['remainingOwnedProcesses'] and not audit['remainingProfiles'] and not audit['remainingAttemptContainers']
assert not read('.cache/linux-console-053/container-audit.json')['remainingProfiles']

destination=Path('compatibility/evidence/console-integration-2026-10-08'); destination.mkdir()
for folder in sorted(Path('.cache').glob('console-*')):
    if folder.is_dir() and not folder.name.startswith('console-node22'):
        shutil.copytree(folder,destination/folder.name,ignore=shutil.ignore_patterns('flashwright-driver','recovered-profiles'))
shutil.copytree('.cache/console-node22-002',destination/'node22')
shutil.copytree('.cache/console-node22-002-resources',destination/'node22-resources')
shutil.copy2('.cache/console-node22-002.log',destination/'node22.log')
for folder in sorted(Path('.cache').glob('linux-console-*')):
    if folder.is_dir():
        shutil.copytree(folder,destination/folder.name.replace('linux-console-', 'linux-'),ignore=shutil.ignore_patterns('flashwright-driver-linux-x64'))
for folder in sorted(Path('.cache').glob('console-node22*')):
    if folder.is_dir() and folder.name not in ['console-node22-002', 'console-node22-002-resources']:
        shutil.copytree(folder,destination/folder.name)
shutil.copytree('.cache/linux-image-rebuild-005',destination/'linux-image-rebuild')
for name in ['verify-console-platform.mjs','linux-console-focused.sh','archive-console-core.py','audit-console.py','record-console.py','console-cleanup-audit.json','audit-console-053.py','audit-console-final.py','run-console-final-native.py','console-probe-cleanup-audit.json']:
    shutil.copy2(Path('.cache')/name,destination/name)

comparisons=[]; handle_comparisons=[]
for root in [Path('compatibility/evidence'),destination/'linux-053/evidence']:
    for kind,collection in [('console',comparisons),('handles',handle_comparisons)]:
        for path in sorted(root.glob(kind+'-*/report.json')):
            report=read(path)
            if report.get('sources')!=sources or 'outcomes' not in report: continue
            assert report['status']=='passed' and not report['sourceChangedDuringVerification'],path
            assert report['outcomes']['flashwright']==report['outcomes']['reference'],path
            collection.append({**reference(path),'node':report['node'],'browser':report['browser'],'sharedGroups':len(report['outcomes']['reference']),'referenceDifference':report['referenceDifferences']})
assert len(comparisons)==len(handle_comparisons)==3,(comparisons,handle_comparisons)
resources=[]
new_native=[Path(name) for name in subprocess.check_output(['git','ls-files','--others','--exclude-standard','compatibility/evidence/resources'],text=True).splitlines()]
for path in [*new_native,*destination.glob('**/resources/*.json'),*destination.glob('**/host-resources/*.json'),*destination.glob('node22-resources/*.json')]:
    report=read(path); assert not report['remainingObservedProcesses'],path
    observed={}
    for sample in report['samples']:
        assert sample['concurrentRssBytes']==sum(process['rssBytes'] for process in sample['processes']),path
        for process in sample['processes']:
            identity=(process['process'],process['started']); observed[identity]=max(observed.get(identity,0),process['cpuSeconds'])
    assert len(observed)==report['observedProcessCount'],path
    assert abs(sum(observed.values())-report['observedCpuSeconds'])<0.000001,path
    assert max((sample['concurrentRssBytes'] for sample in report['samples']),default=0)==report['maximumSampledConcurrentRssBytes'],path
    resources.append({**reference(path),**{key:report[key] for key in ['timedOut','interrupted','exitCode','cleanupSignals','cleanup']}})
checkpoint={
 'schemaVersion':1,'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'scope':'M2 live page/context console events and owned native argument handles, plus guardian/watchdog cleanup repairs. Functional verification only; no performance or release claim.',
 'sources':sources,'previousCheckpoint':reference('compatibility/evidence/handles-checkpoint-2026-10-08.json'),
 'provenance':reference('compatibility/upstream/console-provenance.json'),
 'contract':{
  'requiredCapabilities':['page.console.subscribe','context.console.subscribe'],
  'delivery':'Apply subscription controls in driver acceptance order. All EventEmitter registration/removal forms update capture; page listeners run before context listeners with the same message and argument objects. Evaluation replies wait for preceding browser events to be processed, without an extra browser command. Context subscriptions include future pages and main-world same-process child frames.',
  'arguments':'Retain the original execution context and remote reference without installing an evaluation helper during capture. Console references use individual releases rather than Chromium\'s shared console group. Property and evaluation results use separate private groups. Chromium console.clear invalidates its own object arguments; later disposal recognizes already-released references and preserves the page and unrelated private handles.',
  'diagnostics':'Pinned type, preview/text, exact UTF-16, first stack location and aliases, timestamp, page identity and null worker for this supported scope. Log.entryAdded supplies browser log entries with no argument handles; worker logs are excluded.',
  'bounds':'At most 4096 retained/pending public handles per page. Unobserved or discarded in-flight argument references enter a separate bounded 4096-ID queue, released in batches of 64. This background queue has no hidden application timeout. Unrepresentable events and exhausted capacity deliver a bounded originating global error before the stream closes and owned resources are released.',
  'intentionalDifference':'SPECS S4.l: preserve BigInt argument values and resulting console text where pinned Playwright 1.60.0 converts them to undefined. Retained separately from equal-result conformance.',
  'cleanupRepair':'The watchdog gives newly promoted orphan owners a fresh grace interval within its unchanged total cleanup bound. Guardian diagnostic writes tolerate a closed stderr pipe instead of panicking before browser/profile cleanup.',
 },
 'verification':{
  'nativeCore':{**reference(native_path),'groups':35,'rustTests':65,'lifecycleCases':82,'driverSha256':native['driverSha256']},
  'node22':{**reference(destination/'node22/report.json'),'groups':16,'consoleLifecycleCases':8,'handleLifecycleCases':7,'guardianLifecycleCases':7,'watchdogBrowserCases':6},
  'linuxFocused':{**reference(destination/'linux-053/evidence/console-focused-linux/report.json'),'groups':19,'rustTests':65,'consoleLifecycleCases':8,'handleLifecycleCases':7,'guardianLifecycleCases':7,'watchdogBrowserCases':6,'driverSha256':linux['driverSha256'],'environmentClass':linux['environmentClass'],'containerImage':linux['containerImage']},
  'linuxBurstRepetitions':{'cases':12, 'log':reference(destination/'linux-probe-054/run.log'), 'sourceReport':reference(destination/'linux-probe-054/source-report.json'), 'cleanupAudit':reference(destination/'linux-probe-054/container-audit.json')},
  'consoleComparisons':comparisons,'handleRegressions':handle_comparisons,'resourcesIndependentlyRecomputed':len(resources),
 },
 'developmentAttempts':[
  'The first differential expected +0 instead of the actual preserved -0; the fixture was corrected. Two reference runs then timed out because removing every BrowserContext listener removes its private close resolver. The all-listener test is isolated in a disposable context closed by browser teardown; no reference close hang is counted as a successful case.',
  'Native core attempt 001 failed two browser watchdog cases. Focused inspection found a promoted-owner grace race; a deterministic regression fails with the previous watchdog and passes with the fix. Ownership diagnostics additionally exposed guardian panic on a closed stderr pipe. The failed debug probe left four profiles, and the original failed core left two. All six were matched to recorded test windows, checked for active use and moved reversibly to ignored recovery storage. They are not claimed as successful automatic cleanup. The final frozen-source runs pass cleanup without those interventions.',
  'A console.clear probe exposed disposal of an already-released CDP object retiring the page. Exact missing-reference errors now count as completed release; both native and shared differential tests preserve page usability and unrelated private handles.',
  'Linux attempt 049 and exact-binary probes 050/052 failed the unobserved 1000-event long-task case, while probe 051 passed. Probe 052 retained the driver synchronization-failure shutdown reason. The primary event path was replaced with synchronous owner processing, without increasing the queue or reducing application work. The final frozen Linux matrix is checked separately from these retained failures.',
  'Build and Clippy attempts include corrected TypeScript EventEmitter override typing and Rust collapsible-if lint failures. Earlier successful smoke/differential runs predate the final source and do not substitute for the frozen matrix.',
 ],
 'environmentRecovery':'The local Linux image tag was absent. The pinned recipe was rebuilt using cached layers. When its tag later disappeared again, the recorded image digest remained present and was used directly for the owned verification container. This is emulated functional evidence only.',
 'eventBurstRepair':'The Linux 1000-event unobserved-console case intermittently overflowed the old 512-event primary broadcast queue. Applying engine metadata synchronously in the CDP read path removes that lossy primary handoff and preserves preceding-event/reply order. Secondary bounded storage interception waiters remain explicit-failure subscribers. Two transport regressions cover a 2048-event burst and originating event failure/closure without pending-lock reentrancy.',
 'cleanupAudit':reference(destination/'console-cleanup-audit.json'),
 'failedProfileRecovery':reference(destination/'console-cleanup-001/recovered-profiles.json'),
 'resourceReports':resources,
 'remaining':['Console/error history, workers, out-of-process frames and async listener-removal policies','ElementHandle-specific operations, additional by-value classes and cross-context element adoption','Broader runner/artifact/network/frame compatibility and M3 transport','Full current Linux core, native Linux CI/performance, contention, platform packages, material complete-flow speedup and release gates'],
 'performance':'No new performance claim. Previous timings remain bound to their recorded source/browser/binary snapshots.',
}
Path('compatibility/evidence/console-checkpoint-2026-10-08.json').write_text(json.dumps(checkpoint,indent=2)+'\n')
print(json.dumps({'sources':len(sources),'consoleComparisons':len(comparisons),'handleComparisons':len(handle_comparisons),'resourceReports':len(resources),'nativeDriver':native['driverSha256'],'linuxDriver':linux['driverSha256']},indent=2))
