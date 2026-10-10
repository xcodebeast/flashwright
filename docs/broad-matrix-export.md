# Portable broad-matrix evidence

`tools/broad-matrix-snapshot.mjs` exports a completed, valid broad matrix without changing its workload, admission, comparison, or verifier semantics. Keep the original raw directory and the exact recorded source checkout. The exporter may run from a newer checkout, but both original and normalized evidence are verified by `tools/verify-broad-matrix.mjs` in the recorded checkout, with that checkout as the working directory. Its required installed dependencies must remain available.

Use Bun to run the exporter:

```sh
bun tools/broad-matrix-snapshot.mjs export RAW_DIRECTORY NEW_DESTINATION RECORDED_WORKSPACE PRIVATE_MAPPING_JSON
bun tools/broad-matrix-snapshot.mjs verify NEW_DESTINATION RECORDED_WORKSPACE
```

The optional private mapping file is an array of objects with `original` and `replacement` strings. Each original must be a specific absolute environment path. Additional replacement roots use `/environment/name`, for example `/environment/chromedriver` or `/environment/cypress-bundle`. Supply exact dependency, browser-profile, Cypress bundle/cache, or original checkout roots when those occur in retained evidence. Do not publish this mapping file. The raw evidence directory, recorded workspace, measured runtime, and browser executable are mapped automatically; macOS aliases of the supplied evidence directory are handled explicitly.

The destination contains `manifest.json` and the complete normalized inventory under `evidence/`. Nothing is omitted. The manifest records original and exported file hashes and the historical source manifest. Core log hashes, the core report hash in metadata, Cypress sample markers, competitor receipt inventories, and the final summary inventory are rebuilt in that order. Source and dependency hash maps remain unchanged. Every JSON and JSONL numeric observation and the complete Markdown comparison table must remain unchanged.

Flat core stdout logs named `verification/*.txt` or `verification/*.log` may contain arbitrary bytes, including malformed UTF-8 and NUL. Their bytes remain exactly unchanged outside explicit path substitutions; literal Unicode paths are matched as UTF-8 bytes, and encoded file URLs are mapped separately. The internal one-byte representation does not decode or re-encode the log. Private-path detection, including percent-encoded paths, still applies. Core log hashes are rebuilt from the retained normalized bytes.

JSON, JSONL, Markdown, nested verification logs, competitor stdout, and every other supported artifact retain strict UTF-8 and NUL rejection. Unknown private or temporary paths, broad home/temp mappings, symlinks, unsupported extensions, and unreviewed Cypress environment fields stop export. Currently reviewed Cypress environment keys are `CACHE_FOLDER` and `RUN_BINARY`; their values still undergo path validation. Full Cypress `runner-result.json` files are retained. If a future runner adds a field or artifact requiring another policy, review it explicitly before extending the exporter.

The independent snapshot verifier checks the exported inventory, requires each competitor receipt to cover its complete artifact inventory, validates the exact Cypress sample marker against the retained sample bytes, and invokes the same recorded-source verifier. Corruption tests repair the outer hashes after altering a marker, ensuring these checks validate the relationship between artifacts as well as their individual hashes. This confirms retained evidence against its historical source gate; it does not verify current live executable or installed dependency bytes, establish equivalence to a newer checkout, authenticate an untrusted manifest, or establish performance leadership. The original raw evidence is needed to independently audit the normalization itself. Tests use clearly marked synthetic full matrices, never published as measurements.
