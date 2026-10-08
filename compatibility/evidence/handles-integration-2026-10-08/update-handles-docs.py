from pathlib import Path
import json

checkpoint_path = 'compatibility/evidence/handles-checkpoint-2026-10-08.json'
checkpoint = json.loads(Path(checkpoint_path).read_text())
verification = 'All 33 native macOS core groups pass, including 62 Rust tests and 73 lifecycle cases. Ten focused Node22/headless-shell groups and thirteen focused Linux amd64-emulation groups pass at the same 199 source hashes. The three final handle differentials match nine shared groups, including ten primitive cases, and retain the S4.l BigInt difference separately. Seven native handle lifecycle/publication cases and all five caller-deadline allocation cases pass. Packed ESM/CommonJS consumers preserve nested handle inference, property types, DOM subtypes and frame evaluation. This is functional evidence only; full current Linux core, native Linux/performance and release gates remain open.'

path = Path('compatibility/reference-manifest.json')
value = json.loads(path.read_text())
engine = value['engineDevelopment']
engine['evidence'].append(checkpoint_path)
engine['handleCheckpoint'] = checkpoint_path
engine['handleStatus'] = verification
engine['sourceIdentity'] = f"199 source hashes match across 33 native macOS core groups, ten focused Node22/headless-shell groups and thirteen focused emulated Linux groups. Current debug binaries: macOS {checkpoint['verification']['nativeCore']['driverSha256']}; Linux {checkpoint['verification']['linuxFocused']['driverSha256']}. See {checkpoint_path}. No new performance claim."
value['upstreamSources'].append({'path':'compatibility/upstream/handle-value.source.js', 'provenance':'compatibility/upstream/handle-value-provenance.json', 'purpose':'Pinned value/preview reference inspection and adapted DOM reference descriptions; independent native ownership and bounded UTF-16 wire values'})
path.write_text(json.dumps(value, indent=2)+'\n')

path = Path('compatibility/development-coverage.json')
value = json.loads(path.read_text())
value['capabilities']['page'].append('evaluateHandle with JSHandle or ElementHandle identity')
value['capabilities']['frame'].extend(['evaluate in the same-process frame main world', 'evaluateHandle in the same-process frame main world'])
value['capabilities']['evaluation'].extend(['nested and repeated live JSHandle arguments with graph identity', 'DOM Node/Document/Window reference descriptions including nested values'])
value['capabilities']['handle'] = ['evaluate and evaluateHandle in the original execution context', 'jsonValue for the declared graph value classes', 'getProperty with one getter invocation', 'getProperties for enumerable own value descriptors, without invoking getters', 'asElement with preserved DOM subtype', 'toString preview', 'idempotent dispose and Symbol.asyncDispose', 'independent property-reference disposal', 'primitive handles across live pages and after navigation', 'detached DOM identity without rebinding to replacements']
value['implementation']['handles'] = checkpoint['contract']['ownership'] + ' ' + checkpoint['contract']['bounds'] + ' ' + checkpoint['contract']['intentionalDifference']
value['implementation']['handleVerification'] = verification + ' See ' + checkpoint_path
value['testSources'].extend(['compatibility/m2/handles.mjs','compatibility/m1/test_handles.py','tools/run-handle-tests.mjs','tools/record-handle-provenance.mjs'])
value['limitations'] = [item.replace('FrameLocator, handles and broader frame/navigation conformance remain unfinished', 'FrameLocator, cross-context ElementHandle adoption and broader frame/navigation conformance remain unfinished') for item in value['limitations']]
value['limitations'].append('ElementHandle-specific actions/reads remain typed unsupported; use a Locator for implemented operations. Handles can retain and evaluate Maps, functions and symbols, but jsonValue for those classes, Error/typed-array serialization, cross-context element adoption and out-of-process frame evaluation remain unsupported. Handle slots are capped at 4096 per page, including pending allocations. No new performance result applies to this binary.')
path.write_text(json.dumps(value, indent=2)+'\n')

