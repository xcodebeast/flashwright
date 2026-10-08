from pathlib import Path
import json

checkpoint_path = 'compatibility/evidence/diagnostics-checkpoint-2026-10-08.json'
checkpoint = json.loads(Path(checkpoint_path).read_text())
verification = 'All 31 native macOS core groups pass, including 58 Rust tests and 65 lifecycle cases. Seven focused Node22/headless-shell groups and ten focused Linux amd64-emulation groups pass at the same 191 source hashes. The final three diagnostic differentials match all 20 error cases and nine lifecycle checks exactly against Playwright 1.60.0. Packed ESM/CommonJS consumers preserve Error inference, and oversized exceptions fail with ResourceLimitError and release owned resources. This is functional evidence only; a full current Linux core and native Linux/performance/release gates remain open.'

path = Path('compatibility/reference-manifest.json')
value = json.loads(path.read_text())
engine = value['engineDevelopment']
engine['evidence'].append(checkpoint_path)
engine['pageErrorCheckpoint'] = checkpoint_path
engine['pageErrorStatus'] = verification
engine['sourceIdentity'] = f"191 source hashes match across 31 native macOS core groups, seven focused Node22/headless-shell groups and ten focused emulated Linux groups. Current debug binaries: macOS {checkpoint['verification']['nativeCore']['driverSha256']}; Linux {checkpoint['verification']['linuxFocused']['driverSha256']}. See {checkpoint_path}. No new performance claim."
value['upstreamSources'].append({'path':'compatibility/upstream/page-error.source.js', 'provenance':'compatibility/upstream/page-error-provenance.json', 'purpose':'Pinned Chromium exception formatting port; original event JSON preserves UTF-16 through Rust without another renderer command'})
path.write_text(json.dumps(value, indent=2)+'\n')

path = Path('compatibility/development-coverage.json')
value = json.loads(path.read_text())
value['capabilities']['page'].append('pageerror events and typed on/once/waitForEvent for main-page and same-process child-frame exceptions')
value['implementation']['pageErrors'] = 'Native Error name/message/stack follow pinned Chromium formatting. Original event JSON preserves exact UTF-16 through bounded Rust/Node framing; no renderer callback or retained history is added. Exceptions are routed only to live published pages by browser/session identity. Shared waits remain independent of pending evaluations and remove their listeners on settlement. Workers, out-of-process frames, context error events and pageErrors history remain outside this slice.'
value['implementation']['pageErrorVerification'] = verification + ' See ' + checkpoint_path
value['testSources'].extend(['compatibility/m2/diagnostics.mjs','tools/run-diagnostic-tests.mjs','tools/record-page-error-provenance.mjs'])
value['limitations'] = [item.replace('Popup/dialog/console/pageerror coverage remains unfinished', 'Popup/dialog/console coverage remains unfinished; pageerror supports the main-page session and same-process child frames, with worker/out-of-process/context events and retained history still open') for item in value['limitations']]
path.write_text(json.dumps(value, indent=2)+'\n')

path = Path('compatibility/milestones.json')
value = json.loads(path.read_text())
for milestone in value['milestones']:
 if milestone['id'] == 'M2':
  milestone['completed'].append('Pageerror event delivery preserves the pinned native Error name, message, stack and lone UTF-16 surrogates without further renderer evaluation. Main-page and same-process child-frame errors, navigation, ordering, identity, predicates and pending-operation independence pass. ' + verification)
  milestone['evidence'].append(checkpoint_path)
  milestone['remaining'] = [item.replace('Console/pageerror, handles and additional public event contracts', 'Console, handles, worker/out-of-process/context pageerror events, retained error history and additional public event contracts').replace('console/pageerror, handles and the rest', 'console, handles, broader diagnostic events and the rest') for item in milestone['remaining']]
value['nextImplementation'] = 'Continue M2 with JSHandle/ElementHandle lifecycle and serialization, then console arguments and broader diagnostic/runner integration. Pageerror now preserves pinned Error values and exact UTF-16 across main-page and same-process child-frame events; the current native core and focused Node22/emulated Linux checks pass. Handle ownership must remain bound to its original execution context, including cancellation, navigation and failed publication. Screenshot masks/comparison, cross-process routing/preparation, broader storage, M3 transport, native Linux, contention, platform packages and release gates remain open. Prior performance checkpoints apply only to their recorded binaries.'
path.write_text(json.dumps(value, indent=2)+'\n')

path = Path('README.md')
text = path.read_text().replace('Page screenshots return PNG/JPEG buffers and atomic files with font, style, caret and animation handling.', 'Page screenshots return PNG/JPEG buffers and atomic files with font, style, caret and animation handling. Typed `pageerror` listeners and waits preserve Chromium error names, messages and stacks from the page and same-process child frames.')
text += '\nThe [page-error checkpoint](compatibility/evidence/diagnostics-checkpoint-2026-10-08.json) matches 20 exception/rejection cases and nine event-lifecycle checks against Playwright, including exact UTF-16, navigation and delivery during pending evaluation. All 31 native macOS core groups, seven focused Node 22 groups and ten focused emulated Linux groups pass at 191 matching source hashes. Packed ESM/CommonJS listeners infer `Error`; oversized events fail explicitly and release owned resources. Workers, out-of-process frame diagnostics, console arguments, handles and retained error history remain open. The Linux run covers this slice rather than the full core suite. No new speed result is claimed.\n'
path.write_text(text)
