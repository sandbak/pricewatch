const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "state.json");

function load() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function save(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function get(state, id) {
  return state[id] || { lastPrice: null, lastChecked: null, alertSent: false };
}

function set(state, id, updates) {
  state[id] = { ...get(state, id), ...updates };
}

module.exports = { load, save, get, set };