path = Path('compatibility/milestones.json')
value = json.loads(path.read_text())
for milestone in value['milestones']:
 if milestone['id'] == 'M2':
  milestone['completed'].append('JSHandle and ElementHandle base lifecycle, exact UTF-16 property names/values, supported graph serialization, nested handle arguments and same-process frame evaluation are implemented with original-context ownership. New groups publish transactionally; disposal, navigation, cancellation, slot exhaustion and rejected/late replies release owned references. Detached DOM handles retain the original node. Primitive BigInt preservation is a documented S4.l reference difference. ' + verification)
  milestone['evidence'].append(checkpoint_path)
  milestone['remaining'] = [item.replace('Console, handles, worker/out-of-process/context pageerror events', 'Console arguments, additional handle value classes/element operations, worker/out-of-process/context pageerror events').replace('console, handles, broader diagnostic events and the rest', 'console arguments, additional handle classes/operations, broader diagnostic events and the rest') for item in milestone['remaining']]
value['nextImplementation'] = 'Continue M2 with console arguments and broader diagnostic/runner integration using the verified handle ownership boundary. Handle base lifecycle, supported graph values and same-process frame evaluation now pass the full native core and focused Node22/emulated Linux matrix. ElementHandle actions/reads, cross-context adoption, additional by-value classes and out-of-process evaluation remain open. Screenshot masks/comparison, broader routing/storage, M3 transport, native Linux, contention, platform packages and release gates remain open. Prior performance checkpoints apply only to their recorded binaries.'
path.write_text(json.dumps(value, indent=2)+'\n')

path = Path('README.md')
s = path.read_text().replace('Broader runner, artifact and API coverage remains unfinished.', 'JSHandle and ElementHandle base operations now preserve graph and DOM identity, with independent property disposal and original-frame ownership. Broader runner, artifact and API coverage remains unfinished.', 1)
s = s.replace('Workers, out-of-process frame diagnostics, console arguments, handles and retained error history remain open. The Linux run covers this slice rather than the full core suite.', 'At that checkpoint, workers, out-of-process frame diagnostics, console arguments, handles and retained error history remained open. That Linux run covered the diagnostic slice rather than the full core suite.')
s += '\nThe [handle checkpoint](compatibility/evidence/handles-checkpoint-2026-10-08.json) adds `evaluateHandle`, JSHandle base operations and same-process `Frame.evaluate`/`evaluateHandle`. Property handles survive parent disposal; detached DOM handles keep their original node; navigation frees destroyed object references. Cancellation, rejected replies and the 4096-handle limit have cleanup tests. All 33 native core groups, ten Node 22 groups and thirteen focused emulated Linux groups pass at 199 matching source hashes, with no retained owned processes or profiles. Primitive BigInt handles deliberately preserve their value where Playwright 1.60 loses it; S4.l records this separately. Element-specific actions, additional serialization classes, cross-context adoption and console arguments remain open. No new speed claim.\n'
path.write_text(s)

path = Path('SPECS.md')
s = path.read_text().replace('The complete runner adapter, broader navigation/frame/value conformance, remaining artifacts and release performance gates remain unfinished.', 'JSHandle and ElementHandle base lifecycle, nested handle arguments, supported graph values and same-process frame evaluation now preserve original-context ownership with bounded allocation cleanup. Element-specific operations and additional value classes remain unsupported. The complete runner adapter, broader navigation/frame/value conformance, remaining artifacts and release performance gates remain unfinished.', 1)
s = s.replace('Limits are negotiated and configurable where valid; exceeded limits return explicit resource errors without truncating requested content', 'Handle allocation additionally caps each page at 4096 retained or pending references; destroyed object contexts release those slots, while primitive handles remain alive until disposal or page closure. Limits are negotiated and configurable where valid; exceeded limits return explicit resource errors without truncating requested content', 1)
path.write_text(s)
