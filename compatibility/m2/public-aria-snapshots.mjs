import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Shared browser acceptance cases. The caller owns matched browsers, provenance and cleanup. */
export async function publicAriaSnapshotCases(browser, engine, outcomes = []) {
  const cases = [
    ['default, explicit, zero, negative and bounded depth', async page => {
      await markup(page, '<main><h1>Heading</h1><ul><li>First</li></ul><button>Save</button></main>');
      const output = [];
      for (const target of [page, page.locator('main')]) {
        const ordinary = await target.ariaSnapshot();
        assert.match(ordinary, /Heading/); assert.match(ordinary, /Save/);
        assert.equal(await target.ariaSnapshot({ mode: 'default' }), ordinary);
        assert.equal(await target.ariaSnapshot({ depth: 0 }), ordinary);
        assert.equal(await target.ariaSnapshot({ depth: -1 }), '');
        output.push(ordinary, await target.ariaSnapshot({ depth: 1 }));
      }
      return output;
    }],
    ['strict, hidden, absent and inherited timeout', async page => {
      await markup(page, '<button>First</button><button>Second</button><p hidden>Hidden</p>');
      await assert.rejects(() => page.locator('button').ariaSnapshot(), /strict mode violation/);
      assert.equal(await page.locator('p').ariaSnapshot(), '');
      page.setDefaultTimeout(80);
      await assert.rejects(() => page.locator('#absent').ariaSnapshot(), { name: 'TimeoutError' });
      return '';
    }],
    ['late Locator target with explicit zero timeout', async page => {
      await markup(page, '<main></main>'); page.setDefaultTimeout(1);
      await page.evaluate(() => setTimeout(() => { document.querySelector('main').innerHTML = '<button>Later</button>'; }, 80));
      const snapshot = await page.locator('button').ariaSnapshot({ timeout: 0 });
      assert.match(snapshot, /Later/); return snapshot;
    }],
    ['Page retries absent body', async page => {
      await page.evaluate(() => {
        document.body.remove();
        setTimeout(() => { const body = document.createElement('body'); body.innerHTML = '<button>Body returned</button>'; document.documentElement.append(body); }, 80);
      });
      const snapshot = await page.ariaSnapshot({ timeout: 2000 });
      assert.match(snapshot, /Body returned/); return snapshot;
    }],
    ['Unicode, shadow content and rounded boxes', async page => {
      await markup(page, '<button style="position:absolute;left:10.25px;top:20.75px;width:100.4px;height:30.6px">Save</button><div id="host"></div>');
      await page.evaluate(() => {
        document.querySelector('button').setAttribute('aria-label', 'Name \ud800 \ud83d\ude00');
        document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow</button>';
      });
      const snapshot = await page.ariaSnapshot();
      assert.match(snapshot, /Shadow/);
      return [snapshot, await page.locator('body > button').ariaSnapshot({ boxes: true })];
    }],
    ['same-process frame path and Page excludes child document', async page => {
      await markup(page, '<button>Parent</button><iframe id="child"></iframe>');
      await page.evaluate(() => { document.querySelector('iframe').contentDocument.body.innerHTML = '<button>Child</button>'; });
      const parent = await page.ariaSnapshot(); assert.doesNotMatch(parent, /Child/);
      const child = await page.frameLocator('#child').getByRole('button').ariaSnapshot();
      assert.match(child, /Child/); return [parent, child];
    }],
    ['frame path retries replacement while preserving original root', async page => {
      await markup(page, '<iframe id="child"></iframe>');
      await page.evaluate(() => setTimeout(() => {
        const previous = document.querySelector('iframe');
        const replacement = document.createElement('iframe'); replacement.id = 'child';
        previous.replaceWith(replacement); replacement.contentDocument.body.innerHTML = '<button>Replacement</button>';
      }, 80));
      const snapshot = await page.frameLocator('#child').getByRole('button').ariaSnapshot({ timeout: 2000 });
      assert.match(snapshot, /Replacement/); return snapshot;
    }],
    ['Locator waits delayed navigation with a live predecessor match', async page => {
      let releaseResponse;
      let observeRequest;
      const received = new Promise(resolve => { observeRequest = resolve; });
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        if (request.url === '/delayed') {
          releaseResponse = () => { releaseResponse = undefined; response.end('<button id="target">Successor</button>'); };
          observeRequest();
        } else response.end('<button id="target">Predecessor</button>');
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const origin = `http://127.0.0.1:${server.address().port}`;
      let navigation;
      let capture;
      try {
        await page.goto(origin);
        navigation = page.goto(origin + '/delayed');
        navigation.catch(() => {});
        await received;
        let settled = false;
        capture = page.locator('#target').ariaSnapshot({ timeout: 2000 }).finally(() => { settled = true; });
        capture.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 80));
        const settledBeforeCommit = settled;
        releaseResponse();
        await navigation;
        const output = await capture;
        assert.equal(settledBeforeCommit, false, 'capture must wait while predecessor remains live');
        assert.match(output, /Successor/); assert.doesNotMatch(output, /Predecessor/);
        return output;
      } finally {
        releaseResponse?.();
        await Promise.allSettled([navigation, capture]);
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }
    }],
    ['pending Locator retries root navigation', async page => {
      await markup(page, '<main>Old document</main>');
      const snapshot = page.locator('#destination').ariaSnapshot({ timeout: 2000 });
      await new Promise(resolve => setTimeout(resolve, 80));
      await page.goto('data:text/html,' + encodeURIComponent('<button id="destination">New document</button>'));
      const output = await snapshot; assert.match(output, /New document/); return output;
    }],
    ['deadline while renderer is blocked and late reply isolation', async page => {
      await markup(page, '<button id="target">Before block</button>');
      await page.locator('#target').ariaSnapshot();
      const entered = page.waitForEvent('console', message => message.text() === 'aria-block-start');
      let rendererFinished = false;
      const busy = page.evaluate(() => {
        console.log('aria-block-start');
        const until = performance.now() + 800;
        while (performance.now() < until) {}
        document.querySelector('#target').textContent = 'After block';
      }).finally(() => { rendererFinished = true; });
      busy.catch(() => {});
      await entered;
      await assert.rejects(() => page.locator('#target').ariaSnapshot({ timeout: 80 }), { name: 'TimeoutError' });
      assert.equal(rendererFinished, false, 'host deadline must settle while renderer is still blocked');
      await busy;
      const output = await page.locator('#target').ariaSnapshot();
      assert.match(output, /After block/); return output;
    }],
    ['owner closure cancels unbounded capture behind a blocked renderer', async page => {
      await markup(page, '<button id="target">Before close</button>');
      await page.locator('#target').ariaSnapshot();
      const entered = page.waitForEvent('console', message => message.text() === 'aria-close-start');
      const busy = page.evaluate(() => {
        console.log('aria-close-start');
        const until = performance.now() + 1200;
        while (performance.now() < until) {}
      });
      busy.catch(() => {});
      await entered;
      const capture = page.locator('#target').ariaSnapshot({ timeout: 0 });
      const rejected = assert.rejects(capture, /closed|destroyed|cancelled/i);
      await page.close(); await rejected; await Promise.allSettled([busy]); return '';
    }],
    ['closure interrupts missing target', async page => {
      const result = page.locator('#absent').ariaSnapshot({ timeout: 0 });
      const failure = assert.rejects(result, /closed/i);
      await page.close(); await failure; return '';
    }],
  ];
  for (const [name, run] of cases) {
    const context = await browser.newContext(); context.setDefaultTimeout(2000);
    const page = await context.newPage();
    try { outcomes.push({ name, value: await run(page) }); }
    catch (error) { outcomes.push({ name, error: { name: error.name, message: error.message, stack: error.stack } }); throw error; }
    finally { await context.close(); }
  }
  if (engine === 'flashwright') {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await assert.rejects(() => page.ariaSnapshot({ mode: 'ai' }), { name: 'UnsupportedFeatureError' });
      await assert.rejects(() => page.locator('#absent').ariaSnapshot({ mode: 'ai' }), { name: 'UnsupportedFeatureError' });
      await markup(page, '<main></main>');
      await page.evaluate(() => {
        const root = document.querySelector('main');
        for (let index = 0; index < 200; index++) {
          const button = document.createElement('button');
          button.textContent = `${index}:` + 'x'.repeat(800); root.append(button);
        }
      });
      await assert.rejects(() => page.ariaSnapshot(), { name: 'ResourceLimitError' });
      await assert.rejects(() => page.locator('main').ariaSnapshot(), { name: 'ResourceLimitError' });
      await markup(page, '<button>Recovered</button>');
      assert.match(await page.ariaSnapshot(), /Recovered/);
    } finally { await context.close(); }
  }
  return outcomes;
}
async function markup(page, html) { await page.evaluate(value => { document.body.innerHTML = value; }, html); }

