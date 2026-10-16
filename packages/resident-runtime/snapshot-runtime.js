/** Own bounded snapshot cache generations without mutating application prototypes or DOM nodes. */
function createSnapshotCapture(configuration = {}) {
  const maximumLimits = Object.freeze({
    maximumDataBytes: 4 * 1024 * 1024 - 64 * 1024,
    maximumNodes: 25000,
    maximumAttributes: 100000,
    maximumDepth: 128,
    maximumSheets: 1024,
    maximumRules: 100000,
    maximumCacheBytes: 2 * 1024 * 1024,
    maximumCacheNodes: 12500,
    maximumCacheAttributes: 50000,
    maximumCacheSheets: 512,
  });
  const limits = Object.freeze({ ...maximumLimits, ...configuration });
  for (const [name, value] of Object.entries(limits))
    if (!Object.hasOwn(maximumLimits, name) || !Number.isSafeInteger(value) || value < 0 || value > maximumLimits[name]) throw new Error(`Invalid snapshot limit: ${name}`);
  const createGeneration = () => ({ nodes: new WeakMap(), sheets: new WeakMap(), bytes: 0, nodeCount: 0, attributes: 0, sheetCount: 0 });
  let committed = createGeneration();
  let tentative;
  let lastCommittedSnapshot = 0;
  let pendingToken;
  let pendingSnapshotNumber;
  let retired = false;

  function failure(message) { return new Error(`SnapshotResourceLimit: ${message}`); }

  /** Count JSON string bytes before any escaped copy, preserving lone UTF-16 surrogates. */
  function stringBytes(value) {
    if (value.length + 2 > limits.maximumDataBytes) throw failure('a string exceeds the capture byte limit');
    // The native regexp scan avoids a JS loop for ordinary unescaped ASCII.
    if (!/["\\\x00-\x1f\x7f-\uffff]/.test(value)) return value.length + 2;
    let bytes = 2;
    for (let index = 0; index < value.length; index++) {
      const character = value.charCodeAt(index);
      if (character === 34 || character === 92 || character === 8 || character === 9 || character === 10 || character === 12 || character === 13) bytes += 2;
      else if (character < 32) bytes += 6;
      else if (character < 128) bytes++;
      else if (character < 2048) bytes += 2;
      else if (character >= 0xd800 && character <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
        else bytes += 6;
      } else if (character >= 0xdc00 && character <= 0xdfff) bytes += 6;
      else bytes += 3;
      if (bytes > limits.maximumDataBytes) throw failure('a string exceeds the capture byte limit');
    }
    return bytes;
  }
  function primitiveBytes(value) {
    if (typeof value === 'string') return stringBytes(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value).length;
    if (typeof value === 'boolean') return value ? 4 : 5;
    if (value === null) return 4;
    throw new Error('SnapshotProtocol: invalid primitive');
  }
  function safeUrl(value) { return /^(?:javascript|vbscript):/i.test(value.trimStart()) ? '' : value; }
  function cacheStats(generation) { return { bytes: generation.bytes, nodes: generation.nodeCount, attributes: generation.attributes, sheets: generation.sheetCount }; }

  function capture(options) {
    if (retired) throw new Error('SnapshotClosed: capture owner is retired');
    if (tentative) throw new Error('SnapshotProtocol: previous capture requires commit or discard');
    if (!Number.isSafeInteger(options.snapshotNumber) || options.snapshotNumber !== lastCommittedSnapshot + 1 || typeof options.token !== 'string' || !options.token.length || options.token.length > 128)
      throw new Error('SnapshotProtocol: invalid capture identity');
    const snapshotNumber = options.snapshotNumber;
    const started = performance.now();
    const frameIdentifiers = options.frames ?? [];
    if (!Array.isArray(frameIdentifiers) || frameIdentifiers.length > 128) throw new Error('SnapshotProtocol: frame mapping exceeds its limit');
    tentative = createGeneration();
    pendingToken = options.token;
    pendingSnapshotNumber = snapshotNumber;
    const counters = { bytes: 0, overrideBytes: 0, cssReadBytes: 0, nodes: 0, depth: 0, cssDepth: 0, attributes: 0, sheets: 0, rules: 0, overrideCount: 0 };
    let literalIndex = 0;
    const visitedSheets = new WeakMap();
    const overrides = [];
    const attributeCounts = new WeakMap();
    const overrideUrls = new Map();
    const customElements = new Set();
    const customElementStates = new Map();

    function reserve(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || counters.bytes + bytes > limits.maximumDataBytes) throw failure('capture exceeds its byte limit');
      counters.bytes += bytes;
    }
    function attribute(attributes, name, value) {
      if (++counters.attributes > limits.maximumAttributes) throw failure('capture exceeds its attribute limit');
      if (Object.hasOwn(attributes, name)) throw new Error('SnapshotProtocol: duplicate serialized attribute');
      const count = attributeCounts.get(attributes) ?? 0;
      reserve(stringBytes(name) + stringBytes(value) + (count ? 2 : 1));
      attributeCounts.set(attributes, count + 1);
      attributes[name] = value;
    }
    function arrayPrefix(name, attributes = Object.create(null)) {
      reserve(5 + stringBytes(name)); // [name,{}] without children
      return [name, attributes];
    }
    function appendChild(parent, child) { reserve(1); parent.push(child); }
    function reference(snapshot, index) {
      const result = [[snapshotNumber - snapshot, index]];
      reserve(5 + primitiveBytes(result[0][0]) + primitiveBytes(index));
      return result;
    }
    function makeComparison(oldEntry, sheet = false) {
      let equal = !!oldEntry;
      let position = 0;
      const values = [];
      let retainedBytes = 0;
      let retainedAttributes = 0;
      const countName = sheet ? 'sheetCount' : 'nodeCount';
      const maximum = sheet ? limits.maximumCacheSheets : limits.maximumCacheNodes;
      let admitted = tentative[countName] < maximum;
      if (admitted) tentative[countName]++;
      function abandon() {
        if (!admitted) return;
        tentative[countName]--;
        tentative.bytes -= retainedBytes;
        tentative.attributes -= retainedAttributes;
        admitted = false; retainedBytes = 0; retainedAttributes = 0; values.length = 0;
      }
      return {
        observe(value) {
          if (oldEntry?.values[position] !== value) equal = false;
          position++;
          const bytes = typeof value === 'string' ? value.length * 2 : 0;
          if (admitted && tentative.bytes + bytes <= limits.maximumCacheBytes) {
            tentative.bytes += bytes; retainedBytes += bytes; values.push(value);
          } else abandon();
        },
        attribute() {
          if (admitted && tentative.attributes < limits.maximumCacheAttributes) { tentative.attributes++; retainedAttributes++; }
          else abandon();
        },
        unequal() { equal = false; },
        equal() { return equal && position === oldEntry.values.length; },
        retain(map, key, snapshot, index) { if (admitted) map.set(key, { values, snapshot, index }); },
      };
    }
    function finishNode(key, output, comparison, oldEntry, startBytes, startIndex) {
      if (comparison.equal()) {
        counters.bytes = startBytes + counters.overrideBytes;
        literalIndex = startIndex;
        const html = reference(oldEntry.snapshot, oldEntry.index);
        comparison.retain(tentative.nodes, key, oldEntry.snapshot, oldEntry.index);
        return { html, equal: true, snapshot: oldEntry.snapshot, index: oldEntry.index };
      }
      const index = literalIndex++;
      comparison.retain(tentative.nodes, key, snapshotNumber, index);
      return { html: output, equal: false, snapshot: snapshotNumber, index };
    }
    function inspectRule(rule, depth) {
      if (++counters.rules > limits.maximumRules || depth > limits.maximumDepth) throw failure('capture exceeds its CSS rule limit');
      counters.cssDepth = Math.max(counters.cssDepth, depth);
      const children = rule.cssRules;
      if (children) for (let index = 0; index < children.length; index++) inspectRule(children[index], depth + 1);
    }
    function sheetText(sheet, depth = 1) {
      const visited = visitedSheets.get(sheet);
      if (visited) return visited;
      if (++counters.sheets > limits.maximumSheets || depth > limits.maximumDepth) throw failure('capture exceeds its stylesheet limit');
      const result = { text: '', inaccessible: false };
      visitedSheets.set(sheet, result);
      if (sheet.disabled) return result;
      let rules;
      try { rules = sheet.cssRules; }
      catch (error) {
        if (error?.name !== 'SecurityError') throw error;
        result.inaccessible = true;
        return result;
      }
      const parts = [];
      for (let index = 0; index < rules.length; index++) {
        const rule = rules[index];
        inspectRule(rule, depth);
        const text = rule.cssText;
        const bytes = stringBytes(text) + (index ? 1 : 0);
        if (counters.cssReadBytes + bytes > limits.maximumDataBytes) throw failure('stylesheet text exceeds the capture byte limit');
        counters.cssReadBytes += bytes;
        parts.push(text);
        if (rule.styleSheet) externalSheet(rule.styleSheet, depth + 1);
      }
      result.text = parts.join('\n');
      return result;
    }
    function externalSheet(sheet, depth = 1) {
      if (!sheet.href) return;
      const existed = visitedSheets.has(sheet);
      const content = sheetText(sheet, depth);
      if (existed || content.inaccessible) return;
      const url = new URL(sheet.href, document.baseURI); url.hash = '';
      const key = url.href;
      const previous = overrideUrls.get(key);
      if (previous !== undefined) {
        if (previous !== content.text) throw new Error('SnapshotUnsupported: distinct stylesheet content shares one URL');
        return;
      }
      const encodedBytes = stringBytes(key) + stringBytes(content.text) + 49;
      reserve(encodedBytes + 256);
      counters.overrideBytes += encodedBytes + 256;
      counters.overrideCount++;
      overrideUrls.set(key, content.text);
      overrides.push({ url: key, content: content.text, contentType: 'text/css' });
    }
    function adoptedSheet(sheet) {
      const content = sheetText(sheet);
      if (content.inaccessible) throw new Error('SnapshotUnsupported: inaccessible adopted stylesheet');
      const oldEntry = committed.sheets.get(sheet);
      const comparison = makeComparison(oldEntry, true);
      comparison.observe(content.text);
      if (comparison.equal()) {
        const html = reference(oldEntry.snapshot, oldEntry.index);
        comparison.retain(tentative.sheets, sheet, oldEntry.snapshot, oldEntry.index);
        return { html, equal: true, snapshot: oldEntry.snapshot, index: oldEntry.index };
      }
      const attributes = Object.create(null);
      const html = arrayPrefix('template', attributes);
      attribute(attributes, '__playwright_style_sheet_', content.text);
      const index = literalIndex++;
      comparison.retain(tentative.sheets, sheet, snapshotNumber, index);
      return { html, equal: false, snapshot: snapshotNumber, index };
    }
    function visit(node, depth = 1, inHead = false, inBody = false) {
      if (++counters.nodes > limits.maximumNodes || depth > limits.maximumDepth) throw failure('capture exceeds its DOM traversal limit');
      counters.depth = Math.max(counters.depth, depth);
      const kind = node.nodeType;
      if (kind !== 1 && kind !== 3 && kind !== 11) return;
      const name = kind === 11 ? 'template' : node.nodeName;
      if (name === 'SCRIPT' || name === 'NOSCRIPT' || name === 'META' && ['content-security-policy', 'refresh', 'set-cookie'].includes(node.httpEquiv.toLowerCase())) return;
      if (name === 'LINK' && ['preload', 'prefetch'].includes(node.rel.toLowerCase())) return;
      if (inHead && (name === 'IFRAME' || name === 'FRAME')) return;
      const oldEntry = committed.nodes.get(node);
      const comparison = makeComparison(oldEntry);
      const startBytes = counters.bytes - counters.overrideBytes;
      const startIndex = literalIndex;
      comparison.observe(name);
      if (kind === 3) {
        const value = node.nodeValue ?? '';
        reserve(stringBytes(value)); comparison.observe(value);
        return finishNode(node, value, comparison, oldEntry, startBytes, startIndex);
      }
      const attributes = Object.create(null);
      const output = arrayPrefix(name, attributes);
      const addAttribute = (key, value) => { attribute(attributes, key, String(value)); comparison.attribute(); comparison.observe(key); comparison.observe(String(value)); };
      const addChild = child => {
        if (!child) return;
        appendChild(output, child.html);
        comparison.observe(child.snapshot); comparison.observe(child.index);
        if (!child.equal) comparison.unequal();
      };
      if (kind === 11) addAttribute('__playwright_shadow_root_', 'open');
      if (kind === 1) {
        if (node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
          if (node.hasAttribute('is')) throw new Error('SnapshotUnsupported: customized built-in element markers are not supported');
          if (node.localName.includes('-')) {
            if (!inBody) throw new Error('SnapshotUnsupported: custom elements outside BODY are not supported');
            const defined = node.matches(':defined');
            const previous = customElementStates.get(node.localName);
            // The viewer defines names globally, so it cannot reproduce per-instance mixtures.
            if (previous !== undefined && previous !== defined) throw new Error('SnapshotUnsupported: one custom element name has mixed defined states');
            customElementStates.set(node.localName, defined);
            if (defined) customElements.add(node.localName);
          }
        }
        if (name === 'INPUT' || name === 'TEXTAREA') addAttribute('__playwright_value_', node.value);
        if (name === 'INPUT' && ['checkbox', 'radio'].includes(node.type)) addAttribute('__playwright_checked_', node.checked ? 'true' : 'false');
        if (name === 'OPTION') addAttribute('__playwright_selected_', node.selected ? 'true' : 'false');
        if (node.scrollTop) addAttribute('__playwright_scroll_top_', node.scrollTop);
        if (node.scrollLeft) addAttribute('__playwright_scroll_left_', node.scrollLeft);
        if (node.popover && node.matches(':popover-open')) addAttribute('__playwright_popover_open_', 'true');
        if (name === 'DIALOG' && node.open) addAttribute('__playwright_dialog_open_', node.matches(':modal') ? 'modal' : 'true');
        if (node === options.target) addAttribute('__playwright_target__', options.callId);
        if (['CANVAS', 'IFRAME', 'FRAME'].includes(name)) {
          const bounds = node.getBoundingClientRect();
          const geometry = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
          if (!Object.values(geometry).every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('SnapshotProtocol: invalid element geometry');
          addAttribute('__playwright_bounding_rect__', JSON.stringify(geometry));
        }
        if (name === 'IFRAME' || name === 'FRAME') {
          const mapping = frameIdentifiers.find(entry => entry.element === node);
          addAttribute('src', mapping ? `/snapshot/${mapping.frameId}` : '');
        }
        if (name === 'IMG' || name === 'PICTURE') addAttribute('__playwright_current_src__', name === 'IMG' ? safeUrl(node.currentSrc) : '');
        for (let index = 0; index < node.attributes.length; index++) {
          const item = node.attributes[index]; const key = item.name;
          if (Object.hasOwn(attributes, key) || name === 'LINK' && key === 'integrity' || name === 'IFRAME' && ['src', 'srcdoc', 'sandbox'].includes(key) || name === 'FRAME' && key === 'src' || name === 'DIALOG' && key === 'open') continue;
          let value = item.value;
          stringBytes(value);
          if (key.startsWith('on')) value = '';
          else if (key === 'src' || key === 'href') value = safeUrl(value);
          else if (name === 'META' && key === 'charset') value = 'utf-8';
          addAttribute(key, value);
        }
      }
      comparison.observe(null);
      if (name === 'STYLE' && node.sheet) {
        const content = sheetText(node.sheet);
        const text = content.inaccessible ? node.textContent ?? '' : content.text;
        reserve(stringBytes(text)); appendChild(output, text); literalIndex++;
        comparison.observe(text);
      } else {
        if (name === 'LINK' && node.sheet) externalSheet(node.sheet);
        if (kind === 1 && node.shadowRoot) addChild(visit(node.shadowRoot, depth + 1, false, inBody || name === 'BODY'));
        if (name === 'HEAD') {
          const baseAttributes = Object.create(null);
          const base = arrayPrefix('BASE', baseAttributes);
          attribute(baseAttributes, 'href', document.baseURI);
          appendChild(output, base);
          literalIndex++;
          comparison.observe(document.baseURI);
        }
        for (let child = node.firstChild; child; child = child.nextSibling) addChild(visit(child, depth + 1, inHead || name === 'HEAD', inBody || name === 'BODY'));
        const root = node === document.documentElement ? document : kind === 11 ? node : undefined;
        if (root) for (const sheet of root.adoptedStyleSheets ?? []) addChild(adoptedSheet(sheet));
      }
      if (name === 'BODY' && customElements.size) addAttribute('__playwright_custom_elements__', [...customElements].join(','));
      comparison.observe(null);
      return finishNode(node, output, comparison, oldEntry, startBytes, startIndex);
    }
    try {
      // Metadata is charged before DOM construction; no stringify-first admission check.
      const url = location.href;
      const doctype = document.doctype?.name ?? '';
      const viewport = { width: innerWidth, height: innerHeight };
      if (!Object.values(viewport).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff)) throw new Error('SnapshotProtocol: invalid viewport');
      const wallTime = Date.now();
      if (typeof wallTime !== 'number' || !Number.isFinite(wallTime) || wallTime < 0) throw new Error('SnapshotProtocol: invalid wall time');
      reserve(stringBytes(url) + stringBytes(doctype) + 3 * 32 + 512);
      const html = document.documentElement ? visit(document.documentElement).html : arrayPrefix('HTML');
      const collectionTime = performance.now() - started;
      if (!Number.isFinite(collectionTime) || collectionTime < 0) throw new Error('SnapshotProtocol: invalid collection time');
      reserve(32);
      const data = { html, doctype, resourceOverrides: overrides, viewport, url, wallTime, collectionTime };
      return { token: pendingToken, snapshotNumber, data, counters: { ...counters }, committedCache: cacheStats(committed), tentativeCache: cacheStats(tentative) };
    } catch (error) { tentative = undefined; pendingToken = undefined; pendingSnapshotNumber = undefined; throw error; }
  }
  function checkToken(token) {
    if (!tentative || pendingToken !== token) throw new Error('SnapshotProtocol: stale capture token');
  }
  return {
    capture,
    commit(token, snapshotNumber) {
      checkToken(token);
      if (snapshotNumber !== pendingSnapshotNumber) throw new Error('SnapshotProtocol: invalid committed snapshot');
      committed = tentative; tentative = undefined; pendingToken = undefined; pendingSnapshotNumber = undefined; lastCommittedSnapshot = snapshotNumber;
      return { snapshotNumber, cache: cacheStats(committed) };
    },
    discard(token) { checkToken(token); tentative = undefined; pendingToken = undefined; pendingSnapshotNumber = undefined; return true; },
    reset() { committed = createGeneration(); tentative = undefined; pendingToken = undefined; pendingSnapshotNumber = undefined; lastCommittedSnapshot = 0; return true; },
    retire() { this.reset(); retired = true; return true; },
    inspect() { return { retired, pendingToken, lastCommittedSnapshot, committed: cacheStats(committed), tentative: tentative ? cacheStats(tentative) : null }; },
  };
}
