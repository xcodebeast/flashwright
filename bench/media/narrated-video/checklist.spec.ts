// Copyright (c) Flashwright contributors. Licensed under Apache-2.0.

import { test, expect } from '@playwright/test';

const app = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Launch checklist</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #101521; color: #eef2ff; font: 18px/1.5 system-ui, sans-serif; }
  header { padding: 24px 48px; border-bottom: 1px solid #2b3346; display: flex; justify-content: space-between; }
  header strong { letter-spacing: -.5px; } header span, .eyebrow { color: #a5b4fc; font-size: 14px; }
  main { max-width: 780px; margin: 60px auto; }
  .eyebrow { text-transform: uppercase; letter-spacing: 2px; }
  h1 { font-size: 42px; letter-spacing: -1.5px; margin: 8px 0; }
  .description { margin: 0 0 32px; color: #aab5cc; }
  form { display: flex; gap: 12px; }
  input { flex: 1; min-width: 0; border: 1px solid #45516d; border-radius: 10px; padding: 14px 18px; background: #1a2233; color: white; font: inherit; }
  input:focus { outline: 2px solid #a5b4fc; outline-offset: 2px; }
  button { border: 0; border-radius: 10px; padding: 14px 22px; background: #b7c4ff; color: #101521; font: 600 17px system-ui; cursor: pointer; }
  ul { padding: 0; list-style: none; margin: 22px 0; }
  li { display: flex; gap: 16px; align-items: center; padding: 20px; border: 1px solid #35405a; border-radius: 12px; background: #1a2233; }
  li input { flex: none; width: 22px; height: 22px; accent-color: #a5b4fc; }
  li:has(:checked) span { text-decoration: line-through; color: #9ba7bd; }
  #empty { text-align: center; padding: 28px; border: 1px dashed #35405a; border-radius: 12px; color: #aab5cc; }
  footer { display: flex; justify-content: space-between; color: #aab5cc; font-size: 14px; }
  #status { color: #9ce4bc; }
</style></head><body>
<header><strong>Flashwright</strong><span>Example app</span></header>
<main>
  <div class="eyebrow">Ready to ship</div>
  <h1>Launch checklist</h1>
  <p class="description">One less thing to remember before your next release.</p>
  <form><input aria-label="New task" placeholder="What needs to happen?"><button>Add task</button></form>
  <ul aria-label="Tasks"></ul>
  <p id="empty">Your checklist is empty. Add your first task.</p>
  <footer><span id="count">0 tasks remaining</span><span id="status" role="status">All changes saved</span></footer>
</main>
<script>
  const form = document.querySelector('form');
  const input = form.querySelector('input');
  const list = document.querySelector('ul');
  form.onsubmit = event => {
    event.preventDefault();
    if (!input.value.trim()) return;
    const item = document.createElement('li');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.setAttribute('aria-label', 'Complete ' + input.value);
    const label = document.createElement('span');
    label.textContent = input.value;
    item.append(check, label);
    list.append(item);
    input.value = '';
    document.getElementById('empty').hidden = true;
    check.onchange = update;
    update();
  };
  function update() {
    const left = list.querySelectorAll('input:not(:checked)').length;
    document.getElementById('count').textContent = left + (left === 1 ? ' task remaining' : ' tasks remaining');
  }
</script></body></html>`;

test('adds a task and marks it done', async ({ page, narrate }) => {
  await page.setContent(app);
  await narrate('Start with an empty launch checklist.');
  await page.getByRole('textbox', { name: 'New task' }).fill('Ship the README');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByRole('listitem')).toHaveText('Ship the README');
  await narrate('Add a task before the next release.');
  await page.getByRole('checkbox', { name: 'Complete Ship the README' }).check();
  await expect(page.getByText('0 tasks remaining')).toBeVisible();
  await narrate('Mark it done. The checklist is clear.');
});
