#!/usr/bin/env node
console.log("=== Starting Price Watcher ===");

// Phase 1: Core modules only
try {
  require("express");
  console.log("✓ express");
} catch (e) { console.error("✗ express:", e.message); process.exit(1); }

try {
  require("dotenv").config();
  console.log("✓ dotenv");
} catch (e) { console.error("✗ dotenv:", e.message); }

try {
  require("path");
  require("cors");
  require("node-cron");
  require("chalk");
  console.log("✓ path, cors, node-cron, chalk");
} catch (e) { console.error("✗ core:", e.message); }

// Phase 2: Our modules
try {
  require("./lib/env");
  console.log("✓ lib/env");
} catch (e) { console.error("✗ lib/env:", e.message); }

try {
  require("./lib/config");
  console.log("✓ lib/config");
} catch (e) { console.error("✗ lib/config:", e.message); }

try {
  require("./state");
  console.log("✓ state");
} catch (e) { console.error("✗ state:", e.message); }

try {
  require("./scrapers");
  console.log("✓ scrapers");
} catch (e) { console.error("✗ scrapers:", e.message); }

try {
  require("./telegram");
  console.log("✓ telegram");
} catch (e) { console.error("✗ telegram:", e.message); }

// Phase 3: Clerk (wrapped)
try {
  require("@clerk/express");
  console.log("✓ @clerk/express");
} catch (e) { console.error("✗ @clerk/express:", e.message); }

// Phase 4: Start HTTP server
console.log("\n=== Starting HTTP server ===");
try {
  const express = require("express");
  const app = express();
  app.get("/", (req, res) => res.send("OK"));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✓ Server running on port ${PORT}`);
  });
} catch (err) {
  console.error("✗ Server failed:", err);
  process.exit(1);
}
