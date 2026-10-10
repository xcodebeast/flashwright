import { forbidUpstreamBrowserBackend } from "file:///workspace/benchmarks/native-backend-guard.mjs";
forbidUpstreamBrowserBackend();
export { test, expect, defineConfig } from "file:///workspace/packages/flashwright-test/dist/esm/index.js";
export const nativeBackendGuardActive = true;
