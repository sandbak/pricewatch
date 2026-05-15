const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { checkIntervalMinutes: 60, products: [] };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function save(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function getProducts() {
  return load().products || [];
}

function addProduct(product) {
  const config = load();
  if (!config.products) config.products = [];

  // Generate ID from label
  const id = product.id || slugify(product.label);
  const newProduct = { ...product, id };
  config.products.push(newProduct);
  save(config);
  return newProduct;
}

function updateProduct(id, updates) {
  const config = load();
  const index = config.products.findIndex((p) => p.id === id);
  if (index === -1) return null;
  config.products[index] = { ...config.products[index], ...updates, id };
  save(config);
  return config.products[index];
}

function deleteProduct(id) {
  const config = load();
  const index = config.products.findIndex((p) => p.id === id);
  if (index === -1) return false;
  config.products.splice(index, 1);
  save(config);
  return true;
}

function getSettings() {
  const config = load();
  return {
    checkIntervalMinutes: config.checkIntervalMinutes || 60,
  };
}

function updateSettings(settings) {
  const config = load();
  if (settings.checkIntervalMinutes != null) {
    config.checkIntervalMinutes = Math.max(1, parseInt(settings.checkIntervalMinutes, 10) || 60);
  }
  save(config);
  return config;
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = {
  load,
  save,
  getProducts,
  addProduct,
  updateProduct,
  deleteProduct,
  getSettings,
  updateSettings,
};