/** Trace validation keeps ordinary browser capture enabled and rejects options before it starts. */
export async function publicAriaSnapshotTraceCase(browser, engine, path) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await markup(page, '<button>Trace snapshot</button>');
    // Observe frame callbacks before tracing so rendering opportunities add no DOM snapshot actions.
    let tracingStarted = false;
    const paintTimestamps = [];
    let painted;
    const paintCompleted = new Promise(resolve => { painted = resolve; });
    page.on('console', message => {
      if (!tracingStarted || paintTimestamps.length === 4 || !message.text().startsWith('public-aria-paint:')) return;
      paintTimestamps.push(Number(message.text().slice('public-aria-paint:'.length)));
      if (paintTimestamps.length === 4) painted();
    });
    await page.evaluate(() => {
      const button = document.querySelector('button');
      let count = 0;
      const paint = timestamp => {
        button.style.backgroundColor = ++count % 2 ? 'rgb(255,0,0)' : 'rgb(0,0,255)';
        console.log('public-aria-paint:' + timestamp);
        if (count < 300) requestAnimationFrame(paint);
      };
      requestAnimationFrame(paint);
    });
    await context.tracing.start({ snapshots: true, screenshots: true, sources: true });
    tracingStarted = true;
    let paintDeadline;
    try {
      await Promise.race([paintCompleted, new Promise((_, reject) => {
        paintDeadline = setTimeout(() => reject(new Error('ARIA filmstrip fixture did not observe four increasing frame callbacks')), 2000);
      })]);
    } finally { clearTimeout(paintDeadline); tracingStarted = false; }
    assert.equal(paintTimestamps.length, 4);
    assert.ok(paintTimestamps.every((timestamp, index) => Number.isFinite(timestamp)
      && (index === 0 || timestamp > paintTimestamps[index - 1])));
    const pageSnapshot = await page.ariaSnapshot();
    const locatorSnapshot = await page.locator('button').ariaSnapshot({ boxes: true });
    assert.match(pageSnapshot, /Trace snapshot/); assert.match(locatorSnapshot, /Trace snapshot/);
    if (engine === 'flashwright') {
      for (const target of [page, page.locator('button')]) {
        await assert.rejects(() => target.ariaSnapshot({ mode: 'ai' }), { name: 'UnsupportedFeatureError' });
        await assert.rejects(() => target.ariaSnapshot({ futureOption: true }), { name: 'UnsupportedFeatureError' });
        await assert.rejects(() => target.ariaSnapshot({ timeout: -1 }), { name: 'InvalidArgumentError' });
      }
    }
    await context.tracing.stop({ path });
    return { pageSnapshot, locatorSnapshot };
  } finally { await context.close(); }
}
