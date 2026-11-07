# vendor/

Flashwright installs no third-party npm packages: the code it needs from npm is bundled into its own
files when it is built. The packages here are hard forks of that code, cut down to what Flashwright
uses, so that less third-party code ships and fewer packages are involved. Everything else that is
bundled comes from npm as it is (see each bundle's `.js.LICENSE` file in `lib/`).

## The forks

| Fork | Upstream | What is left out |
|---|---|---|
| `zod/` | zod 4.6.7 | Zod 3 and Zod Mini, messages in languages other than English, JSON Schema import, the schema compiler |
| `mcp-sdk/` | @modelcontextprotocol/sdk 1.32.2 | The client, OAuth, examples, Zod 3 support (with zod-to-json-schema), the Ajv JSON Schema validator (only used for elicitation answers). Hono's request listener and content-type are inlined in `deps/` |
| `zip.js/` | @zip.js/zip.js 2.24.0 | Web workers and WebAssembly codecs (Flashwright uses the browser's compression streams), the zip file system API |
| `enquirer/` | enquirer 2.4.1 | Every prompt but the text and multiselect prompts watch mode uses. ansi-colors and strip-ansi are inlined |
| `open/` | open 11.0.4 | Nothing, but its eleven helper packages are inlined in `deps/` |
| `debug/` | debug 4.4.3 | The browser build. ms and supports-color are inlined |

`stubs/browserslist.js` stands in for browserslist and its browser data in the Babel bundle; Babel only
calls it for browser targets, which the test transform never sets.

Each fork keeps its upstream license, and its `package.json` names the upstream version, so the
bundles' license files list them like any other package.

## Changing a fork

The forks are written by a script, do not edit them by hand:

```bash
node utils/vendor/vendor.mjs          # all of them
node utils/vendor/vendor.mjs zod      # one
```

`utils/vendor/recipes.mjs` has one recipe per fork: the pinned upstream version, the modules Flashwright
imports, and a few exact patches that cut what it does not use. The script downloads the upstream
package, applies the patches (each must match exactly once, so a changed upstream file stops it rather
than producing a broken fork), and copies only the files reachable from the imported modules.

To update a fork, change its version in the recipe and run the script. If a patch no longer applies,
upstream changed that code: read the new version and adjust the patch.

The build resolves the imports to the forks through `aliases.json`, which the script writes; TypeScript
through `paths` in `tsconfig.json`, which mirror the recipes' `typeAliases`.

## What stays a regular dependency

Packages that are small and rarely change (colors, progress, ini, retry, …) and packages where a
mistake costs too much (ws, yaml, the proxy agents, Babel) are bundled as they come from npm. The
upstream MCP SDK, zod and zip.js are still dev dependencies because the tests use them to check the
forks against the real thing.
