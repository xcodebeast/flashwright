async _initialize(hasUIWindow) {
        if (!this._page.isStorageStatePage && hasUIWindow && !this._crPage._browserContext._browser.isClank() && !this._crPage._browserContext._options.noDefaultViewport) {
          try {
            const { windowId } = await this._client.send("Browser.getWindowForTarget");
            this._windowId = windowId;
          } catch {
          }
        }
        if (this._isMainFrame() && hasUIWindow && !this._page.isStorageStatePage)
          startAutomaticVideoRecording(this._crPage._page);
        let lifecycleEventsEnabled;
        if (!this._isMainFrame())
          this._addRendererListeners();
        this._addBrowserListeners();
        this._bufferedAttachedToTargetEvents = [];
        const promises = [
          this._client.send("Page.enable"),
          this._client.send("Page.getFrameTree").then(({ frameTree }) => {
            if (this._isMainFrame()) {
              this._handleFrameTree(frameTree);
              this._addRendererListeners();
            }
            const attachedToTargetEvents = this._bufferedAttachedToTargetEvents || [];
            this._bufferedAttachedToTargetEvents = void 0;
            for (const event of attachedToTargetEvents)
              this._onAttachedToTarget(event);
            const localFrames = this._isMainFrame() ? this._page.frames() : [this._page.frameManager.frame(this._targetId)];
            for (const frame of localFrames) {
              this._client._sendMayFail("Page.createIsolatedWorld", {
                frameId: frame._id,
                grantUniveralAccess: true,
                worldName: this._crPage.utilityWorldName
              });
            }
            const isInitialEmptyPage = this._isMainFrame() && this._page.mainFrame().url() === ":";
            if (isInitialEmptyPage) {
              lifecycleEventsEnabled.catch((e) => {
              }).then(() => {
                this._eventListeners.push(eventsHelper.addEventListener(this._client, "Page.lifecycleEvent", (event) => this._onLifecycleEvent(event)));
              });
            } else {
              this._firstNonInitialNavigationCommittedFulfill();
              this._eventListeners.push(eventsHelper.addEventListener(this._client, "Page.lifecycleEvent", (event) => this._onLifecycleEvent(event)));
            }
          }),
          this._client.send("Log.enable", {}),
          lifecycleEventsEnabled = this._client.send("Page.setLifecycleEventsEnabled", { enabled: true }),
          this._client.send("Runtime.enable", {}),
          this._client.send("Page.addScriptToEvaluateOnNewDocument", {
            source: "",
            worldName: this._crPage.utilityWorldName
          }),
          this._crPage._networkManager.addSession(this._client, void 0, this._isMainFrame()),
          this._client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
        ];
        if (!this._page.isStorageStatePage) {
          const skipDefaultOverrides = this._crPage._browserContext._browser.options.noDefaults && this._crPage._browserContext === this._crPage._browserContext._browser._defaultContext;
          if (this._crPage._browserContext.needsPlaywrightBinding())
            promises.push(this.exposePlaywrightBinding());
          if (this._isMainFrame() && !skipDefaultOverrides)
            promises.push(this._client.send("Emulation.setFocusEmulationEnabled", { enabled: true }));
          const options2 = this._crPage._browserContext._options;
          if (options2.bypassCSP)
            promises.push(this._client.send("Page.setBypassCSP", { enabled: true }));
          if (options2.ignoreHTTPSErrors || options2.internalIgnoreHTTPSErrors)
            promises.push(this._client.send("Security.setIgnoreCertificateErrors", { ignore: true }));
          if (this._isMainFrame())
            promises.push(this._updateViewport());
          if (options2.hasTouch)
            promises.push(this._client.send("Emulation.setTouchEmulationEnabled", { enabled: true }));
          if (options2.javaScriptEnabled === false)
            promises.push(this._client.send("Emulation.setScriptExecutionDisabled", { value: true }));
          if (options2.userAgent || options2.locale)
            promises.push(this._updateUserAgent());
          if (options2.locale)
            promises.push(emulateLocale(this._client, options2.locale));
          if (options2.timezoneId)
            promises.push(emulateTimezone(this._client, options2.timezoneId));
          if (!this._crPage._browserContext._browser.options.headful)
            promises.push(this._setDefaultFontFamilies(this._client));
          promises.push(this._updateGeolocation(true));
          if (!skipDefaultOverrides)
            promises.push(this._updateEmulateMedia());
          promises.push(this._updateFileChooserInterception(true));
          for (const initScript of this._crPage._page.allInitScripts())
            promises.push(this._evaluateOnNewDocument(
              initScript,
              "main",
              true
              /* runImmediately */
            ));
        }
        promises.push(this._client.send("Runtime.runIfWaitingForDebugger"));
        promises.push(this._firstNonInitialNavigationCommittedPromise);
        await Promise.all(promises);
      }