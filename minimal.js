#!/usr/bin/env node
console.log("=== MINIMAL SERVER STARTING ===");
try {
  const express = require("express");
  console.log("✓ express loaded");
  const app = express();
  app.get("/", (req, res) => res.send("OK"));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✓ Server listening on port ${PORT}`);
  });
} catch (err) {
  console.error("CRASH:", err);
  process.exit(1);
}
