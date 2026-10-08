import json
from pathlib import Path

checkpoint_path='compatibility/evidence/storage-checkpoint-2026-10-08.json'
checkpoint=json.loads(Path(checkpoint_path).read_text())
assert checkpoint['totalCoreGroups']==81
path=Path('compatibility/development-coverage.json')
coverage=json.loads(path.read_text())
coverage['capabilities']['browser'].append('newContext/newPage with cookie and HTTP(S) localStorage storageState object or file')
coverage['capabilities']['context'].extend(['cookies with URL filtering', 'addCookies including Chromium partition keys', 'clearCookies with name/domain/path string or RegExp filters', 'storageState with atomic path output and exact UTF-16 localStorage'])
coverage['implementation']['contextStorage']='Context-owned visited origins survive page closure. Native context-scoped cookie commands serialize with state snapshots. Private origin pages fulfill their requests locally, bypass service workers and preserve exact UTF-16 entries. Cancelled prior-document interceptions are consumed without replay; unrelated fulfillment failures propagate. Initial restoration finishes before publication, snapshot files replace atomically, and uncertain mutation acknowledgements retire the affected context without replay. SPECS S4.j records the intentional reference service-worker difference. See '+checkpoint_path
coverage['implementation']['runner'] += ' Native storageState fixtures inherit contextOptions and support explicit object and file overrides.'
coverage['implementation']['residentRegistryExperiment']=coverage['implementation']['residentRegistryExperiment'].replace('Current 104 core groups', 'The preceding evaluation-helper checkpoint records 104 core groups')
coverage['implementation']['evaluationRuntime'] += ' These performance results predate cookie/storage-state implementation and apply to the recorded binary only.'
for source in ['crates/flashwright-engine/src/context_state.rs','crates/flashwright-engine/src/storage.rs','compatibility/m2/storage.mjs','tools/run-storage-tests.mjs']:
 if source not in coverage['testSources']: coverage['testSources'].append(source)
coverage['limitations']=[value for value in coverage['limitations'] if not value.startswith('Two current matched headless-shell Playwright comparisons')]
coverage['limitations']=[value.replace('The current 64-launch ordinary plan', 'The preceding evaluation-helper 64-launch ordinary plan') for value in coverage['limitations']]
coverage['limitations'].append('Basic storage excludes IndexedDB, existing-context setStorageState, non-HTTP origins and out-of-process child-frame collection. Snapshot origin, UTF-16 and serialized-message caps fail explicitly. Temporary pages bypass service-worker interception; the pinned reference can execute worker-supplied application code during fallback collection, an intentional documented difference rather than full service-worker parity.')
coverage['limitations'].append('The general outbound control-frame overflow path still shuts down the driver instead of returning a per-call ResourceLimitError. Snapshot results have a local guard; large cookie results and future artifacts require the next M1 transport fix.')
coverage['limitations'].append('Cookie/storage-state conformance adds 81 core groups over three native macOS configurations, focused Node22 checks, and three complete storage-corpus runs on emulated Linux. The full Linux run after the interception fix exceeded its lifecycle watchdog budget and remains incomplete; its forced cleanup left an owned profile in the stopped container, which was removed. Watchdog profile cleanup remains open. Ordinary performance has not been rerun for this new binary; prior timing and CPU claims remain bound to their immutable checkpoints.')
path.write_text(json.dumps(coverage,indent=2)+'\n')

