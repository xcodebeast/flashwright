// The inventory's items, shared by the server and the tests that check counts against them.
export const categories = ['Books', 'Games', 'Tools', 'Garden', 'Kitchen', 'Office', 'Toys', 'Sports', 'Music', 'Health', 'Pets', 'Travel'];
export const warehouses = ['North', 'South', 'East', 'West'];

export const items = Array.from({ length: 400 }, (_, index) => {
  const i = index + 1;
  const stock = (i * 37) % 120;
  return {
    id: i,
    sku: 'SKU-' + String(i).padStart(4, '0'),
    name: 'Item ' + i,
    description: `Model ${(i * 7) % 90} in ${categories[i % categories.length].toLowerCase()}`,
    category: categories[i % categories.length],
    warehouse: warehouses[i % warehouses.length],
    stock,
    price: 1 + (i * 13) % 200 + ((i * 29) % 100) / 100,
    status: stock === 0 ? 'Out of stock' : stock < 10 ? 'Low stock' : 'In stock',
  };
});
