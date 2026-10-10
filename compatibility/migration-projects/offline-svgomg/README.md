# V1 Retained application and tests

This fixture retains the complete selected six-test SVGOMG example from Playwright 1.60.0, plus a content-hashed snapshot of the app served at [the public demo](https://demo.playwright.dev/svgomg/). The original test file, app JavaScript, workers, stylesheets, fonts, SVG, icons, manifest, changelog and six source maps remain unchanged. [provenance.json](provenance.json) records every retained file's URL, byte count and SHA-256

The snapshot contains 14 runtime assets and six source maps. Its distribution identity is `64dc06d645ea14ac6663122584c062525f124c4f7fd3b4c0b9ff6f0526bd3821`; the manifest defines its digest calculation. This is an exact retained distribution, not a claim that a source checkout reproduces its bundles. The closest inspected first-party source commit matches 33 of 35 mapped JavaScript source inputs; the other two differences and dependency-version differences are recorded separately. The app's version label alone doesn't establish its deployment revision. Local Git attributes preserve retained line endings and permit only the inherited whitespace in two unchanged notices

The demo source maps contain byte-identical published inputs from nanoevents 6.0.1, Prism 1.27.0, pako 2.0.4 and SVGO 2.7.0. [NOTICE.md](NOTICE.md) and `licenses/` retain first-party, dependency, font and Playwright notices, including pako's Zlib notice and the conservative SVGO dependency set. The original car SVG retains its creator and public-domain declaration. The exact font build-time revision hasn't been established; Inconsolata identification follows the retained CSS

# V2 Shared local adaptations

The existing corpus server serves ordinary application files at `/svgomg/` over loopback HTTP with no-store caching. The app needs no build or installation. It uses its real JavaScript workers and native browser behavior

The server applies one declared HTML replacement: remove the callback that loads Google Analytics from another origin. The original HTML is retained; the served HTML must have SHA-256 `92934025bffff1e410c3a417bd9c837d2d6bd0e9a6152baca560157f935cdb01`. App JavaScript, workers, UI and inline CSS stay unchanged. The public demo already disables service-worker registration. No test-time interception or resource replay is used

Generated tests replace the package import through the engine adapter and replace only the beforeEach setup URL with the local HTTP URL. All six test callback bodies and declaration lines stay unchanged. Native file selection, the in-memory SVG upload, sandboxed data-URL iframe preview, real blob download and the `car-lite.svg` filename remain part of the workload. Fresh runner contexts isolate IndexedDB settings

# V3 Admission status and commands

The repaired fixture is source-materialized and unverified. The first local attempt used the earlier incomplete distribution: each engine attempted all six tests, with one pass and five failures. Both engines requested the omitted `all.css` six times and received HTTP 404; the five failures involved pointer interception. That attempt was rejected, with clean owned-process teardown and no performance acceptance. Its original fixture commit, manifest, distribution and receipt identities remain in `provenance.json`. These results don't establish an engine API gap

This revision restores the unchanged public-demo `all.css`, its source map and the map referenced by the inline CSS. A static HTML/CSS audit covers resource attributes, style elements/attributes, stylesheet URLs/imports and source-map comments, including unquoted HTML attributes. Every discovered local reference is retained; the three inline font URLs already existed, and the embedded SVG background needs no HTTP request. Compiled `all.css` has no URLs or imports. Dynamic JavaScript and functional browser admission remain separate. This repaired distribution has no timing, packed-package or native Linux claim

Once the checkout is built and a runtime window is available, run from the repository root:

```sh
FLASHWRIGHT_BROWSER_PATH=/absolute/path/to/pinned/chromium \
FLASHWRIGHT_DRIVER_PATH=/absolute/path/to/integrated/flashwright-driver \
bun tools/run-application-suite.mjs NEW_OUTPUT_DIRECTORY svgomg
```

The existing functional harness runs both engines with one worker, no retries, the same browser/viewport/artifact settings and all six tests. Its Flashwright adapter rejects entry into the upstream browser/request backend. Recheck its complete receipt from the recorded checkout and dependencies:

```sh
bun tools/verify-application-suite.mjs RETAINED_DIRECTORY
```

HTTP expectations are proposed from static inspection: six document/page-script/stylesheet loads, four demo SVG loads and at least five SVGO worker loads when every test passes. The rejected attempt observed six stylesheet requests on each engine, all unsuccessful. The repaired baseline must verify six HTTP 200 stylesheet responses; the successful-suite SVG/worker counts remain unverified. Preserve every request and investigate differences before accepting or changing those counts. Lazy gzip/Prism workers, optional fonts/icons/manifest/maps and conditional changelog loading have no mandatory counts

Admission requires six passes on each engine, unchanged source/body/binary identities, declared successful HTTP requests and clean owned-process teardown without watchdog intervention. The functional receipt explicitly sets `performanceAccepted: false`; later matched runner measurements must use this same complete fixture and retain preparation, failure, teardown and resource costs