path=Path('compatibility/milestones.json')
milestones=json.loads(path.read_text())
for milestone in milestones['milestones']:
 if milestone['id'] in ['M1','M2']:
  milestone['evidence'].append(checkpoint_path)
 if milestone['id']=='M1':
  milestone['completed'].append('Context-scoped cookie mutation deadlines and context-close interruption pass stopped-browser cases; uncertainty retires the owning context without replay. All 29 lifecycle/protocol cases pass on native macOS. The final full Linux run remained incomplete at its external job budget; its earlier three cookie deadline/closure cases had passed.')
 if milestone['id']=='M2':
  milestone['completed'].append('Basic cookies and cookie/localStorage state round trips pass 81 full-core groups over native macOS browser/configuration variants, Node22 focused checks, and three post-fix storage corpora on emulated Linux. The final full Linux core run is incomplete, with forced watchdog cleanup retained as a gap. Coverage includes partitioned cookies, selective clearing, real HTTP authentication, exact UTF-16, closed-page and same-process child origins, private HTTPS restoration, atomic files, failure cleanup, runner fixture precedence and packed consumers. The service-worker fallback difference is documented in SPECS S4.j.')
  milestone['remaining']=[value.replace('Cookies/storage state, screenshot artifacts and the rest of the S9 preview minimum','Screenshot artifacts, console/pageerror, handles and the rest of the S9 preview minimum; broader storage conformance (IndexedDB, existing-context replacement and cross-process origins) remains open') for value in milestone['remaining']]
milestones['nextImplementation']='Fix M1 watchdog cleanup so forced job termination gives the guardian a bounded chance to release its profile, retaining escalation for unresponsive descendants. Complete the full Linux verification gap. Then fix the M1 general outbound control-message limit before adding M2 screenshot artifacts: oversized command results currently shut down the driver rather than returning a per-call ResourceLimitError. Preserve acknowledged input/effects and the usable stream without replay; test negotiated low limits, oversized values/errors and successor commands. Then implement the M2 screenshot Buffer/file slice with pinned defaults and cleanup. Basic cookies/localStorage state now have a complete development conformance checkpoint. IndexedDB, existing-context replacement, console/pageerror, handles, M3 transport, native Linux, contention, platform packages and release gates remain open. Existing performance checkpoints apply only to their recorded binaries; the storage change has no new timing claim.'
path.write_text(json.dumps(milestones,indent=2)+'\n')

path=Path('SPECS.md')
source=path.read_text()
source=source.replace('owns contexts/pages, evaluates values and navigates real HTTP pages with network and lifecycle events.', 'owns contexts/pages, evaluates values and navigates real HTTP pages with network and lifecycle events. Basic cookies and exact UTF-16 localStorage state now round-trip through objects/files and native runner fixtures; private origin pages preserve isolation, with the documented service-worker collection difference in S4.j.')
path.write_text(source)
path=Path('README.md')
source=path.read_text()
paragraph='''The [cookie and storage-state checkpoint](compatibility/evidence/storage-checkpoint-2026-10-08.json) records 81 passing core groups across three native macOS configurations at 166 matching source hashes, plus Node 22 checks and three focused storage-corpus runs on emulated Linux. The final full Linux run exhausted its lifecycle watchdog budget; its forced cleanup left an owned profile in the stopped container, which was removed. Full Linux verification and orderly watchdog cleanup remain open. Cookie attributes, partitioned-cookie restoration, URL filters and selective clearing match the pinned reference. Object/file snapshots preserve localStorage UTF-16 data, closed-page and child origins, and real HTTP login cookies. Runner fixture precedence and packed ESM/CommonJS consumers pass. Snapshot limits reject explicitly, failed files preserve the prior complete snapshot, and uncertain writes retire their context without replay.

Temporary origin pages stay private and send no application requests. They also bypass service workers: the pinned reference can execute a worker-supplied document during fallback collection and thereby mutate the storage it is saving. This deliberate difference is retained in the fixture and [SPECS S4.j](SPECS.md#s4-compatibility-and-unsupported-behavior). IndexedDB, existing-context replacement, non-HTTP origin state and cross-process collection remain unsupported. The prior performance figures apply to their recorded binaries; this implementation has no new timing claim.

'''
marker='The Linux script runs in the pinned Playwright container'
assert marker in source
source=source.replace(marker,paragraph+marker)
path.write_text(source)
print('Updated storage development coverage; release status remains incomplete.')
