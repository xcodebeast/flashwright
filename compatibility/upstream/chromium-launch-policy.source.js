const disabledFeatures = [
      // See https://github.com/microsoft/playwright/issues/14047
      "AvoidUnnecessaryBeforeUnloadCheckSync",
      // See https://github.com/microsoft/playwright/issues/38568
      "BoundaryEventDispatchTracksNodeRemoval",
      "DestroyProfileOnBrowserClose",
      // See https://github.com/microsoft/playwright/pull/13854
      "DialMediaRouteProvider",
      "GlobalMediaControls",
      // See https://github.com/microsoft/playwright/pull/27605
      "HttpsUpgrades",
      // Hides the Lens feature in the URL address bar. Its not working in unofficial builds.
      "LensOverlay",
      // See https://github.com/microsoft/playwright/pull/8162
      "MediaRouter",
      // See https://github.com/microsoft/playwright/issues/28023
      "PaintHolding",
      // See https://github.com/microsoft/playwright/issues/32230
      "ThirdPartyStoragePartitioning",
      // See https://github.com/microsoft/playwright/issues/16126
      "Translate",
      // See https://issues.chromium.org/u/1/issues/435410220
      "AutoDeElevate",
      // See https://github.com/microsoft/playwright/issues/37714
      "RenderDocument",
      // Prevents downloading optimization hints on startup.
      "OptimizationHints",
      // Disables forced sign-in in Edge.
      "msForceBrowserSignIn",
      // Disables updating the preferred version in LaunchServices preferences on mac.
      "msEdgeUpdateLaunchServicesPreferredVersion"
    ].filter(Boolean);
const chromiumSwitches = (options2) => [
      "--disable-field-trial-config",
      // https://source.chromium.org/chromium/chromium/src/+/main:testing/variations/README.md
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-back-forward-cache",
      // Avoids surprises like main request not being intercepted during page.goBack().
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-extensions-with-background-pages",
      "--disable-component-update",
      // Avoids unneeded network activity after startup.
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-edgeupdater",
      // Disables Edge-specific updater on mac.
      "--disable-extensions",
      "--disable-features=" + disabledFeatures.join(","),
      process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? "" : "--enable-features=CDPScreenshotNewSurface",
      "--allow-pre-commit-input",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-renderer-backgrounding",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--no-first-run",
      "--password-store=basic",
      "--use-mock-keychain",
      // See https://chromium-review.googlesource.com/c/chromium/src/+/2436773
      "--no-service-autorun",
      "--export-tagged-pdf",
      // https://chromium-review.googlesource.com/c/chromium/src/+/4853540
      "--disable-search-engine-choice-screen",
      // https://issues.chromium.org/41491762
      "--unsafely-disable-devtools-self-xss-warnings",
      // Edge can potentially restart on Windows (msRelaunchNoCompatLayer) which looses its file descriptors (stdout/stderr) and CDP (3/4). Disable until fixed upstream.
      "--edge-skip-compat-layer-relaunch",
      // This disables Chrome for Testing infobar that is visible in the persistent context.
      // The switch is ignored everywhere else, including Chromium/Chrome/Edge.
      "--disable-infobars",
      // Less annoying popups.
      "--disable-search-engine-choice-screen",
      // Prevents the "three dots" menu crash in IdentityManager::HasPrimaryAccount for ephemeral contexts.
      options2?.android ? "" : "--disable-sync"
    ].filter(Boolean);
class ChromiumDefaults {
async defaultArgs(options2, isPersistent, userDataDir) {
        const chromeArguments = this._innerDefaultArgs(options2);
        chromeArguments.push(`--user-data-dir=${userDataDir}`);
        chromeArguments.push("--remote-debugging-pipe");
        if (isPersistent)
          chromeArguments.push("about:blank");
        else
          chromeArguments.push("--no-startup-window");
        return chromeArguments;
      }
_innerDefaultArgs(options2) {
        const { args = [] } = options2;
        const userDataDirArg = args.find((arg) => arg.startsWith("--user-data-dir"));
        if (userDataDirArg)
          throw this._createUserDataDirArgMisuseError("--user-data-dir");
        if (args.find((arg) => arg.startsWith("--remote-debugging-pipe")))
          throw new Error("Playwright manages remote debugging connection itself.");
        if (args.find((arg) => !arg.startsWith("-")))
          throw new Error("Arguments can not specify page to be opened");
        const chromeArguments = [...chromiumSwitches()];
        chromeArguments.push("--enable-unsafe-swiftshader");
        if (options2.headless) {
          chromeArguments.push("--headless");
          chromeArguments.push(
            "--hide-scrollbars",
            "--mute-audio",
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"
          );
        }
        if (options2.chromiumSandbox !== true)
          chromeArguments.push("--no-sandbox");
        const proxy = options2.proxyOverride || options2.proxy;
        if (proxy) {
          const proxyURL = new URL(proxy.server);
          const isSocks = proxyURL.protocol === "socks5:";
          if (isSocks && !options2.socksProxyPort) {
            chromeArguments.push(`--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE ${proxyURL.hostname}"`);
          }
          chromeArguments.push(`--proxy-server=${proxy.server}`);
          const proxyBypassRules = [];
          if (proxy.bypass)
            proxyBypassRules.push(...proxy.bypass.split(",").map((t) => t.trim()).map((t) => t.startsWith(".") ? "*" + t : t));
          if (options2.socksProxyPort || shouldProxyLoopback(proxy.bypass))
            proxyBypassRules.push("<-loopback>");
          if (proxyBypassRules.length > 0)
            chromeArguments.push(`--proxy-bypass-list=${proxyBypassRules.join(";")}`);
        }
        chromeArguments.push(...args);
        return chromeArguments;
      }
}
