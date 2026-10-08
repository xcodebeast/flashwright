import assert from 'node:assert/strict';

function assertReleased(result) {
  assert.equal(result.cacheDepth, 0);
  assert.equal(result.metrics.cachedSelectorPrefixes, 0);
  assert.equal(result.metrics.selectorBatchActive, false);
  assert.ok(Object.values(result.cacheSizes).every(size => size === 0), JSON.stringify(result.cacheSizes));
  for (const name of ['activeConditions', 'observedRoots', 'queuedDiscovery', 'queuedConditions']) assert.equal(result.metrics[name], 0, name);
  for (const name of ['fallbackSchedulingQueued', 'animationFrameScheduled', 'fallbackTimerScheduled', 'deadlineTimerScheduled', 'discoveryTimerScheduled', 'flushMicrotaskScheduled', 'flushTaskScheduled', 'flushChannelOpen']) assert.equal(result.metrics[name], false, name);
}

/** Native locator integration, including cache opt-out for arbitrary callbacks and selectors. */
export async function verifyConditionQueryBatches({ reset, evaluate, page, cases }) {
  async function prepare(html) {
    // Withhold only registry fallback wakeups so one mutation gives one measured sweep.
    await reset(html, true, false, true, true);
    await evaluate(`(() => {
      globalThis.nativeTokens = [];
      globalThis.nativePromises = [];
      globalThis.startNativeCondition = (token, selector, expression, request) => {
        const json = JSON.stringify({selector,...request});
        const units = Array.from({length:json.length}, (_, index) => json.charCodeAt(index));
        nativeTokens.push(token);
        nativePromises.push(testLocator.waitForAssertion(units, Date.now() + 3000, expression, false, token));
      };
      globalThis.nativeCacheState = metrics => ({metrics,cacheDepth:testInjected._evaluator._retainCacheCounter,
        cacheSizes:Object.fromEntries(Object.entries(testInjected._evaluator).filter(([name]) => name.startsWith('_cache')).map(([name,value]) => [name,value.size]))});
      globalThis.inspectNativeConditions = async () => {
        // Each condition captures its own completion state; inspect again after all have ended.
        const json = JSON.stringify({selector:'css=body'});
        const units = Array.from({length:json.length}, (_, index) => json.charCodeAt(index));
        const audit = await testLocator.waitForAssertion(units, Date.now() + 1000, 'to.be.attached', false, 'terminal-audit');
        return {...nativeCacheState(audit.observation.conditionMetrics),terminalAuditPredicates:1};
      };
      globalThis.cancelNativeConditions = () => { for (const token of nativeTokens) testLocator.cancelAssertion(token); };
      return true;
    })()`);
  }

  const comparisons = [];
  for (const selectorBatchCache of [false, true]) {
    await prepare('<section>' + '<p class="item">before</p>'.repeat(32) + '</section>');
    const result = await evaluate(`(async () => {
      testLocator = createTestLocator(${selectorBatchCache});
      const originalQuery = Document.prototype.querySelectorAll;
      const originalResolution = testInjected.querySelectorAll;
      const originalExpect = testInjected._expectCore;
      let queries = 0;
      let predicates = 0;
      let resolutions = 0;
      const elementIndices = new Map([...document.querySelectorAll('.item')].map((element,index) => [element,index]));
      const checksPerCondition = Array(32).fill(0);
      Document.prototype.querySelectorAll = function(selector) {
        if (selector === '.item') queries++;
        return originalQuery.call(this, selector);
      };
      testInjected._expectCore = function(...arguments_) {
        predicates++;
        const index = elementIndices.get(arguments_[0]);
        if (index !== undefined) checksPerCondition[index]++;
        return originalExpect.apply(this, arguments_);
      };
      testInjected.querySelectorAll = function(selector, ...arguments_) {
        if (selector.parts[0].source === '.item') resolutions++;
        return originalResolution.call(this, selector, ...arguments_);
      };
      try {
        for (let index = 0; index < 32; index++) startNativeCondition(String(index), 'css=.item >> nth=' + index,
          'to.have.text', {expectedText:[{string:'after',normalizeWhiteSpace:true}]});
        // Registration performs the first read synchronously. Browser events may
        // legitimately invalidate the group after the next task boundary.
        const initial = {queries,predicates,resolutions};
        await new Promise(resolve => setTimeout(resolve, 0));
        document.body.setAttribute('data-invalidate', 'one');
        const deadline = performance.now() + 2000;
        while (checksPerCondition.some(count => count < 2) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
        const rechecks = {queries:queries-initial.queries,predicates:predicates-initial.predicates,resolutions:resolutions-initial.resolutions};
        cancelNativeConditions();
        const results = await Promise.all(nativePromises);
        return {initial,rechecks,checksPerCondition,statuses:results.map(result => result.status),
          ...(await inspectNativeConditions())};
      } finally {
        cancelNativeConditions();
        Document.prototype.querySelectorAll = originalQuery;
        testInjected._expectCore = originalExpect;
        testInjected.querySelectorAll = originalResolution;
      }
    })()`);
    assert.deepEqual(result.initial, { queries: 32, predicates: 32, resolutions: selectorBatchCache ? 0 : 32 });
    assert.ok(result.rechecks.predicates >= 32);
    assert.ok(result.checksPerCondition.every(count => count >= 2));
    assert.deepEqual(result.statuses, Array(32).fill('cancelled'));
    assertReleased(result);
    comparisons.push({ selectorBatchCache, ...result });
  }
  assert.equal(comparisons[0].rechecks.queries, comparisons[0].rechecks.predicates);
  assert.equal(comparisons[0].rechecks.resolutions, comparisons[0].rechecks.predicates);
  assert.ok(comparisons[1].rechecks.queries < comparisons[1].rechecks.predicates && comparisons[1].rechecks.queries > 0, JSON.stringify(comparisons));
  assert.equal(comparisons[1].rechecks.resolutions, 0);
  cases.push({ name: 'synchronous selector batches share native queries without skipping predicates', comparisons });
  console.log(`Resident registry: ${cases.at(-1).name}`);
  assert.equal(await page.evaluate(() => Document.prototype.querySelectorAll.toString().includes('[native code]')), true,
    'Isolated diagnostic wrappers must not modify application prototypes');

  const indexedComparisons = [];
  for (const selectorBatchCache of [false, true]) {
    await prepare('<section>' + '<p class="item">ready</p>'.repeat(4000) + '</section>');
    const result = await evaluate(`(async () => {
      testLocator = createTestLocator(${selectorBatchCache});
      const originalQuery = Document.prototype.querySelectorAll;
      const originalIterator = NodeList.prototype[Symbol.iterator];
      const shadowDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot');
      const originalExpect = testInjected._expectCore;
      const selectors = [];
      let iteratedNodes = 0;
      let shadowRootReads = 0;
      let predicates = 0;
      let resolution;
      Document.prototype.querySelectorAll = function(selector) {
        selectors.push(selector);
        return originalQuery.call(this, selector);
      };
      NodeList.prototype[Symbol.iterator] = function*() {
        for (const element of originalIterator.call(this)) { iteratedNodes++; yield element; }
      };
      Object.defineProperty(Element.prototype, 'shadowRoot', {...shadowDescriptor, get() {
        shadowRootReads++;
        return shadowDescriptor.get.call(this);
      }});
      testInjected._expectCore = function(...arguments_) {
        predicates++;
        resolution = {selectors:[...selectors],iteratedNodes,shadowRootReads};
        return originalExpect.apply(this, arguments_);
      };
      let status;
      try {
        startNativeCondition('last-document-match', 'css=.item >> nth=3999', 'to.have.text', {expectedText:[{string:'ready'}]});
        [{status}] = await Promise.all(nativePromises);
      } finally {
        cancelNativeConditions();
        Document.prototype.querySelectorAll = originalQuery;
        NodeList.prototype[Symbol.iterator] = originalIterator;
        Object.defineProperty(Element.prototype, 'shadowRoot', shadowDescriptor);
        testInjected._expectCore = originalExpect;
      }
      return {status,predicates,resolution,...(await inspectNativeConditions())};
    })()`);
    assert.equal(result.status, 'matched');
    assert.equal(result.predicates, 1);
    assertReleased(result);
    indexedComparisons.push({ selectorBatchCache, ...result });
  }
  assert.deepEqual(indexedComparisons[0].resolution.selectors, ['.item', '*']);
  assert.ok(indexedComparisons[0].resolution.iteratedNodes >= 8000);
  assert.ok(indexedComparisons[0].resolution.shadowRootReads >= 4000);
  assert.deepEqual(indexedComparisons[1].resolution, { selectors: ['.item'], iteratedNodes: 0, shadowRootReads: 0 });
  cases.push({ name: 'positive CSS index avoids copying all matches and scanning shadow hosts', comparisons: indexedComparisons });
  console.log(`Resident registry: ${cases.at(-1).name}`);

  await prepare('<section><p class="item" data-note="a &gt;&gt; nth=0">light-zero</p><div id="first-shadow"></div><p class="item">light-one</p><div id="second-shadow"></div><p class="item other">light-two</p></section>');
  const shadowIndexing = await evaluate(`(async () => {
    document.querySelector('#first-shadow').attachShadow({mode:'open'}).innerHTML = '<p class="item">shadow-zero</p><div id="nested"></div>';
    document.querySelector('#first-shadow').shadowRoot.querySelector('#nested').attachShadow({mode:'open'}).innerHTML = '<p class="item">nested</p>';
    document.querySelector('#second-shadow').attachShadow({mode:'open'}).innerHTML = '<p class="item">shadow-one</p>';
    const samples = [
      ['css=.item >> nth=0','light-zero'], ['css=.item >> nth=2','light-two'],
      ['css=.item >> nth=3','shadow-zero'], ['css=.item >> nth=4','nested'],
      ['css=.item >> nth=5','shadow-one'], ['css=.item >> nth=-1','shadow-one'],
      ['css=.item >> nth=-2','nested'], ['css=.item >> nth=1.8','light-one'],
      ['css=.item[data-note="a >> nth=0"] >> nth=0','light-zero'],
      ['css=.item:text("shadow") >> nth=0','shadow-zero'],
      ['css=section > .item >> nth=2','light-two'],
      ['css=section >> css=.item >> nth=3','shadow-zero'],
      ['css=.item, .other >> nth=1','shadow-zero']
    ];
    const reference = samples.map(([selector]) => testInjected.querySelector(testInjected.parseSelector(selector), document, true)?.textContent);
    try {
      for (const [index,[selector,value]] of samples.entries())
        startNativeCondition('index-' + index, selector, 'to.have.text', {expectedText:[{string:value}]});
      for (const index of [6,99,-99]) startNativeCondition('missing-' + index, 'css=.item >> nth=' + index, 'to.have.count', {expectedNumber:0});
      startNativeCondition('array', 'css=.item >> nth=2', 'to.have.text.array', {expectedText:[{string:'light-two'}]});
      startNativeCondition('captured-index', '*css=.item >> nth=0', 'to.have.text', {expectedText:[{string:'light-zero'}]});
      const results = await Promise.all(nativePromises);
      return {reference,expected:samples.map(([,value]) => value),statuses:results.map(result => result.status),
        captureMessage:results.at(-1).message,...(await inspectNativeConditions())};
    } finally { cancelNativeConditions(); }
  })()`);
  assert.deepEqual(shadowIndexing.reference, shadowIndexing.expected);
  assert.deepEqual(shadowIndexing.statuses, [...Array(shadowIndexing.expected.length + 4).fill('matched'), 'error']);
  assert.ok(shadowIndexing.captureMessage.units.map(unit => String.fromCharCode(unit)).join('').includes('capture'));
  assertReleased(shadowIndexing);
  cases.push({ name: 'indexed document matches preserve shadow order and full-selector fallbacks', ...shadowIndexing });
  console.log(`Resident registry: ${cases.at(-1).name}`);

  await prepare('<section><p class="item">before</p><p class="item remove">before</p><p class="item remove">before</p><div id="shadow-host"></div></section>');
  const changingRoots = await evaluate(`(async () => {
    const shadow = document.querySelector('#shadow-host').attachShadow({mode:'open'});
    shadow.innerHTML = '<p class="item">before</p><p class="item">before</p><p class="item">before</p>';
    const samples = [[-1,'shadow-two'],[0,'light'],[1,'shadow-zero'],[-2,'shadow-one'],[2,'shadow-one'],[3,'shadow-two']];
    try {
      for (const [index,value] of samples) startNativeCondition('moving-' + index, 'css=.item >> nth=' + index,
        'to.have.text', {expectedText:[{string:value}]});
      startNativeCondition('removed-index', 'css=.item >> nth=4', 'to.have.count', {expectedNumber:0});
      await new Promise(resolve => setTimeout(resolve, 0));
      for (const element of document.querySelectorAll('.remove')) element.remove();
      document.querySelector('.item').textContent = 'light';
      [...shadow.querySelectorAll('.item')].forEach((element,index) => { element.textContent = ['shadow-zero','shadow-one','shadow-two'][index]; });
      const results = await Promise.all(nativePromises);
      return {statuses:results.map(result => result.status),...(await inspectNativeConditions())};
    } finally { cancelNativeConditions(); }
  })()`);
  assert.deepEqual(changingRoots.statuses, Array(7).fill('matched'));
  assertReleased(changingRoots);
  cases.push({ name: 'fresh indexed batches follow targets between document and shadow matches', ...changingRoots });
  console.log(`Resident registry: ${cases.at(-1).name}`);

  await prepare('<section data-note="a &gt;&gt; nth=0">' + '<p class="item">before</p>'.repeat(100) + '</section>');
  const indexing = await evaluate(`(async () => {
    try {
      const prefix = 'css=section[data-note="a >> nth=0"] > .item';
      for (const [index,expected] of [[0,'zero'],[1,'one'],[2,'two'],[-1,'two'],[-2,'one']])
        startNativeCondition(String(index), prefix + ' >> nth=' + index, 'to.have.text', {expectedText:[{string:expected}]});
      for (const index of [99,-99]) startNativeCondition(String(index), prefix + ' >> nth=' + index, 'to.have.count', {expectedNumber:0});
      await new Promise(resolve => setTimeout(resolve, 0));
      document.querySelector('section').innerHTML = '<p class="item">zero</p><p class="item">one</p><p class="item">two</p>';
      const results = await Promise.all(nativePromises);
      return {statuses:results.map(result => result.status),...(await inspectNativeConditions())};
    } finally { cancelNativeConditions(); }
  })()`);
  assert.deepEqual(indexing.statuses, Array(7).fill('matched'));
  assertReleased(indexing);
  cases.push({ name: 'shared prefixes preserve quoted separators, negative indices and missing targets', ...indexing });
  console.log(`Resident registry: ${cases.at(-1).name}`);

  for (const replace of [false, true]) {
    await prepare('<section>' + '<input class="item" value="before">'.repeat(16) + '</section>');
    const result = await evaluate(`(async () => {
      const originalExpect = testInjected._expectCore;
      let predicates = 0;
      let boundary;
      testInjected._expectCore = function(...arguments_) {
        if (++predicates === 17) queueMicrotask(() => {
          boundary = nativeCacheState(null);
          for (const element of document.querySelectorAll('.item')) {
            if (${replace}) {
              const successor = document.createElement('input');
              successor.className = 'item'; successor.value = 'after'; element.replaceWith(successor);
            } else element.value = 'after';
          }
          document.body.setAttribute('data-invalidate', 'after-microtask');
        });
        return originalExpect.apply(this, arguments_);
      };
      try {
        for (let index = 0; index < 16; index++) startNativeCondition(String(index), 'css=.item >> nth=' + index,
          'to.have.value', {expectedText:[{string:'after'}]});
        await new Promise(resolve => setTimeout(resolve, 0));
        document.body.setAttribute('data-invalidate', 'start');
        const results = await Promise.all(nativePromises);
        return {boundary,predicates,statuses:results.map(result => result.status),
          ...(await inspectNativeConditions())};
      } finally { cancelNativeConditions(); testInjected._expectCore = originalExpect; }
    })()`);
    assert.deepEqual(result.statuses, Array(16).fill('matched'));
    assert.equal(result.boundary.cacheDepth, 0);
    assert.ok(Object.values(result.boundary.cacheSizes).every(size => size === 0));
    assertReleased(result);
    cases.push({ name: replace ? 'replacement after a batch sees fresh membership' : 'property changes after a batch still execute fresh predicates', ...result });
    console.log(`Resident registry: ${cases.at(-1).name}`);
  }

  await prepare('<input class="item" value="before"><p id="callback"></p>');
  const callback = await evaluate(`(async () => {
    let armed = false;
    let callbackDepth;
    Object.defineProperty(document.querySelector('#callback'), 'fixtureValue', {get() {
      if (!armed) return 'before';
      callbackDepth = testInjected._evaluator._retainCacheCounter;
      const successor = document.createElement('input'); successor.className = 'item'; successor.value = 'after';
      document.querySelector('.item').replaceWith(successor);
      return 'after';
    }});
    try {
      startNativeCondition('before-callback', 'css=.item', 'to.have.value', {expectedText:[{string:'after'}]});
      // Private fault injection: public application-script assertions remain unsupported.
      startNativeCondition('callback', 'css=#callback', 'to.have.property', {expressionArg:'fixtureValue',expectedValue:'after'});
      startNativeCondition('after-callback', 'css=.item', 'to.have.value', {expectedText:[{string:'after'}]});
      await new Promise(resolve => setTimeout(resolve, 0));
      armed = true;
      document.body.setAttribute('data-invalidate', 'callback');
      const results = await Promise.all(nativePromises);
      return {callbackDepth,statuses:results.map(result => result.status),...(await inspectNativeConditions())};
    } finally { cancelNativeConditions(); }
  })()`);
  assert.equal(callback.callbackDepth, 0);
  assert.deepEqual(callback.statuses, ['matched', 'matched', 'matched']);
  assertReleased(callback);
  cases.push({ name: 'application callback predicates close any adjacent query-cache scopes', ...callback });
  console.log(`Resident registry: ${cases.at(-1).name}`);

  await prepare('<div class="item"><span></span></div>');
  const custom = await evaluate(`(async () => {
    let armed = false;
    const depths = [];
    testInjected._engines.set('fixture', {queryAll(root) {
      depths.push(testInjected._evaluator._retainCacheCounter);
      return armed ? [root] : [];
    }});
    try {
      startNativeCondition('custom-selector', 'css=.item >> internal:has=' + JSON.stringify('fixture=child'),
        'to.have.count', {expectedNumber:1});
      await new Promise(resolve => setTimeout(resolve, 0));
      const initialDepths = depths.splice(0);
      armed = true; document.body.setAttribute('data-invalidate', 'custom');
      const [result] = await Promise.all(nativePromises);
      return {initialDepths,recheckDepths:depths,status:result.status,...(await inspectNativeConditions())};
    } finally { cancelNativeConditions(); testInjected._engines.delete('fixture'); }
  })()`);
  assert.equal(custom.status, 'matched');
  assert.deepEqual(custom.recheckDepths, custom.initialDepths, 'Unknown nested selector engine inherited an extra batch scope');
  assert.ok(custom.initialDepths.length > 0);
  assertReleased(custom);
  cases.push({ name: 'unknown nested selector engines remain outside shared query scopes', ...custom });
  console.log(`Resident registry: ${cases.at(-1).name}`);

  await prepare('<input class="item" value="before"><p class="survivor">before</p>');
  const failure = await evaluate(`(async () => {
    try {
      startNativeCondition('invalid-input', 'css=.item', 'to.have.value', {expectedText:[{string:'after'}]});
      startNativeCondition('survivor', 'css=.survivor', 'to.have.text', {expectedText:[{string:'after'}]});
      await new Promise(resolve => setTimeout(resolve, 0));
      document.querySelector('.item').outerHTML = '<p class="item">after</p>';
      document.querySelector('.survivor').textContent = 'after';
      const results = await Promise.all(nativePromises);
      return {statuses:results.map(result => result.status),message:results[0].message,
        ...(await inspectNativeConditions())};
    } finally { cancelNativeConditions(); }
  })()`);
  assert.deepEqual(failure.statuses, ['error', 'matched']);
  assert.ok(failure.message);
  assertReleased(failure);
  cases.push({ name: 'predicate errors release query scopes and preserve unrelated progress', ...failure });
  console.log(`Resident registry: ${cases.at(-1).name}`);
}
