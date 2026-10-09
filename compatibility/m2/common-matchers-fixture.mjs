import assert from 'node:assert/strict';

export const commonMatcherHTML = `<!doctype html><meta charset="utf-8"><title>Common matchers</title>
<style id="styles">#styled { color: rgb(12, 34, 56); width: 42px; --token: ticket; } #styled::before { content: "before"; } #styled::after { content: "after"; }</style>
<div id="classes" class="alpha beta">Classes</div><section id="class-list"><div class="first selected"></div><div class="second"></div></section>
<div id="styled">Styled</div><button id="implicit-role">Save</button><div id="explicit-role" role="switch">Power</div>
<label id="choices-label" for="choices">Choices</label><select id="choices" multiple><option value="one" selected>One</option><option value="two">Two</option><option value="three" selected>Three</option></select>
<select id="single"><option>One</option></select><span id="label" hidden> External   label </span><button id="named" aria-labelledby="label" aria-describedby="description">Ignored</button>
<p id="description" hidden> Helpful   details </p><input id="invalid" aria-invalid="true" aria-errormessage="error"><p id="error"> Required   value </p>
<div id="replace" class="before">Replacement</div><div id="shadow-host"></div><iframe name="child" src="/child"></iframe>`;

/** Shared reference/candidate cases assert outcomes, with no timing comparison or fallback browser path. */
export async function commonMatcherCases(page, expect, check, baseURL, implementation) {
  const short = expect.configure({ timeout: 80 });
  const rejects = async operation => {
    await assert.rejects(async () => operation(), error => {
      assert.equal(typeof error.message, 'string');
      assert(error.message.length > 10);
      return true;
    });
  };
  await check('class matching preserves exact string, regex and element-array ordering', async () => {
    await expect(page.locator('#classes')).toHaveClass('alpha beta');
    await expect(page.locator('#classes')).toHaveClass(/^alpha\s+beta$/);
    await expect(page.locator('#classes')).not.toHaveClass('beta alpha');
    await expect(page.locator('#class-list > div')).toHaveClass(Object.freeze(['first selected', /second/]));
    await expect(page.locator('#class-list > div')).not.toHaveClass(['second', 'first selected']);
    await expect(page.locator('#missing')).toHaveClass([]);
    await expect(page.locator('#missing')).not.toHaveClass(['anything']);
  });
  await check('partial classes match tokens with exact list cardinality and reject regex', async () => {
    await expect(page.locator('#classes')).toContainClass('beta alpha');
    await expect(page.locator('#classes')).toContainClass('  beta\talpha  ');
    await expect(page.locator('#classes')).toContainClass('');
    await expect(page.locator('#classes')).not.toContainClass('alph');
    await expect(page.locator('#class-list > div')).toContainClass(['selected', 'second']);
    await expect(page.locator('#class-list > div')).not.toContainClass(['selected']);
    await expect(page.locator('#missing')).toContainClass([]);
    await rejects(() => expect(page.locator('#classes')).toContainClass(/alpha/));
    await rejects(() => expect(page.locator('#classes')).toContainClass([/alpha/]));
  });
  await check('computed CSS includes scalar regex and before/after pseudo-elements', async () => {
    await expect(page.locator('#styled')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.locator('#styled')).toHaveCSS('width', /^42px$/);
    await expect(page.locator('#styled')).toHaveCSS('--token', 'ticket');
    await expect(page.locator('#styled')).toHaveCSS('content', '"before"', { pseudo: 'before' });
    await expect(page.locator('#styled')).toHaveCSS('content', /after/, { pseudo: 'after' });
    await expect(page.locator('#styled')).not.toHaveCSS('display', 'inline');
  });
  await check('ID predicates use scalar exact and regex semantics', async () => {
    await expect(page.locator('#classes')).toHaveId('classes');
    await expect(page.locator('#classes')).toHaveId(/^class/);
    await expect(page.locator('#classes')).not.toHaveId('Classes');
    await expect(page.locator('#class-list > div').first()).toHaveId('');
  });
  await check('selected values preserve option order label retargeting and multiple-control errors', async () => {
    await expect(page.locator('#choices')).toHaveValues(Object.freeze(['one', /three/]));
    await expect(page.locator('#choices-label')).toHaveValues(['one', 'three']);
    await expect(page.locator('#choices')).not.toHaveValues(['three', 'one']);
    await rejects(() => short(page.locator('#single')).toHaveValues(['One']));
    await rejects(() => short(page.locator('#classes')).toHaveValues([]));
  });
  await check('roles preserve implicit/explicit behavior and do not use role hierarchy', async () => {
    await expect(page.locator('#implicit-role')).toHaveRole('button');
    await expect(page.locator('#explicit-role')).toHaveRole('switch');
    await expect(page.locator('#explicit-role')).not.toHaveRole('checkbox');
    await rejects(() => expect(page.locator('#implicit-role')).toHaveRole(/button/));
  });
  await check('accessible names and descriptions resolve hidden references and explicit case overrides', async () => {
    await expect(page.locator('#named')).toHaveAccessibleName('External label');
    await expect(page.locator('#named')).toHaveAccessibleName('external LABEL', { ignoreCase: true });
    await expect(page.locator('#named')).toHaveAccessibleName(/external label/i);
    await rejects(() => short(page.locator('#named')).toHaveAccessibleName(/external label/i, { ignoreCase: false }));
    await expect(page.locator('#named')).toHaveAccessibleDescription('Helpful details');
    await expect(page.locator('#named')).toHaveAccessibleDescription(/helpful details/, { ignoreCase: true });
  });
  await check('accessible errors depend on invalid state and normalize referenced text', async () => {
    await expect(page.locator('#invalid')).toHaveAccessibleErrorMessage('Required value');
    await expect(page.locator('#invalid')).toHaveAccessibleErrorMessage(/required value/, { ignoreCase: true });
    await page.evaluate(() => document.querySelector('#invalid').setAttribute('aria-invalid', 'false'));
    await expect(page.locator('#invalid')).toHaveAccessibleErrorMessage('');
  });
  await check('strict and missing-target negation remain distinct from empty list semantics', async () => {
    await rejects(() => short(page.locator('#class-list > div')).toHaveId('first'));
    await rejects(() => short(page.locator('#missing')).not.toHaveId('anything'));
    await rejects(() => short(page.locator('#missing')).not.toHaveClass('anything'));
    await rejects(() => short(page.locator('#missing')).not.toHaveClass([]));
    await rejects(() => short(page.locator('#missing')).not.toHaveAccessibleName('anything'));
    await rejects(() => short(page.locator('#missing')).not.toHaveValues([]));
    await rejects(() => short(page.locator('css=[')).toHaveRole('button'));
  });
  await check('property-only selected changes and stylesheet-only changes wake retrying predicates', async () => {
    await page.evaluate(() => {
      setTimeout(() => {
        for (const option of document.querySelector('#choices').options) option.selected = option.value === 'two';
        document.querySelector('#styles').sheet.cssRules[0].style.color = 'rgb(90, 80, 70)';
      }, 40);
    });
    await Promise.all([
      expect(page.locator('#choices')).toHaveValues(['two']),
      expect(page.locator('#styled')).toHaveCSS('color', 'rgb(90, 80, 70)'),
    ]);
  });
  await check('replacement and late accessible reference updates requery the original locator', async () => {
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector('#replace').outerHTML = '<section id="replace" class="after">Successor</section>';
        document.querySelector('#label').textContent = 'Changed label';
        document.querySelector('#description').textContent = 'Changed details';
        document.querySelector('#invalid').setAttribute('aria-invalid', 'true');
        document.querySelector('#error').textContent = 'Changed error';
      }, 40);
    });
    await Promise.all([
      expect(page.locator('#replace')).toHaveClass('after'),
      expect(page.locator('#named')).toHaveAccessibleName('Changed label'),
      expect(page.locator('#named')).toHaveAccessibleDescription('Changed details'),
      expect(page.locator('#invalid')).toHaveAccessibleErrorMessage('Changed error'),
    ]);
  });
  await check('open shadow and same-process child frame locators preserve assertion scope', async () => {
    await page.evaluate(() => document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<button id="shadow-button" class="shadow">Shadow action</button>');
    await expect(page.locator('#shadow-button')).toHaveClass('shadow');
    await expect(page.locator('#shadow-button')).toHaveAccessibleName('Shadow action');
    const child = page.frame('child');
    assert(child);
    await expect(child.locator('button')).toHaveId('child-button');
    await expect(child.locator('button')).toHaveRole('button');
    await expect(child.locator('button')).toHaveAccessibleName('Child action');
  });
  await check('long diagnostic truncation does not truncate the predicate', async () => {
    const expected = 'a'.repeat(5000) + 'z';
    await page.evaluate(value => document.querySelector('#classes').className = value, expected);
    await expect(page.locator('#classes')).toHaveClass(expected);
    await assert.rejects(short(page.locator('#classes')).toHaveClass('a'.repeat(5000) + 'x'), error => {
      if (implementation === 'flashwright') {
        assert.match(error.message, /diagnostic was truncated/);
        assert.equal(error.matcherResult.actual, 'a'.repeat(4096) + '… [diagnostic truncated]');
      }
      return true;
    });
  });
  await check('navigation retires old predicate work and matches the successor document', async () => {
    const pending = expect(page.locator('#successor')).toHaveClass('arrived');
    void pending.catch(() => {});
    await page.goto(baseURL + '/successor');
    await pending;
  });
  await check('page closure rejects unfinished new predicates without closing a sibling page', async () => {
    const sibling = await page.context().newPage();
    try {
      await sibling.goto(baseURL + '/child');
      const pending = expect(page.locator('#successor')).toHaveCSS('color', 'never', { timeout: 0 });
      const rejected = assert.rejects(pending, /toHaveCSS|closed|Target/i);
      await page.close();
      await rejected;
      assert.equal(page.isClosed(), true);
      await expect(sibling.locator('button')).toHaveAccessibleName('Child action');
    } finally { await sibling.close(); }
  });
}
