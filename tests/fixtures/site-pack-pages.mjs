// Pages the end-to-end site pack checks work against: a list of three
// products a snapshot reads line by line, each with its name, its price and
// an Add button, and a cart of two lines whose total sits in one element a
// page tool reads.
export const sitePackPages = {
  "/packs/products": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lab products</title>
<style>body{font:16px system-ui;margin:24px}li{margin:8px 0}button{margin-left:8px}</style></head>
<body><h1>Lab products</h1>
<ul id="products">
<li data-id="trail-mix"><span class="name">Trail mix</span> <span class="price">$4.50</span> <button type="button">Add Trail mix</button></li>
<li data-id="lamp-oil"><span class="name">Lamp oil</span> <span class="price">$12.00</span> <button type="button">Add Lamp oil</button></li>
<li data-id="rope"><span class="name">Rope</span> <span class="price">$7.25</span> <button type="button">Add Rope</button></li>
</ul>
<p><a href="/packs/cart">Cart</a></p>
</body></html>`,
  "/packs/cart": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lab cart</title>
<style>body{font:16px system-ui;margin:24px}</style></head>
<body><h1>Lab cart</h1>
<ul id="lines">
<li data-id="trail-mix">Trail mix, 2 at $4.50</li>
<li data-id="rope">Rope, 1 at $7.25</li>
</ul>
<p>Total: $<span id="total">16.25</span></p>
<p><a href="/packs/products">Products</a></p>
</body></html>`,
};
