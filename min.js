#!/usr/bin/env node
const http = require("http");
const port = process.env.PORT || 3000;
console.log("Starting minimal HTTP server on port", port);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});
server.listen(port, () => console.log("Server listening on", port));
