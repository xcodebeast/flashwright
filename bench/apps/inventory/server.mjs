// "Inventory": an admin page with the size of a real application's: a table of 400 items with
// filters, search, sorting, row actions and dialogs, about 9,000 elements. Its tests find elements
// the way Playwright recommends (roles, labels, text), so they measure locator cost on a large page.
// Every change stays in the page, so tests can run in parallel and in any order.
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { categories, items, warehouses } from './tests/data.mjs';

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Inventory</title><style>
body { font: 13px sans-serif; margin: 0; display: grid; grid-template-columns: 220px 1fr; grid-template-rows: auto 1fr }
header { grid-column: 1 / 3; display: flex; gap: 12px; padding: 10px; background: #234; color: white } header a { color: white }
aside { padding: 10px; border-right: 1px solid #ccc } aside label { display: block } main { padding: 10px; overflow: auto }
table { border-collapse: collapse; width: 100% } td, th { border-bottom: 1px solid #eee; padding: 2px 6px; text-align: left }
.badge { padding: 1px 6px; border-radius: 8px; background: #dfd } .badge.low { background: #ffd } .badge.out { background: #fdd }
dialog { border: 1px solid #888 } .toast { position: fixed; bottom: 12px; right: 12px; background: #333; color: white; padding: 6px 10px }
.menu { position: absolute; background: white; border: 1px solid #aaa } .menu button { display: block }
</style></head><body>
<header><nav aria-label="Main"><a href="/inventory" data-link>Inventory</a> <a href="/orders" data-link>Orders</a> <a href="/reports" data-link>Reports</a> <a href="/settings" data-link>Settings</a></nav><button aria-label="Account">Account</button></header>
<aside><h2>Filters</h2>
<fieldset><legend>Category</legend>${categories.map(c => `<label><input type="checkbox" name="category" value="${c}"> ${c}</label>`).join('')}</fieldset>
<fieldset><legend>Status</legend>${['All', 'In stock', 'Low stock', 'Out of stock'].map((s, i) => `<label><input type="radio" name="status" value="${s}"${i ? '' : ' checked'}> ${s}</label>`).join('')}</fieldset>
<label>Warehouse <select name="warehouse"><option value="">All</option>${warehouses.map(w => `<option>${w}</option>`).join('')}</select></label>
<label>Max price <input name="maxPrice" type="number"></label>
<button id="reset">Reset filters</button></aside>
<main id="app"></main>
<script>
const app = document.getElementById('app');
let items = [], selected = new Set(), sort = { key: 'id', direction: 1 };
const filters = () => {
  const form = document.querySelector('aside');
  return {
    categories: [...form.querySelectorAll('input[name=category]:checked')].map(i => i.value),
    status: form.querySelector('input[name=status]:checked').value,
    warehouse: form.querySelector('select[name=warehouse]').value,
    maxPrice: Number(form.querySelector('input[name=maxPrice]').value) || Infinity,
    query: (document.getElementById('search')?.value || '').toLowerCase(),
  };
};
function visibleItems() {
  const f = filters();
  return items.filter(item => (!f.categories.length || f.categories.includes(item.category)) && (f.status === 'All' || item.status === f.status) &&
    (!f.warehouse || item.warehouse === f.warehouse) && item.price <= f.maxPrice && (item.name.toLowerCase().includes(f.query) || item.sku.toLowerCase().includes(f.query)))
    .sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * sort.direction);
}
function toast(text) { const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text; document.body.append(t); setTimeout(() => t.remove(), 1500); }
const money = price => '$' + price.toFixed(2);
const badge = status => '<span class="badge ' + (status === 'Low stock' ? 'low' : status === 'Out of stock' ? 'out' : '') + '"><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4"></circle></svg> ' + status + '</span>';
const columns = [['name', 'Name'], ['sku', 'SKU'], ['category', 'Category'], ['warehouse', 'Warehouse'], ['stock', 'Stock'], ['price', 'Price'], ['status', 'Status']];
function renderTable() {
  const rows = visibleItems();
  const header = columns.map(([key, title]) => '<th aria-sort="' + (sort.key === key ? (sort.direction > 0 ? 'ascending' : 'descending') : 'none') + '"><button data-sort="' + key + '">' + title + '</button></th>').join('');
  const body = rows.map(item => '<tr data-id="' + item.id + '"><td><input type="checkbox" aria-label="Select ' + item.sku + '"' + (selected.has(item.id) ? ' checked' : '') + '></td>' +
    '<td><strong>' + item.name + '</strong><br><small>' + item.description + '</small></td><td>' + item.sku + '</td><td>' + item.category + '</td><td>' + item.warehouse + '</td>' +
    '<td><span>' + item.stock + '</span></td><td>' + money(item.price) + '</td><td>' + badge(item.status) + '</td>' +
    '<td><button data-edit>Edit</button> <button data-delete>Delete</button> <button data-more aria-haspopup="menu">More actions</button></td></tr>').join('');
  app.querySelector('#table').innerHTML = '<thead><tr><th><input type="checkbox" aria-label="Select all"' + (rows.length && rows.every(item => selected.has(item.id)) ? ' checked' : '') + '></th>' + header + '<th>Actions</th></tr></thead><tbody>' + body + '</tbody>';
  app.querySelector('#count').textContent = rows.length ? 'Showing ' + rows.length + ' items' : 'No items match';
  app.querySelector('#bulk').textContent = 'Delete selected (' + selected.size + ')';
  app.querySelector('#bulk').disabled = !selected.size;
}
function confirmDialog(title, onConfirm) {
  const d = document.createElement('dialog');
  d.setAttribute('aria-label', title);
  d.innerHTML = '<p>' + title + '</p><button data-confirm>Delete</button><button data-cancel>Cancel</button>';
  document.body.append(d); d.showModal();
  d.querySelector('[data-confirm]').onclick = () => { d.remove(); onConfirm(); };
  d.querySelector('[data-cancel]').onclick = () => d.remove();
}
function editDialog(item) {
  const d = document.createElement('dialog');
  d.setAttribute('aria-label', 'Edit ' + item.sku);
  d.innerHTML = '<h3>Edit ' + item.sku + '</h3><label>Name <input name="name" value="' + item.name + '"></label><label>Stock <input name="stock" type="number" value="' + item.stock + '"></label>' +
    '<label>Price <input name="price" type="number" step="0.01" value="' + item.price + '"></label><button data-save>Save</button><button data-cancel>Cancel</button>';
  document.body.append(d); d.showModal();
  d.querySelector('[data-save]').onclick = () => {
    item.name = d.querySelector('[name=name]').value;
    item.stock = Number(d.querySelector('[name=stock]').value);
    item.price = Number(d.querySelector('[name=price]').value);
    item.status = item.stock === 0 ? 'Out of stock' : item.stock < 10 ? 'Low stock' : 'In stock';
    d.remove(); renderTable(); toast('Saved ' + item.sku);
  };
  d.querySelector('[data-cancel]').onclick = () => d.remove();
}
async function render() {
  const path = location.pathname;
  if (path === '/reports') {
    app.innerHTML = '<h1>Reports</h1><ul>' + items.slice(0, 200).map(item => '<li><a href="#' + item.sku + '">' + item.name + ' sales</a> <span>' + item.stock * 3 + ' sold</span></li>').join('') + '</ul>';
    return;
  }
  if (path !== '/inventory') {
    app.innerHTML = '<h1>' + path.slice(1, 2).toUpperCase() + path.slice(2) + '</h1><p>Nothing here yet.</p>';
    return;
  }
  app.innerHTML = '<h1>Inventory</h1><p aria-busy="true">Loading items</p>';
  if (!items.length)
    items = await (await fetch('/api/items')).json();
  if (location.pathname !== '/inventory')
    return;
  app.innerHTML = '<h1>Inventory</h1><div role="toolbar" aria-label="Items"><label>Search items <input id="search" type="search"></label> <button id="bulk" disabled></button> <button id="export">Export</button> <span id="count"></span></div><table id="table" aria-label="Items"></table>';
  document.getElementById('search').oninput = renderTable;
  document.getElementById('search').onkeydown = e => { if (e.key === 'Escape') { e.target.value = ''; renderTable(); } };
  document.getElementById('bulk').onclick = () => confirmDialog('Delete ' + selected.size + ' items?', () => { items = items.filter(item => !selected.has(item.id)); const n = selected.size; selected.clear(); renderTable(); toast('Deleted ' + n + ' items'); });
  document.getElementById('export').onclick = () => toast('Exported ' + visibleItems().length + ' items');
  const table = document.getElementById('table');
  table.onclick = e => {
    const sortButton = e.target.closest('[data-sort]');
    if (sortButton) { const key = sortButton.dataset.sort; sort = { key, direction: sort.key === key ? -sort.direction : 1 }; renderTable(); return; }
    const row = e.target.closest('tr[data-id]');
    const item = row && items.find(item => item.id === Number(row.dataset.id));
    if (e.target.matches('[data-edit]')) editDialog(item);
    if (e.target.matches('[data-delete]')) confirmDialog('Delete ' + item.sku + '?', () => { items = items.filter(other => other !== item); selected.delete(item.id); renderTable(); toast('Deleted ' + item.sku); });
    if (e.target.matches('[data-more]')) {
      const menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'menu');
      menu.innerHTML = '<button role="menuitem" data-duplicate>Duplicate</button><button role="menuitem" data-archive>Archive</button>';
      e.target.after(menu);
      menu.querySelector('[data-duplicate]').onclick = () => { const copy = { ...item, id: Math.max(...items.map(i => i.id)) + 1, sku: item.sku + '-COPY', name: item.name + ' copy' }; items.push(copy); renderTable(); toast('Duplicated ' + item.sku); };
      menu.querySelector('[data-archive]').onclick = () => { menu.remove(); toast('Archived ' + item.sku); };
    }
  };
  table.onchange = e => {
    if (e.target.matches('[aria-label="Select all"]')) { for (const item of visibleItems()) e.target.checked ? selected.add(item.id) : selected.delete(item.id); renderTable(); return; }
    const row = e.target.closest('tr[data-id]');
    if (row) { const id = Number(row.dataset.id); e.target.checked ? selected.add(id) : selected.delete(id); renderTable(); }
  };
  renderTable();
}
document.querySelector('aside').oninput = () => { if (document.getElementById('table')) renderTable(); };
document.getElementById('reset').onclick = () => { document.querySelector('aside').querySelectorAll('input[type=checkbox]').forEach(i => i.checked = false); document.querySelector('input[value=All]').checked = true; document.querySelector('select[name=warehouse]').value = ''; document.querySelector('input[name=maxPrice]').value = ''; renderTable(); };
document.addEventListener('click', e => { const a = e.target.closest('a[data-link]'); if (a) { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); render(); } });
window.addEventListener('popstate', render);
render();
</script></body></html>`;

export async function startInventoryServer() {
  // A little API latency, as from a local backend.
  const latency = 15;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/items') {
      await sleep(latency);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(items));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(page);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
