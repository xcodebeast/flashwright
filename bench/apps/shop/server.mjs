// "Shop": a small single-page app with the shapes most e2e suites exercise: a login that sets a
// session cookie, data fetched with realistic API latency, client-side routing, a modal with a
// CSS transition, toasts that disappear, a debounced search and a cart kept in localStorage.
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const products = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: 5 + (i * 7) % 40, category: ['Books', 'Games', 'Tools'][i % 3] }));

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title><style>
body { font-family: sans-serif; margin: 0 } header { display: flex; gap: 12px; padding: 12px; background: #eee }
main { padding: 16px } .card { display: inline-block; width: 180px; margin: 6px; padding: 8px; border: 1px solid #ccc }
.modal { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.3); opacity: 0; transition: opacity 150ms }
.modal.open { opacity: 1 } .dialog { background: white; padding: 24px; transform: translateY(20px); transition: transform 150ms }
.modal.open .dialog { transform: none } .toast { position: fixed; bottom: 16px; right: 16px; background: #333; color: white; padding: 8px 12px }
.spinner { width: 16px; height: 16px; border: 2px solid #999; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite }
@keyframes spin { to { transform: rotate(360deg) } }
</style></head><body><header><a href="/" data-link>Home</a><a href="/products" data-link>Products</a><a href="/cart" data-link>Cart (<span id="cart-count">0</span>)</a><span id="user"></span></header><main id="app"></main>
<script>
const app = document.getElementById('app');
const cart = () => JSON.parse(localStorage.getItem('cart') || '[]');
const setCart = items => { localStorage.setItem('cart', JSON.stringify(items)); document.getElementById('cart-count').textContent = items.length; };
const api = async (path, options) => { const r = await fetch('/api' + path, options); if (r.status === 401) { navigate('/login'); throw new Error('unauthorized'); } return r.json(); };
function toast(text) { const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text; document.body.append(t); setTimeout(() => t.remove(), 1500); }
function navigate(path) { history.pushState({}, '', path); render(); }
document.addEventListener('click', e => { const a = e.target.closest('a[data-link]'); if (a) { e.preventDefault(); navigate(a.getAttribute('href')); } });
window.addEventListener('popstate', render);
async function render() {
  setCart(cart());
  const path = location.pathname;
  if (path === '/login') {
    app.innerHTML = '<h1>Sign in</h1><form id="login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button><p id="error" role="alert"></p></form>';
    document.getElementById('login').onsubmit = async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify(data) });
      if (r.ok) { navigate('/'); } else { document.getElementById('error').textContent = 'Invalid credentials'; }
    };
    return;
  }
  app.innerHTML = '<div class="spinner" aria-label="Loading"></div>';
  let me;
  try { me = await api('/me'); } catch { return; }
  document.getElementById('user').textContent = me.email;
  if (path === '/') {
    const stats = await api('/stats');
    app.innerHTML = '<h1>Welcome back</h1><p>' + stats.products + ' products in ' + stats.categories + ' categories</p><button id="open-promo">Show offer</button>';
    document.getElementById('open-promo').onclick = () => {
      const m = document.createElement('div'); m.className = 'modal';
      m.innerHTML = '<div class="dialog" role="dialog" aria-label="Offer"><p>10% off today</p><button id="claim">Claim</button><button id="close">Close</button></div>';
      document.body.append(m); requestAnimationFrame(() => m.classList.add('open'));
      m.querySelector('#claim').onclick = () => { toast('Offer claimed'); m.remove(); };
      m.querySelector('#close').onclick = () => m.remove();
    };
  } else if (path === '/products') {
    const params = new URLSearchParams(location.search);
    app.innerHTML = '<h1>Products</h1><input type="search" placeholder="Search" aria-label="Search" value="' + (params.get('q') || '') + '"><select aria-label="Category"><option value="">All</option><option>Books</option><option>Games</option><option>Tools</option></select><div id="list"></div>';
    const list = document.getElementById('list');
    const search = app.querySelector('input'), category = app.querySelector('select');
    category.value = params.get('category') || '';
    const load = async () => {
      list.innerHTML = '<div class="spinner" aria-label="Loading"></div>';
      const items = await api('/products?q=' + encodeURIComponent(search.value) + '&category=' + encodeURIComponent(category.value));
      list.innerHTML = items.map(p => '<div class="card" data-testid="product"><h3>' + p.name + '</h3><p>' + p.category + ' · $' + p.price + '</p><button data-id="' + p.id + '">Add to cart</button></div>').join('') || '<p>No products found</p>';
      list.querySelectorAll('button').forEach(b => b.onclick = () => { setCart([...cart(), Number(b.dataset.id)]); toast('Added to cart'); });
    };
    let timer; search.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 150); };
    category.onchange = load;
    await load();
  } else if (path === '/cart') {
    const items = cart();
    const all = await api('/products?q=&category=');
    const rows = items.map(id => all.find(p => p.id === id));
    app.innerHTML = '<h1>Cart</h1><ul>' + rows.map((p, i) => '<li>' + p.name + ' <button data-index="' + i + '">Remove</button></li>').join('') + '</ul><p id="total">Total: $' + rows.reduce((a, p) => a + p.price, 0) + '</p><button id="checkout"' + (rows.length ? '' : ' disabled') + '>Checkout</button>';
    app.querySelectorAll('li button').forEach(b => b.onclick = () => { const c = cart(); c.splice(Number(b.dataset.index), 1); setCart(c); render(); });
    document.getElementById('checkout').onclick = async () => {
      const order = await api('/orders', { method: 'POST', body: JSON.stringify(cart()) });
      setCart([]);
      app.innerHTML = '<h1>Thank you</h1><p>Order #' + order.id + ' confirmed</p>';
    };
  }
}
render();
</script></body></html>`;

export async function startShopServer({ latency = 40 } = {}) {
  let orders = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = (status, body, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); response.end(JSON.stringify(body)); };
    const session = /session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
    if (!url.pathname.startsWith('/api/')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page);
      return;
    }
    const chunks = [];
    for await (const chunk of request)
      chunks.push(chunk);
    await sleep(latency);
    if (url.pathname === '/api/login') {
      const { email, password } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (password !== 'secret')
        return json(401, { error: 'invalid' });
      return json(200, { ok: true }, { 'Set-Cookie': `session=${encodeURIComponent(email)}; Path=/; HttpOnly` });
    }
    if (!session)
      return json(401, { error: 'unauthorized' });
    if (url.pathname === '/api/me')
      return json(200, { email: decodeURIComponent(session) });
    if (url.pathname === '/api/stats')
      return json(200, { products: products.length, categories: 3 });
    if (url.pathname === '/api/products') {
      const q = (url.searchParams.get('q') || '').toLowerCase(), category = url.searchParams.get('category');
      return json(200, products.filter(p => p.name.toLowerCase().includes(q) && (!category || p.category === category)));
    }
    if (url.pathname === '/api/orders' && request.method === 'POST')
      return json(200, { id: ++orders });
    json(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
