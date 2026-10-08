from pathlib import Path
import json

checkpoint = 'compatibility/evidence/output-limits-checkpoint-2026-10-08.json'
assert json.loads(Path(checkpoint).read_text())['acceptedChecks']['nativeCoreGroups'] == 54

path = Path('compatibility/milestones.json')
document = json.loads(path.read_text())
milestone = next(item for item in document['milestones'] if item['id'] == 'M1')
milestone['completed'].append('Outbound results and dynamic error diagnostics obey negotiated byte/depth/node limits before any transport write. Rejected calls preserve input delivery and cleanup without replay; rejected allocations remain private and are disposed. Oversized events fail the stream explicitly. Two native core configurations pass all 54 groups at 170 matching source hashes, plus eight Node22 groups and 26 focused emulated Linux cases. The retained full Linux lifecycle batch still exceeded its job budget.')
milestone['evidence'].append(checkpoint)
milestone['remaining'].append('Complete full Linux verification and explain retained broad lifecycle failures; focused passes and clean forced cleanup do not replace that matrix.')
document['nextImplementation'] = 'Implement the M2 page screenshot Buffer/file slice with bounded artifact transfer, pinned defaults, atomic files and cancellation cleanup. Outbound control limits now reject individual oversized results without closing the driver or replaying effects; allocation publication and diagnostic limits are verified. Preserve the incomplete full Linux matrix and its failure evidence; improve immediate lifecycle failure diagnostics before another broad run so a watchdog cannot erase the traceback. IndexedDB, existing-context replacement, console/pageerror, handles, M3 transport, native Linux, contention, platform packages and release gates remain open. Prior performance checkpoints apply only to their recorded binaries; output-limit conformance makes no new timing claim.'
path.write_text(json.dumps(document, indent=2) + '\n')

path = Path('compatibility/development-coverage.json')
document = json.loads(path.read_text())
document['implementation']['outboundLimits'] = 'Driver replies are validated and encoded once before writing. Byte/depth/node overflow becomes a per-call ResourceLimitError, retaining input delivery and cleanup without replay. UTF-16 errors and diagnostics share the payload node budget; fixed error metadata stays representable. Events that cannot fit send a global error and close. Allocations remain private until their reply is accepted; rejection performs bounded disposal. See ' + checkpoint
for name in ['crates/flashwright-driver/src/output.rs', 'crates/flashwright-engine/src/publication.rs', 'compatibility/m1/output_limits.py']:
    if name not in document['testSources']:
        document['testSources'].append(name)
document['limitations'] = [item for item in document['limitations'] if not item.startswith('The general outbound control-frame overflow path')]
document['limitations'].append('Output-limit conformance passes 54 native core groups, eight Node22 groups and 26 focused emulated Linux cases at 170 matching source hashes. A Linux Rust compilation exceeded its 120-second job budget; after build preparation the full lifecycle batch exceeded its unchanged 240-second budget following a blocked-pointer case failure. The complete public lifecycle class then passed separately. Both failed runs are retained, with no observed process/profile residue; the full Linux matrix remains incomplete. No ordinary performance result applies to this new binary yet.')
path.write_text(json.dumps(document, indent=2) + '\n')

path = Path('compatibility/reference-manifest.json')
document = json.loads(path.read_text())
engine = document['engineDevelopment']
engine['evidence'].append(checkpoint)
engine['outputLimitsCheckpoint'] = checkpoint
engine['sourceIdentity'] = '170 matching source hashes pass 54 core groups on macOS Node24 full Chromium with residency on and headless shell with residency off. Eight focused Node22 groups and 26 focused emulated Linux cases pass. The full Linux matrix remains incomplete and both broad failures are retained. Optimized macOS driver: dec9fe0d132eab0bfc00395b381eacf5d75fe8a332bc1b45aa84d3cda36e28f8.'
engine['performanceStatus'] += ' These performance observations apply to the immutable evaluation-helper binary, before storage and output-limit changes. The current output-limit checkpoint has no new timing claim.'
path.write_text(json.dumps(document, indent=2) + '\n')

path = Path('README.md')
text = path.read_text()
needle = 'The full Linux matrix remains open; no new performance claim is made.'
assert text.count(needle) == 1
text = text.replace(needle, 'That checkpoint left the full Linux matrix open and made no new performance claim.')
paragraph = 'The [output-limit checkpoint](' + checkpoint + ') records 54 passing native core groups, eight focused Node 22 groups and 26 focused emulated Linux cases at 170 matching source hashes. Oversized results and errors now reject only their call, preserving input delivery and cleanup without replay. Allocations stay private until their successful reply fits; rejected allocations are disposed. An event that cannot fit closes the stream with an explicit resource error. The full Linux run again exhausted its lifecycle job budget, and a preceding compilation attempt also timed out; both failures and clean cleanup audits are retained. All ten public lifecycle cases passed separately. The full Linux gate remains open, and prior performance figures do not apply to this new binary.\n\n'
needle = 'The Linux script runs in the pinned Playwright container'
assert text.count(needle) == 1
text = text.replace(needle, paragraph + needle)
path.write_text(text)
print('Updated checkpoint routing, current source identity and remaining gates.')
