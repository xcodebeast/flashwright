# N1 Source and distribution attribution

SVGOMG is authored by its upstream contributors and distributed under the [retained MIT notice](licenses/svgomg.txt). The retained app is a snapshot of the [Playwright demo distribution](https://demo.playwright.dev/svgomg/), with independent content hashes in [provenance.json](provenance.json). Its exact deployment commit is unknown. Source ancestry, confirmed emitted dependency inputs and the demo's disabled service-worker condition are recorded separately; no exact source-build reproduction is claimed

Playwright 1.60.0's unchanged six-test example is retained under [Apache-2.0](licenses/playwright.txt), with its [NOTICE](licenses/playwright-notice.txt). The original `test-svgs/car-lite.svg` RDF metadata identifies “little red racing car,” creator Onsemeliot, and `http://creativecommons.org/licenses/publicdomain/`. That historical URL resolves to the [Copyright-Only Dedication or Public Domain Certification 1.0 United States](https://creativecommons.org/publicdomain/certification/1.0/us/); the original declaration remains in the unchanged SVG. This attribution doesn't relabel it as CC0 or claim independently verified artwork provenance

# N2 Confirmed emitted dependency notices

| Component | Confirmed input version | Notice |
| --- | --- | --- |
| nanoevents | 6.0.1 | [MIT](licenses/nanoevents.txt) |
| Prism | 1.27.0 | [MIT](licenses/prismjs.txt) |
| SVGO | 2.7.0 | [MIT](licenses/svgo.txt) |
| pako | 2.0.4 | [MIT](licenses/pako-mit.txt) and [Zlib notice in original deflate source](licenses/pako-zlib-source.txt) |
| Inconsolata | Exact font binary revision unverified | [SIL Open Font License 1.1](licenses/inconsolata.txt) |

pako's published deflate source is retained unchanged so its original Zlib copyright, permission and restrictions are complete. That file isn't served as application code. Font family attribution follows retained font-face CSS; font hashes are pinned, while the binary metadata/build-time revision hasn't been verified. The OFL notice is retained from a separately pinned Google Fonts source commit

# N3 Conservative SVGO dependency notices

The following notices correspond to the non-development dependency set in the [retained upstream SVGO 2.7.0 lock](provenance/svgo-v2.7.0-package-lock.json). This includes a conservative superset of possible bundled dependencies; it doesn't claim every listed package occurs in the emitted browser bundle. The [upstream browser bundler configuration](provenance/svgo-v2.7.0-rollup.config.js) is also retained

| Package | Version | Notice |
| --- | --- | --- |
| @trysound/sax | 0.2.0 | [ISC](licenses/svgo-dependencies/trysound-sax.txt) |
| boolbase | 1.0.0 | [ISC](licenses/svgo-dependencies/boolbase.txt) |
| commander | 7.2.0 | [MIT](licenses/svgo-dependencies/commander.txt) |
| css-select | 4.1.3 | [BSD-2-Clause](licenses/svgo-dependencies/css-select.txt) |
| css-tree | 1.1.3 | [MIT](licenses/svgo-dependencies/css-tree.txt) |
| css-what | 5.0.1 | [BSD-2-Clause](licenses/svgo-dependencies/css-what.txt) |
| csso | 4.2.0 | [MIT](licenses/svgo-dependencies/csso.txt) |
| dom-serializer | 1.3.2 | [MIT](licenses/svgo-dependencies/dom-serializer.txt) |
| domelementtype | 2.2.0 | [BSD-2-Clause](licenses/svgo-dependencies/domelementtype.txt) |
| domhandler | 4.2.2 | [BSD-2-Clause](licenses/svgo-dependencies/domhandler.txt) |
| domutils | 2.8.0 | [BSD-2-Clause](licenses/svgo-dependencies/domutils.txt) |
| entities | 2.2.0 | [BSD-2-Clause](licenses/svgo-dependencies/entities.txt) |
| mdn-data | 2.0.14 | [CC0-1.0](licenses/svgo-dependencies/mdn-data.txt) |
| nanocolors | 0.1.12 | [MIT](licenses/svgo-dependencies/nanocolors.txt) |
| nth-check | 2.0.0 | [BSD-2-Clause](licenses/svgo-dependencies/nth-check.txt) |
| source-map | 0.6.1 | [BSD-3-Clause](licenses/svgo-dependencies/source-map.txt) |
| stable | 0.1.8 | [MIT in complete published README](licenses/svgo-dependencies/stable.txt) |

boolbase's published 1.0.0 package declares ISC but doesn't contain a standalone notice. Its unchanged upstream repository notice is pinned at `be0bcd8a4e917a0a5895e95b523fbbed05a64871`. stable's published README contains its complete MIT notice; that original file is retained. Necessary upstream copyright names and notice addresses remain intact
