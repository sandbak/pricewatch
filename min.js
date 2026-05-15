#!/usr/bin/env node
const http = require("http");
const port = 3000;
console.log("Starting on port", port);
const s = http.createServer((r, w) => { w.writeHead(200); w.end("OK"); });
s.listen(port, () => console.log("Listening"));
